import type { NormalizedStoreProduct } from "../../types";
import { parseSalesUnitSize } from "./packSize";

type Seed = [string, string, string | null, string, number, number | null, string?];

// [webshopId, title, brand, salesUnitSize, regularCents, bonusCents, bonusLabel]
const SEEDS: Seed[] = [
  ["mock-kwark", "AH Magere kwark", "AH", "1 kg", 129, null],
  ["mock-melk", "AH Halfvolle melk", "AH", "1 l", 119, null],
  ["mock-pindakaas", "Calvé Pindakaas", "Calvé", "650 g", 399, 299, "25% korting"],
  ["mock-eieren", "AH Scharreleieren", "AH", "10 stuks", 285, null],
  ["mock-bananen", "AH Bananen", "AH", "1 kg", 189, null],
  ["mock-komkommer", "AH Komkommer", "AH", "per stuk", 79, null],
  ["mock-cola-zero", "Coca-Cola Zero sugar", "Coca-Cola", "6 x 330 ml", 459, null],
  ["mock-kipfilet", "AH Kipfilet", "AH", "500 g", 599, null],
  ["mock-volkorenbrood", "AH Volkoren brood", "AH", "800 g", 215, null],
  ["mock-pasta", "AH Penne", "AH", "500 g", 99, null],
  ["mock-koffiemelk", "Friesche Vlag Langlekker koffiemelk", "Friesche Vlag", "1 l", 189, null],
  ["mock-roomboter", "AH Roomboter", "AH", "250 g", 289, null],
];

function seedToProduct([id, title, brand, size, regular, bonus, label]: Seed): NormalizedStoreProduct {
  const { baseAmount, baseUnit } = parseSalesUnitSize(size);
  return {
    id: `ah:${id}`,
    provider: "ah",
    externalId: id,
    title,
    brand,
    isHouseBrand: brand === "AH",
    unitSizeRaw: size,
    baseAmount,
    baseUnit,
    regularPriceCents: regular,
    currentPriceCents: bonus ?? regular,
    promo: bonus ? { type: "percentage", label: label ?? "Bonus", discountPercent: 25 } : null,
    isOnlineOnlyPromo: false,
    imageUrl: null,
    available: true,
    isMockFallback: true,
  };
}

const KEYWORDS: Record<string, string[]> = {
  "mock-kwark": ["kwark", "yoghurt"],
  "mock-melk": ["melk", "halfvolle"],
  "mock-pindakaas": ["pindakaas", "pinda"],
  "mock-eieren": ["ei", "eieren"],
  "mock-bananen": ["banaan", "bananen"],
  "mock-komkommer": ["komkommer"],
  "mock-cola-zero": ["cola", "zero", "frisdrank"],
  "mock-kipfilet": ["kip", "kipfilet"],
  "mock-volkorenbrood": ["brood", "volkoren"],
  "mock-pasta": ["pasta", "penne", "spaghetti"],
  "mock-koffiemelk": ["koffiemelk", "koffie"],
  "mock-roomboter": ["boter", "roomboter"],
};

/** Offline catalog used only when api.ah.nl cannot be reached. */
export function searchMockCatalog(query: string, limit: number): NormalizedStoreProduct[] {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 1);
  const hits = SEEDS.filter((seed) => {
    const hay = `${seed[1].toLowerCase()} ${(KEYWORDS[seed[0]] ?? []).join(" ")}`;
    return words.some((w) => hay.includes(w) || (w.length > 3 && KEYWORDS[seed[0]]?.some((k) => w.includes(k))));
  });
  return (hits.length ? hits : []).slice(0, limit).map(seedToProduct);
}

export function mockPromotions(): NormalizedStoreProduct[] {
  return SEEDS.filter((s) => s[5] !== null).map(seedToProduct);
}
