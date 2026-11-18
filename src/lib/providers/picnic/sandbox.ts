import type { NormalizedStoreProduct, PromoMechanism } from "@/lib/types";
import { isPicnicHouseBrand, parsePromoLabel, parseUnitQuantity } from "./parse";

export const SANDBOX_SOURCE_NOTE = "Picnic voorbeeldprijzen (koppel Picnic voor live accountprijzen)";

interface SandboxSeed {
  id: string;
  title: string;
  brand: string | null;
  size: string;
  /** Regular price in cents. */
  price: number;
  /** Current price in cents when discounted. */
  now?: number;
  promo?: string | PromoMechanism;
  keywords: string;
}

function tiered(label: string, tiers: Array<[number, number]>): PromoMechanism {
  return { type: "tiered_price", label, tiers: tiers.map(([fromQty, unitPriceCents]) => ({ fromQty, unitPriceCents })) };
}

const SEEDS: SandboxSeed[] = [
  { id: "sb-kwark-500", title: "Picnic Magere kwark", brand: "Picnic", size: "500 gram", price: 109, keywords: "kwark magere kwark mager" },
  { id: "sb-kwark-1k", title: "Picnic Magere kwark", brand: "Picnic", size: "1 kg", price: 179, promo: tiered("Staffelprijs: vanaf 4 stuks", [[1, 179], [4, 159]]), keywords: "kwark magere kwark mager" },
  { id: "sb-kwark-campina", title: "Campina Magere kwark", brand: "Campina", size: "500 gram", price: 149, now: 129, promo: "2 voor €2.50", keywords: "kwark magere kwark mager" },
  { id: "sb-kwark-almhof", title: "Almhof Magere kwark", brand: "Almhof", size: "500 gram", price: 135, keywords: "kwark magere kwark mager" },
  { id: "sb-melk-halfvol", title: "Picnic Halfvolle melk", brand: "Picnic", size: "1 liter", price: 109, keywords: "melk halfvolle melk halfvol" },
  { id: "sb-melk-vol", title: "Picnic Volle melk", brand: "Picnic", size: "1 liter", price: 109, keywords: "melk volle melk vol" },
  { id: "sb-melk-campina", title: "Campina Halfvolle melk", brand: "Campina", size: "1 liter", price: 129, keywords: "melk halfvolle melk halfvol" },
  { id: "sb-pindakaas-picnic", title: "Picnic Pindakaas", brand: "Picnic", size: "350 gram", price: 199, keywords: "pindakaas pinda" },
  { id: "sb-pindakaas-calve-350", title: "Calvé Pindakaas", brand: "Calvé", size: "350 gram", price: 349, now: 279, promo: "1+1 gratis", keywords: "pindakaas pinda" },
  { id: "sb-pindakaas-calve-650", title: "Calvé Pindakaas", brand: "Calvé", size: "650 gram", price: 549, keywords: "pindakaas pinda" },
  { id: "sb-cola-zero", title: "Coca-Cola Zero Sugar", brand: "Coca-Cola", size: "6 x 330 ml", price: 549, now: 449, promo: "25% korting", keywords: "cola zero cola coca" },
  { id: "sb-cola-zero-picnic", title: "Picnic Cola Zero", brand: "Picnic", size: "1.5 liter", price: 89, keywords: "cola zero cola" },
  { id: "sb-eieren-10", title: "Picnic Scharreleieren", brand: "Picnic", size: "10 stuks", price: 279, keywords: "eieren ei scharrelei scharreleieren" },
  { id: "sb-eieren-6", title: "Picnic Scharreleieren", brand: "Picnic", size: "6 stuks", price: 179, keywords: "eieren ei scharrelei scharreleieren" },
  { id: "sb-bananen", title: "Bananen", brand: null, size: "5 stuks", price: 119, keywords: "bananen banaan fruit" },
  { id: "sb-komkommer", title: "Komkommer", brand: null, size: "1 stuk", price: 79, now: 59, promo: "25% korting", keywords: "komkommer groente" },
  { id: "sb-kipfilet", title: "Picnic Kipfilet", brand: "Picnic", size: "400 gram", price: 449, promo: "2e halve prijs", keywords: "kipfilet kip filet vlees" },
  { id: "sb-brood-volkoren", title: "Picnic Volkoren brood", brand: "Picnic", size: "800 gram", price: 169, keywords: "brood volkoren volkorenbrood" },
  { id: "sb-spaghetti", title: "Picnic Spaghetti", brand: "Picnic", size: "500 gram", price: 89, keywords: "spaghetti pasta" },
  { id: "sb-spaghetti-barilla", title: "Barilla Spaghetti n.5", brand: "Barilla", size: "500 gram", price: 199, now: 149, promo: "2 voor €3.50", keywords: "spaghetti pasta" },
  { id: "sb-roomboter", title: "Picnic Roomboter", brand: "Picnic", size: "250 gram", price: 289, keywords: "roomboter boter" },
  { id: "sb-koffiebonen", title: "Picnic Koffiebonen medium roast", brand: "Picnic", size: "1 kg", price: 1099, keywords: "koffie koffiebonen bonen" },
  { id: "sb-koffiebonen-dg", title: "Douwe Egberts Koffiebonen", brand: "Douwe Egberts", size: "1 kg", price: 1599, now: 1299, promo: "1+1 gratis", keywords: "koffie koffiebonen bonen" },
  { id: "sb-cherrytomaten", title: "Cherrytomaten", brand: null, size: "250 gram", price: 169, keywords: "cherrytomaten tomaten tomaat cherry" },
  { id: "sb-yoghurt", title: "Picnic Griekse yoghurt", brand: "Picnic", size: "500 gram", price: 129, keywords: "yoghurt griekse" },
  { id: "sb-kaas", title: "Picnic Jonge kaas plakken", brand: "Picnic", size: "400 gram", price: 449, keywords: "kaas jonge kaas plakken" },
  { id: "sb-aardappelen", title: "Picnic Kruimige aardappelen", brand: "Picnic", size: "2.5 kg", price: 299, keywords: "aardappelen aardappel kruimig" },
  { id: "sb-rijst", title: "Picnic Basmati rijst", brand: "Picnic", size: "1 kg", price: 229, keywords: "rijst basmati" },
];

function toProduct(seed: SandboxSeed): NormalizedStoreProduct {
  const unit = parseUnitQuantity(seed.size);
  const promo = typeof seed.promo === "string" ? parsePromoLabel(seed.promo) : (seed.promo ?? null);
  return {
    id: `picnic:${seed.id}`,
    provider: "picnic",
    externalId: seed.id,
    title: seed.title,
    brand: seed.brand,
    isHouseBrand: isPicnicHouseBrand(seed.brand, seed.title),
    unitSizeRaw: seed.size,
    baseAmount: unit.baseAmount,
    baseUnit: unit.baseUnit,
    regularPriceCents: seed.price,
    currentPriceCents: seed.now ?? seed.price,
    promo,
    isOnlineOnlyPromo: false,
    previouslyBought: false,
    imageUrl: null,
    available: true,
    isMockFallback: true,
  };
}

export function getSandboxCatalog(): NormalizedStoreProduct[] {
  return SEEDS.map(toProduct);
}

export function searchSandboxCatalog(query: string, limit = 20): NormalizedStoreProduct[] {
  const tokens = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
  if (tokens.length === 0) return [];
  const scored: Array<{ seed: SandboxSeed; score: number }> = [];
  for (const seed of SEEDS) {
    const hay = `${seed.title} ${seed.brand ?? ""} ${seed.keywords}`
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const hits = tokens.filter((t) => hay.includes(t)).length;
    if (hits === tokens.length) scored.push({ seed, score: hits });
  }
  return scored.slice(0, limit).map(({ seed }) => toProduct(seed));
}
