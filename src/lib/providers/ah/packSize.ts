import type { BaseUnit } from "../../types";

export interface AhPackSize {
  baseAmount: number;
  baseUnit: BaseUnit;
}

const UNIT_RE =
  /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kilogram|kilo|kg|gram|gr|g|mg|liter|ltr|l|ml|cl|dl|stuks|stuk|stk|st)\b/i;

const FACTORS: Record<string, [number, BaseUnit]> = {
  kilogram: [1000, "g"],
  kilo: [1000, "g"],
  kg: [1000, "g"],
  gram: [1, "g"],
  gr: [1, "g"],
  g: [1, "g"],
  mg: [0.001, "g"],
  liter: [1000, "ml"],
  ltr: [1000, "ml"],
  l: [1000, "ml"],
  ml: [1, "ml"],
  cl: [10, "ml"],
  dl: [100, "ml"],
  stuks: [1, "piece"],
  stuk: [1, "piece"],
  stk: [1, "piece"],
  st: [1, "piece"],
};

/** Maps AH `salesUnitSize` ("1,5 l", "6 x 330 ml", "per stuk") to an amount in g / ml / pieces. */
export function parseSalesUnitSize(raw: string | null | undefined): AhPackSize {
  const text = (raw ?? "").trim();
  const m = UNIT_RE.exec(text);
  if (m) {
    const multiplier = m[1] ? Number(m[1]) : 1;
    const amount = Number(m[2].replace(",", "."));
    const [factor, baseUnit] = FACTORS[m[3].toLowerCase()];
    const baseAmount = Math.round(multiplier * amount * factor * 1000) / 1000;
    if (baseAmount > 0) return { baseAmount, baseUnit };
  }
  if (/\bper\s+(kg|kilo)\b/i.test(text)) return { baseAmount: 1000, baseUnit: "g" };
  if (/\bper\s+(l|liter)\b/i.test(text)) return { baseAmount: 1000, baseUnit: "ml" };
  return { baseAmount: 1, baseUnit: "piece" };
}

const DESC_MULTI_WEIGHT_RE = /\b(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kilogram|kilo|kg|gram|gr|g)\b/i;
const DESC_CA_WEIGHT_RE =
  /(?<!per\s)(?<!\/\s*)\b(?:ca\.?\s*|circa\s*|gewicht\s*:?\s*|inhoud\s*:?\s*)?(\d+(?:[.,]\d+)?)\s*(kilogram|kilo|kg|gram|gr|g)\b(?!\s*bevat)/gi;
const UNIT_PRICE_KG_RE = /\bper\s*(?:kg|kilo)\s*€?\s*(\d+(?:[.,]\d{1,2})?)/i;
const UNIT_PRICE_L_RE = /\bper\s*(?:l|liter)\s*€?\s*(\d+(?:[.,]\d{1,2})?)/i;

function extractWeightGramsFromTexts(texts: Array<string | null | undefined>): number | null {
  for (const raw of texts) {
    if (!raw) continue;
    const clean = raw.replace(/<[^>]+>/g, " ");
    const multi = DESC_MULTI_WEIGHT_RE.exec(clean);
    if (multi) {
      const mult = Number(multi[1]);
      const amt = Number(multi[2].replace(",", "."));
      const factor = /^k/i.test(multi[3]) ? 1000 : 1;
      const g = Math.round(mult * amt * factor);
      if (g >= 15 && g <= 20000) return g;
    }
    DESC_CA_WEIGHT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DESC_CA_WEIGHT_RE.exec(clean)) !== null) {
      const prefix = clean.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
      if (/\b(?:per|voedingswaarde|energie)\s*$/.test(prefix)) continue;
      const amt = Number(m[1].replace(",", "."));
      const factor = /^k/i.test(m[2]) ? 1000 : 1;
      const g = Math.round(amt * factor);
      // Skip "100 g" in prose unless explicitly preceded by ca./inhoud/gewicht or inside title
      if (g === 100 && !/\b(?:ca|circa|inhoud|gewicht)/i.test(m[0]) && raw !== texts[0]) continue;
      if (g >= 25 && g <= 20000) return g;
    }
  }
  return null;
}

/**
 * Enriches AH pack sizing using title, `unitPriceDescription` ("prijs per kg €11.95") and product descriptions
 * when `salesUnitSize` only specifies pieces ("4 stuks", "Tros", "per stuk").
 */
export function resolveAhPackInfo(input: {
  salesUnitSize?: string | null;
  title: string;
  regularPriceEuros?: number | null;
  unitPriceDescription?: string | null;
  descriptionHighlights?: string | null;
  descriptionFull?: string | null;
  extraDescriptions?: string[] | null;
}): AhPackSize & { pieceCount: number | null } {
  const rawSize = (input.salesUnitSize ?? "").trim();
  const base = parseSalesUnitSize(rawSize);

  // "Tros" bananas (~5 bananas) would otherwise look 5x more expensive per piece than "5 stuks" packs.
  if (/^tros$/i.test(rawSize) && /\bbana/i.test(input.title)) {
    return { baseAmount: 5, baseUnit: "piece", pieceCount: 5 };
  }

  let pieceCount: number | null = null;
  const multi = /^\s*(\d+)\s*[x×]\s*\d/i.exec(rawSize) ?? /\b(\d+)\s*[x×]\s*\d+/i.exec(input.title);
  if (multi) pieceCount = Math.max(1, Number(multi[1]));
  else {
    const pcs =
      /\b(\d+)\s*(?:stuks?|stk|st|pack|blikjes|rollen|zakjes|bakjes)\b/i.exec(rawSize) ??
      /\b(\d+)\s*(?:stuks?|stk|-?\s*pack|blikjes)\b/i.exec(input.title);
    if (pcs) pieceCount = Math.max(1, Number(pcs[1]));
    else if (base.baseUnit === "piece" && base.baseAmount >= 1 && Number.isInteger(base.baseAmount)) {
      pieceCount = base.baseAmount;
    }
  }

  if (base.baseUnit !== "piece") {
    return { ...base, pieceCount };
  }

  // Try unitPriceDescription first ("prijs per kg €11.95") — exact store-reported ratio.
  const upd = input.unitPriceDescription ?? "";
  if (input.regularPriceEuros && input.regularPriceEuros > 0 && upd) {
    const kgMatch = UNIT_PRICE_KG_RE.exec(upd);
    if (kgMatch) {
      const perKg = Number(kgMatch[1].replace(",", "."));
      if (perKg > 0) {
        const grams = Math.round((input.regularPriceEuros / perKg) * 1000);
        if (grams >= 20 && grams <= 25000) return { baseAmount: grams, baseUnit: "g", pieceCount };
      }
    }
    const lMatch = UNIT_PRICE_L_RE.exec(upd);
    if (lMatch) {
      const perL = Number(lMatch[1].replace(",", "."));
      if (perL > 0) {
        const ml = Math.round((input.regularPriceEuros / perL) * 1000);
        if (ml >= 20 && ml <= 25000) return { baseAmount: ml, baseUnit: "ml", pieceCount };
      }
    }
  }

  const descGrams = extractWeightGramsFromTexts([
    input.title,
    ...(input.extraDescriptions ?? []),
    input.descriptionHighlights,
    input.descriptionFull,
  ]);
  if (descGrams !== null) {
    return { baseAmount: descGrams, baseUnit: "g", pieceCount };
  }

  return { ...base, pieceCount };
}
