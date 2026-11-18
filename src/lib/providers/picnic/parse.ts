import { extractPieceCount } from "@/lib/engine/units";
import type { BaseUnit, NormalizedStoreProduct, PromoMechanism } from "@/lib/types";

export const PICNIC_STATIC_BASE = "https://storefront-prod.nl.picnicinternational.com";

export interface PicnicPriceRange {
  price: number;
  from_quantity: number;
}

export interface PicnicTileLike {
  id: string;
  name: string;
  namePrefix?: string | null;
  brand?: string | null;
  qualityCue?: string | null;
  imageId?: string | null;
  displayPrice: number;
  originalPrice?: number | null;
  priceRanges?: PicnicPriceRange[] | null;
  unitQuantity?: string | null;
  labels?: Array<{ text?: string | null }>;
  isUnavailable?: boolean;
}

/** Same format as `picnic-api` catalog.getImageUrl, usable without a client. */
export function picnicImageUrl(imageId: string | null | undefined, size = "medium", base = PICNIC_STATIC_BASE): string | null {
  if (!imageId) return null;
  return `${base}/static/images/${encodeURIComponent(imageId)}/${size}.png`;
}

function toNumber(raw: string): number {
  return Number.parseFloat(raw.replace(",", "."));
}

/** Parses Picnic unit quantities: "1 kg", "500 gram", "6 x 330 ml", "1.5 liter", "2 stuks", "per stuk". */
export function parseUnitQuantity(raw: string | null | undefined): { baseAmount: number; baseUnit: BaseUnit } {
  const text = (raw ?? "").toLowerCase().replace(/\bca\.?\s*/g, "").trim();
  const m = /^(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kilo|gram|gr|g|liter|l|ml|cl|dl|stuks?|st|pieces?|rollen|rol)?(?![a-z])/.exec(text);
  if (!m) return { baseAmount: 1, baseUnit: "piece" };
  const multiplier = m[1] ? Number.parseInt(m[1], 10) : 1;
  const amount = toNumber(m[2]);
  const unit = m[3] ?? "";
  let base: { baseAmount: number; baseUnit: BaseUnit };
  switch (unit) {
    case "kg":
    case "kilo":
      base = { baseAmount: amount * 1000, baseUnit: "g" };
      break;
    case "gram":
    case "gr":
    case "g":
      base = { baseAmount: amount, baseUnit: "g" };
      break;
    case "liter":
    case "l":
      base = { baseAmount: amount * 1000, baseUnit: "ml" };
      break;
    case "ml":
      base = { baseAmount: amount, baseUnit: "ml" };
      break;
    case "cl":
      base = { baseAmount: amount * 10, baseUnit: "ml" };
      break;
    case "dl":
      base = { baseAmount: amount * 100, baseUnit: "ml" };
      break;
    default:
      base = { baseAmount: amount, baseUnit: "piece" };
  }
  return { baseAmount: Math.round(base.baseAmount * multiplier * 100) / 100, baseUnit: base.baseUnit };
}

/** Parses a Dutch promo label ("1+1 gratis", "2 voor €3.99", "2e halve prijs", "25% korting"). */
export function parsePromoLabel(label: string | null | undefined): PromoMechanism | null {
  const text = (label ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  const plus = /(\d+)\s*\+\s*(\d+)\s*gratis/.exec(lower);
  if (plus) {
    const buyQty = Number.parseInt(plus[1], 10);
    const freeQty = Number.parseInt(plus[2], 10);
    return { type: buyQty === 1 && freeQty === 1 ? "bogo" : "x_plus_y_free", label: text, buyQty, freeQty };
  }
  if (/2e\s*(?:artikel\s*)?halve\s*prijs|tweede\s*halve\s*prijs/.test(lower)) {
    return { type: "second_half_price", label: text };
  }
  const xForY = /(\d+)\s*voor\s*(€\s*\d+(?:[.,]\d{1,2})?|\d+[.,]\d{1,2})/.exec(lower);
  if (xForY) {
    return {
      type: "x_for_y",
      label: text,
      bundleQty: Number.parseInt(xForY[1], 10),
      bundlePriceCents: Math.round(toNumber(xForY[2].replace("€", "").trim()) * 100),
    };
  }
  const xForPay = /(\d+)\s*voor\s*(\d+)\b/.exec(lower);
  if (xForPay) {
    const get = Number.parseInt(xForPay[1], 10);
    const pay = Number.parseInt(xForPay[2], 10);
    if (get > pay) return { type: "x_plus_y_free", label: text, buyQty: pay, freeQty: get - pay };
  }
  const pct = /(\d+)\s*%\s*korting/.exec(lower);
  if (pct) return { type: "percentage", label: text, discountPercent: Number.parseInt(pct[1], 10) };
  return null;
}

/** Progressive price tiers (Picnic priceRanges). Returns null when there is no real volume discount. */
export function promoFromPriceRanges(
  ranges: PicnicPriceRange[] | null | undefined,
  basePriceCents: number,
  label = "Staffelprijs",
): PromoMechanism | null {
  if (!ranges || ranges.length === 0) return null;
  const sorted = [...ranges].sort((a, b) => a.from_quantity - b.from_quantity);
  if (!sorted.some((r) => r.from_quantity > 1)) return null;
  const tiers = sorted.map((r) => ({ fromQty: r.from_quantity, unitPriceCents: r.price }));
  if (tiers[0].fromQty > 1) tiers.unshift({ fromQty: 1, unitPriceCents: basePriceCents });
  return { type: "tiered_price", label, tiers };
}

/** Picnic marks private label as brand "Picnic" or without brand + "Picnic ..." name. */
export function isPicnicHouseBrand(brand: string | null | undefined, name: string): boolean {
  if (brand && brand.trim().toLowerCase() === "picnic") return true;
  return !brand && /^picnic\b/i.test(name.trim());
}

const DISTINGUISHING_CUES = /^(planetproof|biologisch|lactosevrij|scharrel|vrije uitloop|glutenvrij)$/i;

/** Strips noisy suffixes like ", In prijs verlaagd" from Picnic's unitQuantity string. */
export function cleanPicnicUnitSize(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/,\s*in prijs verlaagd/gi, "")
    .trim();
}

/** Builds a clear title combining brand, prefix ("Bio") and distinguishing cue ("PlanetProof"). */
export function formatPicnicTitle(tile: Pick<PicnicTileLike, "name" | "namePrefix" | "brand" | "qualityCue">): string {
  const rawName = tile.name.trim();
  const prefix = tile.namePrefix?.trim();
  let core = rawName;
  if (prefix && !core.toLowerCase().startsWith(prefix.toLowerCase())) {
    core = `${prefix} ${core}`;
  }
  if (core.length > 0) {
    core = core.charAt(0).toUpperCase() + core.slice(1);
  }
  const brand = tile.brand?.trim();
  let title = core;
  if (brand && !title.toLowerCase().startsWith(brand.toLowerCase())) {
    title = `${brand} ${title}`;
  }
  const cue = tile.qualityCue?.trim();
  if (cue && DISTINGUISHING_CUES.test(cue) && !title.toLowerCase().includes(cue.toLowerCase())) {
    title = `${title} (${cue})`;
  }
  return title;
}

export function normalizePicnicTile(tile: PicnicTileLike, opts: { previouslyBought?: boolean } = {}): NormalizedStoreProduct {
  const unit = parseUnitQuantity(tile.unitQuantity);
  const labelText = (tile.labels ?? []).map((l) => l.text ?? "").find((t) => parsePromoLabel(t));
  const promo =
    promoFromPriceRanges(tile.priceRanges, tile.displayPrice, labelText || "Staffelprijs") ?? parsePromoLabel(labelText);
  const houseBrand = isPicnicHouseBrand(tile.brand, tile.name);
  const resolvedBrand = tile.brand?.trim() || (houseBrand ? "Picnic" : null);
  const title = formatPicnicTitle({ ...tile, brand: resolvedBrand });
  const unitSizeRaw = cleanPicnicUnitSize(tile.unitQuantity);
  const pieceCount = extractPieceCount(unitSizeRaw, title, unit.baseUnit, unit.baseAmount);
  return {
    id: `picnic:${tile.id}`,
    provider: "picnic",
    externalId: tile.id,
    title,
    brand: resolvedBrand,
    isHouseBrand: houseBrand,
    unitSizeRaw,
    baseAmount: unit.baseAmount,
    baseUnit: unit.baseUnit,
    pieceCount,
    regularPriceCents: tile.originalPrice ?? tile.displayPrice,
    currentPriceCents: tile.displayPrice,
    promo,
    isOnlineOnlyPromo: false,
    previouslyBought: opts.previouslyBought ?? false,
    imageUrl: picnicImageUrl(tile.imageId),
    available: !tile.isUnavailable,
    isMockFallback: false,
    updatedAt: new Date().toISOString(),
  };
}
