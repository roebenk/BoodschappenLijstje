import type { NormalizedStoreProduct, RadarDeal, StoreChannel, StoreProviderId } from "./domain";

export interface AdapterCapabilities {
  search: boolean;
  promotions: boolean;
  historySync: boolean;
  listPush: boolean;
  minOrderCents?: number;
}

export interface StoreAuthState {
  provider: StoreProviderId;
  status: "anonymous" | "authenticated" | "awaiting_2fa" | "disconnected" | "error";
  displayName?: string | null;
  lastSyncedAt?: string | null;
  isMockFallback?: boolean;
  message?: string | null;
}

export type AuthFlowInput =
  | { step: "get_login_url" }
  | { step: "exchange_code"; codeOrUrl: string }
  | { step: "login"; email: string; password: string }
  | { step: "verify_2fa"; code: string }
  | { step: "logout" };

export interface AuthFlowResult {
  state: StoreAuthState;
  /** AH `get_login_url` step. */
  loginUrl?: string;
  /** Picnic: 2FA code was requested by SMS. */
  requires2fa?: boolean;
}

export interface SearchOptions {
  query: string;
  limit?: number;
}

export interface SearchResponse {
  products: NormalizedStoreProduct[];
  isMockFallback: boolean;
  sourceNote?: string;
}

export interface SyncHistoryResult {
  provider: StoreProviderId;
  receiptsOrOrdersSynced: number;
  itemsSynced: number;
  productsMapped: number;
  syncedAt: string;
}

export interface PushItemInput {
  externalId: string;
  title: string;
  quantity: number;
}

export interface PushListResult {
  provider: StoreProviderId;
  success: boolean;
  itemsPushed: number;
  cartTotalCents?: number;
  message?: string;
}

export interface SupermarketAdapter {
  readonly id: StoreProviderId;
  readonly displayName: string;
  readonly channel: StoreChannel;
  readonly capabilities: AdapterCapabilities;
  getAuthState(): Promise<StoreAuthState>;
  authenticate(input: AuthFlowInput): Promise<AuthFlowResult>;
  searchProducts(options: SearchOptions): Promise<SearchResponse>;
  getPromotions?(): Promise<RadarDeal[]>;
  syncHistory?(): Promise<SyncHistoryResult>;
  pushItems?(items: PushItemInput[]): Promise<PushListResult>;
}
