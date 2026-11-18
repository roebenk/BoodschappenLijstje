import { getDb } from "@/lib/db";
import {
  countDismissedDeals,
  dismissWeekDeal,
  findConceptBySlugs,
  getConceptById,
  getDefaultProvider,
  getSelectedAiModel,
  getDismissedDealKeys,
  getStoreProducts,
  getTopPreferences,
  linkConceptToProduct,
  listPurchaseHistory,
  recomputeProductPreferences,
  restoreAllWeekDeals,
  restoreWeekDeal,
  setConceptBrandPreference,
  setDefaultProvider,
  setSelectedAiModel,
  upsertConcept,
} from "@/lib/db/repositories";
import { categorizeReceiptItemsBatch, conceptSlugAliases, slugifyConcept } from "@/lib/engine";
import { getProvider } from "@/lib/providers/registry";
import { getRuntimeConfig } from "@/lib/config";
import { AI_MODELS } from "@/lib/llm/models";
import type {
  ActiveShoppingProviderId,
  PreferenceView,
  PreferencesResponse,
  RadarDeal,
  StoreProviderId,
  SyncHistoryResult,
  UpdateConceptPreferenceRequest,
} from "@/lib/types";
import { badRequest, notFound } from "./errors";
import { emitEvent, nowIso } from "./eventBus";
import { clearSearchCache, optimizeUnlockedList } from "./shoppingService";

const MODES = ["auto", "house_brand", "pinned_brand"];
const DEFAULT_PROVIDERS: ActiveShoppingProviderId[] = ["ah", "picnic"];

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getPreferencesView(): Promise<PreferencesResponse> {
  const prefs = getTopPreferences({ limit: 50 });
  const products = new Map(getStoreProducts(prefs.map((p) => p.storeProductId)).map((p) => [p.id, p]));
  const preferences: PreferenceView[] = prefs.map((p) => {
    const product = products.get(p.storeProductId);
    const concept = p.conceptId ? getConceptById(p.conceptId) : null;
    return {
      ...p,
      productTitle: product?.title ?? null,
      brand: product?.brand ?? null,
      provider: product?.provider ?? null,
      conceptName: concept?.name ?? null,
      imageUrl: product?.imageUrl ?? null,
      brandPreferenceMode: concept?.brandPreferenceMode ?? "auto",
      pinnedBrand: concept?.pinnedBrand ?? null,
    };
  });

  // Current promos on products the user buys often…
  const dismissedKeys = getDismissedDealKeys();
  const seenKeys = new Set<string>();
  const seenTitles = new Set<string>();
  const weekDeals: RadarDeal[] = [];
  for (const p of prefs.filter((x) => x.timesBought > 0)) {
    const product = products.get(p.storeProductId);
    if (!product || (!product.promo && product.regularPriceCents <= product.currentPriceCents)) continue;
    const dealKey = `product:${p.storeProductId}`;
    if (dismissedKeys.has(dealKey) || seenKeys.has(dealKey)) continue;
    seenKeys.add(dealKey);
    seenTitles.add(`${product.provider}:${product.title.trim().toLowerCase()}`);
    weekDeals.push({
      dealKey,
      provider: product.provider,
      title: product.title,
      priceCents: product.currentPriceCents,
      regularPriceCents: product.regularPriceCents,
      promoLabel: product.promo?.label ?? "Aanbieding",
      imageUrl: product.imageUrl,
      timesBought: p.timesBought,
    });
  }
  // …plus a few store spotlights (best effort; never blocks the page for long).
  const spotlights = await Promise.all(
    (["ah", "picnic"] as const).map((id) =>
      withTimeout(getProvider(id).getPromotions?.() ?? Promise.resolve<RadarDeal[]>([]), 4000, [] as RadarDeal[]),
    ),
  );
  for (const deals of spotlights) {
    for (const d of deals.slice(0, 5)) {
      const dealKey = d.dealKey ?? `spotlight:${d.provider}:${slugifyConcept(d.title)}`;
      const titleKey = `${d.provider}:${d.title.trim().toLowerCase()}`;
      if (dismissedKeys.has(dealKey) || seenKeys.has(dealKey) || seenTitles.has(titleKey)) continue;
      seenKeys.add(dealKey);
      seenTitles.add(titleKey);
      weekDeals.push({ ...d, dealKey });
    }
  }
  return {
    preferences,
    weekDeals,
    dismissedDealsCount: countDismissedDeals(),
    settings: getAppSettings(),
  };
}

export function getAppSettings(): NonNullable<PreferencesResponse["settings"]> {
  const config = getRuntimeConfig();
  return {
    defaultProvider: getDefaultProvider(),
    aiModel: getSelectedAiModel() ?? config.openRouterDefaultModel,
    aiFallbackModel: config.openRouterFallbackModel,
    aiConfigured: config.hasOpenRouterKey,
  };
}

export function updateConceptPreference(req: UpdateConceptPreferenceRequest): void {
  const hasDefaultProvider = req.defaultProvider !== undefined;
  const hasAiModel = req.aiModel !== undefined;
  const hasConceptUpdate = req.conceptId !== undefined || req.brandPreferenceMode !== undefined;
  const hasDismissDeal = typeof req.dismissDealKey === "string" && req.dismissDealKey.trim().length > 0;
  const hasRestoreDeal = typeof req.restoreDealKey === "string" && req.restoreDealKey.trim().length > 0;
  const hasRestoreAllDeals = req.restoreAllDeals === true;

  if (!hasDefaultProvider && !hasAiModel && !hasConceptUpdate && !hasDismissDeal && !hasRestoreDeal && !hasRestoreAllDeals) {
    throw badRequest("Geen wijziging opgegeven");
  }
  if (hasAiModel && !AI_MODELS.some((model) => model.id === req.aiModel)) {
    throw badRequest("Ongeldig AI-model");
  }

  if (hasDismissDeal) {
    dismissWeekDeal(req.dismissDealKey!.trim(), req.dismissDealLabel ?? null);
  }
  if (hasRestoreDeal) {
    restoreWeekDeal(req.restoreDealKey!.trim());
  }
  if (hasRestoreAllDeals) {
    restoreAllWeekDeals();
  }

  if (hasDefaultProvider) {
    if (!DEFAULT_PROVIDERS.includes(req.defaultProvider!)) {
      throw badRequest("Ongeldige standaardwinkel");
    }
    setDefaultProvider(req.defaultProvider!);
    optimizeUnlockedList();
  }

  if (hasAiModel) setSelectedAiModel(req.aiModel!);

  if (hasConceptUpdate) {
    if (req.conceptId === undefined || !Number.isInteger(req.conceptId)) throw badRequest("conceptId ontbreekt");
    if (!req.brandPreferenceMode || !MODES.includes(req.brandPreferenceMode)) {
      throw badRequest("Ongeldige brandPreferenceMode");
    }
    if (req.brandPreferenceMode === "pinned_brand" && !req.pinnedBrand?.trim()) {
      throw badRequest("pinnedBrand is verplicht bij pinned_brand");
    }
    if (!getConceptById(req.conceptId)) throw notFound("Concept niet gevonden");
    setConceptBrandPreference(req.conceptId, req.brandPreferenceMode, req.pinnedBrand?.trim() ?? null);
  }

  emitEvent({ type: "preferences.changed", at: nowIso() });
}

/** Links synced history products to canonical concepts (LLM or keyword cleanup) and rebuilds affinities. */
export async function linkHistoryToConcepts(): Promise<void> {
  const linked = new Set(
    (
      getDb()
        .prepare("SELECT store_product_id FROM concept_product_links WHERE is_valid_match = 1")
        .all() as Array<{ store_product_id: string }>
    ).map((r) => r.store_product_id),
  );
  const history = listPurchaseHistory(2000).filter((h) => h.storeProductId && !linked.has(h.storeProductId));
  const byName = new Map<string, string[]>();
  for (const h of history) {
    const list = byName.get(h.rawName) ?? [];
    if (!list.includes(h.storeProductId!)) list.push(h.storeProductId!);
    byName.set(h.rawName, list);
  }
  const names = [...byName.keys()].slice(0, 200);
  if (names.length > 0) {
    const allProductIds = [...new Set(names.flatMap((n) => byName.get(n) ?? []))];
    const products = new Map(getStoreProducts(allProductIds).map((p) => [p.id, p]));
    for (const c of await categorizeReceiptItemsBatch(names)) {
      const productIds = byName.get(c.rawName);
      if (!productIds?.length || !c.conceptSlug) continue;
      const aliases = conceptSlugAliases(c.conceptName);
      const concept =
        findConceptBySlugs([c.conceptSlug, ...aliases]) ??
        upsertConcept({
          slug: c.conceptSlug,
          name: c.conceptName,
          baseUnit: products.get(productIds[0])?.baseUnit ?? "g",
        });
      for (const productId of productIds) {
        linkConceptToProduct(concept.id, productId, true, "history");
      }
    }
  }
  recomputeProductPreferences();
}

export async function syncStore(provider: StoreProviderId): Promise<SyncHistoryResult> {
  const adapter = getProvider(provider);
  if (!adapter.syncHistory) throw badRequest("Deze winkel ondersteunt geen geschiedenis-sync");
  const result = await adapter.syncHistory();
  clearSearchCache();
  try {
    await linkHistoryToConcepts();
  } catch {
    // concept linking is an enhancement; the sync itself succeeded
  }
  emitEvent({ type: "stores.changed", at: nowIso(), provider });
  emitEvent({ type: "preferences.changed", at: nowIso() });
  return result;
}
