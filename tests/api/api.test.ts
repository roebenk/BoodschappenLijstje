import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, resetDbConnectionForTests } from "@/lib/db";
import * as repo from "@/lib/db/repositories";
import type {
  HealthResponse,
  ItemComparisonResult,
  ListResponse,
  NormalizedStoreProduct,
  ShoppingListItem,
  SupermarketAdapter,
} from "@/lib/types";

const h = vi.hoisted(() => ({
  adapters: {} as Record<string, SupermarketAdapter>,
  pushItems: vi.fn(),
}));

vi.mock("@/lib/providers/registry", () => ({
  getProvider: (id: string) => h.adapters[id],
  getAllProviders: () => Object.values(h.adapters),
}));

import { GET as eventsGet } from "@/app/api/events/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as listGet, POST as listPost, DELETE as listDelete } from "@/app/api/list/route";
import { GET as suggestionsGet } from "@/app/api/list/suggestions/route";
import { GET as itemGet, PATCH as itemPatch } from "@/app/api/list/[id]/route";
import { GET as manualSearchGet } from "@/app/api/list/[id]/search/route";
import { POST as optimizePost } from "@/app/api/list/optimize/route";
import { POST as pushPost } from "@/app/api/list/push/route";
import { GET as dealsGet } from "@/app/api/deals/route";
import { GET as preferencesGet, PATCH as preferencesPatch } from "@/app/api/preferences/route";
import { GET as statsGet } from "@/app/api/stats/route";
import { GET as storesGet } from "@/app/api/stores/route";
import { POST as demoSeedPost } from "@/app/api/stores/demo-seed/route";
import { subscriberCount } from "@/lib/services/eventBus";
import { expandSearchQueries } from "@/lib/llm/openrouter";
import { clearSearchCache } from "@/lib/services/shoppingService";

const ROOT = path.join(process.cwd(), ".test-data-api");
const realCwd = process.cwd();
const dir = (() => {
  fs.mkdirSync(ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(ROOT, "t-"));
})();

function fakeAdapter(id: "ah" | "picnic" | "jumbo" | "plus"): SupermarketAdapter {
  return {
    id,
    displayName: id,
    channel: id === "ah" ? "in_store" : id === "picnic" ? "delivery" : "radar",
    capabilities: { search: true, promotions: true, historySync: false, listPush: id === "ah" || id === "picnic" },
    getAuthState: async () => ({ provider: id, status: id === "jumbo" || id === "plus" ? "disconnected" : "anonymous" }),
    authenticate: async () => ({ state: { provider: id, status: "anonymous" } }),
    // Sandboxed search: the seeded store_products act as the store catalogue.
    searchProducts: async ({ query }) => {
      const ids = getDb().prepare("SELECT id FROM store_products WHERE provider = ?").all(id) as Array<{ id: string }>;
      const tokens = query.toLowerCase().split(/\s+/);
      const products: NormalizedStoreProduct[] = repo
        .getStoreProducts(ids.map((r) => r.id))
        .filter((p) => tokens.every((t) => p.title.toLowerCase().includes(t)));
      return { products, isMockFallback: false };
    },
    getPromotions: async () => [],
    pushItems: id === "ah" || id === "picnic" ? (items) => h.pushItems(id, items) : undefined,
  };
}

function fallbackProduct(provider: "ah" | "picnic", externalId: string, title: string): NormalizedStoreProduct {
  return {
    id: `${provider}:${externalId}`, provider, externalId, title, brand: null, isHouseBrand: true,
    unitSizeRaw: "150 g", baseAmount: 150, baseUnit: "g", regularPriceCents: 349, currentPriceCents: 349,
    promo: null, isOnlineOnlyPromo: false, imageUrl: null, available: true,
  };
}

const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const post = (url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", ...(body === undefined ? {} : json(body)) });
const patch = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "PATCH", ...json(body) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

let kwarkId = 0;
let pindakaasId = 0;

beforeAll(() => {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.DATA_DIR = path.join(dir, "data");
  process.env.OPENROUTER_API_KEY = "";
  resetDbConnectionForTests();
  for (const id of ["ah", "picnic", "jumbo", "plus"] as const) h.adapters[id] = fakeAdapter(id);
  h.pushItems.mockImplementation(async (provider: string, items: unknown[]) => ({
    provider,
    success: true,
    itemsPushed: items.length,
  }));
});

afterAll(() => {
  resetDbConnectionForTests();
  vi.restoreAllMocks();
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.chdir(realCwd);
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes(needle) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("api", () => {
  it("GET /api/health returns a valid HealthResponse without leaking the OpenRouter key", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-super-secret";
    const res = await healthGet();
    process.env.OPENROUTER_API_KEY = "";
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-or-super-secret");
    const body = JSON.parse(text) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.database.ok).toBe(true);
    expect(body.openRouter.configured).toBe(true);
    expect(body.stores.map((s) => s.provider).sort()).toEqual(["ah", "jumbo", "picnic", "plus"]);
  });

  it("GET /api/stores lists all providers", async () => {
    const body = (await (await storesGet()).json()) as { stores: Array<{ provider: string }> };
    expect(body.stores).toHaveLength(4);
  });

  it("GET /api/list/suggestions returns an empty list without history", async () => {
    expect(await (await suggestionsGet()).json()).toEqual({ suggestions: [] });
  });

  it("POST /api/stores/demo-seed populates preferences and Calvé loyalty", async () => {
    const res = await demoSeedPost();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(body.historyEntries).toBeGreaterThan(50);
    expect(body.preferences).toBeGreaterThan(10);

    const concept = repo.getConceptBySlug("pindakaas")!;
    const loyalty = repo.getBrandLoyalty(concept.id);
    expect(loyalty.topBrand).toBe("Calvé");
    expect(loyalty.topBrandShare).toBeGreaterThan(0.8);

    const view = (await (await preferencesGet()).json()) as { preferences: Array<{ conceptName: string | null }> };
    expect(view.preferences.length).toBeGreaterThan(5);
    expect(view.preferences.some((p) => p.conceptName === "pindakaas")).toBe(true);

    const suggestions = (await (await suggestionsGet()).json()) as { suggestions: string[] };
    expect(suggestions.suggestions.length).toBeGreaterThan(0);
    expect(suggestions.suggestions.length).toBeLessThanOrEqual(50);
    expect(suggestions.suggestions.every((name) => name.length > 0)).toBe(true);
  });

  it("POST /api/list parses, compares both stores, applies Calvé loyalty and Picnic advice", async () => {
    const res = await listPost(post("/api/list", { inputs: ["4x 1kg magere kwark", "pindakaas", "  "] }));
    expect(res.status).toBe(201);
    const { items } = (await res.json()) as { items: ShoppingListItem[] };
    expect(items).toHaveLength(2);

    const kwark = items[0];
    kwarkId = kwark.id;
    expect(kwark.requestedQty).toBe(4);
    expect(kwark.ahQty).toBe(4);
    expect(kwark.ahTotalCents).toBe(4 * 149);
    expect(kwark.picnicTotalCents).toBe(4 * 139);
    expect(kwark.assignedProvider).toBe("picnic");

    const pinda = items[1];
    pindakaasId = pinda.id;
    expect(pinda.ahProduct?.brand).toBe("Calvé");
    expect(pinda.picnicProduct?.brand).toBe("Calvé");
    expect(pinda.loyaltyNote).toContain("Calvé");
    expect(pinda.loyaltyNote).toContain("bespaart");

    const list = (await (await listGet()).json()) as ListResponse;
    expect(list.items).toHaveLength(2);
    expect(list.picnicSubtotalCents).toBeGreaterThanOrEqual(4 * 139);
    expect(list.picnicSubtotalCents).toBeLessThan(3500);
    expect(list.totalCents).toBe(list.ahSubtotalCents + list.picnicSubtotalCents);
    expect(list.picnicAdvice.minOrderCents).toBe(3500);
    expect(list.picnicAdvice.meetsMinimum).toBe(false);
    expect(list.picnicAdvice.recommendation).toBe("all_at_ah");
  });

  it("GET /api/list/[id] returns all ranked candidates for the bottom sheet", async () => {
    const res = await itemGet(new Request("http://localhost/api/list/x"), ctx(pindakaasId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemComparisonResult & { item: ShoppingListItem };
    expect(body.item.id).toBe(pindakaasId);
    expect(body.ah.winner?.product.brand).toBe("Calvé");
    expect(body.ah.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(body.ah.houseBrandChallenger?.product.isHouseBrand).toBe(true);
    expect(body.picnic.winner).not.toBeNull();

    const missing = await itemGet(new Request("http://localhost/api/list/x"), ctx(9999));
    expect(missing.status).toBe(404);
  });

  it("PATCH /api/list/[id] preserves store mode when switching stores or products", async () => {
    const switchStore = await itemPatch(
      patch("/api/list/x", { assignedProvider: "ah", isProviderLocked: false }),
      ctx(kwarkId),
    );
    expect(((await switchStore.json()) as { item: ShoppingListItem }).item).toMatchObject({
      assignedProvider: "ah",
      isProviderLocked: false,
    });

    const lock = await itemPatch(patch("/api/list/x", { assignedProvider: "ah" }), ctx(kwarkId));
    const locked = ((await lock.json()) as { item: ShoppingListItem }).item;
    expect(locked.assignedProvider).toBe("ah");
    expect(locked.isProviderLocked).toBe(true);

    const swap = await itemPatch(
      patch("/api/list/x", { chosenProduct: { provider: "ah", productId: "ah:wi-demo-ah-pindakaas-350" } }),
      ctx(pindakaasId),
    );
    const swapped = ((await swap.json()) as { item: ShoppingListItem }).item;
    expect(swapped.ahProductId).toBe("ah:wi-demo-ah-pindakaas-350");
    expect(swapped.ahTotalCents).toBe(199);
    expect(swapped.assignedProvider).toBe("ah");
    expect(swapped.isProviderLocked).toBe(false);

    expect(repo.getProductPreference("ah:wi-demo-ah-pindakaas-350")?.manualPicks).toBe(1);
    expect(repo.getProductPreference("ah:wi-demo-calve-350")?.manualRejects).toBe(1);

    const lockedSwap = await itemPatch(
      patch("/api/list/x", { chosenProduct: { provider: "ah", productId: locked.ahProductId! } }),
      ctx(kwarkId),
    );
    expect(((await lockedSwap.json()) as { item: ShoppingListItem }).item.isProviderLocked).toBe(true);

    const qty = await itemPatch(patch("/api/list/x", { requestedQty: 2 }), ctx(kwarkId));
    const requantified = ((await qty.json()) as { item: ShoppingListItem }).item;
    expect(requantified.ahQty).toBe(2);
    expect(requantified.ahTotalCents).toBe(2 * 149);
  });

  it("POST /api/list/optimize respects locks; all_ah pulls unlocked Picnic items to AH", async () => {
    // kwark is locked to AH (Picnic would be cheaper) -> stays
    let res = await optimizePost(post("/api/list/optimize", { forceMode: "optimal" }));
    let body = (await res.json()) as ListResponse;
    expect(body.items.find((i) => i.id === kwarkId)?.assignedProvider).toBe("ah");

    // unlock -> optimal moves it to Picnic
    await itemPatch(patch("/api/list/x", { isProviderLocked: false }), ctx(kwarkId));
    res = await optimizePost(post("/api/list/optimize", {}));
    body = (await res.json()) as ListResponse;
    expect(body.items.find((i) => i.id === kwarkId)?.assignedProvider).toBe("picnic");
    expect(repo.getShoppingItem(kwarkId)?.assignedProvider).toBe("picnic");

    // Picnic is under the minimum -> all_ah moves the unlocked item, the locked AH item is untouched
    res = await optimizePost(post("/api/list/optimize", { forceMode: "all_ah" }));
    body = (await res.json()) as ListResponse;
    expect(body.items.every((i) => i.assignedProvider === "ah")).toBe(true);
    expect(body.picnicSubtotalCents).toBe(0);
    expect(repo.getShoppingItem(kwarkId)?.assignedProvider).toBe("ah");
  });

  it("POST /api/list/push previews without side effects, then pushes and stamps items", async () => {
    const preview = await (await pushPost(post("/api/list/push", { mode: "preview" }))).json();
    expect(preview.mode).toBe("preview");
    expect(preview.previews).toHaveLength(1);
    expect(preview.previews[0].provider).toBe("ah");
    expect(preview.previews[0].items.map((i: { itemId: number }) => i.itemId).sort()).toEqual(
      [kwarkId, pindakaasId].sort(),
    );
    expect(preview.previews[0].items.find((i: { itemId: number }) => i.itemId === kwarkId).quantity).toBe(2);
    expect(h.pushItems).not.toHaveBeenCalled();

    const pushed = await (await pushPost(post("/api/list/push", { mode: "push", autoCheckPushed: false }))).json();
    expect(pushed.results).toEqual([{ provider: "ah", success: true, itemsPushed: 2 }]);
    expect(h.pushItems).toHaveBeenCalledTimes(1);
    expect(repo.getShoppingItem(kwarkId)?.pushedToStoreAt).toBeTruthy();
    expect(repo.getShoppingItem(kwarkId)?.isChecked).toBe(false);
  });

  it("PATCH /api/preferences stores the brand mode", async () => {
    const conceptId = repo.getConceptBySlug("pindakaas")!.id;
    const res = await preferencesPatch(patch("/api/preferences", { conceptId, brandPreferenceMode: "house_brand" }));
    expect(res.status).toBe(200);
    expect(repo.getConceptById(conceptId)?.brandPreferenceMode).toBe("house_brand");
    const bad = await preferencesPatch(patch("/api/preferences", { conceptId, brandPreferenceMode: "nope" }));
    expect(bad.status).toBe(400);
  });

  it("GET /api/events streams hello and live list.changed events, and cleans up on abort", async () => {
    const abort = new AbortController();
    const res = await eventsGet(new Request("http://localhost/api/events", { signal: abort.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    expect(await readUntil(reader, '"type":"hello"')).toContain('"type":"hello"');
    expect(subscriberCount()).toBe(1);

    await itemPatch(patch("/api/list/x", { isChecked: true }), ctx(kwarkId));
    expect(await readUntil(reader, '"type":"list.changed"')).toContain('"type":"list.changed"');

    abort.abort();
    expect(subscriberCount()).toBe(0);
  });

  it("DELETE /api/list?checked=1 clears checked items only", async () => {
    const res = await listDelete(new Request("http://localhost/api/list?checked=1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(repo.getShoppingItem(kwarkId)).toBeNull();
    expect(repo.getShoppingItem(pindakaasId)).not.toBeNull();
    const bad = await listDelete(new Request("http://localhost/api/list", { method: "DELETE" }));
    expect(bad.status).toBe(400);
  });

  it("places newly added items at the top of the list while preserving multi-add order", async () => {
    const before = ((await (await listGet()).json()) as ListResponse).items.map((i) => i.id);
    expect(before.length).toBeGreaterThanOrEqual(1);

    await listPost(post("/api/list", { inputs: ["komkommer", "bananen"] }));
    const after = ((await (await listGet()).json()) as ListResponse).items;
    expect(after.slice(0, 2).map((i) => i.displayName)).toEqual(["Komkommer", "Bananen"]);
    expect(after.slice(2).map((i) => i.id)).toEqual(before);

    await listPost(post("/api/list", { inputs: ["eieren"] }));
    const afterSingle = ((await (await listGet()).json()) as ListResponse).items;
    expect(afterSingle[0].displayName).toBe("Eieren");
  });

  it("supports configurable defaultProvider tie-breaker on /api/preferences", async () => {
    repo.upsertStoreProducts([
      {
        id: "ah:tie-item",
        provider: "ah",
        externalId: "tie-item",
        title: "AH Tafelzout 500 g",
        brand: "AH",
        isHouseBrand: true,
        unitSizeRaw: "500 g",
        baseAmount: 500,
        baseUnit: "g",
        regularPriceCents: 69,
        currentPriceCents: 69,
        promo: null,
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
      {
        id: "picnic:tie-item",
        provider: "picnic",
        externalId: "tie-item",
        title: "Picnic Tafelzout 500 g",
        brand: "Picnic",
        isHouseBrand: true,
        unitSizeRaw: "500 g",
        baseAmount: 500,
        baseUnit: "g",
        regularPriceCents: 69,
        currentPriceCents: 69,
        promo: null,
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
    ]);

    const initialPrefs = await (await preferencesGet()).json();
    expect(initialPrefs.settings?.defaultProvider).toBe("ah");

    const addRes = await listPost(post("/api/list", { inputs: ["tafelzout"] }));
    const tieItem = ((await addRes.json()) as { items: ShoppingListItem[] }).items[0];
    expect(tieItem.assignedProvider).toBe("ah");

    const setPicnic = await preferencesPatch(patch("/api/preferences", { defaultProvider: "picnic" }));
    expect(setPicnic.status).toBe(200);
    const updatedPrefs = await setPicnic.json();
    expect(updatedPrefs.settings?.defaultProvider).toBe("picnic");

    const refreshed = ((await (await listGet()).json()) as ListResponse).items.find((i) => i.id === tieItem.id);
    expect(refreshed?.assignedProvider).toBe("picnic");

    // Reset back to AH
    await preferencesPatch(patch("/api/preferences", { defaultProvider: "ah" }));
  });

  it("steps packCount (4kg kwark -> 3x / 5x) and recalculates 2-pack multi-buy promos + store choice", async () => {
    const kwRes = await listPost(post("/api/list", { inputs: ["4kg magere kwark"] }));
    const kw = ((await kwRes.json()) as { items: ShoppingListItem[] }).items[0];
    expect(kw.ahQty).toBe(4);
    expect(kw.picnicQty).toBe(4);
    expect(kw.displayName).toBe("Magere kwark (4 kg)");

    const to3 = ((await (await itemPatch(patch("/api/list/x", { packCount: 3 }), ctx(kw.id))).json()) as { item: ShoppingListItem }).item;
    expect(to3.ahQty).toBe(3);
    expect(to3.picnicQty).toBe(3);
    expect(to3.targetBaseAmount).toBe(3000);
    expect(to3.displayName).toBe("Magere kwark (3 kg)");

    const to5 = ((await (await itemPatch(patch("/api/list/x", { packCount: 5 }), ctx(kw.id))).json()) as { item: ShoppingListItem }).item;
    expect(to5.ahQty).toBe(5);
    expect(to5.picnicQty).toBe(5);
    expect(to5.targetBaseAmount).toBe(5000);
    expect(to5.displayName).toBe("Magere kwark (5 kg)");

    // Multi-buy promo when stepping 1x -> 2x: AH has "2 voor 3,00" (€2,20 regular), Picnic has €1,80 regular
    repo.upsertStoreProducts([
      {
        id: "ah:tandpasta-deal",
        provider: "ah",
        externalId: "tandpasta-deal",
        title: "Prodent Tandpasta 75 ml",
        brand: "Prodent",
        isHouseBrand: false,
        unitSizeRaw: "75 ml",
        baseAmount: 75,
        baseUnit: "ml",
        regularPriceCents: 220,
        currentPriceCents: 220,
        promo: { type: "x_for_y", label: "2 voor €3,00", bundleQty: 2, bundlePriceCents: 300 },
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
      {
        id: "picnic:tandpasta-reg",
        provider: "picnic",
        externalId: "tandpasta-reg",
        title: "Prodent Tandpasta 75 ml",
        brand: "Prodent",
        isHouseBrand: false,
        unitSizeRaw: "75 ml",
        baseAmount: 75,
        baseUnit: "ml",
        regularPriceCents: 180,
        currentPriceCents: 180,
        promo: null,
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
    ]);

    const tpRes = await listPost(post("/api/list", { inputs: ["tandpasta"] }));
    const tp1 = ((await tpRes.json()) as { items: ShoppingListItem[] }).items[0];
    // At 1 pack: Picnic (€1,80) beats AH (€2,20 single pack)
    expect(tp1.assignedProvider).toBe("picnic");
    expect(tp1.ahTotalCents).toBe(220);
    expect(tp1.picnicTotalCents).toBe(180);

    // Stepping to 2 packs activates AH "2 voor €3,00" (300c vs Picnic 360c) and switches unlocked store to AH!
    const tp2 = ((await (await itemPatch(patch("/api/list/x", { packCount: 2 }), ctx(tp1.id))).json()) as { item: ShoppingListItem }).item;
    expect(tp2.ahQty).toBe(2);
    expect(tp2.picnicQty).toBe(2);
    expect(tp2.ahTotalCents).toBe(300);
    expect(tp2.picnicTotalCents).toBe(360);
    expect(tp2.assignedProvider).toBe("ah");
    expect(tp2.savingsCents).toBe(140);
  });

  it("dismisses and restores weekdeals, re-optimizes immediately on unlock, auto-checks pushed items, and computes 100%-optimal stats without double counting", async () => {
    // 1. Dismiss & restore weekdeals
    const prefsBefore = await (await dealsGet()).json();
    expect(prefsBefore.weekDeals.length).toBeGreaterThan(0);
    const firstDeal = prefsBefore.weekDeals[0];
    expect(firstDeal.dealKey).toBeTruthy();

    await preferencesPatch(
      patch("/api/preferences", { dismissDealKey: firstDeal.dealKey, dismissDealLabel: firstDeal.title }),
    );
    const prefsAfterDismiss = await (await dealsGet()).json();
    expect(prefsAfterDismiss.weekDeals.some((d: { dealKey?: string }) => d.dealKey === firstDeal.dealKey)).toBe(false);
    expect(prefsAfterDismiss.dismissedDealsCount).toBe(1);
    expect(prefsAfterDismiss.dismissedDeals[0].dealKey).toBe(firstDeal.dealKey);
    await preferencesPatch(patch("/api/preferences", { restoreDealKey: firstDeal.dealKey }));
    expect((await (await dealsGet()).json()).dismissedDealsCount).toBe(0);
    await preferencesPatch(patch("/api/preferences", { dismissDealKey: firstDeal.dealKey, dismissDealLabel: firstDeal.title }));

    await preferencesPatch(patch("/api/preferences", { restoreAllDeals: true }));
    const prefsAfterRestore = await (await dealsGet()).json();
    expect(prefsAfterRestore.dismissedDealsCount).toBe(0);
    expect(prefsAfterRestore.weekDeals.some((d: { dealKey?: string }) => d.dealKey === firstDeal.dealKey)).toBe(true);

    // 2. Clear list cleanly, then add an item where Picnic is cheaper AND a house-brand is even cheaper
    await listDelete(new Request("http://localhost/api/list?all=1", { method: "DELETE" }));
    const statsBaseline = await (await statsGet()).json();
    const baseCount = statsBaseline.lifetime.itemCount as number;

    repo.upsertStoreProducts([
      {
        id: "ah:hagelslag-brand",
        provider: "ah",
        externalId: "hagelslag-brand",
        title: "De Ruijter Chocoladehagelslag puur 400 g",
        brand: "De Ruijter",
        isHouseBrand: false,
        unitSizeRaw: "400 g",
        baseAmount: 400,
        baseUnit: "g",
        regularPriceCents: 350,
        currentPriceCents: 350,
        promo: null,
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
      {
        id: "picnic:hagelslag-brand",
        provider: "picnic",
        externalId: "hagelslag-brand",
        title: "De Ruijter Chocoladehagelslag puur 400 g",
        brand: "De Ruijter",
        isHouseBrand: false,
        unitSizeRaw: "400 g",
        baseAmount: 400,
        baseUnit: "g",
        regularPriceCents: 310,
        currentPriceCents: 310,
        promo: null,
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
      {
        id: "picnic:hagelslag-house",
        provider: "picnic",
        externalId: "hagelslag-house",
        title: "Picnic Chocoladehagelslag puur 400 g",
        brand: "Picnic",
        isHouseBrand: true,
        unitSizeRaw: "400 g",
        baseAmount: 400,
        baseUnit: "g",
        regularPriceCents: 190,
        currentPriceCents: 190,
        promo: null,
        isOnlineOnlyPromo: false,
        imageUrl: null,
        available: true,
      },
    ]);

    const addRes = await listPost(post("/api/list", { inputs: ["chocoladehagelslag puur"] }));
    const hagel = ((await addRes.json()) as { items: ShoppingListItem[] }).items[0];
    expect(hagel.assignedProvider).toBe("picnic");

    // Lock to expensive store (AH €3,50 vs Picnic €1,90), then unlock -> immediately switches back to Picnic without /optimize!
    const lockedAh = ((await (await itemPatch(patch("/api/list/x", { assignedProvider: "ah" }), ctx(hagel.id))).json()) as { item: ShoppingListItem }).item;
    expect(lockedAh.assignedProvider).toBe("ah");
    expect(lockedAh.isProviderLocked).toBe(true);

    const unlocked = ((await (await itemPatch(patch("/api/list/x", { isProviderLocked: false }), ctx(hagel.id))).json()) as { item: ShoppingListItem }).item;
    expect(unlocked.isProviderLocked).toBe(false);
    expect(unlocked.assignedProvider).toBe("picnic");

    // Now choose A-brand De Ruijter on AH (€3,50) while Picnic De Ruijter is €3,10 and Picnic house brand is €1,90
    await itemPatch(
      patch("/api/list/x", { chosenProduct: { provider: "ah", productId: "ah:hagelslag-brand" } }),
      ctx(hagel.id),
    );

    // Push to AH with default autoCheckPushed -> item becomes checked AND recorded in stats
    const pushRes = await (await pushPost(post("/api/list/push", { mode: "push", providers: ["ah"] }))).json();
    expect(pushRes.results).toEqual([{ provider: "ah", success: true, itemsPushed: 1 }]);
    const afterPushItem = repo.getShoppingItem(hagel.id)!;
    expect(afterPushItem.isChecked).toBe(true);
    expect(afterPushItem.recordedInStatsAt).toBeTruthy();

    const statsAfterPush = await (await statsGet()).json();
    expect(statsAfterPush.lifetime.itemCount).toBe(baseCount + 1);

    // Clearing checked items now MUST NOT double-count the already-recorded pushed item!
    await listDelete(new Request("http://localhost/api/list?checked=1", { method: "DELETE" }));
    const statsAfterClear = await (await statsGet()).json();
    expect(statsAfterClear.lifetime.itemCount).toBe(baseCount + 1);
    expect(
      statsAfterClear.lifetime.realizedSavingsCents +
        statsAfterClear.lifetime.missedStoreSavingsCents +
        statsAfterClear.lifetime.missedBrandSavingsCents,
    ).toBe(statsAfterClear.lifetime.optimalSavingsCents);
    // Missed store (€3,50 - €3,10 = €0,40) + missed brand (€3,10 - €1,90 = €1,20) = €1,60 optimal delta
    expect(statsAfterClear.lifetime.optimalSavingsCents - statsAfterClear.lifetime.realizedSavingsCents).toBeGreaterThanOrEqual(160);
  });

  it("searches brand, AI alternatives and local synonyms while filtering and deduplicating results", async () => {
    const base = {
      provider: "ah" as const, brand: "AH", isHouseBrand: true, unitSizeRaw: "400 g",
      baseAmount: 400, baseUnit: "g" as const, regularPriceCents: 200, currentPriceCents: 200,
      promo: null, isOnlineOnlyPromo: false, imageUrl: null, available: true,
    };
    repo.upsertStoreProducts([
      { ...base, id: "ah:nutella-test", externalId: "nutella-test", title: "Nutella hazelnootpasta", brand: "Nutella", isHouseBrand: false },
      { ...base, id: "ah:hazel-test", externalId: "hazel-test", title: "AH hazelnootpasta" },
      { ...base, id: "ah:choco-test", externalId: "choco-test", title: "AH chocoladepasta" },
      { ...base, id: "ah:koek-test", externalId: "koek-test", title: "AH hazelnootpasta koek" },
    ]);

    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const result = name === "search_expansion"
        ? { alternatives: ["hazelnootpasta", "chocoladepasta"] }
        : { exact_ids: ["ah:nutella-test"], alternative_ids: ["ah:hazel-test", "ah:choco-test"] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
    try {
      const response = await listPost(post("/api/list", { inputs: ["Nutella"] }));
      const item = ((await response.json()) as { items: ShoppingListItem[] }).items[0];
      const comparison = (await (await itemGet(new Request("http://localhost/api/list/x"), ctx(item.id))).json()) as ItemComparisonResult;
      const candidates = [comparison.ah.winner, ...comparison.ah.alternatives].filter((c) => c !== null);
      const ids = candidates.map((c) => c.product.id);
      expect(ids).toEqual(expect.arrayContaining(["ah:nutella-test", "ah:hazel-test", "ah:choco-test"]));
      expect(ids).not.toContain("ah:koek-test");
      expect(new Set(ids).size).toBe(ids.length);
      expect(fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).response_format.json_schema.name === "search_expansion")).toHaveLength(1);
    } finally {
      process.env.OPENROUTER_API_KEY = "";
      fetchMock.mockRestore();
    }

    const response = await listPost(post("/api/list", { inputs: ["chocopasta"] }));
    const item = ((await response.json()) as { items: ShoppingListItem[] }).items[0];
    expect(item.ahProduct?.id).toBe("ah:choco-test");
  });

  it("persists cheese matches across days and restarts, refreshes prices, and only classifies new products", async () => {
    const originalAh = h.adapters.ah;
    const originalPicnic = h.adapters.picnic;
    const make = (id: string, title: string, brand: string, category?: string): NormalizedStoreProduct => ({
      id: `ah:${id}`,
      provider: "ah",
      externalId: id,
      title,
      brand,
      isHouseBrand: brand === "AH",
      unitSizeRaw: "150 g",
      baseAmount: 150,
      baseUnit: "g",
      regularPriceCents: 249,
      currentPriceCents: 249,
      promo: null,
      isOnlineOnlyPromo: false,
      imageUrl: null,
      category: category ?? "Kaas",
      available: true,
    });
    const hits = [
      make("parmesan", "AH Parmezaanse kaas flakes", "AH"),
      make("parmigiano", "Galbani Parmigiano Reggiano", "Galbani"),
      make("grana", "AH Grana Padano geraspt", "AH"),
      make("biscuits", "AH Parmezaanse kaas biscuits", "AH", "Borrel, chips, snacks"),
      make("salami", "AH Truffelsalami parmezaanse kaas", "AH", "Borrel, chips, snacks"),
    ];
    const ahSearch = vi.fn(async () => ({ products: hits, isMockFallback: false }));
    h.adapters.ah = { ...originalAh, searchProducts: ahSearch };
    h.adapters.picnic = { ...originalPicnic, searchProducts: async () => ({ products: [], isMockFallback: false }) };
    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { response_format: { json_schema: { name } } } = JSON.parse(String(init?.body));
      const result = name === "search_expansion"
        ? { alternatives: ["Parmigiano Reggiano", "Grana Padano"] }
        : { exact_ids: ["ah:parmesan", "ah:parmigiano"], alternative_ids: ["ah:grana"] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
    const today = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      const added = await listPost(post("/api/list", { inputs: ["Parmezaanse kaas"] }));
      const item = ((await added.json()) as { items: ShoppingListItem[] }).items[0];
      const comparison = (await (await itemGet(new Request("http://localhost/api/list/x"), ctx(item.id))).json()) as ItemComparisonResult;
      const candidates = [comparison.ah.winner, ...comparison.ah.alternatives].filter((c) => c !== null);
      expect(candidates.map((candidate) => candidate.product.id)).toEqual(
        expect.arrayContaining(["ah:parmesan", "ah:parmigiano", "ah:grana"]),
      );
      expect(candidates.find((candidate) => candidate.product.id === "ah:grana")?.matchKind).toBe("alternative");
      expect(candidates.map((candidate) => candidate.product.id)).not.toEqual(
        expect.arrayContaining(["ah:biscuits", "ah:salami"]),
      );
      expect(comparison.ah.otherResults).toEqual([]);
      expect(repo.getCachedConceptMatches("parmezaanse-kaas")?.alternativeProductIds).toContain("ah:grana");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(repo.getCachedConceptMatches("parmezaanse-kaas")?.invalidProductIds).toEqual(
        expect.arrayContaining(["ah:biscuits", "ah:salami"]),
      );

      const searchesToday = ahSearch.mock.calls.length;
      clock.mockReturnValue(today + 24 * 60 * 60 * 1000);
      resetDbConnectionForTests();
      hits[0] = { ...hits[0], currentPriceCents: 199 };
      const tomorrow = await listPost(post("/api/list", { inputs: [" parmezaanse   kaas "] }));
      expect(tomorrow.status).toBe(201);
      expect(ahSearch.mock.calls.length).toBeGreaterThan(searchesToday);
      expect(repo.getStoreProduct("ah:parmesan")?.currentPriceCents).toBe(199);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(repo.getCachedConceptMatches("parmezaanse-kaas")?.alternativeProductIds).toContain("ah:grana");

      hits.push(make("new-parmesan", "AH Parmezaanse kaas biologisch", "AH"));
      resetDbConnectionForTests();
      fetchMock.mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.response_format.json_schema.name).toBe("relevance");
        expect(JSON.parse(body.messages[1].content).producten.map((p: { id: string }) => p.id))
          .toEqual(["ah:new-parmesan"]);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          exact_ids: ["ah:new-parmesan"], alternative_ids: [],
        }) } }] }));
      });
      const withNewProduct = await listPost(post("/api/list", { inputs: ["Parmezaanse kaas"] }));
      expect(withNewProduct.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      process.env.OPENROUTER_API_KEY = "";
      fetchMock.mockRestore();
      h.adapters.ah = originalAh;
      h.adapters.picnic = originalPicnic;
    }
  });

  it("searches without relevance filtering, remembers a manual product and refreshes it after restart", async () => {
    const originalAh = h.adapters.ah;
    const originalPicnic = h.adapters.picnic;
    const ahBerry = fallbackProduct("ah", "berries", "AH Blauwe bessen");
    let picnicBerry = fallbackProduct("picnic", "berries", "Picnic Blueberries bakje");
    const irrelevant = { ...picnicBerry, id: "picnic:yoghurt", externalId: "yoghurt", title: "Picnic Yoghurt blauwe bessen" };
    const search = vi.fn(async ({ query }: { query: string }) => ({
      products: query.toLowerCase().includes("bakje") ? [picnicBerry] : [irrelevant],
      isMockFallback: false,
    }));
    h.adapters.ah = { ...originalAh, searchProducts: async () => ({ products: [ahBerry], isMockFallback: false }) };
    h.adapters.picnic = { ...originalPicnic, searchProducts: search };
    const ids: number[] = [];
    clearSearchCache();
    try {
      const { items: [item] } = await (await listPost(post("/api/list", { inputs: ["blauwe bessen"] }))).json();
      ids.push(item.id);
      expect(item.ahProductId).toBe(ahBerry.id);
      expect(item.picnicProductId).toBeNull();
      const manual = (query: string, provider = "picnic", id = item.id) => manualSearchGet(
        new Request(`http://localhost/api/list/${id}/search?provider=${provider}&query=${encodeURIComponent(query)}`), ctx(id),
      );
      const raw = await (await manual("blauwe bessen")).json();
      expect(raw.source).toBe("live");
      expect(raw.candidates.map((c: { product: NormalizedStoreProduct }) => c.product.id)).toContain(irrelevant.id);
      const found = await (await manual("blueberries bakje")).json();
      expect(found.candidates[0].product.id).toBe(picnicBerry.id);
      const picked = await (await itemPatch(patch("/api/list/x", {
        chosenProduct: { provider: "picnic", productId: picnicBerry.id },
      }), ctx(item.id))).json();
      expect(picked.item.ahProductId).toBe(ahBerry.id);
      expect(picked.item.picnicProductId).toBe(picnicBerry.id);
      picnicBerry = { ...picnicBerry, currentPriceCents: 299 };
      resetDbConnectionForTests();
      const { items: [again] } = await (await listPost(post("/api/list", { inputs: ["blauwe bessen"] }))).json();
      ids.push(again.id);
      expect(again.picnicProductId).toBe(picnicBerry.id);
      expect(again.picnicTotalCents).toBe(299);
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: picnicBerry.title }));
      expect((await manual("x")).status).toBe(400);
      expect((await manual("bessen", "jumbo")).status).toBe(400);
      expect((await manual("bessen", "picnic", 999999)).status).toBe(404);
      const unavailable = { ...picnicBerry, id: "picnic:unavailable", externalId: "unavailable", available: false };
      repo.upsertStoreProducts([unavailable]);
      expect((await itemPatch(patch("/api/list/x", {
        chosenProduct: { provider: "picnic", productId: unavailable.id },
      }), ctx(item.id))).status).toBe(400);
    } finally {
      for (const id of ids) repo.deleteShoppingItem(id);
      h.adapters.ah = originalAh;
      h.adapters.picnic = originalPicnic;
      clearSearchCache();
    }
  });

  it("labels cached manual search results and retains unresolved rows without pricing or pushing them", async () => {
    const original = h.adapters.picnic;
    const item = repo.insertShoppingItem({ rawInput: "fallback bessen", displayName: "Fallback bessen" });
    const template = fallbackProduct("picnic", "fallback", "Fallback bessen");
    const ahBerry = fallbackProduct("ah", "fallback-berries", "Fallback bessen");
    repo.upsertStoreProducts([template, ahBerry]);
    h.adapters.picnic = { ...original, searchProducts: async () => { throw new Error("offline"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await manualSearchGet(
        new Request(`http://localhost/api/list/${item.id}/search?provider=picnic&query=fallback`), ctx(item.id),
      );
      const cached = await response.json();
      expect(cached.source).toBe("cached");
      expect(cached.message).toContain("verouderd");
      expect(cached.candidates[0].product.id).toBe("picnic:fallback");
      const missing = await (await manualSearchGet(
        new Request(`http://localhost/api/list/${item.id}/search?provider=picnic&query=zzgeenresultatenzz`), ctx(item.id),
      )).json();
      expect(missing.source).toBe("unavailable");
      expect(missing.candidates).toEqual([]);
      repo.updateShoppingItem(item.id, {
        ahProductId: ahBerry.id, ahTotalCents: 249, ahQty: 1,
        picnicProductId: template.id, picnicTotalCents: 299, picnicQty: 1, assignedProvider: "ah",
      });
      expect((await itemPatch(patch("/api/list/x", {
        keepUnmatched: true, chosenProduct: { provider: "picnic", productId: template.id },
      }), ctx(item.id))).status).toBe(400);
      const saved = await (await itemPatch(patch("/api/list/x", { keepUnmatched: true }), ctx(item.id))).json();
      expect(saved.item).toMatchObject({
        assignedProvider: null, ahProductId: null, picnicProductId: null,
        ahTotalCents: null, picnicTotalCents: null, requestedQty: 1,
      });
      resetDbConnectionForTests();
      await optimizePost(post("/api/list/optimize", { forceMode: "optimal" }));
      const list = await (await listGet()).json();
      expect(list.items.find((i: ShoppingListItem) => i.id === item.id).assignedProvider).toBeNull();
      const preview = await (await pushPost(post("/api/list/push", { mode: "preview" }))).json();
      expect(preview.skippedItems).toContainEqual({ itemId: item.id, title: item.displayName, reason: "Nog product kiezen" });
      expect(preview.previews.flatMap((p: { items: { itemId: number }[] }) => p.items).some(
        (i: { itemId: number }) => i.itemId === item.id,
      )).toBe(false);
    } finally {
      repo.deleteShoppingItem(item.id);
      h.adapters.picnic = original;
      warn.mockRestore();
      clearSearchCache();
    }
  });

  it("persists a selected AI model, uses it for AI requests, and rejects models outside the shortlist", async () => {
    const model = "mistralai/mistral-small-3.2-24b-instruct";
    const invalid = await preferencesPatch(patch("/api/preferences", { aiModel: "not-a-model" }));
    expect(invalid.status).toBe(400);

    const saved = await preferencesPatch(patch("/api/preferences", { aiModel: model }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.aiModel).toBe(model);
    resetDbConnectionForTests();
    expect((await (await preferencesGet()).json()).settings.aiModel).toBe(model);

    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ alternatives: [] }) } }] })),
    );
    try {
      await expandSearchQueries("een uniek product voor modelkeuze");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe(model);
    } finally {
      process.env.OPENROUTER_API_KEY = "";
      fetchMock.mockRestore();
    }
  });

  it("persists a selected AI backup model and uses it when the primary fails", async () => {
    const primary = "google/gemini-2.5-flash-lite";
    const backup = "openai/gpt-4.1-nano";
    const invalid = await preferencesPatch(patch("/api/preferences", { aiFallbackModel: "not-a-model" }));
    expect(invalid.status).toBe(400);

    const saved = await preferencesPatch(patch("/api/preferences", { aiModel: primary, aiFallbackModel: backup }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.aiFallbackModel).toBe(backup);
    resetDbConnectionForTests();
    expect((await (await preferencesGet()).json()).settings.aiFallbackModel).toBe(backup);

    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ alternatives: ["reserveproduct"] }) } }],
      })));
    try {
      const result = await expandSearchQueries("een uniek product voor reservemodelkeuze");
      expect(result.alternatives).toContain("reserveproduct");
      expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).model)).toEqual([primary, backup]);
    } finally {
      process.env.OPENROUTER_API_KEY = "";
      fetchMock.mockRestore();
    }
  });

  it.each(["", "google/gemini-2.5-flash-lite"])("does not retry when the backup is disabled or matches the primary (%s)", async (backup) => {
    const primary = "google/gemini-2.5-flash-lite";
    const saved = await preferencesPatch(patch("/api/preferences", { aiModel: primary, aiFallbackModel: backup }));
    expect(saved.status).toBe(200);
    resetDbConnectionForTests();
    expect((await (await preferencesGet()).json()).settings.aiFallbackModel).toBe(backup);

    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unavailable", { status: 503 }));
    try {
      await expandSearchQueries(`uniek product zonder extra poging ${backup || "uitgeschakeld"}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe(primary);
    } finally {
      process.env.OPENROUTER_API_KEY = "";
      fetchMock.mockRestore();
    }
  });
});
