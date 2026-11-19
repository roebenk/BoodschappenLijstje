import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbConnectionForTests } from "@/lib/db";
import * as repo from "@/lib/db/repositories";
import {
  buildUnitPriceComparison,
  compareItemAcrossStores,
  conceptSlugAliases,
  evaluateStoreCandidates,
  filterRelevantProducts,
  filterRelevantProductsDeterministic,
  inferGramsPerPiece,
  isCanSized,
  loadPreferenceContext,
  optimizeShoppingList,
  parseGroceryInput,
  parsePackageSize,
  priceCandidate,
  slugifyConcept,
} from "@/lib/engine";
import { resolveAhPackInfo } from "@/lib/providers/ah";
import { normalizePicnicTile } from "@/lib/providers/picnic/parse";
import { expandSearchQueries } from "@/lib/llm/openrouter";
import type { NormalizedStoreProduct, ShoppingListItem } from "@/lib/types";

const ROOT = path.join(process.cwd(), ".test-data-engine");
const realCwd = process.cwd();
const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_DEFAULT_MODEL", "OPENROUTER_FALLBACK_MODEL", "DATA_DIR", "PICNIC_MIN_ORDER_CENTS"];

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
    regularPriceCents: 189,
    currentPriceCents: 189,
    promo: null,
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
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, "t-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.DATA_DIR = path.join(dir, "data");
});

afterAll(() => {
  resetDbConnectionForTests();
  vi.restoreAllMocks();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("units", () => {
  it("parses Dutch package sizes", () => {
    expect(parsePackageSize("1 kg")).toEqual({ baseAmount: 1000, baseUnit: "g" });
    expect(parsePackageSize("ca. 350 g")).toEqual({ baseAmount: 350, baseUnit: "g" });
    expect(parsePackageSize("1,5 kilo")).toEqual({ baseAmount: 1500, baseUnit: "g" });
    expect(parsePackageSize("4 x 125 g")).toEqual({ baseAmount: 500, baseUnit: "g" });
    expect(parsePackageSize("1.5 liter")).toEqual({ baseAmount: 1500, baseUnit: "ml" });
    expect(parsePackageSize("75 cl")).toEqual({ baseAmount: 750, baseUnit: "ml" });
    expect(parsePackageSize("6x0,33l")).toEqual({ baseAmount: 1980, baseUnit: "ml" });
    expect(parsePackageSize("10 st.")).toEqual({ baseAmount: 10, baseUnit: "piece" });
    expect(parsePackageSize("9 rollen")).toEqual({ baseAmount: 9, baseUnit: "piece" });
    expect(parsePackageSize("per stuk")).toEqual({ baseAmount: 1, baseUnit: "piece" });
  });

  it("parses grocery input", () => {
    const k = parseGroceryInput("4x 1kg magere kwark");
    expect(k).toMatchObject({
      multiplier: 4,
      perPackAmount: 1000,
      baseUnit: "g",
      totalTargetAmount: 4000,
      searchQuery: "magere kwark",
      displayName: "Magere kwark (4 kg)",
      allowOvershootDefault: true,
    });
    expect(parseGroceryInput("2 liter halfvolle melk")).toMatchObject({
      multiplier: 1,
      perPackAmount: 2000,
      baseUnit: "ml",
      totalTargetAmount: 2000,
      searchQuery: "halfvolle melk",
      allowOvershootDefault: false,
    });
    expect(parseGroceryInput("6 blikjes cola zero")).toMatchObject({ multiplier: 6, baseUnit: "piece", searchQuery: "cola zero", allowOvershootDefault: true });
    expect(parseGroceryInput("pindakaas")).toMatchObject({
      multiplier: 1,
      perPackAmount: null,
      baseUnit: null,
      totalTargetAmount: null,
      isCountOnly: true,
      searchQuery: "pindakaas",
      allowOvershootDefault: true,
    });
    expect(slugifyConcept("Magere kwark")).toBe("magere-kwark");
  });
});

describe("relevance filter + pricing", () => {
  it("filters flavoured/dessert false positives for magere kwark", () => {
    const hits = [
      product("ah:1", { title: "AH Magere kwark" }),
      product("ah:2", { title: "AH Magere kwark aardbei" }),
      product("ah:3", { title: "Dr. Oetker Kwarktaart", brand: "Dr. Oetker" }),
    ];
    expect(filterRelevantProductsDeterministic("magere kwark", hits).map((p) => p.id)).toEqual(["ah:1"]);
    expect(filterRelevantProductsDeterministic("magere kwark aardbei", hits).map((p) => p.id)).toContain("ah:2");
    const melk = [product("ah:4", { title: "Halfvolle melk" }), product("ah:5", { title: "Halfvolle chocolademelk" })];
    expect(filterRelevantProductsDeterministic("halfvolle melk", melk).map((p) => p.id)).toEqual(["ah:4"]);
  });

  it("does not treat a broad store category as a positive product match", () => {
    const hits = [
      product("ah:1", { title: "AH Witte vrije uitloopeieren M", category: "Zuivel, eieren, boter" }),
      product("ah:2", { title: "AH Drinkyoghurt aardbei kerssmaak", category: "Zuivel, eieren, boter" }),
    ];
    expect(filterRelevantProductsDeterministic("eieren", hits).map((p) => p.id)).toEqual(["ah:1"]);
  });

  it("fairly compares 1+1 gratis 500g tubs against 1kg house pots", () => {
    const parsed = parseGroceryInput("4x 1kg magere kwark");
    const opts = { allowOvershoot: parsed.allowOvershootDefault, channel: "in_store" as const };
    const house = priceCandidate(product("ah:1"), parsed, opts);
    const campina = priceCandidate(
      product("picnic:2", {
        brand: "Campina",
        isHouseBrand: false,
        baseAmount: 500,
        regularPriceCents: 179,
        currentPriceCents: 179,
        promo: { type: "x_plus_y_free", label: "1+1 gratis", buyQty: 1, freeQty: 1 },
      }),
      parsed,
      opts,
    );
    expect(house.effectiveTotalCents).toBe(756);
    expect(campina.packsNeeded).toBe(8);
    expect(campina.effectiveTotalCents).toBe(716);
    expect(campina.effectiveCentsPer1000Base).toBe(179);
    expect(campina.promoApplied).toBe(true);
    const ev = evaluateStoreCandidates("picnic", [house, campina]);
    expect(ev.winner?.product.id).toBe("picnic:2");
  });

  it("takes free 1+1 extra pack only when it costs the same", () => {
    const parsed = parseGroceryInput("500 g kwark");
    const p = product("ah:3", {
      baseAmount: 500,
      regularPriceCents: 179,
      currentPriceCents: 179,
      promo: { type: "x_plus_y_free", label: "1+1 gratis", buyQty: 1, freeQty: 1 },
    });
    const c = priceCandidate(p, parsed, { allowOvershoot: false, channel: "in_store" });
    expect(c.effectiveTotalCents).toBe(179);
    expect(c.hasOvershoot).toBe(true);
    expect(c.packsNeeded).toBe(2);
    const dealX = product("ah:4", { baseAmount: 500, regularPriceCents: 200, currentPriceCents: 200, promo: { type: "x_for_y", label: "2 voor €3,50", bundleQty: 2, bundlePriceCents: 350 } });
    expect(priceCandidate(dealX, parsed, { allowOvershoot: false, channel: "in_store" }).hasOvershoot).toBe(false);
    expect(priceCandidate(dealX, parsed, { allowOvershoot: true, channel: "in_store" }).hasOvershoot).toBe(false);
  });

  it("ignores online-only promos in store", () => {
    const parsed = parseGroceryInput("1 kg kwark");
    const p = product("ah:5", {
      regularPriceCents: 300,
      currentPriceCents: 150,
      isOnlineOnlyPromo: true,
      promo: { type: "percentage", label: "50% korting", discountPercent: 50 },
    });
    expect(priceCandidate(p, parsed, { allowOvershoot: false, channel: "in_store" }).effectiveTotalCents).toBe(300);
    expect(priceCandidate(p, parsed, { allowOvershoot: false, channel: "delivery" }).effectiveTotalCents).toBe(150);
  });

  it("buys one six-pack for '6 blikjes' and prefers can-sized packs", () => {
    const parsed = parseGroceryInput("6 blikjes cola zero");
    expect(parsed.containerHint).toBe("can");
    const six = product("ah:60", { title: "Coca-Cola Zero 6-pack", unitSizeRaw: "6 x 330 ml", baseAmount: 1980, baseUnit: "ml" });
    expect(priceCandidate(six, parsed, { allowOvershoot: false, channel: "in_store" }).packsNeeded).toBe(1);
    expect(isCanSized(six)).toBe(true);
    expect(isCanSized(product("ah:61", { unitSizeRaw: "1,5 l", baseAmount: 1500, baseUnit: "ml" }))).toBe(false);
  });

  it("penalises oversized packs when overshoot is off", () => {
    const parsed = parseGroceryInput("300g kipfilet");
    const small = product("ah:70", { unitSizeRaw: "350 g", baseAmount: 350, regularPriceCents: 400, currentPriceCents: 400 });
    const bulk = product("ah:71", { unitSizeRaw: "800 g", baseAmount: 800, regularPriceCents: 700, currentPriceCents: 700 });
    const opts = { allowOvershoot: false, channel: "in_store" as const };
    const ev = evaluateStoreCandidates("ah", [priceCandidate(small, parsed, opts), priceCandidate(bulk, parsed, opts)]);
    expect(priceCandidate(bulk, parsed, opts).hasOvershoot).toBe(true);
    expect(ev.winner?.product.id).toBe("ah:70");
  });
});

describe("preferences", () => {
  function setup() {
    const calve = product("ah:100", { title: "Calvé pindakaas", brand: "Calvé", isHouseBrand: false, baseAmount: 650, regularPriceCents: 450, currentPriceCents: 450 });
    const house = product("ah:101", { title: "AH pindakaas", baseAmount: 650, regularPriceCents: 250, currentPriceCents: 250 });
    repo.upsertStoreProducts([calve, house]);
    const concept = repo.upsertConcept({ slug: "pindakaas", name: "pindakaas" });
    repo.linkConceptToProduct(concept.id, calve.id, true, "history");
    repo.linkConceptToProduct(concept.id, house.id, true, "history");
    return { calve, house, concept };
  }

  it("keeps a loyal brand and surfaces the house-brand challenger", () => {
    const { calve, house, concept } = setup();
    repo.insertPurchaseHistory(
      [1, 2, 3, 4].map((i) => ({ provider: "ah" as const, txId: `t${i}`, purchasedAt: `2026-01-0${i}`, storeProductId: calve.id, rawName: "Calve pindakaas" })),
    );
    repo.recomputeProductPreferences();
    const parsed = parseGroceryInput("pindakaas");
    const opts = { allowOvershoot: true, channel: "in_store" as const };
    const cands = [calve, house].map((p) => priceCandidate(p, parsed, opts));
    const ev = evaluateStoreCandidates("ah", cands, loadPreferenceContext(concept.id, [calve.id, house.id]));
    expect(ev.winner?.product.brand).toBe("Calvé");
    expect(ev.houseBrandChallenger?.product.id).toBe(house.id);
    expect(ev.winner?.rankReason).toMatch(/Jouw vaste keuze: Calvé — Huismerk bespaart €\d+,\d{2}\/kg/);
    // auto mode without history picks cheapest
    expect(evaluateStoreCandidates("ah", cands).winner?.product.id).toBe(house.id);
  });

  it("learns from manual picks", () => {
    const { calve, house, concept } = setup();
    const parsed = parseGroceryInput("pindakaas");
    const opts = { allowOvershoot: true, channel: "in_store" as const };
    const cands = [calve, house].map((p) => priceCandidate(p, parsed, opts));
    expect(evaluateStoreCandidates("ah", cands, loadPreferenceContext(concept.id, [calve.id, house.id])).winner?.product.id).toBe(house.id);
    repo.recordManualPick(calve.id, concept.id);
    const ev = evaluateStoreCandidates("ah", cands, loadPreferenceContext(concept.id, [calve.id, house.id]));
    expect(ev.winner?.product.id).toBe(calve.id);
  });

  it("honours pinned and house-brand modes", () => {
    const { calve, house } = setup();
    const parsed = parseGroceryInput("pindakaas");
    const cands = [calve, house].map((p) => priceCandidate(p, parsed, { allowOvershoot: true, channel: "in_store" }));
    expect(evaluateStoreCandidates("ah", cands, { brandPreferenceMode: "pinned_brand", pinnedBrand: "calvé" }).winner?.product.id).toBe(calve.id);
    expect(evaluateStoreCandidates("ah", cands, { brandPreferenceMode: "house_brand" }).winner?.product.id).toBe(house.id);
  });
});

describe("optimizer", () => {
  function item(id: number, ah: number | null, picnic: number | null, over: Partial<ShoppingListItem> = {}): ShoppingListItem {
    return {
      id, rawInput: `item ${id}`, displayName: `Item ${id}`, requestedQty: 1, requestedUnitRaw: null,
      targetBaseAmount: null, targetBaseUnit: null, conceptId: null, allowOvershoot: false,
      assignedProvider: null, isProviderLocked: false, ahProductId: null, ahQty: 1, ahTotalCents: ah,
      picnicProductId: null, picnicQty: 1, picnicTotalCents: picnic, radarDeals: [], isChecked: false,
      pushedToStoreAt: null, sortOrder: id, updatedAt: "", ...over,
    };
  }

  it("compares across stores with a Dutch reason", () => {
    const parsed = parseGroceryInput("1 kg kwark");
    const opts = { allowOvershoot: false, channel: "in_store" as const };
    const ah = evaluateStoreCandidates("ah", [priceCandidate(product("ah:1", { regularPriceCents: 200, currentPriceCents: 200 }), parsed, opts)]);
    const pic = evaluateStoreCandidates("picnic", [priceCandidate(product("picnic:1", { regularPriceCents: 160, currentPriceCents: 160 }), parsed, opts)]);
    const r = compareItemAcrossStores(parsed, "kwark", ah, pic);
    expect(r.recommendedProvider).toBe("picnic");
    expect(r.savingsOverOtherStoreCents).toBe(40);
    expect(r.reason).toContain("Picnic");
    expect(r.reason).toContain("goedkoper");
  });

  it("respects locks, computes subtotals and Picnic threshold", () => {
    const items = [
      item(1, 500, 400),
      item(2, 300, 350),
      item(3, 1000, 900, { isProviderLocked: true, assignedProvider: "ah" }),
      item(4, null, 600),
    ];
    const r = optimizeShoppingList(items, { minPicnicOrderCents: 3500 });
    expect(r.items.map((i) => i.assignedProvider)).toEqual(["picnic", "ah", "ah", "picnic"]);
    expect(r.ahSubtotalCents).toBe(1300);
    expect(r.picnicSubtotalCents).toBe(1000);
    expect(r.totalCents).toBe(2300);
    expect(r.totalSavingsCents).toBe(100 + 50 + 0 + 0);
    expect(r.picnicAdvice).toMatchObject({ meetsMinimum: false, shortfallCents: 2500, recommendation: "all_at_ah", allAtAhExtraCostCents: 100 });

    const near = optimizeShoppingList([item(1, 3000, 2000), item(2, 2000, 1000), item(3, 100, 400)], { minPicnicOrderCents: 3500 });
    expect(near.picnicAdvice.shortfallCents).toBe(500);
    expect(near.picnicAdvice.recommendation).toBe("top_up_picnic");

    const ok = optimizeShoppingList([item(1, 5000, 3600)]);
    expect(ok.picnicAdvice).toMatchObject({ meetsMinimum: true, recommendation: "split_optimal", minOrderCents: 3500 });

    const allAh = optimizeShoppingList(items, { forceMode: "all_ah" });
    expect(allAh.items.map((i) => i.assignedProvider)).toEqual(["ah", "ah", "ah", "picnic"]);
    expect(allAh.picnicSubtotalCents).toBe(600);
  });
});

describe("search query expansion", () => {
  it("uses safe local synonyms without an API key and keeps modifiers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await expandSearchQueries("Nutella zonder suiker")).toEqual({
      alternatives: ["hazelnootpasta zonder suiker"],
      safeAlternatives: ["hazelnootpasta zonder suiker"],
    });
    expect((await expandSearchQueries("chocopasta")).alternatives).toEqual(["chocoladepasta"]);
    expect((await expandSearchQueries("Parmezaanse kaas")).alternatives).toEqual([
      "Parmigiano Reggiano",
      "Grana Padano",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds parmesan-family cheeses, labels substitutes, and rejects foods that only contain cheese", async () => {
    const candidates = [
      product("ah:parmesan", { title: "AH Parmezaanse kaas flakes" }),
      product("ah:parmigiano", { title: "Galbani Parmigiano Reggiano" }),
      product("ah:grana", { title: "AH Grana Padano geraspt" }),
      product("ah:biscuits", { title: "AH Parmezaanse kaas biscuits", category: "Borrel, chips, snacks" }),
      product("ah:salami", { title: "AH Truffelsalami parmezaanse kaas", category: "Borrel, chips, snacks" }),
    ];
    const expansion = await expandSearchQueries("Parmezaanse kaas");
    const result = await filterRelevantProducts(
      "Parmezaanse kaas", candidates, "parmezaanse-kaas", expansion.alternatives, expansion.safeAlternatives,
    );
    expect(result.products.map((p) => p.id)).toEqual(["ah:parmesan", "ah:parmigiano", "ah:grana"]);
    expect(result.alternativeProductIds).toEqual(["ah:parmigiano", "ah:grana"]);
    expect(result.rejectedProductIds).toEqual(["ah:biscuits", "ah:salami"]);
  });

  it("uses local alternatives in deterministic matching without accepting unrelated snacks", async () => {
    const candidates = [
      product("ah:spread", { title: "AH hazelnootpasta" }),
      product("ah:cookie", { title: "AH hazelnootpasta koek" }),
      product("ah:pure", { title: "100% hazelnootpasta" }),
    ];
    const result = await filterRelevantProducts("nutella", candidates, "nutella", ["hazelnootpasta"], ["hazelnootpasta"]);
    expect(result.products.map((p) => p.id)).toEqual(["ah:spread"]);
  });

  it("deduplicates concurrent expansions and persists valid AI results across database connections", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        alternatives: ["  hazelnootpasta  ", "Hazelnootpasta"],
      }) } }] })),
    );
    const results = await Promise.all([expandSearchQueries("Nutella"), expandSearchQueries("nutella")]);
    expect(results.map((result) => result.alternatives)).toEqual([["hazelnootpasta"], ["hazelnootpasta"]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDb().prepare("SELECT expansion_version FROM search_query_expansions WHERE query = ?").get("nutella"))
      .toEqual({ expansion_version: 2 });
    resetDbConnectionForTests();
    expect((await expandSearchQueries(" NUTELLA ")).alternatives).toEqual(["hazelnootpasta"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes search expansions at the 30-day expiry boundary", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        alternatives: ["Parmigiano Reggiano"],
      }) } }] })),
    );
    await expandSearchQueries("Parmezaanse kaas");
    const row = getDb().prepare("SELECT updated_at FROM search_query_expansions WHERE query = ?")
      .get("parmezaanse kaas") as { updated_at: string };
    const expiresAt = Date.parse(row.updated_at) + 30 * 24 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, "now");
    try {
      resetDbConnectionForTests();
      clock.mockReturnValue(expiresAt - 1);
      await expandSearchQueries(" PARMEZAANSE   KAAS ");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(expiresAt);
      await expandSearchQueries("Parmezaanse kaas");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not cache failed AI calls and does not trust AI-only alternatives during deterministic fallback", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("error", { status: 500 }));
    expect((await expandSearchQueries("onbekend product")).alternatives).toEqual([]);
    expect((await expandSearchQueries("onbekend product")).alternatives).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const candidates = [product("ah:x", { title: "AH hazelnootpasta" })];
    const result = await filterRelevantProducts("onbekend product", candidates, "onbekend-product", ["hazelnootpasta"], []);
    expect(result.products).toEqual([]);
  });

  it("reassesses legacy AI rejections after search expansion but preserves manual rejections", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const candidates = [
      product("ah:old", { title: "AH hazelnootpasta" }),
      product("ah:manual", { title: "AH hazelnootpasta biologisch" }),
    ];
    repo.upsertStoreProducts(candidates);
    const concept = repo.upsertConcept({ slug: "nutella", name: "Nutella", baseUnit: "g" });
    repo.linkConceptToProduct(concept.id, "ah:old", false, "llm");
    repo.linkConceptToProduct(concept.id, "ah:manual", false, "manual");
    getDb().prepare("UPDATE concept_product_links SET relevance_version = 1 WHERE store_product_id = ?").run("ah:old");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ exact_ids: ["ah:old"], alternative_ids: [] }) } }] })),
    );
    const first = await filterRelevantProducts("nutella", candidates, "nutella", ["hazelnootpasta"], ["hazelnootpasta"]);
    expect(first.products.map((p) => p.id)).toEqual(["ah:old"]);
    const second = await filterRelevantProducts("nutella", candidates, "nutella", ["hazelnootpasta"], ["hazelnootpasta"]);
    expect(second.products.map((p) => p.id)).toEqual(["ah:old"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OpenRouter concept cache", () => {
  it("expands blueberry spellings and excludes berry-flavoured foods, including old AI matches but not manual choices", async () => {
    const expansion = await expandSearchQueries("biologische blauwe bessen");
    expect(expansion.safeAlternatives).toEqual(["biologische blauwe bes", "biologische blueberries"]);
    const berries = product("ah:berry-fruit", { title: "AH Blauwe bessen" });
    const yoghurt = product("ah:berry-yoghurt", { title: "AH Yoghurt blauwe bessen" });
    const muffin = product("ah:berry-muffin", { title: "AH Blauwe bessen muffins" });
    expect(filterRelevantProductsDeterministic("blauwe bessen", [berries, yoghurt, muffin])).toEqual([berries]);
    expect(filterRelevantProductsDeterministic("yoghurt blauwe bessen", [yoghurt])).toEqual([yoghurt]);
    repo.upsertStoreProducts([berries, yoghurt, muffin]);
    const concept = repo.upsertConcept({ slug: "blauwe-bessen", name: "Blauwe bessen", baseUnit: "g" });
    repo.linkConceptToProduct(concept.id, yoghurt.id, true, "llm");
    expect((await filterRelevantProducts("blauwe bessen", [berries, yoghurt])).products).toEqual([berries]);
    repo.recordManualPick(yoghurt.id, concept.id);
    expect((await filterRelevantProducts("blauwe bessen", [yoghurt])).products).toEqual([yoghurt]);
  });

  const hits = [
    product("ah:1", { title: "AH Magere kwark" }),
    product("ah:2", { title: "AH Magere kwark aardbei" }),
    product("ah:3", { title: "Campina Magere kwark", brand: "Campina", isHouseBrand: false }),
  ];

  it("falls back deterministically without an API key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const r = await filterRelevantProducts("magere kwark", hits);
    expect(r.products.map((p) => p.id)).toEqual(["ah:1", "ah:3"]);
    expect(r.usedLlm).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the LLM once and serves repeat searches from SQLite", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ exact_ids: ["ah:1"], alternative_ids: [] }) } }] }), { status: 200 }),
    );
    const first = await filterRelevantProducts("magere kwark", hits);
    expect(first.products.map((p) => p.id)).toEqual(["ah:1"]);
    expect(first.usedLlm).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(repo.getCachedConceptMatches("magere-kwark")?.validProductIds).toEqual(["ah:1"]);

    const second = await filterRelevantProducts("magere kwark", hits);
    expect(second.products.map((p) => p.id)).toEqual(["ah:1"]);
    expect(second.apiCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the fallback model when the first fails, then deterministic filtering", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
    const r = await filterRelevantProducts("magere kwark", hits);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.usedLlm).toBe(false);
    expect(r.products.map((p) => p.id)).toEqual(["ah:1", "ah:3"]);
  });

  it("keeps Picnic 'Cheese onion' (without 'chips' in title), filters babyfood, and reuses alias cache", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    const chipHits = [
      product("picnic:s1090555", { provider: "picnic", title: "Picnic Cheese onion", brand: "Picnic", isHouseBrand: true, category: "Chips" }),
      product("picnic:s1020", { provider: "picnic", title: "Lay's Cheese onion", brand: "Lay's", isHouseBrand: false, category: "Chips" }),
      product("picnic:s9999", { provider: "picnic", title: "Duyvis Dipsaus cheese onion", brand: "Duyvis", isHouseBrand: false }),
    ];

    expect(filterRelevantProductsDeterministic("cheese onion chips", chipHits).map((p) => p.id)).toEqual([
      "picnic:s1090555",
      "picnic:s1020",
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const userPrompt = String(body.messages?.[1]?.content ?? "");
      expect(userPrompt).toContain("picnic:s1090555");
      expect(userPrompt).not.toContain("picnic:s9999");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ exact_ids: ["picnic:s1090555", "picnic:s1020"], alternative_ids: [] }) } }] }),
        { status: 200 },
      );
    });

    const first = await filterRelevantProducts("cheese onion chips", chipHits);
    expect(first.products.map((p) => p.id)).toEqual(["picnic:s1090555", "picnic:s1020"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Reordered words hit canonical alias cache with 0 LLM calls
    const reordered = await filterRelevantProducts("chips cheese onion", chipHits);
    expect(reordered.products.map((p) => p.id)).toEqual(["picnic:s1090555", "picnic:s1020"]);
    expect(reordered.apiCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Singular/plural ("bananen" vs "banaan") shares cache and strips babyfood before LLM
    const bananaHits = [
      product("ah:197393", { title: "AH Bananen tros", unitSizeRaw: "Tros", baseAmount: 5, baseUnit: "piece", pieceCount: 5 }),
      product("ah:baby", { title: "Olvarit Banaan 4+ mnd", brand: "Olvarit", isHouseBrand: false }),
    ];
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const userPrompt = String(JSON.parse(String(init?.body ?? "{}")).messages?.[1]?.content ?? "");
      expect(userPrompt).not.toContain("ah:baby");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ exact_ids: ["ah:197393"], alternative_ids: [] }) } }] }),
        { status: 200 },
      );
    });
    const ban1 = await filterRelevantProducts("bananen", bananaHits);
    expect(ban1.products.map((p) => p.id)).toEqual(["ah:197393"]);
    const ban2 = await filterRelevantProducts("banaan", bananaHits);
    expect(ban2.products.map((p) => p.id)).toEqual(["ah:197393"]);
    expect(ban2.apiCalls).toBe(0);
  });
});

describe("piece vs kg, strong habit/recency, and default store", () => {
  it("extracts AH Tros/description weights, Picnic pieceCount, and bridges Slavinken stuk vs kg", () => {
    expect(resolveAhPackInfo({ salesUnitSize: "Tros", title: "AH Bananen tros" })).toEqual({
      baseAmount: 5,
      baseUnit: "piece",
      pieceCount: 5,
    });
    expect(
      resolveAhPackInfo({
        salesUnitSize: "per stuk",
        title: "AH Slavink",
        regularPriceEuros: 2.39,
        unitPriceDescription: "prijs per kg €11.95",
      }),
    ).toEqual({ baseAmount: 200, baseUnit: "g", pieceCount: 1 });
    expect(
      resolveAhPackInfo({
        salesUnitSize: "4 stuks",
        title: "AH Varkensslavink",
        descriptionFull: "Ambachtelijke slavinken, ca. 400 gram per schaal.",
      }),
    ).toEqual({ baseAmount: 400, baseUnit: "g", pieceCount: 4 });

    const picTile = normalizePicnicTile({
      id: "s101",
      name: "'t Slagershuys Slavinken",
      unitQuantity: "4 x 100 gram",
      displayPrice: 379,
    });
    expect(picTile).toMatchObject({ baseAmount: 400, baseUnit: "g", pieceCount: 4 });

    const parsed = parseGroceryInput("slavinken");
    const ahFourPieces = product("ah:slavink4", {
      title: "AH Varkensslavink",
      unitSizeRaw: "4 stuks",
      baseAmount: 4,
      baseUnit: "piece",
      pieceCount: 4,
      regularPriceCents: 375,
      currentPriceCents: 375,
    });
    const ahExpensivePiece = product("ah:slavinkExp", {
      title: "AH Luxe slavink",
      unitSizeRaw: "2 stuks",
      baseAmount: 2,
      baseUnit: "piece",
      pieceCount: 2,
      regularPriceCents: 490,
      currentPriceCents: 490,
    });
    const ahByWeight = product("ah:slavink200g", {
      title: "AH Slavink 200 g",
      unitSizeRaw: "200 g",
      baseAmount: 200,
      baseUnit: "g",
      pieceCount: 2,
      regularPriceCents: 239,
      currentPriceCents: 239,
    });

    const ahEv = evaluateStoreCandidates(
      "ah",
      [ahFourPieces, ahExpensivePiece, ahByWeight].map((p) => priceCandidate(p, parsed, { allowOvershoot: true, channel: "in_store" })),
      { gramsPerPieceHint: 100 },
    );
    expect(ahEv.winner?.product.id).toBe("ah:slavink4");
    // Expensive €2,45/stuk (≈€24,50/kg) ranks behind €11,95/kg weight item instead of winning on raw 245 < 1195
    const rankOrder = [ahEv.winner!, ...ahEv.alternatives].map((c) => c.product.id);
    expect(rankOrder).toEqual(["ah:slavink4", "ah:slavink200g", "ah:slavinkExp"]);

    const picEv = evaluateStoreCandidates("picnic", [
      priceCandidate(picTile!, parsed, { allowOvershoot: true, channel: "delivery" }),
    ]);
    const cmp = compareItemAcrossStores(parsed, "slavinken", ahEv, picEv);
    expect(cmp.recommendedProvider).toBe("ah");
    const unitCmp = buildUnitPriceComparison(ahEv.winner, picEv.winner);
    expect(unitCmp).toMatchObject({
      comparable: true,
      displayUnit: "stuk",
      ahCentsPerBase1000: 94,
      picnicCentsPerBase1000: 95,
    });

    // Unbridgeable piece vs kg keeps distinct per-store unit labels
    const unbridgeable = buildUnitPriceComparison(
      priceCandidate(product("ah:u1", { baseAmount: 1, baseUnit: "piece", pieceCount: null, currentPriceCents: 150, regularPriceCents: 150 }), parsed, { allowOvershoot: true, channel: "in_store" }),
      priceCandidate(product("picnic:u2", { baseAmount: 500, baseUnit: "g", pieceCount: null, currentPriceCents: 400, regularPriceCents: 400 }), parsed, { allowOvershoot: true, channel: "delivery" }),
    );
    expect(unbridgeable).toMatchObject({ comparable: false, ahDisplayUnit: "stuk", picnicDisplayUnit: "kg" });
  });

  it("strongly weights 71x Bananen tros and recent AH Terra 100% pindakaas purchases", () => {
    const tros = product("ah:197393", {
      title: "AH Bananen tros",
      brand: "AH",
      isHouseBrand: true,
      unitSizeRaw: "Tros",
      baseAmount: 5,
      baseUnit: "piece",
      pieceCount: 5,
      regularPriceCents: 149,
      currentPriceCents: 149,
    });
    const other = product("ah:999", {
      title: "Chiquita Bananen 5 stuks",
      brand: "Chiquita",
      isHouseBrand: false,
      unitSizeRaw: "5 stuks",
      baseAmount: 5,
      baseUnit: "piece",
      pieceCount: 5,
      regularPriceCents: 119,
      currentPriceCents: 119,
    });
    repo.upsertStoreProducts([tros, other]);
    const banConcept = repo.upsertConcept({ slug: "bananen", name: "bananen", baseUnit: "piece" });
    repo.linkConceptToProduct(banConcept.id, tros.id, true, "history");
    repo.linkConceptToProduct(banConcept.id, other.id, true, "llm");
    repo.insertPurchaseHistory(
      Array.from({ length: 71 }, (_, i) => ({
        provider: "ah" as const,
        txId: `ban-${i}`,
        purchasedAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
        storeProductId: tros.id,
        rawName: tros.title,
      })),
    );
    repo.recomputeProductPreferences();

    const banParsed = parseGroceryInput("bananen");
    const banEv = evaluateStoreCandidates(
      "ah",
      [tros, other].map((p) => priceCandidate(p, banParsed, { allowOvershoot: true, channel: "in_store" })),
      loadPreferenceContext(banConcept.id, [tros.id, other.id]),
    );
    expect(banEv.winner?.product.id).toBe("ah:197393");

    // AH Terra 100% pindakaas: 600g bought 5x earlier, 1kg bought 3x most recently vs cheap generic AH Pindakaas naturel (0x)
    const terra1kg = product("ah:479791", {
      title: "AH Terra Plantaardig 100% pindakaas 1 kg",
      brand: "AH Terra",
      isHouseBrand: true,
      unitSizeRaw: "1 kg",
      baseAmount: 1000,
      baseUnit: "g",
      regularPriceCents: 503,
      currentPriceCents: 503,
    });
    const terra600 = product("ah:564838", {
      title: "AH Terra Plantaardig 100% pindakaas 600 g",
      brand: "AH Terra",
      isHouseBrand: true,
      unitSizeRaw: "600 g",
      baseAmount: 600,
      baseUnit: "g",
      regularPriceCents: 329,
      currentPriceCents: 329,
    });
    const genericCheap = product("ah:2001", {
      title: "AH Pindakaas naturel 350 g",
      brand: "AH",
      isHouseBrand: true,
      unitSizeRaw: "350 g",
      baseAmount: 350,
      baseUnit: "g",
      regularPriceCents: 78,
      currentPriceCents: 78, // €2,23/kg vs €5,03/kg
    });
    repo.upsertStoreProducts([terra1kg, terra600, genericCheap]);
    const pbConcept = repo.upsertConcept({ slug: "pindakaas-terra", name: "pindakaas", baseUnit: "g" });
    for (const p of [terra1kg, terra600, genericCheap]) repo.linkConceptToProduct(pbConcept.id, p.id, true, "history");
    repo.insertPurchaseHistory([
      ...[1, 2, 3, 4, 5].map((d) => ({
        provider: "ah" as const,
        txId: `pb-old-${d}`,
        purchasedAt: `2026-02-0${d}T10:00:00Z`,
        storeProductId: terra600.id,
        rawName: terra600.title,
      })),
      ...[10, 15, 19].map((d) => ({
        provider: "ah" as const,
        txId: `pb-new-${d}`,
        purchasedAt: `2026-04-${d}T10:00:00Z`,
        storeProductId: terra1kg.id,
        rawName: terra1kg.title,
      })),
    ]);
    repo.recomputeProductPreferences();

    const pbParsed = parseGroceryInput("pindakaas");
    const pbEv = evaluateStoreCandidates(
      "ah",
      [genericCheap, terra600, terra1kg].map((p) => priceCandidate(p, pbParsed, { allowOvershoot: true, channel: "in_store" })),
      loadPreferenceContext(pbConcept.id, [genericCheap.id, terra600.id, terra1kg.id]),
    );
    expect(pbEv.winner?.product.id).toBe("ah:479791");
    expect(pbEv.houseBrandChallenger?.product.id).toBe("ah:2001");
  });

  it("honours configurable defaultProvider on price ties and applies cross-row multi-buy promos", () => {
    const parsed = parseGroceryInput("komkommer");
    const ahEv = evaluateStoreCandidates("ah", [
      priceCandidate(product("ah:k1", { baseAmount: 1, baseUnit: "piece", regularPriceCents: 89, currentPriceCents: 89 }), parsed, { allowOvershoot: false, channel: "in_store" }),
    ]);
    const picEv = evaluateStoreCandidates("picnic", [
      priceCandidate(product("picnic:k1", { provider: "picnic", baseAmount: 1, baseUnit: "piece", regularPriceCents: 89, currentPriceCents: 89 }), parsed, { allowOvershoot: false, channel: "delivery" }),
    ]);
    expect(compareItemAcrossStores(parsed, "komkommer", ahEv, picEv, false, "ah").recommendedProvider).toBe("ah");
    expect(compareItemAcrossStores(parsed, "komkommer", ahEv, picEv, false, "picnic").recommendedProvider).toBe("picnic");

    const bogoProd = product("ah:bogo", {
      regularPriceCents: 250,
      currentPriceCents: 250,
      promo: { type: "x_plus_y_free", label: "1+1 gratis", buyQty: 1, freeQty: 1 },
    });
    const row = (id: number): ShoppingListItem => ({
      id,
      rawInput: "chips",
      displayName: "Chips",
      requestedQty: 1,
      requestedUnitRaw: null,
      targetBaseAmount: null,
      targetBaseUnit: null,
      conceptId: null,
      allowOvershoot: false,
      assignedProvider: "ah",
      isProviderLocked: false,
      ahProductId: bogoProd.id,
      ahQty: 1,
      ahTotalCents: 250,
      picnicProductId: null,
      picnicQty: 0,
      picnicTotalCents: null,
      radarDeals: [],
      isChecked: false,
      pushedToStoreAt: null,
      sortOrder: id,
      updatedAt: "",
      ahProduct: bogoProd,
    });
    const opt = optimizeShoppingList([row(1), row(2)], { defaultProvider: "picnic" });
    // 2 separate 1x rows of a 1+1 gratis €2,50 item cost €2,50 combined (saving €2,50)!
    expect(opt.ahSubtotalCents).toBe(250);
    expect(opt.totalSavingsCents).toBe(250);
  });

  it("picks 4-pack Gala appels over 1 kilo bag using realistic produce piece weight and unified royal/gala history", () => {
    expect(conceptSlugAliases("royal gala appels")).toContain("gala-appel");

    const ahTray = product("ah:456588", {
      provider: "ah",
      title: "AH Gala schaal",
      brand: "AH",
      isHouseBrand: true,
      unitSizeRaw: "4 stuks",
      baseAmount: 4,
      baseUnit: "piece",
      pieceCount: 4,
      regularPriceCents: 249,
      currentPriceCents: 249,
    });
    const picFour = product("picnic:s1008271", {
      provider: "picnic",
      title: "Uit Nederland Gala appels",
      brand: "Uit Nederland",
      isHouseBrand: true,
      unitSizeRaw: "4 stuks",
      baseAmount: 4,
      baseUnit: "piece",
      pieceCount: 4,
      regularPriceCents: 215,
      currentPriceCents: 215,
    });
    const picKilo = product("picnic:s1018269", {
      provider: "picnic",
      title: "Uit Nederland Gala appels klein",
      brand: "Uit Nederland",
      isHouseBrand: true,
      unitSizeRaw: "1 kilo",
      baseAmount: 1000,
      baseUnit: "g",
      pieceCount: null,
      regularPriceCents: 269,
      currentPriceCents: 269,
    });

    repo.upsertStoreProducts([ahTray, picFour, picKilo]);
    const ahConcept = repo.upsertConcept({ slug: "gala-appel", name: "gala appel", baseUnit: "piece" });
    const royalConcept = repo.upsertConcept({ slug: "royal-gala-appels", name: "royal gala appels", baseUnit: "piece" });
    repo.linkConceptToProduct(ahConcept.id, ahTray.id, true, "history");
    repo.linkConceptToProduct(royalConcept.id, picFour.id, true, "history");
    repo.linkConceptToProduct(royalConcept.id, picKilo.id, true, "llm");

    repo.insertPurchaseHistory([
      ...Array.from({ length: 12 }, (_, i) => ({
        provider: "ah" as const,
        txId: `gala-ah-${i}`,
        purchasedAt: `2026-03-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
        storeProductId: ahTray.id,
        rawName: ahTray.title,
      })),
      {
        provider: "picnic" as const,
        txId: "gala-pic-1",
        purchasedAt: "2026-04-10T10:00:00Z",
        storeProductId: picFour.id,
        rawName: picFour.title,
      },
    ]);
    repo.recomputeProductPreferences();

    const parsed = parseGroceryInput("Gala Appels");
    const gramsPerPieceHint = inferGramsPerPiece([ahTray, picFour, picKilo], parsed.searchQuery);
    expect(gramsPerPieceHint).toBe(180);

    const ctx = {
      ...loadPreferenceContext(royalConcept.id, [ahTray.id, picFour.id, picKilo.id]),
      gramsPerPieceHint,
    };
    const picEv = evaluateStoreCandidates("picnic", [
      priceCandidate(picKilo, parsed, { allowOvershoot: true, channel: "delivery", timesBought: 0 }),
      priceCandidate(picFour, parsed, { allowOvershoot: true, channel: "delivery", timesBought: 1 }),
    ], ctx);

    expect(picEv.winner?.product.id).toBe("picnic:s1008271");
  });
});
