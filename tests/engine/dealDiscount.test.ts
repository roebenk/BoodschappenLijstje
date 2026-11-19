import { describe, expect, it } from "vitest";
import { dealDiscount } from "@/lib/engine/dealDiscount";

describe("dealDiscount", () => {
  it("computes the effective discount for multi-buy promos", () => {
    expect(dealDiscount({ priceCents: 249, regularPriceCents: 249, promoLabel: "1+1 gratis" })).toEqual({
      percent: 50,
      savingCents: 125,
      effectiveUnitCents: 125,
    });
    expect(dealDiscount({ priceCents: 249, regularPriceCents: 249, promoLabel: "2 voor 4,00" })).toMatchObject({
      percent: 20,
      effectiveUnitCents: 200,
    });
    expect(dealDiscount({ priceCents: 200, regularPriceCents: 200, promoLabel: "2e halve prijs" })).toMatchObject({
      percent: 25,
      effectiveUnitCents: 150,
    });
    expect(dealDiscount({ priceCents: 300, regularPriceCents: 300, promoLabel: "3 voor 2" })).toMatchObject({ percent: 33 });
  });

  it("uses the price drop for plain promotions and ignores deals without savings", () => {
    expect(dealDiscount({ priceCents: 279, regularPriceCents: 349, promoLabel: "Aanbieding" })).toEqual({
      percent: 20,
      savingCents: 70,
      effectiveUnitCents: null,
    });
    expect(dealDiscount({ priceCents: 300, regularPriceCents: 300, promoLabel: "Aanbieding" })).toBeNull();
    expect(dealDiscount({ priceCents: 300, regularPriceCents: 300, promoLabel: "2 voor 6,00" })).toBeNull();
  });
});
