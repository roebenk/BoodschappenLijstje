import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbConnectionForTests } from "@/lib/db";
import * as repo from "@/lib/db/repositories";
import { AlbertHeijnAdapter, parseSalesUnitSize, resetAhAuthCacheForTests } from "@/lib/providers/ah";

const ROOT = path.join(process.cwd(), ".test-data-ah");
const realCwd = process.cwd();
let dir: string;

type Handler = (url: string, init: RequestInit, body: any) => unknown | Response;
let calls: Array<{ url: string; method: string; body: any; auth?: string }>;
let handlers: Handler[];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function mockFetch(...hs: Handler[]) {
  handlers = hs;
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", body, auth: headers?.Authorization });
      for (const h of handlers) {
        const r = h(url, init, body);
        if (r !== undefined) return r instanceof Response ? r : json(r);
      }
      return json({ message: "unhandled" }, 404);
    }),
  );
}

const anonHandler: Handler = (url) =>
  url.endsWith("/auth/token/anonymous") ? { access_token: "anon-1", refresh_token: "r", expires_in: 604798 } : undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDbConnectionForTests();
  resetAhAuthCacheForTests();
  fs.mkdirSync(ROOT, { recursive: true });
  dir = fs.mkdtempSync(path.join(ROOT, "t-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.DATA_DIR = path.join(dir, "data");
});

afterAll(() => {
  resetDbConnectionForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(path.join(realCwd, ".test-data-ah"), { recursive: true, force: true });
});

function linkAccount(expiresAt = Date.now() + 3_600_000) {
  repo.saveStoreAccount("ah", {
    tokens: { accessToken: "user-1", refreshToken: "rt-1", expiresAt, isUserToken: true },
    status: "authenticated",
  });
}

const rawProduct = (over: Record<string, unknown>) => ({
  webshopId: 100,
  title: "Testproduct",
  brand: "Merk",
  salesUnitSize: "1 kg",
  priceBeforeBonus: 2.0,
  currentPrice: null,
  isBonus: false,
  ...over,
});

describe("pack sizes", () => {
  it.each([
    ["1 kg", 1000, "g"],
    ["500 g", 500, "g"],
    ["1,5 l", 1500, "ml"],
    ["6 x 330 ml", 1980, "ml"],
    ["75 cl", 750, "ml"],
    ["4 stuks", 4, "piece"],
    ["per stuk", 1, "piece"],
  ])("%s", (raw, baseAmount, baseUnit) => {
    expect(parseSalesUnitSize(raw)).toEqual({ baseAmount, baseUnit });
  });
});

describe("auth", () => {
  it("fetches an anonymous token once and caches it, sending Appie headers", async () => {
    mockFetch(anonHandler, (url) => (url.includes("product/search/v2") ? { products: [] } : undefined));
    const ah = new AlbertHeijnAdapter();
    await ah.searchProducts({ query: "melk" });
    await ah.searchProducts({ query: "kaas" });
    const tokenCalls = calls.filter((c) => c.url.endsWith("/token/anonymous"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toEqual({ clientId: "appie-ios" });
    const searches = calls.filter((c) => c.url.includes("product/search/v2"));
    expect(searches[0].auth).toBe("Bearer anon-1");
    const init = (fetch as any).mock.calls[0][1];
    expect(init.headers["User-Agent"]).toBe("Appie/9.28 (iPhone; iOS 18.0; Scale/3.00)");
    expect(init.headers["x-application"]).toBe("AHWEBSHOP");
  });

  it("returns login url, exchanges a pasted appie:// URL and stores encrypted tokens", async () => {
    mockFetch((url, _i, body) =>
      url.endsWith("/mobile-auth/v1/auth/token") && body.code === "abc123"
        ? { access_token: "u-acc", refresh_token: "u-ref", expires_in: 900 }
        : undefined,
    );
    const ah = new AlbertHeijnAdapter();
    const login = await ah.authenticate({ step: "get_login_url" });
    expect(login.loginUrl).toContain("login.ah.nl/login?client_id=appie-ios");
    expect(login.state.message).toBeTruthy();

    const res = await ah.authenticate({ step: "exchange_code", codeOrUrl: "appie://login-exit?code=abc123" });
    expect(res.state.status).toBe("authenticated");
    expect(repo.getStoreTokens<any>("ah")).toMatchObject({ accessToken: "u-acc", refreshToken: "u-ref" });
    const raw = getDb().prepare("SELECT encrypted_tokens FROM store_accounts WHERE provider='ah'").get() as any;
    expect(String(raw.encrypted_tokens)).not.toContain("u-acc");

    await ah.authenticate({ step: "exchange_code", codeOrUrl: "abc123" });
    expect(calls.filter((c) => c.body?.code === "abc123")).toHaveLength(2);

    const out = await ah.authenticate({ step: "logout" });
    expect(out.state.status).toBe("anonymous");
    expect(repo.getStoreAccount("ah")).toBeNull();
  });

  it("rotates the single-use refresh token only once under concurrent calls", async () => {
    linkAccount(Date.now() + 10_000);
    mockFetch((url) =>
      url.endsWith("/auth/token/refresh") ? { access_token: "user-2", refresh_token: "rt-2", expires_in: 900 } : undefined,
    (url) => (url.includes("product/search/v2") ? { products: [] } : undefined));
    const ah = new AlbertHeijnAdapter();
    await Promise.all([1, 2, 3].map((n) => ah.searchProducts({ query: `q${n}` })));
    const refreshes = calls.filter((c) => c.url.endsWith("/auth/token/refresh"));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].body).toEqual({ clientId: "appie-ios", refreshToken: "rt-1" });
    expect(calls.filter((c) => c.url.includes("search/v2")).every((c) => c.auth === "Bearer user-2")).toBe(true);
    expect(repo.getStoreTokens<any>("ah")).toMatchObject({ accessToken: "user-2", refreshToken: "rt-2" });
  });

  it("marks the session as expired when refresh is rejected and falls back to anonymous", async () => {
    linkAccount(Date.now() - 1000);
    mockFetch(
      anonHandler,
      (url) => (url.endsWith("/auth/token/refresh") ? json({ message: "bad" }, 400) : undefined),
      (url) => (url.includes("product/search/v2") ? { products: [rawProduct({})] } : undefined),
    );
    const ah = new AlbertHeijnAdapter();
    const res = await ah.searchProducts({ query: "x" });
    expect(res.products).toHaveLength(1);
    const state = await ah.getAuthState();
    expect(state.status).toBe("error");
    expect(state.message).toBe("Sessie verlopen — koppel Albert Heijn opnieuw");
    await expect(ah.syncHistory()).rejects.toThrow(/Sessie verlopen/);
  });
});

describe("search normalization", () => {
  it("maps bonus mechanisms, house brands and cents", async () => {
    mockFetch(anonHandler, (url) =>
      url.includes("product/search/v2")
        ? {
            products: [
              rawProduct({ webshopId: 1, title: "AH Magere kwark", brand: "AH", isBonus: true, currentPrice: 1.0, priceBeforeBonus: 2.0, bonusMechanism: "1+1 gratis" }),
              rawProduct({ webshopId: 2, title: "Cola", brand: "Coca-Cola", salesUnitSize: "6 x 330 ml", isBonus: true, currentPrice: 1.75, priceBeforeBonus: 3.5, bonusMechanism: "2 voor 3.50" }),
              rawProduct({ webshopId: 3, title: "Pasta", brand: "Barilla", isBonus: true, currentPrice: 1.1, priceBeforeBonus: 2.2, discountLabels: [{ code: "DISCOUNT_ONE_HALF_PRICE", defaultDescription: "2e halve prijs" }] }),
              rawProduct({ webshopId: 4, title: "AH Terra Hummus", brand: "AH Terra", priceBeforeBonus: 1.99 }),
              rawProduct({ webshopId: 5, title: "AH Excellent kaas", brand: null, priceBeforeBonus: 4.19 }),
              rawProduct({ webshopId: 6, title: "Pakket", isVirtualBundle: true }),
            ],
          }
        : undefined,
    );
    const ah = new AlbertHeijnAdapter();
    const { products, isMockFallback } = await ah.searchProducts({ query: "x", limit: 10 });
    expect(isMockFallback).toBe(false);
    expect(products.map((p) => p.id)).toEqual(["ah:1", "ah:2", "ah:3", "ah:4", "ah:5"]);
    const [kwark, cola, pasta, terra, excellent] = products;
    expect(kwark).toMatchObject({ isHouseBrand: true, regularPriceCents: 200, baseAmount: 1000, baseUnit: "g" });
    expect(kwark.promo).toMatchObject({ type: "bogo", buyQty: 1, freeQty: 1 });
    expect(cola.promo).toMatchObject({ type: "x_for_y", bundleQty: 2, bundlePriceCents: 350 });
    expect(cola).toMatchObject({ baseAmount: 1980, baseUnit: "ml", isHouseBrand: false });
    expect(pasta.promo?.type).toBe("second_half_price");
    expect(terra.isHouseBrand).toBe(true);
    expect(excellent.isHouseBrand).toBe(true);
    expect(terra.promo).toBeNull();
    expect(repo.getStoreProduct("ah:2")?.promo?.bundlePriceCents).toBe(350);
  });

  it("ignores AHONLINE promos in store but flags personal bonus", async () => {
    mockFetch(anonHandler, (url) =>
      url.includes("product/search/v2")
        ? {
            products: [
              rawProduct({ webshopId: 7, isBonus: true, currentPrice: 1.5, priceBeforeBonus: 2.5, promotionType: "AHONLINE", bonusMechanism: "25% korting" }),
              rawProduct({ webshopId: 8, isBonus: true, currentPrice: 1.5, priceBeforeBonus: 2.0, promotionType: "PERSONAL", bonusMechanism: "25% korting" }),
            ],
          }
        : undefined,
    );
    const { products } = await new AlbertHeijnAdapter().searchProducts({ query: "x" });
    expect(products[0]).toMatchObject({ isOnlineOnlyPromo: true, currentPriceCents: 250, regularPriceCents: 250 });
    expect(products[0].promo?.type).toBe("percentage");
    expect(products[1]).toMatchObject({ isOnlineOnlyPromo: false, currentPriceCents: 150 });
    expect(products[1].promo?.isPersonalBonus).toBe(true);
  });

  it("falls back to the offline catalog when the network is blocked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const res = await new AlbertHeijnAdapter().searchProducts({ query: "magere kwark" });
    expect(res.isMockFallback).toBe(true);
    expect(res.products[0].title).toMatch(/kwark/i);
    expect(res.products[0].isMockFallback).toBe(true);
  });
});

describe("receipt history sync", () => {
  it("maps POS ids to webshop ids into purchase_history and preferences, incrementally", async () => {
    linkAccount();
    const receipts = {
      r1: { id: "r1", dateTime: "2026-10-01T10:00:00Z", products: [{ id: 767898, quantity: 2, name: "AH KWARK", amount: { amount: 2.58 } }, { id: 555, quantity: 1, name: "ONBEKEND", amount: { amount: 1 } }] },
      r2: { id: "r2", dateTime: "2026-10-08T10:00:00Z", products: [{ id: 767898, quantity: 1, name: "AH KWARK", amount: { amount: 1.29 } }] },
    };
    const handler: Handler = (url, _i, body) => {
      if (!url.endsWith("/graphql")) {
        if (url.includes("search/v2/products?")) return [rawProduct({ webshopId: 33693, title: "AH Magere kwark", brand: "AH" })];
        return undefined;
      }
      const q: string = body.query;
      if (q.includes("posReceiptsPage")) {
        return { data: { posReceiptsPage: { posReceipts: [receipts.r1, receipts.r2].map(({ id, dateTime }) => ({ id, dateTime })) } } };
      }
      if (q.includes("posReceiptDetails")) return { data: { posReceiptDetails: receipts[body.variables.id as "r1" | "r2"] } };
      if (q.includes("productConvertId")) return { data: { p0: 33693, p1: -1 } };
      return undefined;
    };
    mockFetch(handler);
    const ah = new AlbertHeijnAdapter();
    const res = await ah.syncHistory();
    expect(res).toMatchObject({ provider: "ah", receiptsOrOrdersSynced: 2, itemsSynced: 3, productsMapped: 1 });
    const convert = calls.find((c) => c.body?.query?.includes("productConvertId"))!;
    expect(convert.body.query).toContain("p0: productConvertId(sourceId: 767898)");
    expect(repo.getStoreProduct("ah:33693")).toMatchObject({ posId: 767898, title: "AH Magere kwark" });
    const rows = repo.listPurchaseHistory();
    expect(rows.filter((r) => r.storeProductId === "ah:33693")).toHaveLength(2);
    expect(rows.find((r) => r.rawName === "ONBEKEND")?.storeProductId).toBeNull();
    expect(repo.getProductPreference("ah:33693")?.timesBought).toBe(2);
    expect(repo.getStoreAccount("ah")?.lastSyncedAt).toBeTruthy();

    // Second run skips known receipts: no detail calls.
    mockFetch(handler);
    const again = await ah.syncHistory();
    expect(again.receiptsOrOrdersSynced).toBe(0);
    expect(calls.some((c) => c.body?.query?.includes("posReceiptDetails"))).toBe(false);
  });

  it("requires a linked account", async () => {
    mockFetch(anonHandler);
    await expect(new AlbertHeijnAdapter().syncHistory()).rejects.toThrow(/Koppel/);
  });
});

describe("push to Boodschappenlijst", () => {
  it("uses GraphQL basketItemsAdd", async () => {
    linkAccount();
    mockFetch((url) => (url.endsWith("/graphql") ? { data: { basketItemsAdd: { status: "SUCCESS" } } } : undefined));
    const res = await new AlbertHeijnAdapter().pushItems([{ externalId: "33693", title: "AH Magere kwark", quantity: 4 }]);
    expect(res).toMatchObject({ success: true, itemsPushed: 1 });
    expect(calls[0].body.variables.items).toEqual([{ productId: 33693, quantity: 4 }]);
    expect(calls[0].auth).toBe("Bearer user-1");
  });

  it("falls back to the REST v2 PATCH when GraphQL fails", async () => {
    linkAccount();
    mockFetch(
      (url) => (url.endsWith("/graphql") ? { errors: [{ message: "Subgraph errors redacted" }], data: null } : undefined),
      (url) => (url.includes("shoppinglist/v2/items") ? { items: [] } : undefined),
    );
    const res = await new AlbertHeijnAdapter().pushItems([{ externalId: "33693", title: "AH Magere kwark", quantity: 2 }]);
    expect(res.success).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("orderBy=userInput&orderByParam=0");
    expect(patch.body.items[0]).toEqual({
      productId: 33693,
      quantity: 2,
      type: "SHOPPABLE",
      originCode: "PRD",
      description: "AH Magere kwark",
      strikeThrough: false,
    });
  });
});
