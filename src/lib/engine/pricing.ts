import type {
  BaseUnit,
  DisplayUnit,
  NormalizedStoreProduct,
  ParsedGroceryInput,
  PricedCandidate,
  PromoMechanism,
  UnitPriceComparison,
} from "@/lib/types";
import { extractPieceCount } from "./units";

export interface PriceOptions {
  allowOvershoot: boolean;
  channel: "in_store" | "delivery";
  affinityScore?: number;
  timesBought?: number;
  /** When set, price this exact number of packs without bundle auto-bumping. */
  exactPacks?: number;
}

const DISPLAY_UNIT: Record<BaseUnit, DisplayUnit> = { g: "kg", ml: "l", piece: "stuk" };

export function formatEuro(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}€${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Number of packs one promo "bundle" spans (1 when the deal is per-pack). */
function bundleSize(promo: PromoMechanism): number {
  switch (promo.type) {
    case "bogo":
    case "x_plus_y_free":
      return (promo.buyQty ?? 1) + (promo.freeQty ?? 1);
    case "x_for_y":
      return Math.max(1, promo.bundleQty ?? 1);
    case "second_half_price":
      return 2;
    case "tiered_price":
      return Math.max(1, ...(promo.tiers ?? []).map((t) => t.fromQty));
    default:
      return 1;
  }
}

/** Exact cost of buying `n` packs under the promo (regular price when the promo does not apply). */
export function costForPacks(product: NormalizedStoreProduct, promo: PromoMechanism | null, n: number): number {
  const regular = product.regularPriceCents;
  if (!promo || promo.type === "none") return n * Math.min(regular, product.currentPriceCents || regular);
  switch (promo.type) {
    case "bogo":
    case "x_plus_y_free": {
      const buy = promo.buyQty ?? 1;
      const free = promo.freeQty ?? 1;
      const cycle = buy + free;
      const freeCount = Math.floor(n / cycle) * free;
      return (n - freeCount) * regular;
    }
    case "x_for_y": {
      const q = promo.bundleQty ?? 1;
      const price = promo.bundlePriceCents ?? q * regular;
      return Math.floor(n / q) * price + (n % q) * regular;
    }
    case "second_half_price":
      return Math.floor(n / 2) * (regular + Math.round(regular / 2)) + (n % 2) * regular;
    case "percentage": {
      const unit =
        product.currentPriceCents > 0 && product.currentPriceCents < regular
          ? product.currentPriceCents
          : Math.round(regular * (1 - (promo.discountPercent ?? 0) / 100));
      return n * unit;
    }
    case "fixed_discount":
      return n * Math.min(regular, product.currentPriceCents > 0 ? product.currentPriceCents : regular);
    case "tiered_price": {
      const tier = [...(promo.tiers ?? [])].sort((a, b) => b.fromQty - a.fromQty).find((t) => n >= t.fromQty);
      return n * (tier ? tier.unitPriceCents : regular);
    }
    default:
      return n * regular;
  }
}

/** Number of single units in a multipack ("6 x 330 ml", "6-pack"); 1 for a single item. */
export function subPackCountOf(product: Pick<NormalizedStoreProduct, "unitSizeRaw" | "title">): number {
  const m = /^\s*(\d+)\s*[x×]/i.exec(product.unitSizeRaw ?? "") ?? /\b(\d+)\s*-?\s*pack\b/i.exec(product.title ?? "");
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** Explicit piece count per pack when known ("4 stuks", "4 x 100 gram", "Tros" bananas => 5). */
export function pieceCountOf(
  product: Pick<NormalizedStoreProduct, "pieceCount" | "unitSizeRaw" | "title" | "baseUnit" | "baseAmount">,
): number | null {
  if (typeof product.pieceCount === "number" && product.pieceCount > 0) return product.pieceCount;
  return extractPieceCount(product.unitSizeRaw, product.title, product.baseUnit, product.baseAmount);
}

/** True when a product's single unit is can-sized (150–500 ml). */
export function isCanSized(product: NormalizedStoreProduct): boolean {
  if (product.baseUnit !== "ml" || product.baseAmount <= 0) return false;
  const single = product.baseAmount / subPackCountOf(product);
  return single >= 150 && single <= 500;
}

export function packsNeededFor(product: NormalizedStoreProduct, parsed: ParsedGroceryInput): number {
  if (parsed.baseUnit === "piece" && parsed.totalTargetAmount && parsed.totalTargetAmount > 1) {
    const pc = pieceCountOf(product);
    if (pc && pc > 1) return Math.max(1, Math.ceil(parsed.totalTargetAmount / pc));
    const subPackCount = subPackCountOf(product);
    if (subPackCount > 1) return Math.max(1, Math.ceil(parsed.totalTargetAmount / subPackCount));
  }
  if (
    parsed.totalTargetAmount &&
    parsed.baseUnit &&
    product.baseUnit === parsed.baseUnit &&
    product.baseAmount > 0
  ) {
    return Math.max(1, Math.ceil(parsed.totalTargetAmount / product.baseAmount));
  }
  return Math.max(1, parsed.multiplier);
}

const OVERSIZE_RATIO = 1.6;

/** Same-unit pack that supplies far more than requested while overshoot is not allowed. */
export function isOversizedPack(
  options: PriceOptions,
  parsed: ParsedGroceryInput,
  product: NormalizedStoreProduct,
  totalSuppliedAmount: number,
): boolean {
  return (
    !options.allowOvershoot &&
    parsed.totalTargetAmount !== null &&
    parsed.totalTargetAmount > 0 &&
    product.baseUnit === parsed.baseUnit &&
    parsed.baseUnit !== "piece" &&
    totalSuppliedAmount > parsed.totalTargetAmount * OVERSIZE_RATIO
  );
}

export function priceCandidate(
  product: NormalizedStoreProduct,
  parsed: ParsedGroceryInput,
  options: PriceOptions,
): PricedCandidate {
  const ignorePromo = options.channel === "in_store" && product.isOnlineOnlyPromo === true;
  const promo = ignorePromo || !product.promo || product.promo.type === "none" ? null : product.promo;
  const manualExact = options.exactPacks !== undefined && options.exactPacks >= 1 ? Math.round(options.exactPacks) : null;
  const packsNeeded = manualExact ?? packsNeededFor(product, parsed);
  const regularUnit = product.regularPriceCents;

  let packsUsed = packsNeeded;
  let totalCents = costForPacks(product, ignorePromo ? null : promo, packsNeeded);
  if (ignorePromo) totalCents = packsNeeded * regularUnit;
  let promoSummary: string | null = ignorePromo && product.promo ? `${product.promo.label} (alleen online, genegeerd in winkel)` : null;

  if (promo) {
    const bundle = bundleSize(promo);
    const exact = totalCents;
    if (manualExact === null && bundle > 1 && packsNeeded % bundle !== 0) {
      const bumped = Math.ceil(packsNeeded / bundle) * bundle;
      const bumpedCost = costForPacks(product, promo, bumped);
      const freeExtra = bumpedCost <= exact;
      const unitDrop = !parsed.isCountOnly && bumpedCost / bumped < (exact / packsNeeded) * 0.85;
      if (freeExtra || (options.allowOvershoot && unitDrop)) {
        packsUsed = bumped;
        totalCents = bumpedCost;
      }
    }
    const regularForUsed = packsUsed * regularUnit;
    if (totalCents < regularForUsed) {
      promoSummary =
        packsUsed > packsNeeded
          ? `${promo.label}: ${packsUsed} stuks nodig voor de actie (${packsNeeded} gevraagd)`
          : promo.label;
    } else if (packsNeeded < bundle) {
      promoSummary = `${promo.label} (niet toegepast: ${bundle} nodig)`;
    } else {
      promoSummary = null;
    }
  }

  const regularTotalCents = packsUsed * regularUnit;
  const oversized = isOversizedPack(options, parsed, product, packsUsed * Math.max(product.baseAmount, 0));
  const savingsCents = Math.max(0, regularTotalCents - totalCents);
  const promoApplied = promo !== null && savingsCents > 0;
  const totalSuppliedAmount = packsUsed * Math.max(product.baseAmount, 0);
  const supplied = totalSuppliedAmount > 0 ? totalSuppliedAmount : packsUsed;
  const effectiveCentsPer1000Base =
    product.baseUnit === "piece"
      ? Math.round(totalCents / supplied)
      : Math.round((totalCents / supplied) * 1000);

  return {
    product,
    packsNeeded: packsUsed,
    totalSuppliedAmount,
    effectiveTotalCents: totalCents,
    regularTotalCents,
    savingsCents,
    effectiveCentsPer1000Base,
    displayUnit: DISPLAY_UNIT[product.baseUnit],
    effectiveUnitPriceEuros: effectiveCentsPer1000Base / 100,
    promoApplied,
    promoSummary,
    hasOvershoot: packsUsed > packsNeeded || oversized,
    oversizePenalty:
      oversized && parsed.totalTargetAmount
        ? 1 + (totalSuppliedAmount / parsed.totalTargetAmount - 1.5) * 0.5
        : 1,
    affinityScore: options.affinityScore ?? 0,
    timesBought: options.timesBought ?? 0,
    finalRankScore: effectiveCentsPer1000Base,
    rankReason: "",
  };
}

/**
 * Aligns unit-price comparison across AH and Picnic. When one store prices per `piece` ("4 stuks")
 * and the other prices per `g`/`ml` with a known `pieceCount` ("4 x 100 gram"), bridges both to `/stuk`.
 * When no bridge is possible and units differ, preserves separate `ahDisplayUnit` and `picnicDisplayUnit`.
 */
export function buildUnitPriceComparison(
  ah: PricedCandidate | null,
  picnic: PricedCandidate | null,
  fallbackDisplayUnit: DisplayUnit = "stuk",
): UnitPriceComparison & { comparable: boolean } {
  if (!ah || !picnic) {
    const unit = ah?.displayUnit ?? picnic?.displayUnit ?? fallbackDisplayUnit;
    return {
      ahCentsPerBase1000: ah?.effectiveCentsPer1000Base ?? null,
      picnicCentsPerBase1000: picnic?.effectiveCentsPer1000Base ?? null,
      displayUnit: unit,
      ahDisplayUnit: ah?.displayUnit ?? null,
      picnicDisplayUnit: picnic?.displayUnit ?? null,
      comparable: false,
    };
  }

  if (ah.product.baseUnit === picnic.product.baseUnit) {
    return {
      ahCentsPerBase1000: ah.effectiveCentsPer1000Base,
      picnicCentsPerBase1000: picnic.effectiveCentsPer1000Base,
      displayUnit: ah.displayUnit,
      ahDisplayUnit: ah.displayUnit,
      picnicDisplayUnit: picnic.displayUnit,
      comparable: true,
    };
  }

  const ahPiecesPerPack = pieceCountOf(ah.product);
  const picPiecesPerPack = pieceCountOf(picnic.product);
  if (ahPiecesPerPack && picPiecesPerPack) {
    const ahTotalPieces = ahPiecesPerPack * Math.max(1, ah.packsNeeded);
    const picTotalPieces = picPiecesPerPack * Math.max(1, picnic.packsNeeded);
    return {
      ahCentsPerBase1000: Math.round(ah.effectiveTotalCents / ahTotalPieces),
      picnicCentsPerBase1000: Math.round(picnic.effectiveTotalCents / picTotalPieces),
      displayUnit: "stuk",
      ahDisplayUnit: "stuk",
      picnicDisplayUnit: "stuk",
      comparable: true,
    };
  }

  return {
    ahCentsPerBase1000: ah.effectiveCentsPer1000Base,
    picnicCentsPerBase1000: picnic.effectiveCentsPer1000Base,
    displayUnit: ah.displayUnit,
    ahDisplayUnit: ah.displayUnit,
    picnicDisplayUnit: picnic.displayUnit,
    comparable: false,
  };
}

const PRODUCE_GRAMS_PER_PIECE: Array<[RegExp, number]> = [
  [/\b(bloemkool|broccoli|komkommer|mango|aubergine|ananas|meloen|ijsbergsla)\b/i, 360],
  [/\b(appel|appels|gala|elstar|jonagold|pink lady|kanzi|granny smith|peer|peren|conference|sinaasappel|sinaasappels|grapefruit)\b/i, 180],
  [/\b(paprika|avocado|courgette|ui|uien|venkel)\b/i, 170],
  [/\b(banaan|bananen)\b/i, 150],
  [/\b(citroen|limoen|kiwi|mandarijn|tomaat|tomaten|perzik|nectarine|pruim)\b/i, 90],
];

/**
 * Infers average grams (or ml) per piece from candidates that carry both weight/volume and `pieceCount`,
 * falling back to realistic produce weights (e.g. ~180g per apple) when mixing loose/tray pieces with kg bags.
 */
export function inferGramsPerPiece(products: NormalizedStoreProduct[], queryHint?: string): number | null {
  const ratios: number[] = [];
  for (const p of products) {
    if (p.baseUnit === "piece" || p.baseAmount <= 0) continue;
    const pcs = pieceCountOf(p);
    if (pcs && pcs >= 1) {
      const perPiece = p.baseAmount / pcs;
      if (perPiece >= 15 && perPiece <= 2000) ratios.push(perPiece);
    }
  }
  if (ratios.length > 0) {
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)];
  }
  const probe = [queryHint ?? "", ...products.slice(0, 6).map((p) => p.title)].join(" ");
  for (const [re, grams] of PRODUCE_GRAMS_PER_PIECE) {
    if (re.test(probe)) return grams;
  }
  return null;
}
