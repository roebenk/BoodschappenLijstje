import { getDb } from "../../db";
import {
  getStoreProduct,
  insertPurchaseHistory,
  recomputeProductPreferences,
  saveStoreAccount,
  upsertStoreProducts,
  type PurchaseHistoryInput,
} from "../../db/repositories";
import type { NormalizedStoreProduct, SyncHistoryResult } from "../../types";
import { requireUserToken } from "./auth";
import { ahGraphql, ahRequest } from "./client";
import { parseSalesUnitSize } from "./packSize";
import { fetchAhProductsByIds } from "./products";

const MAX_RECEIPTS = 200;
const PAGE_SIZE = 50;
const CONVERT_BATCH = 25;
const DETAIL_CONCURRENCY = 3;

interface Money {
  amount?: number | null;
}
interface ReceiptSummary {
  id: string;
  dateTime?: string | null;
}
interface ReceiptLine {
  id?: number | string | null;
  quantity?: number | null;
  name?: string | null;
  price?: Money | null;
  amount?: Money | null;
}

const RECEIPTS_QUERY = `query FetchPosReceipts($offset: Int!, $limit: Int!) {
  posReceiptsPage(pagination: { offset: $offset, limit: $limit }) {
    posReceipts { id dateTime totalAmount { amount } }
  }
}`;

const RECEIPT_QUERY = `query FetchReceipt($id: String!) {
  posReceiptDetails(id: $id) {
    id
    products { id quantity name price { amount } amount { amount } }
  }
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (euros: number) => Math.round(euros * 100);

function knownReceiptIds(): Set<string> {
  const rows = getDb().prepare("SELECT DISTINCT tx_id FROM purchase_history WHERE provider = 'ah'").all() as unknown as Array<{
    tx_id: string;
  }>;
  return new Set(rows.map((r) => String(r.tx_id)));
}

function knownPosMap(): Map<number, string> {
  const rows = getDb()
    .prepare("SELECT pos_id, external_id FROM store_products WHERE provider = 'ah' AND pos_id IS NOT NULL")
    .all() as unknown as Array<{ pos_id: number; external_id: string }>;
  return new Map(rows.map((r) => [Number(r.pos_id), String(r.external_id)]));
}

function existingExternalIds(ids: string[]): Set<string> {
  const have = new Set<string>();
  for (const id of ids) if (getStoreProduct(`ah:${id}`)) have.add(id);
  return have;
}

async function fetchReceiptList(token: string): Promise<ReceiptSummary[]> {
  const all: ReceiptSummary[] = [];
  for (let offset = 0; offset < MAX_RECEIPTS; offset += PAGE_SIZE) {
    const data = await ahGraphql<{ posReceiptsPage?: { posReceipts?: ReceiptSummary[] } }>(
      RECEIPTS_QUERY,
      { offset, limit: PAGE_SIZE },
      token,
    );
    const page = data.posReceiptsPage?.posReceipts ?? [];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all.slice(0, MAX_RECEIPTS);
}

async function fetchReceiptDetails(
  token: string,
  receipts: ReceiptSummary[],
): Promise<Array<{ receipt: ReceiptSummary; lines: ReceiptLine[] }>> {
  const out: Array<{ receipt: ReceiptSummary; lines: ReceiptLine[] }> = [];
  let next = 0;
  const worker = async () => {
    while (next < receipts.length) {
      const receipt = receipts[next++];
      try {
        const data = await ahGraphql<{ posReceiptDetails?: { products?: ReceiptLine[] } }>(
          RECEIPT_QUERY,
          { id: receipt.id },
          token,
        );
        out.push({ receipt, lines: data.posReceiptDetails?.products ?? [] });
      } catch {
        // One bad receipt must not abort the sync; it is retried next time.
      }
      await sleep(40);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, receipts.length) }, worker));
  return out;
}

async function convertPosIds(token: string, posIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (let i = 0; i < posIds.length; i += CONVERT_BATCH) {
    const batch = posIds.slice(i, i + CONVERT_BATCH);
    const query = `query Convert { ${batch.map((id, n) => `p${n}: productConvertId(sourceId: ${Math.trunc(id)})`).join(" ")} }`;
    try {
      const data = await ahGraphql<Record<string, number | null>>(query, undefined, token);
      batch.forEach((posId, n) => {
        const web = data[`p${n}`];
        if (typeof web === "number" && web > 0) map.set(posId, web);
      });
    } catch {
      // Unconvertible batch: those lines stay unmapped.
    }
  }
  return map;
}

function stubProduct(webshopId: string, posId: number | null, name: string): NormalizedStoreProduct {
  return {
    id: `ah:${webshopId}`,
    provider: "ah",
    externalId: webshopId,
    posId,
    title: name,
    brand: null,
    isHouseBrand: /^AH\s/i.test(name),
    unitSizeRaw: "",
    ...parseSalesUnitSize(""),
    regularPriceCents: 0,
    currentPriceCents: 0,
    promo: null,
    isOnlineOnlyPromo: false,
    imageUrl: null,
    available: true,
    updatedAt: new Date().toISOString(),
  };
}

interface OrderLine {
  webshopId: string;
  title: string;
  quantity: number;
  totalCents: number;
}

/** Best-effort: the online order endpoints are unverified, so every failure is ignored. */
async function fetchOnlineOrders(
  token: string,
): Promise<Array<{ id: string; date: string; lines: OrderLine[] }>> {
  try {
    const res = await ahRequest<unknown>("/mobile-services/order/v2/orders", { token });
    const list = Array.isArray(res) ? res : ((res as { orders?: unknown[] } | null)?.orders ?? []);
    const orders: Array<{ id: string; date: string; lines: OrderLine[] }> = [];
    for (const o of list as Array<Record<string, unknown>>) {
      const id = o.id ?? o.orderId;
      const rawLines = (o.orderLines ?? o.items ?? o.lines) as Array<Record<string, any>> | undefined;
      if (id == null || !Array.isArray(rawLines)) continue;
      const lines: OrderLine[] = [];
      for (const l of rawLines) {
        const wid = l.product?.webshopId ?? l.webshopId ?? l.productId;
        if (wid == null) continue;
        const qty = Number(l.quantity ?? 1) || 1;
        const price = Number(l.product?.currentPrice ?? l.product?.priceBeforeBonus ?? l.price ?? 0);
        lines.push({ webshopId: String(wid), title: String(l.product?.title ?? l.title ?? `Product ${wid}`), quantity: qty, totalCents: cents(price * qty) });
      }
      const date = String(o.deliveryDate ?? o.transactionCompleteDateTime ?? o.orderDate ?? "");
      if (lines.length && date) orders.push({ id: `order:${id}`, date: new Date(date).toISOString(), lines });
    }
    return orders;
  } catch {
    return [];
  }
}

export async function syncAhHistory(): Promise<SyncHistoryResult> {
  const token = await requireUserToken();
  const known = knownReceiptIds();
  const list = await fetchReceiptList(token);
  const fresh = list.filter((r) => !known.has(String(r.id)));
  const details = await fetchReceiptDetails(token, fresh);

  const posIds = new Set<number>();
  for (const d of details) for (const l of d.lines) if (l.id != null && Number.isFinite(Number(l.id))) posIds.add(Number(l.id));

  const posToWeb = new Map<number, string>();
  const knownPos = knownPosMap();
  const unknown: number[] = [];
  for (const id of posIds) {
    const web = knownPos.get(id);
    if (web) posToWeb.set(id, web);
    else unknown.push(id);
  }
  for (const [pos, web] of await convertPosIds(token, unknown)) posToWeb.set(pos, String(web));

  const orders = await fetchOnlineOrders(token);
  const knownOrders = known;
  const freshOrders = orders.filter((o) => !knownOrders.has(o.id));

  const nameByWeb = new Map<string, string>();
  const posByWeb = new Map<string, number>();
  for (const d of details) {
    for (const l of d.lines) {
      const web = l.id != null ? posToWeb.get(Number(l.id)) : undefined;
      if (web) {
        posByWeb.set(web, Number(l.id));
        if (l.name) nameByWeb.set(web, l.name);
      }
    }
  }
  for (const o of freshOrders) for (const l of o.lines) nameByWeb.set(l.webshopId, nameByWeb.get(l.webshopId) ?? l.title);

  const missing = [...nameByWeb.keys()].filter((id) => !existingExternalIds([id]).has(id));
  const resolved = new Map<string, NormalizedStoreProduct>();
  if (missing.length) {
    try {
      for (const p of await fetchAhProductsByIds(missing, token)) resolved.set(p.externalId, p);
    } catch {
      // Fall through to stubs.
    }
  }
  const toUpsert: NormalizedStoreProduct[] = [];
  for (const id of missing) {
    const pos = posByWeb.get(id) ?? null;
    const p = resolved.get(id) ?? stubProduct(id, pos, nameByWeb.get(id) ?? `Product ${id}`);
    toUpsert.push({ ...p, posId: pos });
  }
  // Known products that still lack a kassa id.
  for (const [web, pos] of posByWeb) {
    if (missing.includes(web)) continue;
    const existing = getStoreProduct(`ah:${web}`);
    if (existing && existing.posId == null) toUpsert.push({ ...existing, posId: pos });
  }
  upsertStoreProducts(toUpsert);

  const entries: PurchaseHistoryInput[] = [];
  let itemsSynced = 0;
  const mappedWeb = new Set<string>();
  for (const { receipt, lines } of details) {
    const purchasedAt = receipt.dateTime ? new Date(receipt.dateTime).toISOString() : new Date().toISOString();
    const merged = new Map<string, PurchaseHistoryInput>();
    for (const l of lines) {
      const name = (l.name ?? "").trim() || "Onbekend product";
      const web = l.id != null ? posToWeb.get(Number(l.id)) : undefined;
      const qty = l.quantity ?? 1;
      const total = l.amount?.amount ?? (l.price?.amount != null ? l.price.amount * qty : 0);
      if (web) mappedWeb.add(web);
      const prev = merged.get(name);
      if (prev) {
        prev.quantity = (prev.quantity ?? 0) + qty;
        prev.totalCents = (prev.totalCents ?? 0) + cents(total);
      } else {
        merged.set(name, {
          provider: "ah",
          txId: String(receipt.id),
          purchasedAt,
          storeProductId: web ? `ah:${web}` : null,
          rawName: name,
          quantity: qty,
          totalCents: cents(total),
        });
      }
    }
    entries.push(...merged.values());
  }
  for (const o of freshOrders) {
    for (const l of o.lines) {
      mappedWeb.add(l.webshopId);
      entries.push({
        provider: "ah",
        txId: o.id,
        purchasedAt: o.date,
        storeProductId: `ah:${l.webshopId}`,
        rawName: l.title,
        quantity: l.quantity,
        totalCents: l.totalCents,
      });
    }
  }
  itemsSynced = insertPurchaseHistory(entries);
  recomputeProductPreferences();

  const syncedAt = new Date().toISOString();
  saveStoreAccount("ah", { status: "authenticated", lastSyncedAt: syncedAt });
  return {
    provider: "ah",
    receiptsOrOrdersSynced: details.length + freshOrders.length,
    itemsSynced,
    productsMapped: mappedWeb.size,
    syncedAt,
  };
}
