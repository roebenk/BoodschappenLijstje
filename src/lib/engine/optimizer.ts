import { getRuntimeConfig } from "@/lib/config";
import type {
  ActiveShoppingProviderId,
  DisplayUnit,
  ItemComparisonResult,
  ListOptimizationResult,
  NormalizedStoreProduct,
  ParsedGroceryInput,
  PicnicThresholdAdvice,
  PricedCandidate,
  ShoppingListItem,
  StoreEvaluation,
} from "@/lib/types";
import { buildUnitPriceComparison, costForPacks, formatEuro, pieceCountOf } from "./pricing";

const NAMES: Record<ActiveShoppingProviderId, string> = { ah: "AH", picnic: "Picnic" };

function promoReason(provider: ActiveShoppingProviderId, c: PricedCandidate): string {
  const label = c.product.promo?.label ?? c.promoSummary ?? "actie";
  const prefix = provider === "ah" ? "AH Bonus" : "Picnic actie";
  return `${prefix} ${label} bespaart ${formatEuro(c.savingsCents)}`;
}

/**
 * Returns normalized supplied amounts when AH and Picnic products either share `baseUnit`
 * OR can be bridged via `pieceCount` (e.g. AH "4 stuks" vs Picnic "8 x 100 gram").
 */
export function comparableSupply(
  ahProd: NormalizedStoreProduct | null | undefined,
  ahQty: number,
  picProd: NormalizedStoreProduct | null | undefined,
  picQty: number,
): { suppliedAh: number; suppliedPic: number; displayUnit: DisplayUnit } | null {
  if (!ahProd || !picProd) return null;
  const qA = Math.max(1, ahQty);
  const qP = Math.max(1, picQty);
  if (ahProd.baseUnit === picProd.baseUnit && ahProd.baseAmount > 0 && picProd.baseAmount > 0) {
    const unit: DisplayUnit = ahProd.baseUnit === "g" ? "kg" : ahProd.baseUnit === "ml" ? "l" : "stuk";
    return { suppliedAh: ahProd.baseAmount * qA, suppliedPic: picProd.baseAmount * qP, displayUnit: unit };
  }
  const pcA = pieceCountOf(ahProd);
  const pcP = pieceCountOf(picProd);
  if (pcA && pcP) {
    return { suppliedAh: pcA * qA, suppliedPic: pcP * qP, displayUnit: "stuk" };
  }
  return null;
}

/** Compares the winners of both stores for one item and explains the choice in Dutch. */
export function compareItemAcrossStores(
  parsed: ParsedGroceryInput,
  conceptSlug: string,
  ah: StoreEvaluation,
  picnic: StoreEvaluation,
  usedLlm = false,
  defaultProvider: ActiveShoppingProviderId = "ah",
): ItemComparisonResult {
  const a = ah.winner;
  const p = picnic.winner;
  const base = { parsed, conceptSlug, ah, picnic, usedLlm };
  if (!a && !p) {
    return {
      ...base,
      recommendedProvider: defaultProvider,
      savingsOverOtherStoreCents: 0,
      reason: "Geen aanbod gevonden bij AH of Picnic",
    };
  }
  if (a && !p) {
    return { ...base, recommendedProvider: "ah", savingsOverOtherStoreCents: 0, reason: "Alleen bij AH verkrijgbaar" };
  }
  if (!a && p) {
    return { ...base, recommendedProvider: "picnic", savingsOverOtherStoreCents: 0, reason: "Alleen bij Picnic verkrijgbaar" };
  }
  const ca = a!;
  const cp = p!;
  const target = parsed.totalTargetAmount;
  const supply = comparableSupply(ca.product, ca.packsNeeded, cp.product, cp.packsNeeded);
  const unitBridge = buildUnitPriceComparison(ca, cp);
  const sameUnit = ca.product.baseUnit === cp.product.baseUnit;
  const bothFulfil =
    target !== null &&
    ((sameUnit && ca.totalSuppliedAmount >= target && cp.totalSuppliedAmount >= target) ||
      (parsed.baseUnit === "piece" && supply !== null && supply.suppliedAh >= target && supply.suppliedPic >= target));
  const supplyDiffers = supply !== null && supply.suppliedAh !== supply.suppliedPic;

  // Pack sizes / piece counts differ without a fixed target: compare normalized unit price; otherwise basket total.
  const useUnitPrice = supplyDiffers && !bothFulfil && unitBridge.comparable;
  const unitA = unitBridge.ahCentsPerBase1000 ?? ca.effectiveCentsPer1000Base;
  const unitP = unitBridge.picnicCentsPerBase1000 ?? cp.effectiveCentsPer1000Base;
  const diffA = useUnitPrice ? unitA : ca.effectiveTotalCents;
  const diffP = useUnitPrice ? unitP : cp.effectiveTotalCents;

  let winner: ActiveShoppingProviderId;
  if (diffP < diffA) winner = "picnic";
  else if (diffA < diffP) winner = "ah";
  else if (unitBridge.comparable && unitP < unitA) winner = "picnic";
  else if (unitBridge.comparable && unitA < unitP) winner = "ah";
  else winner = defaultProvider;

  const win = winner === "ah" ? ca : cp;
  const lose = winner === "ah" ? cp : ca;
  const winUnit = winner === "ah" ? unitA : unitP;
  const loseUnit = winner === "ah" ? unitP : unitA;
  const unitLabel = unitBridge.comparable ? unitBridge.displayUnit : win.displayUnit;

  let totalDiff = Math.max(0, lose.effectiveTotalCents - win.effectiveTotalCents);
  if (useUnitPrice && supply) {
    const winSupplied = winner === "ah" ? supply.suppliedAh : supply.suppliedPic;
    const loseSupplied = winner === "ah" ? supply.suppliedPic : supply.suppliedAh;
    const eqLoseCents = Math.round((lose.effectiveTotalCents / loseSupplied) * winSupplied);
    totalDiff = Math.max(0, eqLoseCents - win.effectiveTotalCents);
  }
  const unitDiff = unitBridge.comparable ? Math.max(0, loseUnit - winUnit) : 0;

  let reason: string;
  if (win.promoApplied && win.savingsCents > 0 && (win.effectiveTotalCents < lose.effectiveTotalCents || unitDiff > 0)) {
    reason = promoReason(winner, win);
  } else if (diffA === diffP && unitDiff === 0) {
    reason = `Zelfde prijs; ${NAMES[winner]} gekozen`;
  } else if (useUnitPrice || totalDiff === 0) {
    reason = `${NAMES[winner]} ${formatEuro(unitDiff)}/${unitLabel} goedkoper`;
  } else if (unitBridge.comparable) {
    reason = `${NAMES[winner]} ${formatEuro(totalDiff)} goedkoper (${formatEuro(unitDiff)}/${unitLabel})`;
  } else {
    reason = `${NAMES[winner]} ${formatEuro(totalDiff)} goedkoper`;
  }
  return { ...base, recommendedProvider: winner, savingsOverOtherStoreCents: totalDiff, reason };
}

export interface OptimizeOptions {
  minPicnicOrderCents?: number;
  forceMode?: "optimal" | "all_ah";
  preserveAssigned?: boolean;
  defaultProvider?: ActiveShoppingProviderId;
}

function totalFor(item: ShoppingListItem, provider: ActiveShoppingProviderId): number | null {
  return provider === "ah" ? item.ahTotalCents : item.picnicTotalCents;
}

function savingsForAssigned(item: ShoppingListItem, provider: ActiveShoppingProviderId): number {
  const other: ActiveShoppingProviderId = provider === "ah" ? "picnic" : "ah";
  const chosen = totalFor(item, provider);
  const alt = totalFor(item, other);
  if (chosen === null || alt === null) return 0;

  if (item.targetBaseAmount === null) {
    const supply = comparableSupply(item.ahProduct, item.ahQty, item.picnicProduct, item.picnicQty);
    if (supply && supply.suppliedAh !== supply.suppliedPic) {
      const chosenSupplied = provider === "ah" ? supply.suppliedAh : supply.suppliedPic;
      const otherSupplied = provider === "ah" ? supply.suppliedPic : supply.suppliedAh;
      const eqOtherCents = Math.round((alt / otherSupplied) * chosenSupplied);
      return Math.max(0, eqOtherCents - chosen);
    }
  }
  return Math.max(0, alt - chosen);
}

function compareUnlockedStores(
  item: ShoppingListItem,
  defaultProvider: ActiveShoppingProviderId,
): { winner: ActiveShoppingProviderId; savingsCents: number } {
  const ah = item.ahTotalCents!;
  const pic = item.picnicTotalCents!;

  if (item.targetBaseAmount === null) {
    const supply = comparableSupply(item.ahProduct, item.ahQty, item.picnicProduct, item.picnicQty);
    if (supply && supply.suppliedAh !== supply.suppliedPic) {
      const ahPerUnit = ah / supply.suppliedAh;
      const picPerUnit = pic / supply.suppliedPic;
      const eps = 1e-9;
      let winner: ActiveShoppingProviderId;
      if (picPerUnit + eps < ahPerUnit) winner = "picnic";
      else if (ahPerUnit + eps < picPerUnit) winner = "ah";
      else winner = defaultProvider;
      const chosenSupplied = winner === "ah" ? supply.suppliedAh : supply.suppliedPic;
      const otherPerUnit = winner === "ah" ? picPerUnit : ahPerUnit;
      const chosenTotal = winner === "ah" ? ah : pic;
      const eqOtherCents = Math.round(otherPerUnit * chosenSupplied);
      return { winner, savingsCents: Math.max(0, eqOtherCents - chosenTotal) };
    }
  }

  let winner: ActiveShoppingProviderId;
  if (pic < ah) winner = "picnic";
  else if (ah < pic) winner = "ah";
  else winner = defaultProvider;
  const savingsCents = Math.abs(ah - pic);
  return { winner, savingsCents };
}

/** Assigns each item to a store and totals the basket, including Picnic minimum-order advice and shared-product promos. */
export function optimizeShoppingList(items: ShoppingListItem[], options: OptimizeOptions = {}): ListOptimizationResult {
  const min = options.minPicnicOrderCents ?? getRuntimeConfig().picnicMinOrderCents;
  const forceAh = options.forceMode === "all_ah";
  const defaultProvider = options.defaultProvider ?? "ah";

  const result = items.map((item): ShoppingListItem => {
    const ah = item.ahTotalCents;
    const pic = item.picnicTotalCents;
    let provider: ActiveShoppingProviderId | null = null;
    let savingsCents = 0;
    if ((item.isProviderLocked || options.preserveAssigned) && item.assignedProvider) {
      provider = item.assignedProvider;
      if (options.preserveAssigned || item.targetBaseAmount !== null || item.isProviderLocked) {
        savingsCents = savingsForAssigned(item, provider);
      }
    } else if (ah !== null && pic !== null) {
      if (forceAh) {
        provider = "ah";
        savingsCents = Math.max(0, pic - ah);
      } else {
        const cmp = compareUnlockedStores(item, defaultProvider);
        provider = cmp.winner;
        savingsCents = cmp.savingsCents;
      }
    } else if (ah !== null) {
      provider = "ah";
    } else if (pic !== null) {
      provider = "picnic";
    }
    return { ...item, assignedProvider: provider, savingsCents };
  });

  let ahSubtotalCents = 0;
  let picnicSubtotalCents = 0;
  let totalSavingsCents = 0;
  let allAtAhExtraCostCents = 0;

  // Group open rows sharing the exact same (provider, productId) so multi-buy promos apply across separate rows too.
  const productGroups = new Map<
    string,
    { provider: ActiveShoppingProviderId; product: NormalizedStoreProduct; totalQty: number; sumRowCents: number }
  >();

  for (const item of result) {
    if (item.isChecked) continue;
    if (item.assignedProvider === "ah") {
      const rowCents = item.ahTotalCents ?? 0;
      ahSubtotalCents += rowCents;
      if (item.ahProduct) {
        const key = `ah:${item.ahProduct.id}`;
        const g = productGroups.get(key) ?? { provider: "ah", product: item.ahProduct, totalQty: 0, sumRowCents: 0 };
        g.totalQty += Math.max(1, item.ahQty);
        g.sumRowCents += rowCents;
        productGroups.set(key, g);
      }
    } else if (item.assignedProvider === "picnic") {
      const rowCents = item.picnicTotalCents ?? 0;
      picnicSubtotalCents += rowCents;
      if (item.picnicProduct) {
        const key = `picnic:${item.picnicProduct.id}`;
        const g = productGroups.get(key) ?? { provider: "picnic", product: item.picnicProduct, totalQty: 0, sumRowCents: 0 };
        g.totalQty += Math.max(1, item.picnicQty);
        g.sumRowCents += rowCents;
        productGroups.set(key, g);
      }
      if (item.ahTotalCents !== null && item.picnicTotalCents !== null) {
        const supply =
          item.targetBaseAmount === null
            ? comparableSupply(item.ahProduct, item.ahQty, item.picnicProduct, item.picnicQty)
            : null;
        if (supply && supply.suppliedAh !== supply.suppliedPic) {
          const eqAhCents = Math.round((item.ahTotalCents / supply.suppliedAh) * supply.suppliedPic);
          allAtAhExtraCostCents += eqAhCents - item.picnicTotalCents;
        } else {
          allAtAhExtraCostCents += item.ahTotalCents - item.picnicTotalCents;
        }
      }
    }
    totalSavingsCents += item.savingsCents ?? 0;
  }

  for (const g of productGroups.values()) {
    const ignorePromo = g.provider === "ah" && g.product.isOnlineOnlyPromo === true;
    const promo = ignorePromo ? null : g.product.promo;
    if (!promo || promo.type === "none") continue;
    const combinedCost = costForPacks(g.product, promo, g.totalQty);
    if (combinedCost < g.sumRowCents) {
      const extraDiscount = g.sumRowCents - combinedCost;
      if (g.provider === "ah") ahSubtotalCents -= extraDiscount;
      else picnicSubtotalCents -= extraDiscount;
      totalSavingsCents += extraDiscount;
    }
  }

  allAtAhExtraCostCents = Math.max(0, allAtAhExtraCostCents);

  return {
    items: result,
    ahSubtotalCents,
    picnicSubtotalCents,
    totalCents: ahSubtotalCents + picnicSubtotalCents,
    totalSavingsCents,
    picnicAdvice: picnicAdvice(picnicSubtotalCents, min, allAtAhExtraCostCents),
  };
}

export function picnicAdvice(picnicCents: number, minCents: number, allAtAhExtraCostCents: number): PicnicThresholdAdvice {
  const base = { minOrderCents: minCents, currentPicnicCents: picnicCents, allAtAhExtraCostCents };
  if (picnicCents === 0) {
    return { ...base, meetsMinimum: false, shortfallCents: 0, recommendation: "split_optimal", message: "Geen Picnic-bestelling nodig" };
  }
  if (picnicCents >= minCents) {
    return {
      ...base,
      meetsMinimum: true,
      shortfallCents: 0,
      recommendation: "split_optimal",
      message: `Picnic-bestelling ${formatEuro(picnicCents)} haalt het minimum van ${formatEuro(minCents)}`,
    };
  }
  const shortfallCents = minCents - picnicCents;
  const allAh = shortfallCents > 1200 || allAtAhExtraCostCents <= 200;
  return {
    ...base,
    meetsMinimum: false,
    shortfallCents,
    recommendation: allAh ? "all_at_ah" : "top_up_picnic",
    message: allAh
      ? `Picnic mist nog ${formatEuro(shortfallCents)} voor het minimum; alles bij AH kost slechts ${formatEuro(allAtAhExtraCostCents)} extra`
      : `Picnic mist nog ${formatEuro(shortfallCents)} voor het minimum (${formatEuro(minCents)}); vul aan, want alles bij AH kost ${formatEuro(allAtAhExtraCostCents)} extra`,
  };
}
