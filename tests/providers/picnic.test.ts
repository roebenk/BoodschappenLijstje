import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbConnectionForTests } from "@/lib/db";
import {
  getProductPreference,
  getStoreAccount,
  getStoreProduct,
  getStoreTokens,
  listPurchaseHistory,
} from "@/lib/db/repositories";

const mocks = vi.hoisted(() => ({
  ctor: [] as Array<Record<string, unknown> | undefined>,
  login: vi.fn(),
  generate2FACode: vi.fn(),
  verify2FACode: vi.fn(),
  getSearchResults: vi.fn(),
  getDeliverySummaries: vi.fn(),
  getDelivery: vi.fn(),
  addProductToCart: vi.fn(),
}));

vi.mock("picnic-api", () => ({
  default: class FakePicnicClient {
    authKey: string | null;
    auth = { login: mocks.login, generate2FACode: mocks.generate2FACode, verify2FACode: mocks.verify2FACode };
    catalog = { getSearchResults: mocks.getSearchResults, getPromotions: vi.fn() };
    delivery = { getDeliverySummaries: mocks.getDeliverySummaries, getDelivery: mocks.getDelivery };
    cart = { addProductToCart: mocks.addProductToCart };
    constructor(options?: Record<string, unknown>) {
      mocks.ctor.push(options);
      this.authKey = (options?.authKey as string) ?? null;
    }
  },
}));

import { PicnicAdapter } from "@/lib/providers/picnic";
import { cleanPicnicUnitSize, formatPicnicTitle, normalizePicnicTile, parsePromoLabel, parseUnitQuantity } from "@/lib/providers/picnic/parse";
import { JumboRadarAdapter, PlusRadarAdapter, parseCheckjebon } from "@/lib/providers/radar";

const ROOT = path.join(process.cwd(), ".test-data-picnic");
const realCwd = process.cwd();

beforeEach(() => {
  vi.restoreAllMocks();
  for (const m of Object.values(mocks)) if (typeof m === "function") m.mockReset();
  mocks.ctor.length = 0;
  resetDbConnectionForTests();
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, "t-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.DATA_DIR = path.join(dir, "data");
  delete process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.PICNIC_MIN_ORDER_CENTS;
});

afterAll(() => {
  resetDbConnectionForTests();
  vi.restoreAllMocks();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function connect(adapter: PicnicAdapter) {
  mocks.login.mockResolvedValue({ authKey: "key-1", userId: "u", secondFactorAuthenticationRequired: false });
  await adapter.authenticate({ step: "login", email: "a@b.nl", password: "pw" });
}

describe("PicnicAdapter metadata", () => {
  it("exposes delivery capabilities with the configured minimum order", () => {
    process.env.PICNIC_MIN_ORDER_CENTS = "4000";
    const a = new PicnicAdapter();
    expect(a.id).toBe("picnic");
    expect(a.channel).toBe("delivery");
    expect(a.capabilities).toMatchObject({ search: true, promotions: true, historySync: true, listPush: true, minOrderCents: 4000 });
    delete process.env.PICNIC_MIN_ORDER_CENTS;
  });
});

describe("sandbox fallback (unauthenticated)", () => {
  it("serves realistic Picnic products for magere kwark and pindakaas without calling the API", async () => {
    const a = new PicnicAdapter();
    const kwark = await a.searchProducts({ query: "magere kwark" });
    expect(kwark.isMockFallback).toBe(true);
    expect(kwark.sourceNote).toContain("Picnic voorbeeldprijzen");
    expect(kwark.products.length).toBeGreaterThanOrEqual(4);
    expect(kwark.products.every((p) => p.isMockFallback && p.provider === "picnic")).toBe(true);
    const kilo = kwark.products.find((p) => p.baseAmount === 1000);
    expect(kilo?.isHouseBrand).toBe(true);
    expect(kilo?.promo?.type).toBe("tiered_price");
    expect(kwark.products.some((p) => p.brand === "Campina" && p.promo?.type === "x_for_y")).toBe(true);

    const pb = await a.searchProducts({ query: "pindakaas" });
    expect(pb.isMockFallback).toBe(true);
    expect(pb.products.some((p) => p.brand === "Calvé" && p.promo?.type === "bogo")).toBe(true);
    expect(pb.products.some((p) => p.isHouseBrand)).toBe(true);
    expect(mocks.getSearchResults).not.toHaveBeenCalled();
    expect((await a.getAuthState()).status).toBe("disconnected");
  });
});

describe("login and SMS 2FA", () => {
  it("goes awaiting_2fa -> verify_2fa -> authenticated with encrypted tokens", async () => {
    const a = new PicnicAdapter();
    mocks.login.mockResolvedValue({ authKey: "pending-key", userId: "u", secondFactorAuthenticationRequired: true });
    mocks.generate2FACode.mockResolvedValue(null);
    const res = await a.authenticate({ step: "login", email: "a@b.nl", password: "pw" });
    expect(res.requires2fa).toBe(true);
    expect(res.state).toMatchObject({ provider: "picnic", status: "awaiting_2fa", message: "SMS-code verstuurd naar je telefoon" });
    expect(mocks.generate2FACode).toHaveBeenCalledWith("SMS");
    expect(getStoreAccount("picnic")?.status).toBe("awaiting_2fa");
    expect(getStoreTokens("picnic")).toEqual({ authKey: "pending-key", email: "a@b.nl", pending2fa: true });

    mocks.verify2FACode.mockResolvedValue({ authKey: "final-key" });
    const verified = await a.authenticate({ step: "verify_2fa", code: "123456" });
    expect(verified.state.status).toBe("authenticated");
    expect(mocks.verify2FACode).toHaveBeenCalledWith("123456");
    expect(mocks.ctor.at(-1)).toMatchObject({ authKey: "pending-key" });
    expect(getStoreTokens("picnic")).toEqual({ authKey: "final-key", email: "a@b.nl" });

    const raw = fs.readdirSync(process.env.DATA_DIR!).join(",");
    expect(raw).toContain("boodschappen.db");
  });

  it("stores authKey directly without 2FA and logout falls back to the sandbox", async () => {
    const a = new PicnicAdapter();
    await connect(a);
    expect((await a.getAuthState()).status).toBe("authenticated");
    expect(mocks.generate2FACode).not.toHaveBeenCalled();
    const out = await a.authenticate({ step: "logout" });
    expect(out.state).toMatchObject({ status: "disconnected", isMockFallback: true });
    expect(getStoreAccount("picnic")).toBeNull();
    expect((await a.searchProducts({ query: "eieren" })).isMockFallback).toBe(true);
  });
});

describe("live search", () => {
  it("reuses one authenticated client and its Picnic page metadata across searches", async () => {
    const a = new PicnicAdapter();
    await connect(a);
    mocks.getSearchResults.mockResolvedValue({ query: "melk", correctedQuery: null, recipes: [], products: { sections: [] } });

    await a.searchProducts({ query: "melk" });
    await a.searchProducts({ query: "brood" });

    expect(mocks.ctor).toHaveLength(2);
    expect(mocks.getSearchResults).toHaveBeenCalledTimes(2);
  });

  it("maps RFY, price ranges, promo labels and unit quantities", async () => {
    const a = new PicnicAdapter();
    await connect(a);
    const tile = (over: Record<string, unknown>) => ({
      id: "s1",
      name: "Magere kwark",
      namePrefix: null,
      brand: "Picnic",
      qualityCue: null,
      imageId: "img123",
      displayPrice: 179,
      originalPrice: null,
      unitPrice: null,
      priceRanges: null,
      unitQuantity: "1 kg",
      labels: [],
      isUnavailable: false,
      numberOfOrders: null,
      ...over,
    });
    mocks.getSearchResults.mockResolvedValue({
      query: "kwark",
      correctedQuery: null,
      recipes: [],
      products: {
        sections: [
          { id: "RFY", type: "x", title: "Opnieuw bestellen", products: [tile({})] },
          {
            id: "main",
            type: "x",
            title: null,
            products: [
              tile({}),
              tile({ id: "s2", name: "Kwark vanilla", brand: "Campina", unitQuantity: "500 gram", displayPrice: 99, originalPrice: 149, labels: [{ position: "TOP", type: null, text: "1+1 gratis" }] }),
              tile({ id: "s3", name: "Cola Zero", brand: "Coca-Cola", unitQuantity: "6 x 330 ml", displayPrice: 500, priceRanges: [{ price: 450, from_quantity: 2 }, { price: 400, from_quantity: 4 }] }),
              tile({ id: "s4", name: "Picnic Halfvolle melk", brand: null, unitQuantity: "1.5 liter", displayPrice: 150 }),
            ],
          },
        ],
      },
    });
    const res = await a.searchProducts({ query: "kwark" });
    expect(res.isMockFallback).toBe(false);
    expect(res.products).toHaveLength(4);
    const [s1, s2, s3, s4] = res.products;
    expect(s1).toMatchObject({ id: "picnic:s1", previouslyBought: true, isHouseBrand: true, baseAmount: 1000, baseUnit: "g", regularPriceCents: 179, currentPriceCents: 179 });
    expect(s1.imageUrl).toBe("https://storefront-prod.nl.picnicinternational.com/static/images/img123/medium.png");
    expect(s2).toMatchObject({ previouslyBought: false, regularPriceCents: 149, currentPriceCents: 99, baseAmount: 500 });
    expect(s2.promo).toMatchObject({ type: "bogo", buyQty: 1, freeQty: 1 });
    expect(s3.promo?.type).toBe("tiered_price");
    expect(s3.promo?.tiers).toEqual([
      { fromQty: 1, unitPriceCents: 500 },
      { fromQty: 2, unitPriceCents: 450 },
      { fromQty: 4, unitPriceCents: 400 },
    ]);
    expect(s3).toMatchObject({ baseAmount: 1980, baseUnit: "ml" });
    expect(s4).toMatchObject({ isHouseBrand: true, baseAmount: 1500, baseUnit: "ml" });
    expect(getStoreProduct("picnic:s2")?.currentPriceCents).toBe(99);
  });

  it("parses units and promo labels", () => {
    expect(parseUnitQuantity("500 gram")).toEqual({ baseAmount: 500, baseUnit: "g" });
    expect(parseUnitQuantity("2 stuks")).toEqual({ baseAmount: 2, baseUnit: "piece" });
    expect(parseUnitQuantity("per stuk")).toEqual({ baseAmount: 1, baseUnit: "piece" });
    expect(parsePromoLabel("2+1 gratis")).toMatchObject({ type: "x_plus_y_free", buyQty: 2, freeQty: 1 });
    expect(parsePromoLabel("2 voor €3.99")).toMatchObject({ type: "x_for_y", bundleQty: 2, bundlePriceCents: 399 });
    expect(parsePromoLabel("2e halve prijs")?.type).toBe("second_half_price");
    expect(parsePromoLabel("25% korting")).toMatchObject({ type: "percentage", discountPercent: 25 });
    expect(parsePromoLabel("Vers")).toBeNull();
  });

  it("enriches Picnic titles with brand, Bio prefix and PlanetProof cue and cleans unit sizes", () => {
    expect(
      formatPicnicTitle({ name: "magere kwark", namePrefix: "Bio", brand: "Picnic", qualityCue: null }),
    ).toBe("Picnic Bio magere kwark");
    expect(
      formatPicnicTitle({ name: "Magere kwark", namePrefix: null, brand: "Picnic", qualityCue: "PlanetProof" }),
    ).toBe("Picnic Magere kwark (PlanetProof)");
    expect(
      formatPicnicTitle({ name: "Magere milde kwark", namePrefix: null, brand: "Campina", qualityCue: "Boordevol eiwit" }),
    ).toBe("Campina Magere milde kwark");
    expect(cleanPicnicUnitSize("1 kilo, In prijs verlaagd")).toBe("1 kilo");

    const norm = normalizePicnicTile({
      id: "s1187298",
      name: "Magere Franse kwark",
      namePrefix: null,
      brand: "Picnic",
      qualityCue: "0% vet",
      imageId: "abc",
      displayPrice: 159,
      unitQuantity: "1 kilo, In prijs verlaagd",
    });
    expect(norm.title).toBe("Picnic Magere Franse kwark");
    expect(norm.unitSizeRaw).toBe("1 kilo");
    expect(norm.baseAmount).toBe(1000);
    expect(norm.isHouseBrand).toBe(true);
  });
});

describe("history sync and cart push", () => {
  it("syncs deliveries into purchase_history and preferences, skipping known ones", async () => {
    const a = new PicnicAdapter();
    await connect(a);
    const line = (productId: string, name: string, quantity: number, displayPrice: number) => ({
      id: `l-${productId}`, productId, name, unitQuantity: "500 gram", imageId: null, quantity, maxCount: 99,
      displayPrice, originalPrice: null, priceColor: null, priceRanges: null, labels: [],
    });
    mocks.getDeliverySummaries.mockResolvedValue([
      { id: "d1", status: "COMPLETED", creationTime: "2026-10-01T10:00:00Z" },
      { id: "d2", status: "COMPLETED", creationTime: "2026-10-08T10:00:00Z" },
    ]);
    mocks.getDelivery.mockImplementation(async (id: string) => ({
      id,
      creationTime: id === "d1" ? "2026-10-01T10:00:00Z" : "2026-10-08T10:00:00Z",
      windowStart: null,
      orders: [{ items: [line("s1", "Picnic Magere kwark", 2, 218), line(id === "d1" ? "s2" : "s3", id === "d1" ? "Eieren" : "Brood", 1, 279)] }],
    }));
    const res = await a.syncHistory();
    expect(mocks.getDeliverySummaries).toHaveBeenCalledWith(["COMPLETED"]);
    expect(res).toMatchObject({ provider: "picnic", receiptsOrOrdersSynced: 2, productsMapped: 3 });
    expect(res.itemsSynced).toBe(4);
    const history = listPurchaseHistory().filter((h) => h.provider === "picnic");
    expect(history).toHaveLength(4);
    expect(history[0].storeProductId).toMatch(/^picnic:s/);
    expect(getStoreProduct("picnic:s1")).toMatchObject({ title: "Picnic Magere kwark", isHouseBrand: true, currentPriceCents: 109 });
    expect(getProductPreference("picnic:s1")?.timesBought).toBeGreaterThanOrEqual(2);
    expect(getStoreAccount("picnic")?.lastSyncedAt).toBe(res.syncedAt);

    mocks.getDelivery.mockClear();
    const again = await a.syncHistory();
    expect(again.receiptsOrOrdersSynced).toBe(0);
    expect(mocks.getDelivery).not.toHaveBeenCalled();
  });

  it("pushes items with addProductToCart and reports the cart total", async () => {
    const a = new PicnicAdapter();
    await connect(a);
    mocks.addProductToCart.mockResolvedValueOnce({ totalPrice: 500 }).mockResolvedValueOnce({ totalPrice: 1200 });
    const res = await a.pushItems([
      { externalId: "s1", title: "Kwark", quantity: 4 },
      { externalId: "picnic:s2", title: "Eieren", quantity: 1 },
    ]);
    expect(mocks.addProductToCart).toHaveBeenNthCalledWith(1, "s1", 4);
    expect(mocks.addProductToCart).toHaveBeenNthCalledWith(2, "s2", 1);
    expect(res).toMatchObject({ provider: "picnic", success: true, itemsPushed: 2, cartTotalCents: 1200 });
  });

  it("refuses sync and push when not connected", async () => {
    const a = new PicnicAdapter();
    await expect(a.syncHistory()).rejects.toThrow();
    await expect(a.pushItems([])).rejects.toThrow();
  });
});

describe("Jumbo & Plus radar", () => {
  const data = [
    { n: "jumbo", d: [{ n: "Jumbo Magere Kwark 500g", l: "https://jumbo.com/p/1", p: 1.29, s: "500 g", o: 1.69 }, { n: "Jumbo Melk", p: 1.1, s: "1 l" }] },
    { n: "plus", d: [{ n: "Plus Pindakaas", l: "p2", p: 2.49, s: "350 g" }] },
  ];

  it("has the radar contract and defaults to disconnected", async () => {
    const j = new JumboRadarAdapter();
    const p = new PlusRadarAdapter();
    expect([j.id, p.id]).toEqual(["jumbo", "plus"]);
    expect(j.channel).toBe("radar");
    expect(p.capabilities).toEqual({ search: true, promotions: true, historySync: false, listPush: false });
    expect((await j.getAuthState()).status).toBe("disconnected");
    expect((await j.searchProducts({ query: "kwark" })).products).toEqual([]);
    expect(await j.getPromotions()).toEqual([]);
  });

  it("parses Checkjebon JSON per chain", () => {
    const jumbo = parseCheckjebon(data, "jumbo");
    expect(jumbo).toHaveLength(2);
    expect(jumbo[0]).toMatchObject({ provider: "jumbo", currentPriceCents: 129, regularPriceCents: 169, baseAmount: 500, baseUnit: "g" });
    expect(parseCheckjebon(data, "plus")[0].currentPriceCents).toBe(249);
    expect(parseCheckjebon({ nope: true }, "plus")).toEqual([]);
  });

  it("is enabled from a local Checkjebon file and returns products and deals", async () => {
    const file = path.join(process.cwd(), "supermarkets.json");
    fs.writeFileSync(file, JSON.stringify(data));
    const j = new JumboRadarAdapter();
    const state = await j.authenticate({ step: "exchange_code", codeOrUrl: file });
    expect(state.state.status).toBe("authenticated");
    const found = await j.searchProducts({ query: "magere kwark" });
    expect(found.products.map((x) => x.title)).toEqual(["Jumbo Magere Kwark 500g"]);
    const deals = await j.getPromotions();
    expect(deals).toEqual([expect.objectContaining({ provider: "jumbo", priceCents: 129, regularPriceCents: 169 })]);
    await j.authenticate({ step: "logout" });
    expect((await j.getAuthState()).status).toBe("disconnected");
  });
});
