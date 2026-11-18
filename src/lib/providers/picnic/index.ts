import { lookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import PicnicClient from "picnic-api";
import { getRuntimeConfig } from "@/lib/config";
import {
  deleteStoreAccount,
  getStoreAccount,
  getStoreProduct,
  getStoreTokens,
  insertPurchaseHistory,
  listPurchaseHistory,
  recomputeProductPreferences,
  saveStoreAccount,
  upsertStoreProducts,
} from "@/lib/db/repositories";
import type {
  AdapterCapabilities,
  AuthFlowInput,
  AuthFlowResult,
  NormalizedStoreProduct,
  PushItemInput,
  PushListResult,
  SearchOptions,
  SearchResponse,
  StoreAuthState,
  SupermarketAdapter,
  SyncHistoryResult,
} from "@/lib/types";
import { normalizePicnicTile, parsePromoLabel, parseUnitQuantity, picnicImageUrl, promoFromPriceRanges, isPicnicHouseBrand } from "./parse";
import { SANDBOX_SOURCE_NOTE, searchSandboxCatalog } from "./sandbox";

interface PicnicTokens {
  authKey: string;
  email: string;
  pending2fa?: boolean;
}

interface PicnicPageClient {
  getClientChunk(chunkId: string): Promise<string>;
  findServerActionId(page: unknown, modulePath: string, actionName: string): Promise<string | null>;
}

const MAX_HISTORY_DELIVERIES = 25;
const PICNIC_FETCH_MARKER = Symbol.for("boodschappenlijstje.picnic-ipv4-fetch");

type FetchGlobal = typeof globalThis & { [PICNIC_FETCH_MARKER]?: boolean };

async function requestBody(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError(`Picnic request body type ${body.constructor.name} is niet ondersteund`);
}

async function picnicIpv4Fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = await requestBody(init?.body ?? (input instanceof Request ? input.body : undefined));
  if (body) headers.set("content-length", String(body.length));

  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        headers: Object.fromEntries(headers),
        timeout: 12_000,
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            const ipv4 = addresses.filter((address) => address.family === 4);
            if (ipv4.length === 0) return callback(new Error(`Geen IPv4-adres voor ${hostname}`), "", 4);
            const selected = ipv4[Math.floor(Math.random() * ipv4.length)]!;
            callback(null, options.all ? [{ address: selected.address, family: 4 }] : selected.address as never, 4);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
            else if (value != null) responseHeaders.set(name, value);
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode ?? 500,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }));
        });
      },
    );
    const abort = () => req.destroy(new DOMException("The operation was aborted", "AbortError"));
    init?.signal?.addEventListener("abort", abort, { once: true });
    req.on("timeout", () => req.destroy(new Error("Picnic HTTPS timeout")));
    req.on("error", reject);
    req.on("close", () => init?.signal?.removeEventListener("abort", abort));
    if (body) req.write(body);
    req.end();
  });
}

function installPicnicIpv4Fetch(): void {
  const fetchGlobal = globalThis as FetchGlobal;
  if (fetchGlobal[PICNIC_FETCH_MARKER]) return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    return url.hostname.endsWith("picnicinternational.com")
      ? picnicIpv4Fetch(input, init)
      : originalFetch(input, init);
  }) as typeof fetch;
  fetchGlobal[PICNIC_FETCH_MARKER] = true;
}

installPicnicIpv4Fetch();

export class PicnicAdapter implements SupermarketAdapter {
  readonly id = "picnic" as const;
  readonly displayName = "Picnic";
  readonly channel = "delivery" as const;
  private cachedAuthKey: string | null = null;
  private cachedClient: PicnicClient | null = null;

  get capabilities(): AdapterCapabilities {
    return {
      search: true,
      promotions: true,
      historySync: true,
      listPush: true,
      minOrderCents: getRuntimeConfig().picnicMinOrderCents,
    };
  }

  private newClient(authKey?: string): PicnicClient {
    const client = new PicnicClient({ countryCode: getRuntimeConfig().picnicCountryCode, ...(authKey ? { authKey } : {}) });
    if (authKey) this.configureActionLookup(client);
    return client;
  }

  private configureActionLookup(client: PicnicClient): void {
    const pages = (client.catalog as unknown as { pages?: PicnicPageClient }).pages;
    if (!pages) return;

    const resolved = new Map<string, string | null>();
    pages.findServerActionId = async (page, modulePath, actionName) => {
      const refs = Object.values(
        ((page as { modules?: Record<string, unknown> }).modules ?? {}),
      );
      const chunks = refs.flatMap((ref) => {
        if (!Array.isArray(ref) || typeof ref[0] !== "string" || !ref[0].endsWith(modulePath)) return [];
        return Array.isArray(ref[1]) ? ref[1].filter((chunk): chunk is string => typeof chunk === "string") : [];
      }).filter((chunk) => !chunk.startsWith("client-components.") && !chunk.startsWith("shared-node_modules_"));
      const unique = [...new Set(chunks)];
      const moduleChunk = modulePath.replace(/\.[^.]+$/, "").replaceAll("/", "_");
      unique.sort((a, b) => Number(b.includes(moduleChunk)) - Number(a.includes(moduleChunk)));

      const lookupKey = `${modulePath}#${actionName}#${unique.join(",")}`;
      if (resolved.has(lookupKey)) return resolved.get(lookupKey) ?? null;
      const pattern = new RegExp(`act_${actionName}_[0-9a-f]+`);
      for (const chunk of unique) {
        const id = pattern.exec(await pages.getClientChunk(chunk))?.[0] ?? null;
        if (id) {
          resolved.set(lookupKey, id);
          return id;
        }
      }
      resolved.set(lookupKey, null);
      return null;
    };
  }

  private clientFor(authKey: string): PicnicClient {
    if (!this.cachedClient || this.cachedAuthKey !== authKey) {
      this.cachedClient = this.newClient(authKey);
      this.cachedAuthKey = authKey;
    }
    return this.cachedClient;
  }

  private requireClient(): PicnicClient {
    const account = getStoreAccount("picnic");
    const tokens = getStoreTokens<PicnicTokens>("picnic");
    if (account?.status !== "authenticated" || !tokens?.authKey || tokens.pending2fa) {
      throw new Error("Picnic is niet gekoppeld");
    }
    return this.clientFor(tokens.authKey);
  }

  async getAuthState(): Promise<StoreAuthState> {
    const account = getStoreAccount("picnic");
    if (!account) {
      return {
        provider: "picnic",
        status: "disconnected",
        isMockFallback: true,
        message: "Picnic voorbeeldcatalogus actief tot je Picnic koppelt",
      };
    }
    const email = typeof account.meta.email === "string" ? account.meta.email : null;
    return {
      provider: "picnic",
      status: account.status,
      displayName: email,
      lastSyncedAt: account.lastSyncedAt,
      isMockFallback: account.status !== "authenticated",
      message: account.status === "awaiting_2fa" ? "SMS-code verstuurd naar je telefoon" : null,
    };
  }

  async authenticate(input: AuthFlowInput): Promise<AuthFlowResult> {
    switch (input.step) {
      case "login": {
        const client = this.newClient();
        const result = await client.auth.login(input.email, input.password);
        const authKey = result.authKey || client.authKey || "";
        if (result.secondFactorAuthenticationRequired) {
          const pendingClient = this.newClient(authKey);
          await pendingClient.auth.generate2FACode("SMS");
          saveStoreAccount("picnic", {
            tokens: { authKey, email: input.email, pending2fa: true } satisfies PicnicTokens,
            status: "awaiting_2fa",
            meta: { email: input.email },
          });
          return {
            state: { provider: "picnic", status: "awaiting_2fa", displayName: input.email, message: "SMS-code verstuurd naar je telefoon" },
            requires2fa: true,
          };
        }
        saveStoreAccount("picnic", {
          tokens: { authKey, email: input.email } satisfies PicnicTokens,
          status: "authenticated",
          meta: { email: input.email },
        });
        return { state: await this.getAuthState() };
      }
      case "verify_2fa": {
        const tokens = getStoreTokens<PicnicTokens>("picnic");
        if (!tokens?.authKey || !tokens.pending2fa) throw new Error("Geen Picnic 2FA-verificatie in behandeling");
        const client = this.newClient(tokens.authKey);
        const verified = await client.auth.verify2FACode(input.code.trim());
        saveStoreAccount("picnic", {
          tokens: { authKey: verified.authKey || client.authKey || tokens.authKey, email: tokens.email } satisfies PicnicTokens,
          status: "authenticated",
          meta: { email: tokens.email },
        });
        return { state: await this.getAuthState() };
      }
      case "logout": {
        this.cachedClient = null;
        this.cachedAuthKey = null;
        deleteStoreAccount("picnic");
        return {
          state: {
            provider: "picnic",
            status: "disconnected",
            isMockFallback: true,
            message: "Picnic ontkoppeld; voorbeeldcatalogus actief tot je opnieuw koppelt",
          },
        };
      }
      default:
        throw new Error(`Stap '${input.step}' wordt niet ondersteund door Picnic`);
    }
  }

  async searchProducts({ query, limit = 40 }: SearchOptions): Promise<SearchResponse> {
    const account = getStoreAccount("picnic");
    if (account?.status !== "authenticated") return this.sandboxSearch(query, limit);

    let client: PicnicClient;
    try {
      client = this.requireClient();
    } catch {
      return this.sandboxSearch(query, limit);
    }

    let results;
    try {
      results = await client.catalog.getSearchResults(query);
    } catch (error) {
      if ((error as { status?: number })?.status === 401) {
        saveStoreAccount("picnic", { status: "error" });
        return this.sandboxSearch(query, limit);
      }
      throw error;
    }

    const byId = new Map<string, NormalizedStoreProduct>();
    for (const section of results.products?.sections ?? []) {
      const reorder = section.id === "RFY";
      for (const tile of section.products) {
        const existing = byId.get(tile.id);
        if (existing) {
          if (reorder) existing.previouslyBought = true;
          continue;
        }
        byId.set(tile.id, normalizePicnicTile(tile, { previouslyBought: reorder }));
      }
    }
    const all = [...byId.values()];
    const products =
      all.length <= limit
        ? all
        : [
            ...all.filter((p) => p.previouslyBought || p.isHouseBrand),
            ...all.filter((p) => !p.previouslyBought && !p.isHouseBrand),
          ].slice(0, limit);
    upsertStoreProducts(products);
    return { products, isMockFallback: false };
  }

  private sandboxSearch(query: string, limit: number): SearchResponse {
    return { products: searchSandboxCatalog(query, limit), isMockFallback: true, sourceNote: SANDBOX_SOURCE_NOTE };
  }

  async getPromotions() {
    const client = this.requireClient();
    const promos = await client.catalog.getPromotions();
    const deals = [];
    for (const section of promos.sections) {
      for (const tile of section.products) {
        const product = normalizePicnicTile(tile);
        deals.push({
          provider: "picnic" as const,
          title: product.title,
          priceCents: product.currentPriceCents,
          regularPriceCents: product.regularPriceCents,
          promoLabel: product.promo?.label ?? "Aanbieding",
          imageUrl: product.imageUrl,
        });
      }
    }
    return deals;
  }

  async syncHistory(): Promise<SyncHistoryResult> {
    const client = this.requireClient();
    const known = new Set(
      listPurchaseHistory(100000)
        .filter((h) => h.provider === "picnic")
        .map((h) => h.txId),
    );
    const summaries = await client.delivery.getDeliverySummaries(["COMPLETED"]);
    const fresh = summaries
      .filter((s) => !known.has(s.id))
      .sort((a, b) => b.creationTime.localeCompare(a.creationTime))
      .slice(0, MAX_HISTORY_DELIVERIES);

    let itemsSynced = 0;
    const productIds = new Set<string>();
    for (const summary of fresh) {
      const delivery = await client.delivery.getDelivery(summary.id);
      const purchasedAt = delivery.windowStart ?? delivery.creationTime ?? summary.creationTime;
      const products: NormalizedStoreProduct[] = [];
      const rows = [];
      for (const order of delivery.orders) {
        for (const line of order.items) {
          const storeProductId = `picnic:${line.productId}`;
          if (!getStoreProduct(storeProductId)) {
            const unit = parseUnitQuantity(line.unitQuantity);
            const houseBrand = isPicnicHouseBrand(null, line.name);
            products.push({
              id: storeProductId,
              provider: "picnic",
              externalId: line.productId,
              title: line.name,
              brand: houseBrand ? "Picnic" : null,
              isHouseBrand: houseBrand,
              unitSizeRaw: line.unitQuantity,
              baseAmount: unit.baseAmount,
              baseUnit: unit.baseUnit,
              regularPriceCents: Math.round((line.originalPrice ?? line.displayPrice) / Math.max(line.quantity, 1)),
              currentPriceCents: Math.round(line.displayPrice / Math.max(line.quantity, 1)),
              promo: promoFromPriceRanges(line.priceRanges, line.displayPrice) ?? parsePromoLabel(line.labels?.[0]?.text),
              isOnlineOnlyPromo: false,
              imageUrl: picnicImageUrl(line.imageId),
              available: true,
              updatedAt: new Date().toISOString(),
            });
          }
          productIds.add(storeProductId);
          rows.push({
            provider: "picnic" as const,
            txId: summary.id,
            purchasedAt,
            storeProductId,
            rawName: line.name,
            quantity: line.quantity,
            totalCents: line.displayPrice,
          });
        }
      }
      upsertStoreProducts(products);
      itemsSynced += insertPurchaseHistory(rows);
    }

    recomputeProductPreferences();
    const syncedAt = new Date().toISOString();
    saveStoreAccount("picnic", { status: "authenticated", lastSyncedAt: syncedAt });
    return {
      provider: "picnic",
      receiptsOrOrdersSynced: fresh.length,
      itemsSynced,
      productsMapped: productIds.size,
      syncedAt,
    };
  }

  async pushItems(items: PushItemInput[]): Promise<PushListResult> {
    const client = this.requireClient();
    let itemsPushed = 0;
    let cartTotalCents: number | undefined;
    const failed: string[] = [];
    for (const item of items) {
      const externalId = item.externalId.replace(/^picnic:/, "");
      try {
        const cart = await client.cart.addProductToCart(externalId, Math.max(1, Math.round(item.quantity)));
        cartTotalCents = cart.totalPrice;
        itemsPushed += 1;
      } catch {
        failed.push(item.title);
      }
    }
    return {
      provider: "picnic",
      success: failed.length === 0,
      itemsPushed,
      cartTotalCents,
      message: failed.length ? `Niet gelukt: ${failed.join(", ")}` : undefined,
    };
  }
}
