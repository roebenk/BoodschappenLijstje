import type {
  ActiveShoppingProviderId,
  BaseUnit,
  DisplayUnit,
  NormalizedStoreProduct,
  ShoppingListItem,
} from "./domain";

export interface ParsedGroceryInput {
  rawInput: string;
  searchQuery: string;
  displayName: string;
  /** e.g. "4x" => 4 */
  multiplier: number;
  perPackAmount: number | null;
  baseUnit: BaseUnit | null;
  totalTargetAmount: number | null;
  isCountOnly: boolean;
  allowOvershootDefault: boolean;
  /** Container the user typed ("blikjes" => "can"), used to prefer matching pack formats. */
  containerHint?: "can";
}

export interface PricedCandidate {
  product: NormalizedStoreProduct;
  packsNeeded: number;
  totalSuppliedAmount: number;
  effectiveTotalCents: number;
  regularTotalCents: number;
  savingsCents: number;
  effectiveCentsPer1000Base: number;
  displayUnit: DisplayUnit;
  effectiveUnitPriceEuros: number;
  promoApplied: boolean;
  promoSummary: string | null;
  hasOvershoot: boolean;
  /** Rank multiplier (>1) for packs far larger than requested when overshoot is off. */
  oversizePenalty?: number;
  matchKind?: "exact" | "alternative";
  affinityScore: number;
  timesBought: number;
  finalRankScore: number;
  rankReason: string;
}

export interface StoreEvaluation {
  provider: ActiveShoppingProviderId;
  winner: PricedCandidate | null;
  alternatives: PricedCandidate[];
  /** Additional raw search hits filtered out as flavours/other types, kept for user inspection. */
  otherResults?: PricedCandidate[];
  houseBrandChallenger?: PricedCandidate | null;
}

export interface ItemComparisonResult {
  parsed: ParsedGroceryInput;
  conceptSlug: string;
  ah: StoreEvaluation;
  picnic: StoreEvaluation;
  recommendedProvider: ActiveShoppingProviderId;
  savingsOverOtherStoreCents: number;
  reason: string;
  usedLlm: boolean;
}

export interface PicnicThresholdAdvice {
  minOrderCents: number;
  currentPicnicCents: number;
  meetsMinimum: boolean;
  shortfallCents: number;
  recommendation: "split_optimal" | "all_at_ah" | "top_up_picnic";
  allAtAhExtraCostCents: number;
  message: string;
}

export interface ListOptimizationResult {
  items: ShoppingListItem[];
  ahSubtotalCents: number;
  picnicSubtotalCents: number;
  totalCents: number;
  totalSavingsCents: number;
  picnicAdvice: PicnicThresholdAdvice;
}
