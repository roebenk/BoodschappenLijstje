import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import {
  allocateTopSortOrders,
  findConceptBySlugs,
  getBrandLoyalty,
  getConceptById,
  getDefaultProvider,
  getPreferencesForProducts,
  getShoppingItem,
  getStoreProduct,
  getStoreProducts,
  insertCompletedShoppingItems,
  insertShoppingItem,
  listShoppingItems,
  recordManualPick,
  recordManualReject,
  searchCachedStoreProducts,
  updateShoppingItem,
  upsertConcept,
  upsertStoreProducts,
  clearCheckedShoppingItems,
  deleteShoppingItem,
  type CompletedShoppingItemInput,
} from "@/lib/db/repositories";
import {
  buildUnitPriceComparison,
  comparableSupply,
  compareItemAcrossStores,
  conceptSlugAliases,
  evaluateStoreCandidates,
  filterRelevantProducts,
  filterRelevantProductsDeterministic,
  formatDisplayTitle,
  formatEuro,
  inferGramsPerPiece,
  isGenericStoreBrand,
  isShelfStableText,
  isCanSized,
  loadPreferenceContext,
  optimizeShoppingList,
  parseGroceryInput,
  pieceCountOf,
  priceCandidate,
  slugifyConcept,
} from "@/lib/engine";
import { getProvider } from "@/lib/providers/registry";
import { expandSearchQueries } from "@/lib/llm/openrouter";
import type {
  ActiveShoppingProviderId,
  ItemComparisonResult,
  ListOptimizationResult,
  ListResponse,
  NormalizedStoreProduct,
  ParsedGroceryInput,
  PricedCandidate,
  PushListPreview,
  PushListRequest,
  PushListResponse,
  PushListResult,
  RadarDeal,
  SavingsTriggerSource,
  ShoppingListItem,
  UpdateListItemRequest,
} from "@/lib/types";
import { badRequest, notFound } from "./errors";
import { emitEvent, nowIso } from "./eventBus";

const CHANNEL = { ah: "in_store", picnic: "delivery" } as const;
const RADAR_IDS = ["jumbo", "plus"] as const;
const PROVIDERS: ActiveShoppingProviderId[] = ["ah", "picnic"];
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_SEARCH_TIMEOUT_MS: Record<ActiveShoppingProviderId, number> = {
  ah: 12_000,
  picnic: 15_000,
};
const OPTIONAL_AI_TIMEOUT_MS = 3_000;

/* --------------------------------- Helpers -------------------------------- */

let cachedDbInstance: DatabaseSync | null = null;
const searchCache = new Map<string, { expiresAt: number; products: NormalizedStoreProduct[] }>();
const radarCache = new Map<string, { expiresAt: number; deals: RadarDeal[] }>();

function ensureCacheMatchesDb(): void {
  const db = getDb();
  if (db !== cachedDbInstance) {
    searchCache.clear();
    radarCache.clear();
    cachedDbInstance = db;
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`${label} overschreed ${timeoutMs} ms; fallback wordt gebruikt`);
      resolve(fallback);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function clearSearchCache(): void {
  searchCache.clear();
  radarCache.clear();
}

function withQty(parsed: ParsedGroceryInput, qty: number): ParsedGroceryInput {
  if (qty === parsed.multiplier) return parsed;
  return {
    ...parsed,
    multiplier: qty,
    totalTargetAmount: parsed.perPackAmount !== null ? parsed.perPackAmount * qty : null,
  };
}

function itemParsed(item: ShoppingListItem): ParsedGroceryInput {
  const base = parseGroceryInput(item.rawInput);
  if (item.targetBaseAmount !== null && item.targetBaseUnit !== null) {
    return {
      ...base,
      multiplier: Math.max(1, item.requestedQty),
      baseUnit: item.targetBaseUnit,
      totalTargetAmount: item.targetBaseAmount,
      perPackAmount: Math.round((item.targetBaseAmount / Math.max(1, item.requestedQty)) * 1000) / 1000,
    };
  }
  return withQty(base, item.requestedQty);
}

async function safeSearch(provider: ActiveShoppingProviderId, query: string): Promise<NormalizedStoreProduct[]> {
  ensureCacheMatchesDb();
  try {
    const adapter = getProvider(provider);
    const status = (await adapter.getAuthState()).status;
    const key = `${provider}:${status}:${query.trim().toLowerCase()}`;
    const hit = searchCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.products;
    const response = await withDeadline(
      adapter.searchProducts({ query, limit: 35 }),
      PROVIDER_SEARCH_TIMEOUT_MS[provider],
      { products: [], isMockFallback: true },
      `Productzoekopdracht bij ${provider}`,
    );
    const products = response.isMockFallback
      ? searchCachedStoreProducts(provider, query)
      : response.products;
    if (products.length > 0 && products.every((product) => !product.isMockFallback)) {
      searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, products });
    } else {
      searchCache.delete(key);
    }
    return products;
  } catch (error) {
    console.warn(`Productzoekopdracht bij ${provider} mislukt:`, error);
    return [];
  }
}

async function findRadarDeals(query: string): Promise<RadarDeal[]> {
  ensureCacheMatchesDb();
  const normQuery = query.trim().toLowerCase();
  const deals: RadarDeal[] = [];
  for (const id of RADAR_IDS) {
    try {
      const adapter = getProvider(id);
      const status = (await adapter.getAuthState()).status;
      if (status !== "authenticated") continue;
      const cacheKey = `${id}:${status}:${normQuery}`;
      const cached = radarCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        deals.push(...cached.deals);
        continue;
      }
      const { products } = await adapter.searchProducts({ query, limit: 20 });
      const providerDeals: RadarDeal[] = [];
      for (const p of filterRelevantProductsDeterministic(query, products)) {
        if (!p.promo && p.regularPriceCents <= p.currentPriceCents) continue;
        providerDeals.push({
          provider: id,
          title: p.title,
          priceCents: p.currentPriceCents,
          regularPriceCents: p.regularPriceCents,
          promoLabel: p.promo?.label ?? "Aanbieding",
          imageUrl: p.imageUrl,
        });
      }
      radarCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, deals: providerDeals });
      deals.push(...providerDeals);
    } catch {
      // radar is a best-effort extra
    }
  }
  return deals.slice(0, 6);
}

interface LineEvaluation {
  parsed: ParsedGroceryInput;
  conceptId: number;
  allowOvershoot: boolean;
  comparison: ItemComparisonResult;
  radarDeals: RadarDeal[];
  cheapestProductId: string | null;
  cheapestOverallCents: number | null;
}

function findCheapestOverallCandidate(
  parsed: ParsedGroceryInput,
  comparison: ItemComparisonResult,
): { cheapestProductId: string | null; cheapestOverallCents: number | null } {
  const refWinner =
    comparison.recommendedProvider === "picnic"
      ? (comparison.picnic.winner ?? comparison.ah.winner)
      : (comparison.ah.winner ?? comparison.picnic.winner);
  if (!refWinner) return { cheapestProductId: null, cheapestOverallCents: null };

  const pool = [
    comparison.ah.winner,
    ...comparison.ah.alternatives,
    comparison.ah.houseBrandChallenger,
    comparison.picnic.winner,
    ...comparison.picnic.alternatives,
    comparison.picnic.houseBrandChallenger,
  ].filter((c): c is PricedCandidate => !!c);

  let bestId: string | null = refWinner.product.id;
  let bestCents = refWinner.effectiveTotalCents;

  for (const c of pool) {
    let normCents: number | null = null;
    if (parsed.totalTargetAmount !== null) {
      const cMeets = c.product.baseUnit === parsed.baseUnit && c.totalSuppliedAmount >= parsed.totalTargetAmount;
      const refMeets =
        refWinner.product.baseUnit === parsed.baseUnit && refWinner.totalSuppliedAmount >= parsed.totalTargetAmount;
      if (!cMeets && refMeets) continue;
      normCents = c.effectiveTotalCents;
    } else if (c.product.id === refWinner.product.id) {
      normCents = c.effectiveTotalCents;
    } else {
      const sup = comparableSupply(refWinner.product, refWinner.packsNeeded, c.product, c.packsNeeded);
      if (!sup || sup.suppliedAh <= 0 || sup.suppliedPic <= 0) continue;
      normCents = Math.round((c.effectiveTotalCents / sup.suppliedPic) * sup.suppliedAh);
    }
    if (normCents !== null && normCents > 0 && normCents < bestCents) {
      bestCents = normCents;
      bestId = c.product.id;
    }
  }
  return { cheapestProductId: bestId, cheapestOverallCents: bestCents };
}

/** Search both stores (+ radar), filter via the concept cache/LLM, price and rank every candidate. */
async function evaluateLine(
  rawInput: string,
  opts: { qty?: number; allowOvershoot?: boolean; parsedOverride?: ParsedGroceryInput } = {},
): Promise<LineEvaluation | null> {
  const base = parseGroceryInput(rawInput);
  if (!base.searchQuery) return null;
  const parsed = opts.parsedOverride ?? withQty(base, opts.qty ?? base.multiplier);
  const allowOvershoot = opts.allowOvershoot ?? base.allowOvershootDefault;
  const slug = slugifyConcept(parsed.searchQuery);

  const [ahOriginal, picnicOriginal, radarDeals, expansion] = await Promise.all([
    safeSearch("ah", parsed.searchQuery),
    safeSearch("picnic", parsed.searchQuery),
    findRadarDeals(parsed.searchQuery),
    withDeadline(
      expandSearchQueries(parsed.searchQuery),
      OPTIONAL_AI_TIMEOUT_MS,
      { alternatives: [], safeAlternatives: [] },
      "AI-zoekuitbreiding",
    ),
  ]);
  const expanded = await Promise.all(
    expansion.alternatives.map(async (term) => Promise.all([safeSearch("ah", term), safeSearch("picnic", term)])),
  );
  const merge = (products: NormalizedStoreProduct[]) => [...new Map(products.map((p) => [p.id, p])).values()];
  const ahRaw = merge([...ahOriginal, ...expanded.flatMap(([ah]) => ah)]);
  const picnicRaw = merge([...picnicOriginal, ...expanded.flatMap(([, picnic]) => picnic)]);
  const all = [...ahRaw, ...picnicRaw];
  if (all.length > 0) upsertStoreProducts(all);

  const allIds = all.map((p) => p.id);
  const prefs = getPreferencesForProducts(allIds);
  const deterministicIds = new Set(
    [parsed.searchQuery, ...expansion.safeAlternatives]
      .flatMap((term) => filterRelevantProductsDeterministic(term, all)).map((p) => p.id),
  );

  const deterministicProducts = filterRelevantProductsDeterministic(parsed.searchQuery, all);
  const deterministicAlternativeProducts = expansion.safeAlternatives.flatMap((term) =>
    filterRelevantProductsDeterministic(term, all),
  );
  const deterministicAccepted = [...new Map(
    [...deterministicProducts, ...deterministicAlternativeProducts].map((product) => [product.id, product]),
  ).values()];
  const deterministicAcceptedIds = new Set(deterministicAccepted.map((product) => product.id));
  const deterministicAlternativeIds = deterministicAlternativeProducts
    .filter((product) => !deterministicProducts.some((exact) => exact.id === product.id))
    .map((product) => product.id);
  const filtered = await withDeadline(
    filterRelevantProducts(
      parsed.searchQuery, all, slug, expansion.alternatives, expansion.safeAlternatives,
    ),
    OPTIONAL_AI_TIMEOUT_MS,
    {
      products: deterministicAccepted,
      alternativeProductIds: deterministicAlternativeIds,
      rejectedProductIds: all.filter((product) => !deterministicAcceptedIds.has(product.id)).map((product) => product.id),
      conceptSlug: slug,
      usedLlm: false,
      apiCalls: 0,
    },
    "AI-productselectie",
  );
  const relevant = new Set(filtered.products.map((p) => p.id));
  const alternatives = new Set(filtered.alternativeProductIds);
  const rejected = new Set(filtered.rejectedProductIds);
  // Never drop a deterministic match that the household has actually bought before.
  for (const p of all) {
    if (deterministicIds.has(p.id) && ((prefs.get(p.id)?.timesBought ?? 0) > 0 || p.previouslyBought)) {
      relevant.add(p.id);
    }
  }

  const pick = (raw: NormalizedStoreProduct[]) => {
    let kept = raw.filter((p) => relevant.has(p.id));
    if (parsed.containerHint === "can") {
      const cans = kept.filter(isCanSized);
      if (cans.length > 0) kept = cans;
    }
    return kept;
  };
  const ahCandidates = pick(ahRaw);
  const picnicCandidates = pick(picnicRaw);

  const aliases = conceptSlugAliases(parsed.searchQuery);
  const concept =
    findConceptBySlugs([filtered.conceptSlug, slug, ...aliases]) ??
    upsertConcept({
      slug: filtered.conceptSlug || slug,
      name: parsed.searchQuery,
      baseUnit: parsed.baseUnit ?? ahCandidates[0]?.baseUnit ?? picnicCandidates[0]?.baseUnit ?? "g",
      isShelfStable: isShelfStableText(parsed.searchQuery),
    });

  const combinedCandidates = [...ahCandidates, ...picnicCandidates];
  const ids = combinedCandidates.map((p) => p.id);
  const gramsPerPieceHint = inferGramsPerPiece(combinedCandidates, parsed.searchQuery);
  const ctx = { ...loadPreferenceContext(concept.id, ids), gramsPerPieceHint };
  const price = (p: NormalizedStoreProduct, provider: ActiveShoppingProviderId): PricedCandidate => {
    const candidate = priceCandidate(p, parsed, {
      allowOvershoot,
      channel: CHANNEL[provider],
      affinityScore: prefs.get(p.id)?.affinityScore ?? 0,
      timesBought: prefs.get(p.id)?.timesBought ?? 0,
    });
    if (!relevant.has(p.id)) return candidate;
    return { ...candidate, matchKind: alternatives.has(p.id) ? "alternative" : "exact" };
  };

  const ahKeptIds = new Set(ahCandidates.map((p) => p.id));
  const picnicKeptIds = new Set(picnicCandidates.map((p) => p.id));
  const ahOther = ahRaw
    .filter((p) => !ahKeptIds.has(p.id) && !rejected.has(p.id))
    .map((p) => price(p, "ah"))
    .sort((a, b) => a.effectiveCentsPer1000Base - b.effectiveCentsPer1000Base)
    .slice(0, 15);
  const picnicOther = picnicRaw
    .filter((p) => !picnicKeptIds.has(p.id) && !rejected.has(p.id))
    .map((p) => price(p, "picnic"))
    .sort((a, b) => a.effectiveCentsPer1000Base - b.effectiveCentsPer1000Base)
    .slice(0, 15);

  let ahEval = evaluateStoreCandidates("ah", ahCandidates.map((p) => price(p, "ah")), ctx);
  let picnicEval = evaluateStoreCandidates("picnic", picnicCandidates.map((p) => price(p, "picnic")), ctx);

  // When no explicit target was typed and one store's winner is piece-counted ("4 stuks") while the other store
  // picked a larger bulk weight pack ("8 x 100 gram") with nearly identical unit price, align to the matching piece pack ("4 x 100 gram").
  if (parsed.totalTargetAmount === null && ahEval.winner && picnicEval.winner) {
    const alignPiecePack = (pieceSide: PricedCandidate, weightEval: typeof picnicEval): typeof picnicEval => {
      if (pieceSide.product.baseUnit !== "piece" || weightEval.winner?.product.baseUnit === "piece") return weightEval;
      const targetPieces = pieceCountOf(pieceSide.product);
      const currentPieces = weightEval.winner ? pieceCountOf(weightEval.winner.product) : null;
      if (!targetPieces || !currentPieces || targetPieces === currentPieces) return weightEval;
      const match = weightEval.alternatives.find(
        (alt) =>
          pieceCountOf(alt.product) === targetPieces &&
          alt.timesBought >= (weightEval.winner?.timesBought ?? 0) &&
          alt.effectiveCentsPer1000Base <= (weightEval.winner?.effectiveCentsPer1000Base ?? 0) * 1.03,
      );
      if (!match || !weightEval.winner) return weightEval;
      const allPool = [weightEval.winner, ...weightEval.alternatives];
      return {
        ...weightEval,
        winner: match,
        alternatives: allPool.filter((c) => c.product.id !== match.product.id).slice(0, 15),
      };
    };
    picnicEval = alignPiecePack(ahEval.winner, picnicEval);
    ahEval = alignPiecePack(picnicEval.winner!, ahEval);
  }

  const ah = { ...ahEval, otherResults: ahOther };
  const picnic = { ...picnicEval, otherResults: picnicOther };
  const defaultProvider = getDefaultProvider();
  const comparison = compareItemAcrossStores(parsed, concept.slug, ah, picnic, filtered.usedLlm, defaultProvider);
  const { cheapestProductId, cheapestOverallCents } = findCheapestOverallCandidate(parsed, comparison);
  return {
    parsed,
    conceptId: concept.id,
    allowOvershoot,
    comparison,
    radarDeals,
    cheapestProductId,
    cheapestOverallCents,
  };
}

const unitPrice = (p: NormalizedStoreProduct): number =>
  p.baseAmount > 0 ? (p.currentPriceCents / p.baseAmount) * (p.baseUnit === "piece" ? 1 : 1000) : Infinity;

/** "Jouw vaste keuze" note when the active product is the brand/line the user keeps buying (or pinned). */
function loyaltyNoteFor(item: ShoppingListItem): string | null {
  if (!item.conceptId || !item.assignedProvider) return null;
  const active = item.assignedProvider === "ah" ? item.ahProduct : item.picnicProduct;
  const concept = getConceptById(item.conceptId);
  if (!active || !concept) return null;

  if (concept.brandPreferenceMode === "house_brand") return active.isHouseBrand ? "Huismerk voorkeur" : null;

  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  let brand: string | null = null;
  let detail = "";
  if (concept.brandPreferenceMode === "pinned_brand" && concept.pinnedBrand) {
    brand = concept.pinnedBrand;
  } else if (concept.brandPreferenceMode === "auto") {
    const loyalty = getBrandLoyalty(item.conceptId);
    if (
      loyalty.totalPurchases >= 3 &&
      loyalty.topBrandShare >= 0.75 &&
      loyalty.topBrand &&
      !isGenericStoreBrand(loyalty.topBrand)
    ) {
      brand = loyalty.topBrand;
      detail = ` (${Math.round(loyalty.topBrandShare * 100)}% van je aankopen)`;
    }
  }
  if (!brand || isGenericStoreBrand(active.brand) || norm(active.brand) !== norm(brand)) return null;

  let note = `Jouw vaste keuze: ${active.brand}${detail}`;
  const houseIds = getDb()
    .prepare("SELECT id FROM store_products WHERE provider = ? AND is_house_brand = 1 AND available = 1")
    .all(active.provider) as Array<{ id: string }>;
  const challenger = filterRelevantProductsDeterministic(
    concept.name,
    getStoreProducts(houseIds.map((r) => r.id)).filter(
      (p) => p.id !== active.id && p.baseUnit === active.baseUnit && (active.isHouseBrand ? isGenericStoreBrand(p.brand) : true),
    ),
  ).sort((a, b) => unitPrice(a) - unitPrice(b))[0];
  if (challenger && unitPrice(challenger) < unitPrice(active)) {
    const diff = Math.round(unitPrice(active) - unitPrice(challenger));
    const unit = active.baseUnit === "g" ? "kg" : active.baseUnit === "ml" ? "l" : "stuk";
    note += ` — ${challenger.title} bespaart ${formatEuro(diff)}/${unit}`;
  }
  return note;
}

/** Adds loyalty note + promo-aware & piece/kg-bridged unit prices to a hydrated item. */
function enrichItem(item: ShoppingListItem): ShoppingListItem {
  const parsed = itemParsed(item);
  const options = { allowOvershoot: item.allowOvershoot };
  const ah = item.ahProduct
    ? priceCandidate(item.ahProduct, parsed, {
        ...options,
        channel: "in_store",
        exactPacks: item.ahQty > 0 ? item.ahQty : undefined,
      })
    : null;
  const picnic = item.picnicProduct
    ? priceCandidate(item.picnicProduct, parsed, {
        ...options,
        channel: "delivery",
        exactPacks: item.picnicQty > 0 ? item.picnicQty : undefined,
      })
    : null;
  const prefIds = [item.ahProductId, item.picnicProductId].filter((id): id is string => !!id);
  const prefs = getPreferencesForProducts(prefIds);
  const unitComp = buildUnitPriceComparison(ah, picnic, item.unitPriceComparison?.displayUnit ?? "stuk");
  return {
    ...item,
    unitPriceComparison: {
      ahCentsPerBase1000: unitComp.ahCentsPerBase1000,
      picnicCentsPerBase1000: unitComp.picnicCentsPerBase1000,
      displayUnit: unitComp.displayUnit,
      ahDisplayUnit: unitComp.ahDisplayUnit,
      picnicDisplayUnit: unitComp.picnicDisplayUnit,
    },
    loyaltyNote: loyaltyNoteFor(item),
    ahTimesBought: item.ahProductId ? (prefs.get(item.ahProductId)?.timesBought ?? 0) : 0,
    picnicTimesBought: item.picnicProductId ? (prefs.get(item.picnicProductId)?.timesBought ?? 0) : 0,
    ahPromoApplied: ah?.promoApplied ?? false,
    picnicPromoApplied: picnic?.promoApplied ?? false,
    ahPromoSummary: ah?.promoSummary ?? null,
    picnicPromoSummary: picnic?.promoSummary ?? null,
  };
}

/** Recomputes qty/total for both stores (plus normalized 100%-optimal floor) from the products currently on the item. */
function reprice(
  item: ShoppingListItem,
  exact?: { ahPacks?: number; picnicPacks?: number },
): {
  ahQty: number;
  ahTotalCents: number | null;
  picnicQty: number;
  picnicTotalCents: number | null;
  cheapestOverallCents?: number | null;
} {
  const parsed = itemParsed(item);
  const options = { allowOvershoot: item.allowOvershoot };
  const ah = item.ahProduct
    ? priceCandidate(item.ahProduct, parsed, { ...options, channel: "in_store", exactPacks: exact?.ahPacks })
    : null;
  const picnic = item.picnicProduct
    ? priceCandidate(item.picnicProduct, parsed, { ...options, channel: "delivery", exactPacks: exact?.picnicPacks })
    : null;

  let cheapestOverallCents: number | null | undefined;
  const refCand = item.assignedProvider === "picnic" ? (picnic ?? ah) : (ah ?? picnic);
  if (item.cheapestProduct && refCand) {
    const cheapCand = priceCandidate(item.cheapestProduct, parsed, {
      ...options,
      channel: item.cheapestProduct.provider === "picnic" ? "delivery" : "in_store",
    });
    if (parsed.totalTargetAmount !== null) {
      cheapestOverallCents = cheapCand.effectiveTotalCents;
    } else {
      const sup = comparableSupply(refCand.product, refCand.packsNeeded, cheapCand.product, cheapCand.packsNeeded);
      if (sup && sup.suppliedAh > 0 && sup.suppliedPic > 0) {
        cheapestOverallCents = Math.round((cheapCand.effectiveTotalCents / sup.suppliedPic) * sup.suppliedAh);
      }
    }
  }

  return {
    ahQty: ah?.packsNeeded ?? 0,
    ahTotalCents: ah?.effectiveTotalCents ?? null,
    picnicQty: picnic?.packsNeeded ?? 0,
    picnicTotalCents: picnic?.effectiveTotalCents ?? null,
    ...(cheapestOverallCents !== undefined ? { cheapestOverallCents } : {}),
  };
}

/** Builds a normalized, zero-double-counting savings breakdown for a shopping list item. */
export function computeItemSavingsEntry(
  item: ShoppingListItem,
  triggerSource: SavingsTriggerSource,
  completedAt?: string,
): CompletedShoppingItemInput | null {
  const provider = item.assignedProvider;
  if (!provider) return null;
  const chosenProduct = provider === "ah" ? item.ahProduct : item.picnicProduct;
  const chosenQty = Math.max(1, provider === "ah" ? item.ahQty : item.picnicQty);
  const chosenPaidCents = (provider === "ah" ? item.ahTotalCents : item.picnicTotalCents) ?? 0;
  if (chosenPaidCents <= 0) return null;

  const chosenRegularCents = Math.max(
    chosenPaidCents,
    chosenProduct ? chosenProduct.regularPriceCents * chosenQty : chosenPaidCents,
  );

  const otherRaw = provider === "ah" ? item.picnicTotalCents : item.ahTotalCents;
  let otherProviderCents: number | null = otherRaw;
  if (otherRaw !== null && item.targetBaseAmount === null) {
    const supply = comparableSupply(item.ahProduct, item.ahQty, item.picnicProduct, item.picnicQty);
    if (supply && supply.suppliedAh > 0 && supply.suppliedPic > 0 && supply.suppliedAh !== supply.suppliedPic) {
      const chosenSup = provider === "ah" ? supply.suppliedAh : supply.suppliedPic;
      const otherSup = provider === "ah" ? supply.suppliedPic : supply.suppliedAh;
      otherProviderCents = Math.round((otherRaw / otherSup) * chosenSup);
    }
  }

  const cheapestStoreCents =
    otherProviderCents !== null && otherProviderCents > 0
      ? Math.min(chosenPaidCents, otherProviderCents)
      : chosenPaidCents;

  let rawCheapestOverall = item.cheapestOverallCents;
  if (item.cheapestProduct && chosenProduct) {
    const parsed = itemParsed(item);
    const cheapCand = priceCandidate(item.cheapestProduct, parsed, {
      allowOvershoot: item.allowOvershoot,
      channel: item.cheapestProduct.provider === "picnic" ? "delivery" : "in_store",
    });
    if (item.targetBaseAmount !== null) {
      rawCheapestOverall = cheapCand.effectiveTotalCents;
    } else {
      const sup = comparableSupply(chosenProduct, chosenQty, cheapCand.product, cheapCand.packsNeeded);
      if (sup && sup.suppliedAh > 0 && sup.suppliedPic > 0) {
        rawCheapestOverall = Math.round((cheapCand.effectiveTotalCents / sup.suppliedPic) * sup.suppliedAh);
      }
    }
  }

  const cheapestOverallCents = Math.min(
    cheapestStoreCents,
    rawCheapestOverall != null && rawCheapestOverall > 0 ? rawCheapestOverall : cheapestStoreCents,
  );
  const baselineCents = Math.max(chosenRegularCents, otherProviderCents ?? chosenRegularCents, chosenPaidCents);

  return {
    completedAt,
    triggerSource,
    rawInput: item.rawInput,
    displayName: item.displayName,
    conceptId: item.conceptId,
    chosenProvider: provider,
    chosenProductId: chosenProduct?.id ?? null,
    chosenProductTitle: chosenProduct?.title ?? item.displayName,
    chosenBrand: chosenProduct?.brand ?? null,
    isHouseBrand: chosenProduct?.isHouseBrand ?? false,
    chosenQty,
    baselineCents,
    chosenRegularCents,
    chosenPaidCents,
    otherProviderCents,
    cheapestStoreCents,
    cheapestOverallCents,
    cheapestProductTitle: item.cheapestProduct?.title ?? chosenProduct?.title ?? null,
  };
}

/** Optimises the list; persists changed assignments of unlocked (and selected) items. */
function runOptimization(itemIds?: number[], forceMode?: "optimal" | "all_ah"): ListOptimizationResult {
  const selected = itemIds ? new Set(itemIds) : null;
  const current = listShoppingItems();
  const defaultProvider = getDefaultProvider();
  // Items outside the selection are pinned so they keep their store but still count in the totals.
  const input = current.map((i) =>
    selected && !selected.has(i.id) && i.assignedProvider ? { ...i, isProviderLocked: true } : i,
  );
  let result = optimizeShoppingList(input, { forceMode: "optimal", defaultProvider });
  if (forceMode === "all_ah" && result.picnicSubtotalCents < result.picnicAdvice.minOrderCents) {
    result = optimizeShoppingList(input, { forceMode: "all_ah", defaultProvider });
  }
  const before = new Map(current.map((i) => [i.id, i]));
  for (const item of result.items) {
    const prev = before.get(item.id)!;
    if (prev.isProviderLocked) continue;
    if (selected && !selected.has(item.id)) continue;
    if (item.assignedProvider !== prev.assignedProvider) {
      updateShoppingItem(item.id, { assignedProvider: item.assignedProvider });
    }
  }
  return { ...result, items: result.items.map((i) => enrichItem({ ...i, isProviderLocked: before.get(i.id)!.isProviderLocked })) };
}

/* ------------------------------- Public API ------------------------------- */

export async function addItemsToShoppingList(inputs: string[]): Promise<ShoppingListItem[]> {
  const evaluations: Array<{ line: string; ev: LineEvaluation }> = [];
  for (const line of inputs.map((l) => l.trim()).filter(Boolean)) {
    const ev = await evaluateLine(line);
    if (ev) evaluations.push({ line, ev });
  }
  if (evaluations.length === 0) return [];

  // Place newly added items at the top of the list while preserving their typed order.
  const topOrders = allocateTopSortOrders(evaluations.length);
  const createdIds: number[] = [];
  for (let idx = 0; idx < evaluations.length; idx++) {
    const { line, ev } = evaluations[idx];
    const { parsed, comparison, conceptId, allowOvershoot, radarDeals, cheapestProductId, cheapestOverallCents } = ev;
    const ah = comparison.ah.winner;
    const picnic = comparison.picnic.winner;
    const item = insertShoppingItem({
      rawInput: line,
      displayName: parsed.displayName,
      requestedQty: parsed.multiplier,
      requestedUnitRaw: parsed.perPackAmount !== null ? `${parsed.perPackAmount}${parsed.baseUnit}` : null,
      targetBaseAmount: parsed.totalTargetAmount,
      targetBaseUnit: parsed.baseUnit,
      conceptId,
      allowOvershoot,
      assignedProvider: ah || picnic ? comparison.recommendedProvider : null,
      isProviderLocked: false,
      ahProductId: ah?.product.id ?? null,
      ahQty: ah?.packsNeeded ?? 0,
      ahTotalCents: ah?.effectiveTotalCents ?? null,
      picnicProductId: picnic?.product.id ?? null,
      picnicQty: picnic?.packsNeeded ?? 0,
      picnicTotalCents: picnic?.effectiveTotalCents ?? null,
      cheapestProductId,
      cheapestOverallCents,
      radarDeals,
      sortOrder: topOrders[idx],
    });
    createdIds.push(item.id);
  }
  runOptimization();
  emitEvent({ type: "list.changed", at: nowIso(), itemIds: createdIds });
  return createdIds.map((id) => getShoppingItem(id)).filter((i): i is ShoppingListItem => !!i).map(enrichItem);
}

export function getFullListState(): ListResponse {
  const persistedItems = listShoppingItems();
  const persisted = new Map(persistedItems.map((i) => [i.id, i]));
  const result = optimizeShoppingList(persistedItems, {
    preserveAssigned: true,
    defaultProvider: getDefaultProvider(),
  });
  return {
    items: result.items.map((i) => enrichItem({ ...i, isProviderLocked: persisted.get(i.id)?.isProviderLocked ?? false })),
    ahSubtotalCents: result.ahSubtotalCents,
    picnicSubtotalCents: result.picnicSubtotalCents,
    totalCents: result.totalCents,
    totalSavingsCents: result.totalSavingsCents,
    picnicAdvice: result.picnicAdvice,
  };
}

export async function getItemComparisonDetails(
  itemId: number,
): Promise<ItemComparisonResult & { item: ShoppingListItem }> {
  const item = getShoppingItem(itemId);
  if (!item) throw notFound("Item niet gevonden");
  const ev = await evaluateLine(item.rawInput, {
    parsedOverride: itemParsed(item),
    allowOvershoot: item.allowOvershoot,
  });
  if (!ev) throw badRequest("Item heeft geen zoekopdracht");
  return { ...ev.comparison, item: enrichItem(item) };
}

export async function updateItem(itemId: number, patch: UpdateListItemRequest): Promise<ShoppingListItem> {
  const item = getShoppingItem(itemId);
  if (!item) throw notFound("Item niet gevonden");

  const next: Parameters<typeof updateShoppingItem>[1] = {};
  let preferencesChanged = false;
  let needsReprice = false;
  let exactPackOverride: { ahPacks?: number; picnicPacks?: number } | undefined;

  if (patch.isChecked !== undefined) next.isChecked = !!patch.isChecked;
  if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
  if (patch.allowOvershoot !== undefined) {
    next.allowOvershoot = !!patch.allowOvershoot;
    needsReprice = true;
  }
  if (patch.requestedQty !== undefined) {
    if (!Number.isInteger(patch.requestedQty) || patch.requestedQty < 1) throw badRequest("Ongeldig aantal");
    next.requestedQty = patch.requestedQty;
    if (item.targetBaseAmount !== null && item.targetBaseUnit !== null) {
      const base = parseGroceryInput(item.rawInput);
      const perUnit = base.perPackAmount ?? item.targetBaseAmount / Math.max(1, item.requestedQty);
      const newTarget = Math.round(perUnit * patch.requestedQty * 1000) / 1000;
      next.targetBaseAmount = newTarget;
      next.displayName = formatDisplayTitle(base.searchQuery, newTarget, item.targetBaseUnit, patch.requestedQty);
    }
    needsReprice = true;
  }
  if (patch.packCount !== undefined) {
    if (!Number.isInteger(patch.packCount) || patch.packCount < 1 || patch.packCount > 99) {
      throw badRequest("Ongeldig aantal verpakkingen");
    }
    const packs = patch.packCount;
    const activeProv: ActiveShoppingProviderId =
      patch.assignedProvider ?? item.assignedProvider ?? (item.ahProduct ? "ah" : "picnic");
    const activeProd =
      activeProv === "ah" ? (item.ahProduct ?? item.picnicProduct) : (item.picnicProduct ?? item.ahProduct);
    const base = parseGroceryInput(item.rawInput);

    next.requestedQty = packs;
    if (
      item.targetBaseAmount !== null &&
      item.targetBaseUnit !== null &&
      item.targetBaseUnit !== "piece" &&
      activeProd &&
      activeProd.baseUnit === item.targetBaseUnit &&
      activeProd.baseAmount > 0
    ) {
      const newTarget = Math.round(packs * activeProd.baseAmount * 1000) / 1000;
      next.targetBaseAmount = newTarget;
      next.requestedUnitRaw = `${activeProd.baseAmount}${activeProd.baseUnit}`;
      next.displayName = formatDisplayTitle(base.searchQuery, newTarget, item.targetBaseUnit, packs);
      exactPackOverride = activeProv === "ah" ? { ahPacks: packs } : { picnicPacks: packs };
    } else if (item.targetBaseAmount !== null && item.targetBaseUnit === "piece" && activeProd) {
      const pcsPerPack = pieceCountOf(activeProd) ?? 1;
      const newTarget = packs * pcsPerPack;
      next.targetBaseAmount = newTarget;
      next.displayName = formatDisplayTitle(base.searchQuery, newTarget, "piece", newTarget);
      exactPackOverride = activeProv === "ah" ? { ahPacks: packs } : { picnicPacks: packs };
    } else {
      exactPackOverride = { ahPacks: packs, picnicPacks: packs };
    }
    needsReprice = true;
  }
  if (patch.assignedProvider !== undefined) {
    if (!PROVIDERS.includes(patch.assignedProvider)) throw badRequest("Onbekende winkel");
    next.assignedProvider = patch.assignedProvider;
    next.isProviderLocked = patch.isProviderLocked ?? true;
  } else if (patch.isProviderLocked !== undefined) {
    next.isProviderLocked = patch.isProviderLocked;
    if (patch.isProviderLocked === false) {
      needsReprice = true;
    }
  }

  if (patch.chosenProduct) {
    const { provider, productId } = patch.chosenProduct;
    if (!PROVIDERS.includes(provider)) throw badRequest("Onbekende winkel");
    const product = getStoreProduct(productId);
    if (!product || product.provider !== provider) throw badRequest("Product niet gevonden bij deze winkel");
    const previous = provider === "ah" ? item.ahProductId : item.picnicProductId;
    if (previous && previous !== productId) recordManualReject(previous, item.conceptId);
    recordManualPick(productId, item.conceptId);
    if (provider === "ah") next.ahProductId = productId;
    else next.picnicProductId = productId;
    next.assignedProvider = provider;
    next.isProviderLocked = true;
    preferencesChanged = true;
    needsReprice = true;
  }

  if (Object.keys(next).length > 0) updateShoppingItem(itemId, next);
  if (needsReprice) {
    const fresh = getShoppingItem(itemId)!;
    const repriced = reprice(fresh, exactPackOverride);
    const updateRepriced: Parameters<typeof updateShoppingItem>[1] = { ...repriced };
    // When unlocked, re-evaluate store choice so unlocking or newly activated promos pick the cheapest store immediately.
    if (!fresh.isProviderLocked && patch.assignedProvider === undefined && !patch.chosenProduct) {
      const candidateItem: ShoppingListItem = { ...fresh, ...repriced };
      const opt = optimizeShoppingList([candidateItem], {
        forceMode: "optimal",
        defaultProvider: getDefaultProvider(),
      });
      const newProvider = opt.items[0]?.assignedProvider ?? fresh.assignedProvider;
      if (newProvider && newProvider !== fresh.assignedProvider) {
        updateRepriced.assignedProvider = newProvider;
      }
    }
    updateShoppingItem(itemId, updateRepriced);
  }

  emitEvent({ type: "list.changed", at: nowIso(), itemIds: [itemId] });
  if (preferencesChanged) emitEvent({ type: "preferences.changed", at: nowIso() });
  return enrichItem(getShoppingItem(itemId)!);
}

export function removeItem(itemId: number): void {
  if (!deleteShoppingItem(itemId)) throw notFound("Item niet gevonden");
  emitEvent({ type: "list.changed", at: nowIso(), itemIds: [itemId] });
}

export function clearList(scope: "checked" | "all"): number {
  let statsRecorded = 0;
  if (scope === "checked") {
    const at = nowIso();
    const unrecordedChecked = listShoppingItems().filter(
      (i) => i.isChecked && !i.recordedInStatsAt && i.assignedProvider !== null,
    );
    const entries = unrecordedChecked
      .map((i) => computeItemSavingsEntry(i, "checked_clear", at))
      .filter((e): e is CompletedShoppingItemInput => e !== null);
    statsRecorded = insertCompletedShoppingItems(entries);
  }
  const removed =
    scope === "checked"
      ? clearCheckedShoppingItems()
      : Number(getDb().prepare("DELETE FROM shopping_list_items").run().changes);
  emitEvent({ type: "list.cleared", at: nowIso() });
  if (statsRecorded > 0) emitEvent({ type: "stats.changed", at: nowIso() });
  return removed;
}

export function optimizeUnlockedList(itemIds?: number[], forceMode?: "optimal" | "all_ah"): ListOptimizationResult {
  const result = runOptimization(itemIds, forceMode);
  emitEvent({ type: "list.changed", at: nowIso() });
  return result;
}

function buildPreviews(providers: ActiveShoppingProviderId[]): PushListPreview[] {
  const open = listShoppingItems().filter((i) => !i.isChecked && i.assignedProvider);
  const previews: PushListPreview[] = [];
  for (const provider of providers) {
    const items: PushListPreview["items"] = [];
    let subtotalCents = 0;
    for (const i of open.filter((o) => o.assignedProvider === provider)) {
      const product = provider === "ah" ? i.ahProduct : i.picnicProduct;
      if (!product) continue;
      items.push({
        itemId: i.id,
        externalId: product.externalId,
        title: product.title,
        quantity: Math.max(1, provider === "ah" ? i.ahQty : i.picnicQty),
      });
      subtotalCents += (provider === "ah" ? i.ahTotalCents : i.picnicTotalCents) ?? 0;
    }
    if (items.length > 0) previews.push({ provider, items, subtotalCents });
  }
  return previews;
}

export async function pushListToStores(req: PushListRequest): Promise<PushListResponse> {
  const providers = (req.providers?.length ? req.providers : PROVIDERS).filter((p) => PROVIDERS.includes(p));
  const previews = buildPreviews(providers);
  if (req.mode !== "push") return { mode: "preview", previews };

  const autoCheck = req.autoCheckPushed !== false;
  let statsRecorded = 0;
  const results: PushListResult[] = [];
  for (const preview of previews) {
    const adapter = getProvider(preview.provider);
    if (!adapter.pushItems) {
      results.push({ provider: preview.provider, success: false, itemsPushed: 0, message: "Winkel ondersteunt geen lijst-push" });
      continue;
    }
    try {
      const res = await adapter.pushItems(
        preview.items.map(({ externalId, title, quantity }) => ({ externalId, title, quantity })),
      );
      results.push(res);
      if (res.success) {
        const at = nowIso();
        const entries: CompletedShoppingItemInput[] = [];
        for (const i of preview.items) {
          const full = getShoppingItem(i.itemId);
          if (full && !full.recordedInStatsAt) {
            const entry = computeItemSavingsEntry(full, "push", at);
            if (entry) entries.push(entry);
          }
          updateShoppingItem(i.itemId, {
            pushedToStoreAt: at,
            recordedInStatsAt: full?.recordedInStatsAt ?? at,
            ...(autoCheck ? { isChecked: true } : {}),
          });
        }
        statsRecorded += insertCompletedShoppingItems(entries);
      }
    } catch (e) {
      results.push({
        provider: preview.provider,
        success: false,
        itemsPushed: 0,
        message: e instanceof Error ? e.message : "Push mislukt",
      });
    }
  }
  emitEvent({ type: "list.changed", at: nowIso() });
  if (statsRecorded > 0) emitEvent({ type: "stats.changed", at: nowIso() });
  return { mode: "push", previews, results };
}
