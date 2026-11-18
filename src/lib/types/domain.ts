/** Shared domain models. All money is integer euro cents. */

export type StoreProviderId = "ah" | "picnic" | "jumbo" | "plus";
/** Providers that can currently be shopped at (Jumbo/Plus are radar-only). */
export type ActiveShoppingProviderId = "ah" | "picnic";
export type StoreChannel = "in_store" | "delivery" | "radar";
export type BaseUnit = "g" | "ml" | "piece";
export type BrandPreferenceMode = "auto" | "house_brand" | "pinned_brand";
export type DisplayUnit = "kg" | "l" | "stuk";

export type PromoTierType =
  | "none"
  | "fixed_discount"
  | "percentage"
  | "x_for_y"
  | "bogo"
  | "x_plus_y_free"
  | "second_half_price"
  | "tiered_price";

export interface PromoMechanism {
  type: PromoTierType;
  /** Human label as shown by the store, e.g. "2e halve prijs". */
  label: string;
  /** x_plus_y_free: buy `buyQty`, get `freeQty` free (1+1 => buyQty 1, freeQty 1). */
  buyQty?: number;
  freeQty?: number;
  /** x_for_y: `bundleQty` items for `bundlePriceCents`. */
  bundleQty?: number;
  bundlePriceCents?: number;
  discountPercent?: number;
  /** tiered_price: unit price from `fromQty` items upward (Picnic priceRanges). */
  tiers?: Array<{ fromQty: number; unitPriceCents: number }>;
  isPersonalBonus?: boolean;
}

export interface NormalizedStoreProduct {
  /** `<provider>:<externalId>` */
  id: string;
  provider: StoreProviderId;
  externalId: string;
  /** AH kassa/POS id. */
  posId?: number | null;
  title: string;
  brand: string | null;
  isHouseBrand: boolean;
  unitSizeRaw: string;
  /** Amount per pack in baseUnit (g / ml / pieces). */
  baseAmount: number;
  baseUnit: BaseUnit;
  /** Explicit piece count in the pack when known (e.g. 4 for "4 x 100 gram" or "4 stuks"). */
  pieceCount?: number | null;
  regularPriceCents: number;
  currentPriceCents: number;
  promo: PromoMechanism | null;
  isOnlineOnlyPromo: boolean;
  previouslyBought?: boolean;
  imageUrl: string | null;
  category?: string | null;
  available: boolean;
  isMockFallback?: boolean;
  updatedAt?: string;
}

export interface CanonicalConcept {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  baseUnit: BaseUnit;
  isShelfStable: boolean;
  brandPreferenceMode: BrandPreferenceMode;
  pinnedBrand: string | null;
}

export type ConceptLinkSource = "llm" | "history" | "manual";

export interface PurchaseHistoryEntry {
  id: number;
  provider: StoreProviderId;
  txId: string;
  purchasedAt: string;
  storeProductId: string | null;
  rawName: string;
  quantity: number;
  totalCents: number;
}

export interface ProductPreference {
  storeProductId: string;
  conceptId: number | null;
  timesBought: number;
  lastBoughtAt: string | null;
  manualPicks: number;
  manualRejects: number;
  affinityScore: number;
}

export interface RadarDeal {
  provider: StoreProviderId;
  title: string;
  priceCents: number | null;
  regularPriceCents?: number | null;
  promoLabel: string;
  url?: string | null;
  imageUrl?: string | null;
  /** Stable identifier used to dismiss/hide an item from Weekdeals. */
  dealKey?: string;
  /** Number of past orders in which this product was bought (when from household history). */
  timesBought?: number;
}

export interface UnitPriceComparison {
  ahCentsPerBase1000?: number | null;
  picnicCentsPerBase1000?: number | null;
  displayUnit: DisplayUnit;
  ahDisplayUnit?: DisplayUnit | null;
  picnicDisplayUnit?: DisplayUnit | null;
}

export interface ShoppingListItem {
  id: number;
  rawInput: string;
  displayName: string;
  requestedQty: number;
  requestedUnitRaw: string | null;
  targetBaseAmount: number | null;
  targetBaseUnit: BaseUnit | null;
  conceptId: number | null;
  allowOvershoot: boolean;
  assignedProvider: ActiveShoppingProviderId | null;
  isProviderLocked: boolean;
  ahProductId: string | null;
  ahQty: number;
  ahTotalCents: number | null;
  picnicProductId: string | null;
  picnicQty: number;
  picnicTotalCents: number | null;
  radarDeals: RadarDeal[];
  isChecked: boolean;
  pushedToStoreAt: string | null;
  recordedInStatsAt?: string | null;
  cheapestProductId?: string | null;
  cheapestOverallCents?: number | null;
  sortOrder: number;
  updatedAt: string;
  /** Hydrated from store_products. */
  ahProduct?: NormalizedStoreProduct | null;
  picnicProduct?: NormalizedStoreProduct | null;
  cheapestProduct?: NormalizedStoreProduct | null;
  unitPriceComparison?: UnitPriceComparison;
  savingsCents?: number;
  loyaltyNote?: string | null;
  ahTimesBought?: number;
  picnicTimesBought?: number;
  ahPromoApplied?: boolean;
  picnicPromoApplied?: boolean;
  ahPromoSummary?: string | null;
  picnicPromoSummary?: string | null;
}

export type SavingsTriggerSource = "push" | "checked_clear";

export interface CompletedShoppingItem {
  id: number;
  completedAt: string;
  triggerSource: SavingsTriggerSource;
  rawInput: string;
  displayName: string;
  conceptId: number | null;
  chosenProvider: ActiveShoppingProviderId;
  chosenProductId: string | null;
  chosenProductTitle: string | null;
  chosenBrand: string | null;
  isHouseBrand: boolean;
  chosenQty: number;
  baselineCents: number;
  chosenRegularCents: number;
  chosenPaidCents: number;
  otherProviderCents: number | null;
  cheapestStoreCents: number;
  cheapestOverallCents: number;
  cheapestProductTitle: string | null;
}
