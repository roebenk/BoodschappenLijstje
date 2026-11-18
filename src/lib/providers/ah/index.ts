import type {
  AdapterCapabilities,
  AuthFlowInput,
  AuthFlowResult,
  PushItemInput,
  PushListResult,
  RadarDeal,
  SearchOptions,
  SearchResponse,
  StoreAuthState,
  SupermarketAdapter,
  SyncHistoryResult,
} from "../../types";
import { authenticate, getAuthState } from "./auth";
import { getAhPromotions, searchAh } from "./products";
import { syncAhHistory } from "./receipts";
import { pushToAhList } from "./shoppingList";

export class AlbertHeijnAdapter implements SupermarketAdapter {
  readonly id = "ah" as const;
  readonly displayName = "Albert Heijn";
  readonly channel = "in_store" as const;
  readonly capabilities: AdapterCapabilities = {
    search: true,
    promotions: true,
    historySync: true,
    listPush: true,
  };

  getAuthState(): Promise<StoreAuthState> {
    return getAuthState();
  }

  authenticate(input: AuthFlowInput): Promise<AuthFlowResult> {
    return authenticate(input);
  }

  async searchProducts({ query, limit }: SearchOptions): Promise<SearchResponse> {
    return searchAh(query, limit ?? 20);
  }

  getPromotions(): Promise<RadarDeal[]> {
    return getAhPromotions();
  }

  syncHistory(): Promise<SyncHistoryResult> {
    return syncAhHistory();
  }

  pushItems(items: PushItemInput[]): Promise<PushListResult> {
    return pushToAhList(items);
  }
}

export const albertHeijnAdapter = new AlbertHeijnAdapter();

export { AH_HEADERS, AhAuthRequiredError, AhHttpError } from "./client";
export { extractAuthCode, resetAhAuthCacheForTests } from "./auth";
export { parseSalesUnitSize, resolveAhPackInfo } from "./packSize";
export { normalizeAhProduct, parseAhPromo } from "./products";
