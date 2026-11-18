import type {
  ActiveShoppingProviderId,
  BrandPreferenceMode,
  ProductPreference,
  RadarDeal,
  ShoppingListItem,
  StoreChannel,
  StoreProviderId,
} from "./domain";
import type { ListOptimizationResult, PicnicThresholdAdvice } from "./engine";
import type {
  AdapterCapabilities,
  AuthFlowInput,
  AuthFlowResult,
  PushListResult,
  StoreAuthState,
  SyncHistoryResult,
} from "./providers";

export interface ApiError {
  error: string;
  details?: unknown;
}

/** GET /api/health */
export interface HealthResponse {
  ok: boolean;
  version: string;
  time: string;
  openRouter: { configured: boolean; defaultModel: string; fallbackModel: string };
  stores: StoreAuthState[];
  database: { ok: boolean; path: string };
}

/** GET /api/list */
export interface ListResponse {
  items: ShoppingListItem[];
  ahSubtotalCents: number;
  picnicSubtotalCents: number;
  totalCents: number;
  totalSavingsCents: number;
  picnicAdvice: PicnicThresholdAdvice;
}

/** GET /api/list/suggestions */
export interface ListSuggestionsResponse {
  suggestions: string[];
}

/** POST /api/list (adds items; each line is parsed + priced) */
export interface AddListItemsRequest {
  /** One or more raw lines, e.g. "4x 1kg magere kwark". */
  inputs: string[];
}
export interface AddListItemsResponse {
  items: ShoppingListItem[];
}

/** PATCH /api/list/[id] */
export interface UpdateListItemRequest {
  isChecked?: boolean;
  /** Switch store; sets isProviderLocked. */
  assignedProvider?: ActiveShoppingProviderId;
  isProviderLocked?: boolean;
  allowOvershoot?: boolean;
  requestedQty?: number;
  /** Step or set exact pack count on the active store (e.g. 4x 1kg -> 3x or 5x). */
  packCount?: number;
  /** Variant swap: user picked a different product (teaches preferences). */
  chosenProduct?: { provider: ActiveShoppingProviderId; productId: string };
  sortOrder?: number;
}
export interface UpdateListItemResponse {
  item: ShoppingListItem;
}

/** DELETE /api/list/[id] -> { ok: true }; DELETE /api/list?checked=1 clears checked items */
export interface OkResponse {
  ok: true;
}

/** POST /api/list/optimize */
export interface OptimizeListRequest {
  /** Restrict to these item ids; omit for all unlocked items. */
  itemIds?: number[];
  forceMode?: "optimal" | "all_ah";
}
export type OptimizeListResponse = ListOptimizationResult;

/** POST /api/list/push */
export interface PushListRequest {
  /** preview: compute what would be pushed without calling the stores. */
  mode: "preview" | "push";
  providers?: ActiveShoppingProviderId[];
  /** Automatically mark successfully pushed items as checked (default true). */
  autoCheckPushed?: boolean;
}
export interface PushListPreview {
  provider: ActiveShoppingProviderId;
  items: Array<{ itemId: number; externalId: string; title: string; quantity: number }>;
  subtotalCents: number;
}
export interface PushListResponse {
  mode: "preview" | "push";
  previews: PushListPreview[];
  results?: PushListResult[];
}

/** GET /api/stores */
export interface StoreInfo {
  provider: StoreProviderId;
  displayName: string;
  channel: StoreChannel;
  capabilities: AdapterCapabilities;
  auth: StoreAuthState;
}
export interface StoresResponse {
  stores: StoreInfo[];
}

/** POST /api/stores/[provider]/auth */
export type StoreAuthRequest = AuthFlowInput;
export type StoreAuthResponse = AuthFlowResult;

/** POST /api/stores/[provider]/sync */
export type StoreSyncResponse = SyncHistoryResult;

/** POST /api/stores/demo-seed */
export interface DemoSeedResponse {
  ok: true;
  historyEntries: number;
  products: number;
  preferences: number;
}

/** GET /api/preferences */
export interface PreferenceView extends ProductPreference {
  productTitle: string | null;
  brand: string | null;
  provider: StoreProviderId | null;
  conceptName: string | null;
  imageUrl: string | null;
  brandPreferenceMode?: BrandPreferenceMode;
  pinnedBrand?: string | null;
}
export interface AppSettings {
  defaultProvider: ActiveShoppingProviderId;
  aiModel: string;
  aiFallbackModel: string;
  aiConfigured: boolean;
}

export interface PreferencesResponse {
  preferences: PreferenceView[];
  weekDeals: RadarDeal[];
  dismissedDealsCount?: number;
  settings?: AppSettings;
}

/** PATCH /api/preferences */
export interface UpdateConceptPreferenceRequest {
  conceptId?: number;
  brandPreferenceMode?: BrandPreferenceMode;
  pinnedBrand?: string | null;
  defaultProvider?: ActiveShoppingProviderId;
  aiModel?: string;
  dismissDealKey?: string;
  dismissDealLabel?: string | null;
  restoreDealKey?: string;
  restoreAllDeals?: boolean;
}

/** GET /api/stats */
export interface SavingsBreakdown {
  itemCount: number;
  totalPaidCents: number;
  baselineCents: number;
  realizedSavingsCents: number;
  promoSavingsCents: number;
  storeSplitSavingsCents: number;
  optimalSavingsCents: number;
  missedStoreSavingsCents: number;
  missedBrandSavingsCents: number;
  captureRatePct: number;
}

export interface StoreHistorySummary {
  provider: ActiveShoppingProviderId;
  orderCount: number;
  lineCount: number;
  totalSpentCents: number;
  averageBasketCents: number;
}

export interface TopFavoriteStat {
  storeProductId: string;
  provider: StoreProviderId;
  title: string;
  imageUrl: string | null;
  timesBought: number;
  currentPriceCents: number;
}

export interface PriceChangeStat {
  storeProductId: string;
  provider: StoreProviderId;
  title: string;
  timesBought: number;
  avgHistoricalCents: number;
  currentPriceCents: number;
  changeCents: number;
  changePct: number;
}

export interface RecentSavedItemStat {
  id: number;
  completedAt: string;
  title: string;
  provider: ActiveShoppingProviderId;
  qty: number;
  paidCents: number;
  savedCents: number;
  missedOptimalCents: number;
}

export interface StatsResponse {
  lifetime: SavingsBreakdown;
  activeList: SavingsBreakdown;
  completedByStore: Array<{
    provider: ActiveShoppingProviderId;
    itemCount: number;
    paidCents: number;
    savedCents: number;
  }>;
  receiptStoreSummary: StoreHistorySummary[];
  houseBrandSharePct: number;
  houseBrandLines: number;
  brandedLines: number;
  topFavorites: TopFavoriteStat[];
  biggestCompletedWins: RecentSavedItemStat[];
  priceMovers: {
    drops: PriceChangeStat[];
    hikes: PriceChangeStat[];
  };
}

/** Payload of the /api/events SSE stream (`data: <json>`). */
export type SseEventPayload =
  | { type: "hello"; at: string }
  | { type: "list.changed"; at: string; itemIds?: number[] }
  | { type: "list.cleared"; at: string }
  | { type: "stores.changed"; at: string; provider: StoreProviderId }
  | { type: "preferences.changed"; at: string }
  | { type: "stats.changed"; at: string };
