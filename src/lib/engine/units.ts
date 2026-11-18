import type { BaseUnit, ParsedGroceryInput } from "@/lib/types";

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const WEIGHT_UNITS = String.raw`kilogram|kilo|kg|gram|gr|g`;
const VOLUME_UNITS = String.raw`milliliter|ml|centiliter|cl|deciliter|dl|liter|ltr|l`;
const PIECE_WORDS = [
  "stuks", "stuk", "st", "rollen", "rol", "capsules", "capsule", "pads", "tabletten", "tablets", "wasbeurten",
  "zakjes", "zakje", "blikjes", "blikje", "blikken", "blik", "flesjes", "fles", "flessen", "pakken", "pak",
  "pakjes", "pakje", "potjes", "pot", "potten", "bakjes", "bakje", "bakken", "zakken", "zak", "dozen", "doos",
  "plakken", "plak", "plakjes", "porties", "portie", "kroppen", "krop", "bosjes", "bos", "tros", "sneetjes",
];
const NOT_LETTER = String.raw`(?![a-zà-ÿ])`;
const SIZE_RE = new RegExp(
  String.raw`(?<![\d.,a-zà-ÿ])(${NUM})\s*(${WEIGHT_UNITS}|${VOLUME_UNITS})${NOT_LETTER}`,
  "i",
);
const MULTI_SIZE_RE = new RegExp(
  String.raw`(?<![\d.,])(\d+)\s*[x×]\s*(${NUM})\s*(${WEIGHT_UNITS}|${VOLUME_UNITS})${NOT_LETTER}`,
  "i",
);
const PIECES_RE = new RegExp(String.raw`(?<![\d.,])(\d+)\s*(${PIECE_WORDS.join("|")})\.?${NOT_LETTER}`, "i");

export const SHELF_STABLE_KEYWORDS = [
  "koffie", "pasta", "rijst", "cola", "bier", "frisdrank", "pindakaas", "wc-papier", "wc papier", "toiletpapier",
  "wasmiddel", "blik", "houdbaar", "saus", "sauzen", "chips", "thee", "suiker", "meel", "olie", "shampoo",
  "tandpasta", "afwasmiddel", "conserven", "soep", "muesli", "cornflakes",
];

function toNumber(s: string): number {
  return Number.parseFloat(s.replace(",", "."));
}

function unitToBase(amount: number, unit: string): { baseAmount: number; baseUnit: BaseUnit } {
  const u = unit.toLowerCase();
  if (/^(kilogram|kilo|kg)$/.test(u)) return { baseAmount: Math.round(amount * 1000), baseUnit: "g" };
  if (/^(gram|gr|g)$/.test(u)) return { baseAmount: Math.round(amount), baseUnit: "g" };
  if (/^(milliliter|ml)$/.test(u)) return { baseAmount: Math.round(amount), baseUnit: "ml" };
  if (/^(centiliter|cl)$/.test(u)) return { baseAmount: Math.round(amount * 10), baseUnit: "ml" };
  if (/^(deciliter|dl)$/.test(u)) return { baseAmount: Math.round(amount * 100), baseUnit: "ml" };
  return { baseAmount: Math.round(amount * 1000), baseUnit: "ml" };
}

/** Parses Dutch supermarket package strings ("4 x 125 g", "1,5 l", "10 st.") into a base amount. */
export function parsePackageSize(raw: string): { baseAmount: number; baseUnit: BaseUnit } {
  const text = (raw ?? "").toLowerCase().trim();
  const multi = MULTI_SIZE_RE.exec(text);
  if (multi) {
    const one = unitToBase(toNumber(multi[2]), multi[3]);
    return { baseAmount: one.baseAmount * Number(multi[1]), baseUnit: one.baseUnit };
  }
  const size = SIZE_RE.exec(text);
  if (size) {
    const parsed = unitToBase(toNumber(size[1]), size[2]);
    if (parsed.baseAmount > 0) return parsed;
  }
  const pieces = PIECES_RE.exec(text);
  if (pieces && Number(pieces[1]) > 0) return { baseAmount: Number(pieces[1]), baseUnit: "piece" };
  return { baseAmount: 1, baseUnit: "piece" };
}

const DUTCH_SINGULAR_MAP: Record<string, string> = {
  bananen: "banaan",
  appels: "appel",
  appelen: "appel",
  peren: "peer",
  aardbeien: "aardbei",
  druiven: "druif",
  mandarijnen: "mandarijn",
  sinaasappels: "sinaasappel",
  sinaasappelen: "sinaasappel",
  citroenen: "citroen",
  limoenen: "limoen",
  avocados: "avocado",
  paprikas: "paprika",
  tomaten: "tomaat",
  komkommers: "komkommer",
  courgettes: "courgette",
  wortels: "wortel",
  wortelen: "wortel",
  uien: "ui",
  aardappelen: "aardappel",
  aardappels: "aardappel",
  champignons: "champignon",
  olijven: "olijf",
  augurken: "augurk",
  eieren: "ei",
  slavinken: "slavink",
  rundervinken: "rundervink",
  vinken: "vink",
  hamburgers: "hamburger",
  saucijzen: "saucijs",
  braadworsten: "braadworst",
  rookworsten: "rookworst",
  gehaktballen: "gehaktbal",
  filets: "filet",
  lapjes: "lapje",
  broodjes: "broodje",
  afbakbroodjes: "afbakbroodje",
  croissants: "croissant",
  pannenkoeken: "pannenkoek",
  tortillas: "tortilla",
  wraps: "wrap",
  beschuiten: "beschuit",
  crackers: "cracker",
  koekjes: "koekje",
  noten: "noot",
  nootjes: "nootje",
};

export function singularizeDutchWord(word: string): string {
  const w = word.toLowerCase();
  return DUTCH_SINGULAR_MAP[w] ?? w;
}

export function slugifyConcept(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const OPTIONAL_PRODUCE_MODIFIERS = new Set(["royal", "verse", "vers", "hollandse", "nederlandse"]);

/** Candidate equivalent slugs (singularized + token-order-normalized) for cache reuse. */
export function conceptSlugAliases(text: string): string[] {
  const exact = slugifyConcept(text);
  const tokens = exact.split("-").filter(Boolean);
  if (tokens.length === 0) return exact ? [exact] : [];
  const singularTokens = tokens.map(singularizeDutchWord);
  const singular = singularTokens.join("-");
  const sorted = [...tokens].sort().join("-");
  const sortedSingular = [...singularTokens].sort().join("-");

  const strippedTokens = singularTokens.filter((t) => !OPTIONAL_PRODUCE_MODIFIERS.has(t));
  const stripped = strippedTokens.length > 0 && strippedTokens.length < singularTokens.length ? strippedTokens.join("-") : "";
  const strippedSorted =
    strippedTokens.length > 0 && strippedTokens.length < singularTokens.length ? [...strippedTokens].sort().join("-") : "";

  return [...new Set([exact, singular, sorted, sortedSingular, stripped, strippedSorted].filter(Boolean))];
}

/** Extracts an explicit piece count from multipack strings ("4 x 100 gram") or titles ("4 stuks", "6-pack"). */
export function extractPieceCount(
  unitSizeRaw: string | null | undefined,
  title?: string | null,
  baseUnit?: BaseUnit,
  baseAmount?: number,
): number | null {
  const raw = (unitSizeRaw ?? "").trim();
  const ttl = (title ?? "").trim();
  if (/^tros$/i.test(raw) && /\bbana/i.test(ttl)) return 5;
  const multi = /^\s*(\d+)\s*[x×]\s*\d/i.exec(raw) ?? /\b(\d+)\s*[x×]\s*\d+\s*(?:g|gr|gram|kg|ml|l|cl)\b/i.exec(ttl);
  if (multi) return Math.max(1, Number(multi[1]));
  const rawPieces = /\b(\d+)\s*(?:stuks?|stk|st|pack|blikjes|rollen|zakjes|bakjes|flesjes)\b/i.exec(raw);
  if (rawPieces) return Math.max(1, Number(rawPieces[1]));
  const titlePieces = /\b(\d+)\s*(?:stuks?|stk|-?\s*pack|blikjes)\b/i.exec(ttl);
  if (titlePieces) return Math.max(1, Number(titlePieces[1]));
  if (baseUnit === "piece" && baseAmount !== undefined && baseAmount >= 1 && Number.isInteger(baseAmount)) {
    return baseAmount;
  }
  return null;
}

const nf = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 2 });

export function formatAmount(amount: number, unit: BaseUnit): string {
  if (unit === "g") return amount >= 1000 ? `${nf.format(amount / 1000)} kg` : `${nf.format(amount)} g`;
  if (unit === "ml") return amount >= 1000 ? `${nf.format(amount / 1000)} l` : `${nf.format(amount)} ml`;
  return `${nf.format(amount)} stuks`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function formatDisplayTitle(
  searchQuery: string,
  totalTargetAmount: number | null,
  baseUnit: BaseUnit | null,
  multiplier = 1,
): string {
  let displayName = capitalize(searchQuery);
  if (totalTargetAmount !== null && baseUnit !== null) {
    if (baseUnit !== "piece") displayName += ` (${formatAmount(totalTargetAmount, baseUnit)})`;
    else if (multiplier > 1) displayName += ` (${multiplier}x)`;
  }
  return displayName;
}

function cleanSpaces(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,.\-–]+|[\s,.\-–]+$/g, "").trim();
}

export function isShelfStableText(text: string): boolean {
  const t = text.toLowerCase();
  return SHELF_STABLE_KEYWORDS.some((k) => t.includes(k));
}

/** Parses a free-text Dutch grocery line like "4x 1kg magere kwark". */
export function parseGroceryInput(rawInput: string): ParsedGroceryInput {
  let rest = (rawInput ?? "").trim().replace(/\s+/g, " ");
  let multiplier = 1;
  let perPackAmount: number | null = null;
  let baseUnit: BaseUnit | null = null;
  let explicitMultiplier = false;
  let explicitPieces = false;

  const lead = /^(\d+)\s*[x×]\s*/i.exec(rest);
  if (lead) {
    multiplier = Math.max(1, Number(lead[1]));
    explicitMultiplier = true;
    rest = rest.slice(lead[0].length);
  }

  const multi = MULTI_SIZE_RE.exec(rest);
  const size = multi ? null : SIZE_RE.exec(rest);
  if (multi) {
    const one = unitToBase(toNumber(multi[2]), multi[3]);
    perPackAmount = one.baseAmount;
    baseUnit = one.baseUnit;
    multiplier = (explicitMultiplier ? multiplier : 1) * Number(multi[1]);
    rest = rest.replace(multi[0], " ");
  } else if (size) {
    const one = unitToBase(toNumber(size[1]), size[2]);
    perPackAmount = one.baseAmount;
    baseUnit = one.baseUnit;
    rest = rest.replace(size[0], " ");
  } else {
    const pieces = PIECES_RE.exec(rest);
    if (pieces && Number(pieces[1]) > 0 && rest.indexOf(pieces[0]) === 0) {
      multiplier = explicitMultiplier ? multiplier : Number(pieces[1]);
      explicitPieces = /^(stuks|stuk|st)$/i.test(pieces[2]);
      rest = rest.replace(pieces[0], " ");
      perPackAmount = 1;
      baseUnit = "piece";
    }
  }

  if (!baseUnit) {
    const bare = !explicitMultiplier ? /^(\d+)\s+(?!\d)/.exec(rest) : null;
    if (bare) {
      multiplier = Math.max(1, Number(bare[1]));
      rest = rest.slice(bare[0].length);
    }
    if (multiplier > 1) {
      perPackAmount = 1;
      baseUnit = "piece";
    }
  }

  rest = cleanSpaces(rest);
  const words = rest.split(" ");
  if (multiplier > 1 && words.length > 1 && PIECE_WORDS.includes(words[0].toLowerCase().replace(/\.$/, ""))) {
    rest = words.slice(1).join(" ");
  }
  const searchQuery = cleanSpaces(rest.replace(/^(van|de|het|een)\s+/i, "")) || cleanSpaces(rawInput);
  const hasSize = perPackAmount !== null && baseUnit !== null;
  const totalTargetAmount = hasSize ? perPackAmount! * multiplier : null;
  const isCountOnly = !hasSize || (baseUnit === "piece" && !explicitPieces);

  const displayName = formatDisplayTitle(
    searchQuery,
    hasSize ? totalTargetAmount : null,
    hasSize ? baseUnit : null,
    multiplier,
  );

  return {
    rawInput,
    searchQuery,
    displayName,
    multiplier,
    perPackAmount,
    baseUnit,
    totalTargetAmount,
    isCountOnly,
    allowOvershootDefault: isShelfStableText(searchQuery) || multiplier >= 2,
    ...(/\bblik(?:je|jes|ken)?\b/i.test(rawInput) ? { containerHint: "can" as const } : {}),
  };
}
