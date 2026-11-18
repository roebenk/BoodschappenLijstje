import type { ActiveShoppingProviderId, PricedCandidate, StoreEvaluation } from "@/lib/types";
import type { BrandPreferenceMode } from "@/lib/types";
import {
  getBrandLoyalty,
  getConceptById,
  getPreferencesForProducts,
  getRecentConceptPurchases,
} from "@/lib/db/repositories";
import { formatEuro } from "./pricing";

export interface BrandLoyaltyInfo {
  totalPurchases: number;
  topBrand: string | null;
  topBrandShare: number;
  topBrandIsHouseBrand?: boolean;
  piecePurchaseShare?: number;
}

export interface PreferenceContext {
  brandPreferenceMode?: BrandPreferenceMode;
  pinnedBrand?: string | null;
  loyalty?: BrandLoyaltyInfo | null;
  /** Manual pick/reject counters (and optional history stats) per store product id. */
  manual?:
    | Map<string, { manualPicks: number; manualRejects: number; timesBought?: number; affinityScore?: number }>
    | Record<string, { manualPicks: number; manualRejects: number; timesBought?: number; affinityScore?: number }>;
  /** Most recent purchased storeProductIds per provider (newest first) for recency weighting. */
  recentByProvider?: Partial<Record<ActiveShoppingProviderId, string[]>>;
  /** Optional unit-conversion hint when a store mixes `piece` and `g`/`ml` candidates (e.g. Slavinken). */
  gramsPerPieceHint?: number | null;
}

/** Builds the preference context for a concept from the SQLite preference/loyalty/history tables. */
export function loadPreferenceContext(conceptId: number | null, productIds: string[] = []): PreferenceContext {
  if (conceptId === null) return {};
  const concept = getConceptById(conceptId);
  const prefs = getPreferencesForProducts(productIds);
  const manual = new Map<string, { manualPicks: number; manualRejects: number; timesBought: number; affinityScore: number }>();
  for (const [id, p] of prefs) {
    manual.set(id, {
      manualPicks: p.manualPicks,
      manualRejects: p.manualRejects,
      timesBought: p.timesBought,
      affinityScore: p.affinityScore,
    });
  }

  const recentRows = getRecentConceptPurchases(conceptId, productIds, 12);
  const recentByProvider: Partial<Record<ActiveShoppingProviderId, string[]>> = {};
  for (const row of recentRows) {
    if (row.provider !== "ah" && row.provider !== "picnic") continue;
    const list = recentByProvider[row.provider] ?? (recentByProvider[row.provider] = []);
    list.push(row.storeProductId);
  }

  return {
    brandPreferenceMode: concept?.brandPreferenceMode ?? "auto",
    pinnedBrand: concept?.pinnedBrand ?? null,
    loyalty: getBrandLoyalty(conceptId),
    manual,
    recentByProvider,
  };
}

const HOUSE_BONUS = 0.97;
const MANUAL_BONUS = 0.45;
const REJECT_PENALTY = 1.15;
const MAX_HABIT_DISCOUNT = 0.70;

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/** True for plain generic store brands ("AH", "Picnic"), false for distinctive lines ("AH Terra", "AH Biologisch", "Calvé"). */
export function isGenericStoreBrand(brand: string | null | undefined): boolean {
  const b = norm(brand);
  return !b || b === "ah" || b === "albert heijn" || b === "picnic" || b === "huismerk";
}

function manualFor(ctx: PreferenceContext, id: string) {
  const m = ctx.manual;
  if (!m) return undefined;
  return m instanceof Map ? m.get(id) : m[id];
}

function perUnitLabel(c: PricedCandidate): string {
  return c.displayUnit === "stuk" ? "stuk" : c.displayUnit;
}

/**
 * Scores a candidate (lower is better): unit price adjusted for purchase frequency (`timesBought`),
 * recent purchases (`recentByProvider`), specialty/brand habit, house-brand nudge, and manual picks/rejects.
 */
export function scoreCandidate(
  c: PricedCandidate,
  ctx: PreferenceContext = {},
  baseScoreOverride?: number,
): PricedCandidate {
  let score = baseScoreOverride ?? c.effectiveCentsPer1000Base;
  const reasons: string[] = ["laagste prijs per " + perUnitLabel(c)];
  if (c.product.isHouseBrand) {
    score *= HOUSE_BONUS;
    reasons.push("huismerk");
  }

  const manual = manualFor(ctx, c.product.id);
  const effectiveTimesBought = c.timesBought > 0 ? c.timesBought : (manual?.timesBought ?? 0);
  const effectiveAffinity = c.affinityScore > 0 ? c.affinityScore : (manual?.affinityScore ?? 0);
  const isRejected = !!(manual && manual.manualRejects > manual.manualPicks);

  if (isRejected) {
    score *= REJECT_PENALTY;
  } else {
    let habitDiscount = 0;
    let boughtReason: string | null = null;

    if (effectiveTimesBought > 0) {
      // Logarithmic curve: 1x => ~14%, 4x => ~35%, 8x => ~46%, 16x+ => 56%
      habitDiscount += Math.min(0.56, 0.14 + 0.105 * Math.log2(effectiveTimesBought));
      boughtReason = effectiveTimesBought >= 2 ? `${effectiveTimesBought}× eerder gekocht` : "eerder gekocht";
    } else {
      const affinity = Math.max(0, effectiveAffinity) + (c.product.previouslyBought ? 0.5 : 0);
      if (affinity > 0) {
        habitDiscount += Math.min(0.18, affinity * 0.04);
        boughtReason = "eerder gekocht";
      }
    }

    const recent =
      c.product.provider === "ah" || c.product.provider === "picnic"
        ? ctx.recentByProvider?.[c.product.provider]
        : undefined;
    if (recent && recent.length > 0) {
      const window5 = recent.slice(0, 5);
      const recentHits = window5.filter((id) => id === c.product.id).length;
      if (recent[0] === c.product.id) {
        habitDiscount += 0.14 + (window5.length >= 2 ? (recentHits / window5.length) * 0.06 : 0);
        boughtReason = boughtReason ? `${boughtReason}, laatste keuze` : "laatste keuze";
      } else if (recent.slice(0, 3).includes(c.product.id)) {
        habitDiscount += 0.07 + (recentHits / window5.length) * 0.05;
        if (!boughtReason) boughtReason = "recent gekocht";
      }
    }

    // Specialty sub-brands (e.g. "AH Terra", "AH Biologisch") that dominate the user's purchases get a line bonus.
    if (
      (ctx.brandPreferenceMode ?? "auto") === "auto" &&
      ctx.loyalty &&
      ctx.loyalty.totalPurchases >= 3 &&
      ctx.loyalty.topBrandShare >= 0.75 &&
      ctx.loyalty.topBrand &&
      !isGenericStoreBrand(ctx.loyalty.topBrand) &&
      norm(c.product.brand) === norm(ctx.loyalty.topBrand)
    ) {
      habitDiscount += 0.15;
    }

    // When the household consistently buys this concept per piece/tray (e.g. 4-pack apples rather than 1kg small-apple bags),
    // give a gentle nudge toward piece-packaged options.
    if (
      c.product.baseUnit === "piece" &&
      ctx.loyalty &&
      ctx.loyalty.totalPurchases >= 3 &&
      (ctx.loyalty.piecePurchaseShare ?? 0) >= 0.8
    ) {
      habitDiscount += 0.08;
    }

    if (habitDiscount > 0) {
      score *= 1 - Math.min(MAX_HABIT_DISCOUNT, habitDiscount);
      if (boughtReason) reasons.push(boughtReason);
    }
  }

  if (c.oversizePenalty && c.oversizePenalty > 1) {
    score *= c.oversizePenalty;
    reasons.push("grote verpakking");
  }
  if (manual && manual.manualPicks > manual.manualRejects) {
    score *= MANUAL_BONUS;
    reasons.push("handmatig gekozen");
  }
  return { ...c, finalRankScore: Math.round(score * 100) / 100, rankReason: reasons.join(", ") };
}

function byScore(a: PricedCandidate, b: PricedCandidate): number {
  return (
    a.finalRankScore - b.finalRankScore ||
    a.effectiveTotalCents - b.effectiveTotalCents ||
    a.product.id.localeCompare(b.product.id)
  );
}

/** Ranks priced candidates for one store and picks a winner (see brand-loyalty & habit rules). */
export function evaluateStoreCandidates(
  provider: ActiveShoppingProviderId,
  candidates: PricedCandidate[],
  ctx: PreferenceContext = {},
): StoreEvaluation {
  const available = candidates.filter((c) => c.product.available !== false);
  const pool = available.length > 0 ? available : candidates;

  // When a store mixes `piece` ("4 stuks") and `g`/`ml` ("200 g") candidates, convert `piece` base scores
  // to an estimated per-1000g/ml equivalent so 94 ct/stuk isn't blindly compared to 1195 ct/kg.
  const hasWeightOrVol = pool.some((c) => c.product.baseUnit !== "piece");
  const hasPiece = pool.some((c) => c.product.baseUnit === "piece");
  const gramsPerPiece = hasWeightOrVol && hasPiece ? (ctx.gramsPerPieceHint ?? 100) : null;

  const scored = pool
    .map((c) => {
      const baseOverride =
        gramsPerPiece && c.product.baseUnit === "piece"
          ? Math.round((c.effectiveCentsPer1000Base / gramsPerPiece) * 1000)
          : undefined;
      return scoreCandidate(c, ctx, baseOverride);
    })
    .sort(byScore);
  if (scored.length === 0) return { provider, winner: null, alternatives: [], houseBrandChallenger: null };

  const mode = ctx.brandPreferenceMode ?? "auto";
  const cheapestHouse = scored.find((c) => c.product.isHouseBrand) ?? null;
  const cheapestGenericHouse =
    scored
      .filter((c) => c.product.isHouseBrand && isGenericStoreBrand(c.product.brand) && c.product.baseUnit === scored[0].product.baseUnit)
      .sort((a, b) => a.effectiveCentsPer1000Base - b.effectiveCentsPer1000Base)[0] ?? cheapestHouse;

  let winner = scored[0];
  let challenger: PricedCandidate | null = null;

  let loyalBrand: string | null = null;
  if (mode === "pinned_brand" && ctx.pinnedBrand) loyalBrand = norm(ctx.pinnedBrand);
  else if (
    mode === "auto" &&
    ctx.loyalty &&
    ctx.loyalty.totalPurchases >= 3 &&
    ctx.loyalty.topBrandShare >= 0.75 &&
    ctx.loyalty.topBrand &&
    !ctx.loyalty.topBrandIsHouseBrand &&
    !scored.every((c) => norm(c.product.brand) !== norm(ctx.loyalty!.topBrand))
  ) {
    loyalBrand = norm(ctx.loyalty.topBrand);
  }

  if (loyalBrand) {
    const loyal = scored.find(
      (c) => norm(c.product.brand) === loyalBrand && (mode === "pinned_brand" || !c.product.isHouseBrand),
    );
    if (loyal) {
      winner = { ...loyal, rankReason: `Jouw vaste keuze: ${loyal.product.brand}` };
      if (
        cheapestHouse &&
        cheapestHouse.product.id !== loyal.product.id &&
        cheapestHouse.product.baseUnit === loyal.product.baseUnit &&
        cheapestHouse.effectiveCentsPer1000Base < loyal.effectiveCentsPer1000Base
      ) {
        challenger = cheapestHouse;
        const diff = loyal.effectiveCentsPer1000Base - cheapestHouse.effectiveCentsPer1000Base;
        winner.rankReason += ` — Huismerk bespaart ${formatEuro(diff)}/${perUnitLabel(loyal)}`;
      }
    }
  } else if (
    mode === "auto" &&
    !isGenericStoreBrand(winner.product.brand) &&
    cheapestGenericHouse &&
    cheapestGenericHouse.product.id !== winner.product.id &&
    cheapestGenericHouse.product.baseUnit === winner.product.baseUnit &&
    cheapestGenericHouse.effectiveCentsPer1000Base < winner.effectiveCentsPer1000Base
  ) {
    // Specialty sub-brand winner (e.g. AH Terra) still surfaces the cheaper basic house brand as optional savings tip.
    challenger = cheapestGenericHouse;
    const diff = winner.effectiveCentsPer1000Base - cheapestGenericHouse.effectiveCentsPer1000Base;
    winner = {
      ...winner,
      rankReason: `Jouw vaste keuze: ${winner.product.brand} — Basis huismerk bespaart ${formatEuro(diff)}/${perUnitLabel(winner)}`,
    };
  } else if (mode === "house_brand" && cheapestHouse) {
    const cheaperPromo = scored.find(
      (c) =>
        !c.product.isHouseBrand &&
        c.promoApplied &&
        c.product.baseUnit === cheapestHouse.product.baseUnit &&
        c.effectiveCentsPer1000Base < cheapestHouse.effectiveCentsPer1000Base,
    );
    winner = cheaperPromo ?? cheapestHouse;
    if (!cheaperPromo) winner = { ...winner, rankReason: "huismerk voorkeur" };
  }

  const alternatives = scored.filter((c) => c.product.id !== winner.product.id).slice(0, 15);
  return { provider, winner, alternatives, houseBrandChallenger: challenger };
}
