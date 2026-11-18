import { upsertStoreProducts } from "../../db/repositories";
import type { NormalizedStoreProduct, PromoMechanism, RadarDeal } from "../../types";
import { AhHttpError, ahRequest } from "./client";
import { getAccessToken } from "./auth";
import { mockPromotions, searchMockCatalog } from "./fallback";
import { parseSalesUnitSize, resolveAhPackInfo } from "./packSize";

export interface AhDiscountLabel {
  code?: string;
  defaultDescription?: string;
  count?: number | null;
  freeCount?: number | null;
  price?: number | null;
  percentage?: number | null;
}

export interface AhRawProduct {
  webshopId: number;
  title: string;
  brand?: string | null;
  salesUnitSize?: string | null;
  unitPriceDescription?: string | null;
  descriptionHighlights?: string | null;
  descriptionFull?: string | null;
  extraDescriptions?: string[] | null;
  priceBeforeBonus?: number | null;
  currentPrice?: number | null;
  isBonus?: boolean;
  bonusMechanism?: string | null;
  discountLabels?: AhDiscountLabel[] | null;
  promotionType?: string | null;
  mainCategory?: string | null;
  images?: Array<{ width?: number; url: string }> | null;
  availableOnline?: boolean;
  isOrderable?: boolean;
  isVirtualBundle?: boolean;
  isPreviouslyBought?: boolean;
}

const HOUSE_BRANDS = new Set([
  "ah",
  "ah biologisch",
  "ah terra",
  "ah excellent",
  "ah vrij van",
  "ah basic",
  "de zaanse hoeve",
  "zaanse hoeve",
]);
const QUANTITY_BASED = new Set(["bogo", "x_plus_y_free", "second_half_price", "x_for_y"]);

const cents = (euros: number) => Math.round(euros * 100);
const euros = (s: string) => Number(s.replace(",", "."));

export function isAhHouseBrand(brand: string | null | undefined, title: string): boolean {
  return HOUSE_BRANDS.has((brand ?? "").trim().toLowerCase()) || /^AH\s/.test(title.trim());
}

function parsePromoText(text: string): PromoMechanism | null {
  const label = text.trim();
  const plus = /(\d+)\s*\+\s*(\d+)\s*gratis/i.exec(label);
  if (plus) {
    const buyQty = Number(plus[1]);
    const freeQty = Number(plus[2]);
    return buyQty === 1 && freeQty === 1
      ? { type: "bogo", label, buyQty, freeQty }
      : { type: "x_plus_y_free", label, buyQty, freeQty };
  }
  if (/2e\s*gratis/i.test(label)) return { type: "bogo", label, buyQty: 1, freeQty: 1 };
  if (/2e\s*halve\s*prijs/i.test(label)) return { type: "second_half_price", label };
  const xFor = /(\d+)\s*voor\s*(?:€\s*)?(\d+(?:[.,]\d+)?)/i.exec(label);
  if (xFor) {
    return { type: "x_for_y", label, bundleQty: Number(xFor[1]), bundlePriceCents: cents(euros(xFor[2])) };
  }
  const pct = /(\d+(?:[.,]\d+)?)\s*%/.exec(label);
  if (pct) return { type: "percentage", label, discountPercent: euros(pct[1]) };
  return null;
}

function promoFromLabelCode(l: AhDiscountLabel): PromoMechanism | null {
  const label = l.defaultDescription ?? "Bonus";
  switch (l.code) {
    case "DISCOUNT_X_FOR_Y":
    case "DISCOUNT_TIERED_PRICE":
      return l.count && l.price != null
        ? { type: "x_for_y", label, bundleQty: l.count, bundlePriceCents: cents(l.price) }
        : null;
    case "DISCOUNT_X_PLUS_Y_FREE":
      return l.count && l.freeCount
        ? { type: l.count === 1 && l.freeCount === 1 ? "bogo" : "x_plus_y_free", label, buyQty: l.count, freeQty: l.freeCount }
        : null;
    case "DISCOUNT_ONE_HALF_PRICE":
      return { type: "second_half_price", label };
    case "DISCOUNT_PERCENTAGE":
    case "DISCOUNT_TIERED_PERCENT":
    case "DISCOUNT_BUNDLE_BULK":
      return l.percentage ? { type: "percentage", label, discountPercent: l.percentage } : null;
    default:
      return null;
  }
}

export function parseAhPromo(raw: Pick<AhRawProduct, "bonusMechanism" | "discountLabels">): PromoMechanism | null {
  const texts = [raw.bonusMechanism, ...(raw.discountLabels ?? []).map((l) => l.defaultDescription)].filter(
    (t): t is string => !!t && t.trim() !== "",
  );
  for (const t of texts) {
    const p = parsePromoText(t);
    if (p) return p;
  }
  for (const l of raw.discountLabels ?? []) {
    const p = promoFromLabelCode(l);
    if (p) return p;
  }
  return texts[0] ? { type: "fixed_discount", label: texts[0].trim() } : null;
}

export function normalizeAhProduct(raw: AhRawProduct, opts: { isUser?: boolean } = {}): NormalizedStoreProduct | null {
  if (!raw || raw.webshopId == null || raw.isVirtualBundle) return null;
  const regularRaw = raw.priceBeforeBonus ?? raw.currentPrice;
  if (regularRaw == null) return null;
  const regularPriceCents = cents(regularRaw);
  const hasPromo = !!raw.isBonus || raw.currentPrice != null || !!raw.bonusMechanism;
  let promo = hasPromo ? parseAhPromo(raw) : null;
  if (promo && raw.promotionType === "PERSONAL") promo = { ...promo, isPersonalBonus: true };
  const isOnlineOnlyPromo = raw.promotionType === "AHONLINE";

  // In-store shopping: online-only promos do not apply; quantity based promos are priced from the regular price.
  let currentPriceCents = raw.currentPrice != null ? cents(raw.currentPrice) : regularPriceCents;
  if (isOnlineOnlyPromo || (promo && QUANTITY_BASED.has(promo.type))) currentPriceCents = regularPriceCents;

  const title = raw.title.trim();
  const brand = raw.brand?.trim() || null;
  const unitSizeRaw = raw.salesUnitSize ?? "";
  const packInfo = resolveAhPackInfo({
    salesUnitSize: raw.salesUnitSize,
    title,
    regularPriceEuros: regularRaw,
    unitPriceDescription: raw.unitPriceDescription,
    descriptionHighlights: raw.descriptionHighlights,
    descriptionFull: raw.descriptionFull,
    extraDescriptions: raw.extraDescriptions,
  });
  const image = raw.images?.find((i) => i.width === 200) ?? raw.images?.[0];
  return {
    id: `ah:${raw.webshopId}`,
    provider: "ah",
    externalId: String(raw.webshopId),
    title,
    brand,
    isHouseBrand: isAhHouseBrand(brand, title),
    unitSizeRaw,
    baseAmount: packInfo.baseAmount,
    baseUnit: packInfo.baseUnit,
    pieceCount: packInfo.pieceCount,
    regularPriceCents,
    currentPriceCents,
    promo,
    isOnlineOnlyPromo,
    previouslyBought: opts.isUser ? !!raw.isPreviouslyBought : undefined,
    imageUrl: image?.url ?? null,
    category: raw.mainCategory ?? null,
    available: raw.isOrderable !== false,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeAhProducts(raws: AhRawProduct[], opts: { isUser?: boolean } = {}): NormalizedStoreProduct[] {
  return raws.map((r) => normalizeAhProduct(r, opts)).filter((p): p is NormalizedStoreProduct => p !== null);
}

export async function searchAh(
  query: string,
  limit = 20,
): Promise<{ products: NormalizedStoreProduct[]; isMockFallback: boolean; sourceNote?: string }> {
  try {
    const { token, isUser } = await getAccessToken();
    const res = await ahRequest<{ products?: AhRawProduct[] }>(
      `/mobile-services/product/search/v2?query=${encodeURIComponent(query)}&sortOn=RELEVANCE&size=${limit}&page=0&application=AHWEBSHOP`,
      { token },
    );
    const products = normalizeAhProducts(res?.products ?? [], { isUser }).slice(0, limit);
    upsertStoreProducts(products);
    return { products, isMockFallback: false };
  } catch (e) {
    // Only network-level failures fall back to the offline catalog; API errors surface.
    if (e instanceof AhHttpError) throw e;
    const products = searchMockCatalog(query, limit);
    upsertStoreProducts(products);
    return {
      products,
      isMockFallback: true,
      sourceNote: "api.ah.nl is niet bereikbaar — voorbeeldproducten getoond",
    };
  }
}

export async function fetchAhProductsByIds(ids: string[], token: string): Promise<NormalizedStoreProduct[]> {
  const out: NormalizedStoreProduct[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const qs = ids
      .slice(i, i + 25)
      .map((id) => `ids=${encodeURIComponent(id)}`)
      .join("&");
    const res = await ahRequest<AhRawProduct[]>(
      `/mobile-services/product/search/v2/products?${qs}&sortOn=INPUT_PRODUCT_IDS`,
      { token },
    );
    out.push(...normalizeAhProducts(Array.isArray(res) ? res : []));
  }
  return out;
}

/* -------------------------------- Promotions ------------------------------- */

interface BonusSection {
  bonusGroupOrProducts?: Array<{
    bonusGroup?: {
      segmentDescription?: string;
      discountDescription?: string;
      promotionType?: string;
      images?: Array<{ url: string }>;
      exampleFromPrice?: number | null;
      exampleForPrice?: number | null;
    };
    product?: AhRawProduct;
  }>;
}

function mondayOf(d = new Date()): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

function sectionToDeals(section: BonusSection | null, personal: boolean): RadarDeal[] {
  const deals: RadarDeal[] = [];
  for (const entry of section?.bonusGroupOrProducts ?? []) {
    if (entry.product) {
      const p = normalizeAhProduct(entry.product);
      if (!p || p.isOnlineOnlyPromo || !p.promo) continue;
      deals.push({
        provider: "ah",
        title: p.title,
        priceCents: p.currentPriceCents,
        regularPriceCents: p.regularPriceCents,
        promoLabel: personal ? `Persoonlijk: ${p.promo.label}` : p.promo.label,
        imageUrl: p.imageUrl,
      });
    } else if (entry.bonusGroup && entry.bonusGroup.promotionType !== "AHONLINE") {
      const g = entry.bonusGroup;
      deals.push({
        provider: "ah",
        title: g.segmentDescription ?? "Bonus",
        priceCents: g.exampleForPrice != null ? cents(g.exampleForPrice) : null,
        regularPriceCents: g.exampleFromPrice != null ? cents(g.exampleFromPrice) : null,
        promoLabel: personal ? `Persoonlijk: ${g.discountDescription ?? "Bonus"}` : (g.discountDescription ?? "Bonus"),
        imageUrl: g.images?.[0]?.url ?? null,
      });
    }
  }
  return deals;
}

export async function getAhPromotions(limit = 40): Promise<RadarDeal[]> {
  try {
    const { token, isUser } = await getAccessToken();
    const monday = mondayOf();
    const [spotlight, personal] = await Promise.all([
      ahRequest<BonusSection>(
        `/mobile-services/bonuspage/v2/section/spotlight?application=AHWEBSHOP&date=${monday}`,
        { token },
      ).catch(() => null),
      isUser
        ? ahRequest<BonusSection>(`/mobile-services/bonuspage/v1/personal?bonusStartDate=${monday}`, { token }).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);
    const deals = [...sectionToDeals(personal, true), ...sectionToDeals(spotlight, false)];
    const seen = new Set<string>();
    return deals.filter((d) => !seen.has(d.title) && seen.add(d.title)).slice(0, limit);
  } catch (e) {
    if (e instanceof AhHttpError) return [];
    return mockPromotions()
      .slice(0, limit)
      .map((p) => ({
        provider: "ah" as const,
        title: p.title,
        priceCents: p.currentPriceCents,
        regularPriceCents: p.regularPriceCents,
        promoLabel: p.promo?.label ?? "Bonus",
      }));
  }
}
