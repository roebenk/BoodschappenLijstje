import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, parseEnvFile } from "@/lib/config";
import { decryptSecrets, encryptSecrets } from "@/lib/crypto";
import { getDb, resetDbConnectionForTests } from "@/lib/db";
import * as repo from "@/lib/db/repositories";
import type { NormalizedStoreProduct } from "@/lib/types";
import nextConfig from "../../next.config";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";

const ROOT = path.join(process.cwd(), ".test-data");
const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_DEFAULT_MODEL",
  "OPENROUTER_FALLBACK_MODEL",
  "DATA_DIR",
  "TOKEN_ENCRYPTION_KEY",
  "PICNIC_MIN_ORDER_CENTS",
  "PICNIC_COUNTRY_CODE",
  "PORT",
];
const realCwd = process.cwd();
let dir: string;

function product(id: string, over: Partial<NormalizedStoreProduct> = {}): NormalizedStoreProduct {
  const [provider, externalId] = id.split(":") as ["ah" | "picnic", string];
  return {
    id,
    provider,
    externalId,
    title: `Product ${id}`,
    brand: "AH",
    isHouseBrand: true,
    unitSizeRaw: "1 kg",
    baseAmount: 1000,
    baseUnit: "g",
    regularPriceCents: 200,
    currentPriceCents: 150,
    promo: { type: "percentage", label: "25% korting", discountPercent: 25 },
    isOnlineOnlyPromo: false,
    imageUrl: null,
    available: true,
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetDbConnectionForTests();
  for (const k of ENV_KEYS) delete process.env[k];
  dir = fs.mkdtempSync(path.join(fs.existsSync(ROOT) ? ROOT : (fs.mkdirSync(ROOT), ROOT), "t-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.DATA_DIR = path.join(dir, "data");
});

afterAll(() => {
  resetDbConnectionForTests();
  vi.restoreAllMocks();
  fs.rmSync(path.join(realCwd, ".test-data"), { recursive: true, force: true });
});

describe("build output", () => {
  it("keeps development and production output in separate directories", () => {
    expect(nextConfig(PHASE_DEVELOPMENT_SERVER).distDir).not.toBe(nextConfig(PHASE_PRODUCTION_BUILD).distDir);
    expect(nextConfig(PHASE_PRODUCTION_BUILD).distDir).toBe(".next");
  });
});

describe("runtime config", () => {
  it("parses .env content", () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=x # note\nbad line')).toEqual({
      A: "1",
      B: "two words",
      C: "x",
    });
  });

  it("picks up .env changes without restart and prefers process.env", () => {
    delete process.env.DATA_DIR;
    expect(getRuntimeConfig().hasOpenRouterKey).toBe(false);
    expect(getRuntimeConfig().picnicMinOrderCents).toBe(3500);
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "OPENROUTER_API_KEY=sk-test\nPICNIC_MIN_ORDER_CENTS=4000\nPICNIC_COUNTRY_CODE=DE\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const cfg = getRuntimeConfig();
    expect(cfg.openRouterApiKey).toBe("sk-test");
    expect(cfg.hasOpenRouterKey).toBe(true);
    expect(cfg.picnicMinOrderCents).toBe(4000);
    expect(cfg.picnicCountryCode).toBe("DE");
    process.env.OPENROUTER_API_KEY = "from-env";
    expect(getRuntimeConfig().openRouterApiKey).toBe("from-env");
    expect(getRuntimeConfig().dataDir).toBe(path.join(dir, "data"));
  });
});

describe("crypto", () => {
  it("roundtrips with an auto-generated key file", () => {
    const payload = { accessToken: "a", refresh: ["b", 1] };
    const enc = encryptSecrets(payload);
    expect(enc.split(":")).toHaveLength(3);
    expect(enc).not.toContain("accessToken");
    expect(fs.existsSync(path.join(dir, "data", ".token.key"))).toBe(true);
    expect(decryptSecrets<typeof payload>(enc)).toEqual(payload);
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "key-one";
    const enc = encryptSecrets({ a: 1 });
    expect(decryptSecrets(enc)).toEqual({ a: 1 });
    const parts = enc.split(":");
    parts[2] = (parts[2][0] === "0" ? "1" : "0") + parts[2].slice(1);
    expect(() => decryptSecrets(parts.join(":"))).toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = "key-two";
    expect(() => decryptSecrets(enc)).toThrow();
  });
});

describe("database", () => {
  it("initialises schema with 7 tables and pragmas", () => {
    const db = getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "store_accounts",
        "canonical_concepts",
        "store_products",
        "concept_product_links",
        "purchase_history",
        "product_preferences",
        "shopping_list_items",
      ]),
    );
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect(getDb()).toBe(db);
  });

  it("stores encrypted account tokens", () => {
    repo.saveStoreAccount("ah", { tokens: { refresh_token: "secret" }, status: "authenticated", meta: { n: "Ruben" } });
    const raw = getDb().prepare("SELECT encrypted_tokens FROM store_accounts").get() as { encrypted_tokens: string };
    expect(raw.encrypted_tokens).not.toContain("secret");
    expect(repo.getStoreTokens<{ refresh_token: string }>("ah")).toEqual({ refresh_token: "secret" });
    repo.saveStoreAccount("ah", { status: "authenticated", lastSyncedAt: "2026-01-01T00:00:00Z" });
    expect(repo.getStoreAccount("ah")).toMatchObject({ hasTokens: true, lastSyncedAt: "2026-01-01T00:00:00Z", meta: { n: "Ruben" } });
    repo.deleteStoreAccount("ah");
    expect(repo.getStoreAccount("ah")).toBeNull();
  });

  it("upserts products and concepts and caches matches", () => {
    repo.upsertStoreProducts([product("ah:1"), product("picnic:p1", { brand: "Arla", isHouseBrand: false })]);
    repo.upsertStoreProducts([product("ah:1", { currentPriceCents: 99 })]);
    const p = repo.getStoreProduct("ah:1")!;
    expect(p.currentPriceCents).toBe(99);
    expect(p.promo?.type).toBe("percentage");
    expect(p.isHouseBrand).toBe(true);

    const c = repo.upsertConcept({ slug: "magere-kwark", name: "Magere kwark", baseUnit: "g" });
    expect(repo.upsertConcept({ slug: "magere-kwark", name: "Magere kwark", category: "zuivel" }).id).toBe(c.id);
    repo.linkConceptToProduct(c.id, "ah:1", true, "llm");
    repo.linkConceptToProduct(c.id, "picnic:p1", false, "llm");
    const cached = repo.getCachedConceptMatches("magere-kwark")!;
    expect(cached.validProductIds).toEqual(["ah:1"]);
    expect(cached.invalidProductIds).toEqual(["picnic:p1"]);
    expect(repo.getCachedConceptMatches("nope")).toBeNull();
  });

  it("deduplicates history and learns preferences", () => {
    repo.upsertStoreProducts([
      product("ah:1"),
      product("ah:2", { brand: "Arla", isHouseBrand: false }),
    ]);
    const c = repo.upsertConcept({ slug: "melk", name: "Melk", baseUnit: "ml" });
    repo.linkConceptToProduct(c.id, "ah:1", true, "history");
    repo.linkConceptToProduct(c.id, "ah:2", true, "history");
    const entries = [
      { provider: "ah" as const, txId: "t1", purchasedAt: "2026-01-01", storeProductId: "ah:1", rawName: "MELK" },
      { provider: "ah" as const, txId: "t2", purchasedAt: "2026-01-08", storeProductId: "ah:1", rawName: "MELK" },
      { provider: "ah" as const, txId: "t3", purchasedAt: "2026-01-15", storeProductId: "ah:1", rawName: "MELK" },
      { provider: "ah" as const, txId: "t3", purchasedAt: "2026-01-15", storeProductId: "ah:2", rawName: "ARLA MELK" },
    ];
    expect(repo.insertPurchaseHistory(entries)).toBe(4);
    expect(repo.insertPurchaseHistory(entries)).toBe(0);
    expect(repo.listPurchaseHistory()).toHaveLength(4);

    repo.recomputeProductPreferences();
    const pref = repo.getProductPreference("ah:1")!;
    expect(pref).toMatchObject({ timesBought: 3, lastBoughtAt: "2026-01-15", conceptId: c.id });
    const loyalty = repo.getBrandLoyalty(c.id);
    expect(loyalty.topBrand).toBe("AH");
    expect(loyalty.topBrandShare).toBeCloseTo(0.75);

    const before = repo.getProductPreference("ah:2")!.affinityScore;
    repo.recordManualPick("ah:2", c.id);
    repo.recordManualReject("ah:1", c.id);
    repo.recomputeProductPreferences();
    expect(repo.getProductPreference("ah:2")!.affinityScore).toBeGreaterThan(before);
    expect(repo.getProductPreference("ah:2")!.manualPicks).toBe(1);
    expect(repo.getProductPreference("ah:1")!.manualRejects).toBe(1);
    expect(repo.getTopPreferences({ conceptId: c.id })[0].storeProductId).toBe("ah:2");
  });

  it("suggests the most frequently purchased recent concepts and unmatched receipt items", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(repo.listRecentPurchaseSuggestions(now)).toEqual([]);

    repo.upsertStoreProducts([
      product("ah:1", { title: "AH Bananen" }),
      product("picnic:1", { title: "Picnic Bananen" }),
      product("ah:2", { title: "Kaas 1,5 kg" }),
    ]);
    const bananas = repo.upsertConcept({ slug: "bananen", name: "bananen", baseUnit: "piece" });
    repo.linkConceptToProduct(bananas.id, "ah:1", true, "history");
    repo.linkConceptToProduct(bananas.id, "picnic:1", true, "history");
    repo.insertPurchaseHistory([
      { provider: "ah", txId: "a", purchasedAt: "2026-11-01T12:00:00Z", storeProductId: "ah:1", rawName: "AH banaan" },
      { provider: "picnic", txId: "b", purchasedAt: "2026-11-02T12:00:00Z", storeProductId: "picnic:1", rawName: "Picnic banaan" },
      { provider: "ah", txId: "a", purchasedAt: "2026-11-01T12:00:00Z", storeProductId: "ah:1", rawName: "Andere banaan" },
      { provider: "ah", txId: "c", purchasedAt: "2026-11-04T12:00:00Z", storeProductId: "ah:2", rawName: "KAAS" },
      { provider: "ah", txId: "d", purchasedAt: "2026-11-05T12:00:00Z", storeProductId: "ah:2", rawName: "KAAS" },
      { provider: "ah", txId: "e", purchasedAt: "2026-11-06T12:00:00Z", rawName: "Appels" },
      { provider: "ah", txId: "f", purchasedAt: "2026-11-07T12:00:00Z", rawName: "Appels" },
      { provider: "ah", txId: "g", purchasedAt: "2026-11-08T12:00:00Z", rawName: "Appels" },
      { provider: "ah", txId: "h", purchasedAt: "2026-10-21T11:59:59Z", rawName: "Oude aankoop" },
      { provider: "ah", txId: "i", purchasedAt: "2026-11-18T12:00:01Z", rawName: "Toekomst" },
      { provider: "ah", txId: "j", purchasedAt: "2026-10-21T12:00:00Z", rawName: "Grens" },
    ]);

    expect(repo.listRecentPurchaseSuggestions(now)).toEqual(["Appels", "Kaas 1,5 kg", "bananen", "Grens"]);
    repo.insertPurchaseHistory([
      { provider: "ah", txId: "k", purchasedAt: "2026-11-10T12:00:00Z", rawName: "Yoghurt" },
    ]);
    expect(repo.listRecentPurchaseSuggestions(now)).toEqual(["Appels", "Kaas 1,5 kg", "bananen", "Yoghurt"]);
  });

  it("supports shopping list CRUD with hydration", () => {
    repo.upsertStoreProducts([product("ah:1"), product("picnic:p1", { baseAmount: 500, currentPriceCents: 100 })]);
    const a = repo.insertShoppingItem({
      rawInput: "4x 1kg magere kwark",
      displayName: "Magere kwark",
      requestedQty: 4,
      targetBaseAmount: 4000,
      targetBaseUnit: "g",
      assignedProvider: "ah",
      ahProductId: "ah:1",
      ahQty: 4,
      ahTotalCents: 450,
      picnicProductId: "picnic:p1",
      picnicQty: 8,
      picnicTotalCents: 800,
    });
    const b = repo.insertShoppingItem({ rawInput: "pindakaas", displayName: "Pindakaas" });
    expect(a.ahProduct?.id).toBe("ah:1");
    expect(a.unitPriceComparison).toEqual({ ahCentsPerBase1000: 150, picnicCentsPerBase1000: 200, displayUnit: "kg" });
    expect(a.savingsCents).toBe(350);
    expect(b.sortOrder).toBeLessThan(a.sortOrder);
    expect(repo.listShoppingItems().map((i) => i.id)).toEqual([b.id, a.id]);

    repo.updateShoppingItem(b.id, { isChecked: true, assignedProvider: "picnic", isProviderLocked: true });
    expect(repo.getShoppingItem(b.id)).toMatchObject({ isChecked: true, assignedProvider: "picnic", isProviderLocked: true });

    repo.reorderShoppingItems([a.id, b.id]);
    expect(repo.listShoppingItems().map((i) => i.id)).toEqual([a.id, b.id]);

    expect(repo.clearCheckedShoppingItems()).toBe(1);
    expect(repo.listShoppingItems().map((i) => i.id)).toEqual([a.id]);
    expect(repo.deleteShoppingItem(a.id)).toBe(true);
    expect(repo.listShoppingItems()).toEqual([]);
  });
});
