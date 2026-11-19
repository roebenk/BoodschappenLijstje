import { parsePromoLabel } from "@/lib/providers/picnic/parse";
import type { RadarDeal } from "@/lib/types";

export interface DealDiscount {
  /** Effective discount per pack, rounded (0-99). */
  percent: number;
  /** Saving per pack in cents when the deal is applied. */
  savingCents: number;
  /** Effective price per pack for multi-buy deals ("2 voor", "1+1 gratis"); null for plain price drops. */
  effectiveUnitCents: number | null;
}

/** Works out the real discount of a deal, including multi-buy mechanics that a price comparison alone cannot show. */
export function dealDiscount(deal: Pick<RadarDeal, "priceCents" | "regularPriceCents" | "promoLabel">): DealDiscount | null {
  const price = deal.priceCents;
  const regular = deal.regularPriceCents ?? price;
  const promo = parsePromoLabel(deal.promoLabel);

  let effective: number | null = null;
  if (regular && regular > 0 && promo) {
    switch (promo.type) {
      case "bogo":
      case "x_plus_y_free": {
        const buy = promo.buyQty ?? 1;
        const free = promo.freeQty ?? 1;
        effective = (regular * buy) / (buy + free);
        break;
      }
      case "x_for_y":
        if (promo.bundleQty && promo.bundleQty > 1 && promo.bundlePriceCents) effective = promo.bundlePriceCents / promo.bundleQty;
        break;
      case "second_half_price":
        effective = regular * 0.75;
        break;
    }
  }
  if (effective !== null && regular) {
    const savingCents = Math.round(regular - effective);
    if (savingCents <= 0) return null;
    return {
      percent: Math.round((savingCents / regular) * 100),
      savingCents,
      effectiveUnitCents: Math.round(effective),
    };
  }

  if (price !== null && deal.regularPriceCents != null && deal.regularPriceCents > price) {
    const savingCents = deal.regularPriceCents - price;
    return { percent: Math.round((savingCents / deal.regularPriceCents) * 100), savingCents, effectiveUnitCents: null };
  }
  if (promo?.type === "percentage" && promo.discountPercent && price !== null) {
    const savingCents = Math.round((price * promo.discountPercent) / (100 - promo.discountPercent));
    return { percent: promo.discountPercent, savingCents, effectiveUnitCents: null };
  }
  return null;
}
