import {
  getConceptBySlug,
  getTopPreferences,
  insertPurchaseHistory,
  type PurchaseHistoryInput,
  linkConceptToProduct,
  recomputeProductPreferences,
  upsertConcept,
  upsertStoreProducts,
} from "@/lib/db/repositories";
import type { BaseUnit, DemoSeedResponse, NormalizedStoreProduct, PromoMechanism, StoreProviderId } from "@/lib/types";
import { emitEvent, nowIso } from "./eventBus";

export interface DemoProduct {
  provider: Extract<StoreProviderId, "ah" | "picnic">;
  externalId: string;
  title: string;
  brand: string;
  house: boolean;
  size: string;
  amount: number;
  unit: BaseUnit;
  priceCents: number;
  promo?: PromoMechanism;
  /** Concept slug + display name the product is linked to. */
  concept: [string, string];
  /** Number of distinct receipts/deliveries the product appears on. */
  bought: number;
}

const AH = "ah" as const;
const PN = "picnic" as const;

export const DEMO_CATALOG: DemoProduct[] = [
  // Strong brand loyalty: Calvé 9x vs house brand 1x
  { provider: AH, externalId: "wi-demo-calve-350", title: "Calvé Pindakaas 350 g", brand: "Calvé", house: false, size: "350 g", amount: 350, unit: "g", priceCents: 299, concept: ["pindakaas", "pindakaas"], bought: 6 },
  { provider: AH, externalId: "wi-demo-calve-650", title: "Calvé Pindakaas 650 g", brand: "Calvé", house: false, size: "650 g", amount: 650, unit: "g", priceCents: 489, concept: ["pindakaas", "pindakaas"], bought: 3 },
  { provider: AH, externalId: "wi-demo-ah-pindakaas-350", title: "AH Pindakaas 350 g", brand: "AH", house: true, size: "350 g", amount: 350, unit: "g", priceCents: 199, concept: ["pindakaas", "pindakaas"], bought: 1 },
  { provider: PN, externalId: "s-demo-picnic-pindakaas-350", title: "Picnic Pindakaas 350 g", brand: "Picnic", house: true, size: "350 g", amount: 350, unit: "g", priceCents: 189, concept: ["pindakaas", "pindakaas"], bought: 0 },
  { provider: PN, externalId: "s-demo-calve-350", title: "Calvé Pindakaas 350 g", brand: "Calvé", house: false, size: "350 g", amount: 350, unit: "g", priceCents: 319, concept: ["pindakaas", "pindakaas"], bought: 0 },
  { provider: AH, externalId: "wi-demo-cola-zero-15", title: "Coca-Cola Zero Sugar 1,5 l", brand: "Coca-Cola", house: false, size: "1,5 l", amount: 1500, unit: "ml", priceCents: 249, promo: { type: "x_for_y", label: "2 voor 4,00", bundleQty: 2, bundlePriceCents: 400 }, concept: ["cola-zero", "cola zero"], bought: 7 },
  { provider: AH, externalId: "wi-demo-ah-cola-zero-15", title: "AH Cola Zero 1,5 l", brand: "AH", house: true, size: "1,5 l", amount: 1500, unit: "ml", priceCents: 99, concept: ["cola-zero", "cola zero"], bought: 0 },
  { provider: PN, externalId: "s-demo-cola-zero-15", title: "Coca-Cola Zero Sugar 1,5 l", brand: "Coca-Cola", house: false, size: "1,5 l", amount: 1500, unit: "ml", priceCents: 229, concept: ["cola-zero", "cola zero"], bought: 2 },
  { provider: AH, externalId: "wi-demo-oatly-1l", title: "Oatly Haverdrink Barista 1 l", brand: "Oatly", house: false, size: "1 l", amount: 1000, unit: "ml", priceCents: 229, concept: ["haverdrink", "haverdrink"], bought: 5 },
  { provider: AH, externalId: "wi-demo-ah-haverdrink-1l", title: "AH Haverdrink 1 l", brand: "AH", house: true, size: "1 l", amount: 1000, unit: "ml", priceCents: 139, concept: ["haverdrink", "haverdrink"], bought: 0 },
  { provider: AH, externalId: "wi-demo-campina-yoghurt-1l", title: "Campina Volle yoghurt 1 l", brand: "Campina", house: false, size: "1 l", amount: 1000, unit: "ml", priceCents: 159, concept: ["yoghurt", "yoghurt"], bought: 5 },
  { provider: AH, externalId: "wi-demo-ah-yoghurt-1l", title: "AH Volle yoghurt 1 l", brand: "AH", house: true, size: "1 l", amount: 1000, unit: "ml", priceCents: 119, concept: ["yoghurt", "yoghurt"], bought: 1 },
  // House-brand staples
  { provider: AH, externalId: "wi-demo-ah-kwark-1kg", title: "AH Magere kwark 1 kg", brand: "AH", house: true, size: "1 kg", amount: 1000, unit: "g", priceCents: 149, concept: ["magere-kwark", "magere kwark"], bought: 8 },
  { provider: PN, externalId: "s-demo-picnic-kwark-1kg", title: "Picnic Magere kwark 1 kg", brand: "Picnic", house: true, size: "1 kg", amount: 1000, unit: "g", priceCents: 139, concept: ["magere-kwark", "magere kwark"], bought: 3 },
  { provider: AH, externalId: "wi-demo-ah-melk-1l", title: "AH Halfvolle melk 1 l", brand: "AH", house: true, size: "1 l", amount: 1000, unit: "ml", priceCents: 109, concept: ["halfvolle-melk", "halfvolle melk"], bought: 12 },
  { provider: PN, externalId: "s-demo-picnic-melk-1l", title: "Picnic Halfvolle melk 1 l", brand: "Picnic", house: true, size: "1 l", amount: 1000, unit: "ml", priceCents: 105, concept: ["halfvolle-melk", "halfvolle melk"], bought: 2 },
  { provider: AH, externalId: "wi-demo-ah-volkoren-800", title: "AH Volkorenbrood heel 800 g", brand: "AH", house: true, size: "800 g", amount: 800, unit: "g", priceCents: 229, concept: ["volkorenbrood", "volkorenbrood"], bought: 9 },
  { provider: AH, externalId: "wi-demo-ah-eieren-10", title: "AH Scharreleieren vrije uitloop 10 stuks", brand: "AH", house: true, size: "10 stuks", amount: 10, unit: "piece", priceCents: 329, concept: ["eieren", "eieren"], bought: 10 },
  { provider: PN, externalId: "s-demo-picnic-eieren-10", title: "Picnic Vrije uitloop eieren 10 stuks", brand: "Picnic", house: true, size: "10 stuks", amount: 10, unit: "piece", priceCents: 319, concept: ["eieren", "eieren"], bought: 3 },
  { provider: AH, externalId: "wi-demo-ah-bananen", title: "AH Bananen 5 stuks", brand: "AH", house: true, size: "5 stuks", amount: 5, unit: "piece", priceCents: 129, concept: ["bananen", "bananen"], bought: 11 },
  { provider: PN, externalId: "s-demo-picnic-bananen", title: "Picnic Bananen 5 stuks", brand: "Picnic", house: true, size: "5 stuks", amount: 5, unit: "piece", priceCents: 119, concept: ["bananen", "bananen"], bought: 3 },
  { provider: AH, externalId: "wi-demo-ah-komkommer", title: "AH Komkommer", brand: "AH", house: true, size: "1 stuk", amount: 1, unit: "piece", priceCents: 79, concept: ["komkommer", "komkommer"], bought: 8 },
  { provider: PN, externalId: "s-demo-picnic-komkommer", title: "Picnic Komkommer", brand: "Picnic", house: true, size: "1 stuk", amount: 1, unit: "piece", priceCents: 69, concept: ["komkommer", "komkommer"], bought: 2 },
];

const AH_RECEIPTS = 18;
const PICNIC_DELIVERIES = 6;

function toProduct(p: DemoProduct): NormalizedStoreProduct {
  return {
    id: `${p.provider}:${p.externalId}`,
    provider: p.provider,
    externalId: p.externalId,
    title: p.title,
    brand: p.brand,
    isHouseBrand: p.house,
    unitSizeRaw: p.size,
    baseAmount: p.amount,
    baseUnit: p.unit,
    regularPriceCents: p.priceCents,
    currentPriceCents: p.priceCents,
    promo: p.promo ?? null,
    isOnlineOnlyPromo: false,
    imageUrl: null,
    available: true,
    updatedAt: nowIso(),
  };
}

function dayIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

/** Seeds receipts/deliveries + concept links so brand loyalty and affinity work before any store login. */
export async function seedDemoHistory(): Promise<DemoSeedResponse> {
  upsertStoreProducts(DEMO_CATALOG.map(toProduct));

  for (const p of DEMO_CATALOG) {
    const [slug, name] = p.concept;
    const concept = getConceptBySlug(slug) ?? upsertConcept({ slug, name, baseUnit: p.unit });
    linkConceptToProduct(concept.id, `${p.provider}:${p.externalId}`, true, "history");
  }

  const entries: PurchaseHistoryInput[] = [];
  DEMO_CATALOG.forEach((p, index) => {
    const receipts = p.provider === AH ? AH_RECEIPTS : PICNIC_DELIVERIES;
    const spacing = p.provider === AH ? 4 : 10;
    for (let k = 0; k < p.bought; k++) {
      // a stride of 2 spreads purchases over time; k < receipts / stride keeps receipts distinct
      const stride = p.provider === AH && p.bought <= receipts / 2 ? 2 : 1;
      const tx = (index + k * stride) % receipts;
      entries.push({
        provider: p.provider,
        txId: `demo-${p.provider}-${String(tx + 1).padStart(2, "0")}`,
        purchasedAt: dayIso((receipts - 1 - tx) * spacing + 1),
        storeProductId: `${p.provider}:${p.externalId}`,
        rawName: p.title,
        quantity: 1,
        totalCents: p.priceCents,
      });
    }
  });
  const historyEntries = insertPurchaseHistory(entries);
  recomputeProductPreferences();
  emitEvent({ type: "preferences.changed", at: nowIso() });

  return {
    ok: true,
    historyEntries,
    products: DEMO_CATALOG.length,
    preferences: getTopPreferences({ limit: 1000 }).length,
  };
}
