import type { ActiveShoppingProviderId, StoreProviderId, SupermarketAdapter } from "@/lib/types";
import { AlbertHeijnAdapter } from "./ah";
import { PicnicAdapter } from "./picnic";
import { JumboRadarAdapter, PlusRadarAdapter } from "./radar";

let providers: Record<StoreProviderId, SupermarketAdapter> | null = null;

function registry(): Record<StoreProviderId, SupermarketAdapter> {
  providers ??= {
    ah: new AlbertHeijnAdapter(),
    picnic: new PicnicAdapter(),
    jumbo: new JumboRadarAdapter(),
    plus: new PlusRadarAdapter(),
  };
  return providers;
}

export function getProvider(id: StoreProviderId): SupermarketAdapter {
  const adapter = registry()[id];
  if (!adapter) throw new Error(`Onbekende winkelaanbieder: ${id}`);
  return adapter;
}

export function getAllProviders(): SupermarketAdapter[] {
  return Object.values(registry());
}

/** The two providers the shopping list is optimised across. */
export function getActiveShoppingProviders(): [SupermarketAdapter, SupermarketAdapter] {
  const ids: [ActiveShoppingProviderId, ActiveShoppingProviderId] = ["ah", "picnic"];
  return [getProvider(ids[0]), getProvider(ids[1])];
}
