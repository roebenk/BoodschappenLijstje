import type { SQLInputValue } from "node:sqlite";
import type {
  ActiveShoppingProviderId,
  BaseUnit,
  BrandPreferenceMode,
  CanonicalConcept,
  CompletedShoppingItem,
  ConceptLinkSource,
  DisplayUnit,
  NormalizedStoreProduct,
  ProductPreference,
  PromoMechanism,
  PurchaseHistoryEntry,
  RadarDeal,
  SavingsTriggerSource,
  ShoppingListItem,
  StoreProviderId,
} from "../types";
import { decryptSecrets, encryptSecrets } from "../crypto";
import { conceptSlugAliases } from "../engine/units";
import { getDb, withTransaction } from "./index";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const bool = (v: unknown) => (v ? 1 : 0);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function all(sql: string, ...params: SQLInputValue[]): Row[] {
  return getDb().prepare(sql).all(...params) as unknown as Row[];
}
function one(sql: string, ...params: SQLInputValue[]): Row | undefined {
  return getDb().prepare(sql).get(...params) as unknown as Row | undefined;
}
function run(sql: string, ...params: SQLInputValue[]) {
  return getDb().prepare(sql).run(...params);
}

/* ------------------------------ Store accounts ----------------------------- */

export type StoreAccountStatus = "anonymous" | "authenticated" | "awaiting_2fa" | "disconnected" | "error";

export interface StoreAccountRecord {
  provider: StoreProviderId;
  status: StoreAccountStatus;
  hasTokens: boolean;
  lastSyncedAt: string | null;
  meta: Record<string, unknown>;
}

export interface SaveStoreAccountInput {
  /** Secrets are AES-256-GCM encrypted before hitting SQLite. `null` clears them; `undefined` keeps them. */
  tokens?: unknown | null;
  status: StoreAccountStatus;
  lastSyncedAt?: string | null;
  meta?: Record<string, unknown>;
}

export function getStoreAccount(provider: StoreProviderId): StoreAccountRecord | null {
  const r = one("SELECT * FROM store_accounts WHERE provider = ?", provider);
  if (!r) return null;
  return {
    provider,
    status: r.status as StoreAccountStatus,
    hasTokens: !!r.encrypted_tokens,
    lastSyncedAt: str(r.last_synced_at),
    meta: r.account_meta_json ? (JSON.parse(String(r.account_meta_json)) as Record<string, unknown>) : {},
  };
}

export function getStoreTokens<T>(provider: StoreProviderId): T | null {
  const r = one("SELECT encrypted_tokens FROM store_accounts WHERE provider = ?", provider);
  if (!r?.encrypted_tokens) return null;
  return decryptSecrets<T>(String(r.encrypted_tokens));
}

export function saveStoreAccount(provider: StoreProviderId, input: SaveStoreAccountInput): void {
  const existing = one("SELECT * FROM store_accounts WHERE provider = ?", provider);
  const encrypted =
    input.tokens === undefined
      ? str(existing?.encrypted_tokens)
      : input.tokens === null
        ? null
        : encryptSecrets(input.tokens);
  const lastSynced = input.lastSyncedAt === undefined ? str(existing?.last_synced_at) : input.lastSyncedAt;
  const meta = input.meta === undefined ? str(existing?.account_meta_json) : JSON.stringify(input.meta);
  run(
    `INSERT INTO store_accounts (provider, encrypted_tokens, status, last_synced_at, account_meta_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET encrypted_tokens = excluded.encrypted_tokens,
       status = excluded.status, last_synced_at = excluded.last_synced_at,
       account_meta_json = excluded.account_meta_json`,
    provider,
    encrypted,
    input.status,
    lastSynced,
    meta,
  );
}

export function deleteStoreAccount(provider: StoreProviderId): void {
  run("DELETE FROM store_accounts WHERE provider = ?", provider);
}

/* ------------------------------ App settings ------------------------------- */

export function getDefaultProvider(): ActiveShoppingProviderId {
  const r = one("SELECT value FROM app_settings WHERE key = 'default_provider'");
  return r?.value === "picnic" ? "picnic" : "ah";
}

export function setDefaultProvider(provider: ActiveShoppingProviderId): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('default_provider', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    provider,
    now(),
  );
}

export function getSelectedAiModel(): string | null {
  const r = one("SELECT value FROM app_settings WHERE key = 'ai_model'");
  return str(r?.value);
}

export function setSelectedAiModel(model: string): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_model', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    model,
    now(),
  );
}

/* -------------------------- Dismissed week deals --------------------------- */

export function getDismissedDealKeys(): Set<string> {
  return new Set(all("SELECT deal_key FROM dismissed_week_deals").map((r) => String(r.deal_key)));
}

export function countDismissedDeals(): number {
  const r = one("SELECT COUNT(*) AS n FROM dismissed_week_deals");
  return Number(r?.n ?? 0);
}

export function dismissWeekDeal(dealKey: string, label?: string | null): void {
  run(
    `INSERT INTO dismissed_week_deals (deal_key, label, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(deal_key) DO UPDATE SET label = COALESCE(excluded.label, dismissed_week_deals.label)`,
    dealKey,
    label ?? null,
    now(),
  );
}

export function restoreWeekDeal(dealKey: string): boolean {
  return Number(run("DELETE FROM dismissed_week_deals WHERE deal_key = ?", dealKey).changes) > 0;
}

export function restoreAllWeekDeals(): number {
  return Number(run("DELETE FROM dismissed_week_deals").changes);
}

/* --------------------------- Products & concepts --------------------------- */

function rowToProduct(r: Row): NormalizedStoreProduct {
  const promoTier = r.promo_tier_json ? (JSON.parse(String(r.promo_tier_json)) as PromoMechanism) : null;
  return {
    id: String(r.id),
    provider: r.provider as StoreProviderId,
    externalId: String(r.external_id),
    posId: num(r.pos_id),
    title: String(r.title),
    brand: str(r.brand),
    isHouseBrand: !!r.is_house_brand,
    unitSizeRaw: String(r.unit_size_raw ?? ""),
    baseAmount: Number(r.base_amount),
    baseUnit: r.base_unit as BaseUnit,
    pieceCount: num(r.piece_count),
    regularPriceCents: Number(r.regular_price_cents),
    currentPriceCents: Number(r.current_price_cents),
    promo: promoTier,
    isOnlineOnlyPromo: !!r.is_online_only_promo,
    imageUrl: str(r.image_url),
    category: str(r.category),
    available: !!r.available,
    isMockFallback: !!r.is_mock_fallback,
    updatedAt: str(r.updated_at) ?? undefined,
  };
}

export function upsertStoreProducts(products: NormalizedStoreProduct[]): void {
  if (products.length === 0) return;
  withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT INTO store_products (id, provider, external_id, pos_id, title, brand, is_house_brand,
         unit_size_raw, base_amount, base_unit, piece_count, regular_price_cents, current_price_cents, promo_label,
         promo_tier_json, is_online_only_promo, image_url, category, available, is_mock_fallback, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pos_id = COALESCE(excluded.pos_id, store_products.pos_id),
         title = excluded.title, brand = excluded.brand, is_house_brand = excluded.is_house_brand,
         unit_size_raw = excluded.unit_size_raw, base_amount = excluded.base_amount,
         base_unit = excluded.base_unit, piece_count = COALESCE(excluded.piece_count, store_products.piece_count),
         regular_price_cents = excluded.regular_price_cents,
         current_price_cents = excluded.current_price_cents, promo_label = excluded.promo_label,
         promo_tier_json = excluded.promo_tier_json, is_online_only_promo = excluded.is_online_only_promo,
         image_url = excluded.image_url, category = COALESCE(excluded.category, store_products.category),
         available = excluded.available, is_mock_fallback = excluded.is_mock_fallback,
         updated_at = excluded.updated_at`,
    );
    for (const p of products) {
      stmt.run(
        p.id,
        p.provider,
        p.externalId,
        p.posId ?? null,
        p.title,
        p.brand,
        bool(p.isHouseBrand),
        p.unitSizeRaw,
        p.baseAmount,
        p.baseUnit,
        p.pieceCount ?? null,
        p.regularPriceCents,
        p.currentPriceCents,
        p.promo?.label ?? null,
        p.promo ? JSON.stringify(p.promo) : null,
        bool(p.isOnlineOnlyPromo),
        p.imageUrl,
        p.category ?? null,
        bool(p.available),
        bool(p.isMockFallback),
        p.updatedAt ?? now(),
      );
    }
  });
}

export function getStoreProduct(id: string): NormalizedStoreProduct | null {
  const r = one("SELECT * FROM store_products WHERE id = ?", id);
  return r ? rowToProduct(r) : null;
}

export function getStoreProducts(ids: string[]): NormalizedStoreProduct[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return all(`SELECT * FROM store_products WHERE id IN (${placeholders})`, ...ids).map(rowToProduct);
}

function rowToConcept(r: Row): CanonicalConcept {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    category: str(r.category),
    baseUnit: r.base_unit as BaseUnit,
    isShelfStable: !!r.is_shelf_stable,
    brandPreferenceMode: r.brand_preference_mode as BrandPreferenceMode,
    pinnedBrand: str(r.pinned_brand),
  };
}

export interface UpsertConceptInput {
  slug: string;
  name: string;
  category?: string | null;
  baseUnit?: BaseUnit;
  isShelfStable?: boolean;
  brandPreferenceMode?: BrandPreferenceMode;
  pinnedBrand?: string | null;
}

/** Creates the concept or updates the provided fields; returns the stored row. */
export function upsertConcept(input: UpsertConceptInput): CanonicalConcept {
  const existing = one("SELECT * FROM canonical_concepts WHERE slug = ?", input.slug);
  if (!existing) {
    run(
      `INSERT INTO canonical_concepts (slug, name, category, base_unit, is_shelf_stable, brand_preference_mode, pinned_brand)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.slug,
      input.name,
      input.category ?? null,
      input.baseUnit ?? "g",
      bool(input.isShelfStable),
      input.brandPreferenceMode ?? "auto",
      input.pinnedBrand ?? null,
    );
  } else {
    run(
      `UPDATE canonical_concepts SET name = ?, category = ?, base_unit = ?, is_shelf_stable = ?,
         brand_preference_mode = ?, pinned_brand = ? WHERE slug = ?`,
      input.name,
      input.category === undefined ? str(existing.category) : input.category,
      input.baseUnit ?? (existing.base_unit as string),
      input.isShelfStable === undefined ? Number(existing.is_shelf_stable) : bool(input.isShelfStable),
      input.brandPreferenceMode ?? (existing.brand_preference_mode as string),
      input.pinnedBrand === undefined ? str(existing.pinned_brand) : input.pinnedBrand,
      input.slug,
    );
  }
  return getConceptBySlug(input.slug)!;
}

export function getConceptBySlug(slug: string): CanonicalConcept | null {
  const r = one("SELECT * FROM canonical_concepts WHERE slug = ?", slug);
  return r ? rowToConcept(r) : null;
}

function findEquivalentConcepts(slugs: string[]): CanonicalConcept[] {
  const clean = [...new Set(slugs.filter(Boolean))];
  if (clean.length === 0) return [];
  const out: CanonicalConcept[] = [];
  const seen = new Set<number>();
  for (const s of clean) {
    const exact = getConceptBySlug(s);
    if (exact && !seen.has(exact.id)) {
      seen.add(exact.id);
      out.push(exact);
    }
  }
  const targetAliases = new Set(clean.flatMap((s) => conceptSlugAliases(s)));
  for (const r of all("SELECT * FROM canonical_concepts")) {
    const c = rowToConcept(r);
    if (seen.has(c.id)) continue;
    if (conceptSlugAliases(c.slug).some((a) => targetAliases.has(a))) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/** Finds an existing concept across candidate slugs (exact first, then canonical/singular/plural/reordered variants). */
export function findConceptBySlugs(slugs: string[]): CanonicalConcept | null {
  return findEquivalentConcepts(slugs)[0] ?? null;
}

export function getConceptById(id: number): CanonicalConcept | null {
  const r = one("SELECT * FROM canonical_concepts WHERE id = ?", id);
  return r ? rowToConcept(r) : null;
}

export function setConceptBrandPreference(
  conceptId: number,
  mode: BrandPreferenceMode,
  pinnedBrand: string | null = null,
): void {
  run(
    "UPDATE canonical_concepts SET brand_preference_mode = ?, pinned_brand = ? WHERE id = ?",
    mode,
    mode === "pinned_brand" ? pinnedBrand : null,
    conceptId,
  );
}

/** Links (or re-links) a product to a concept; `isValid=false` records a rejected match. */
export function linkConceptToProduct(
  conceptId: number,
  storeProductId: string,
  isValid: boolean,
  source: ConceptLinkSource,
  matchKind: "exact" | "alternative" = "exact",
): void {
  run(
    `INSERT INTO concept_product_links (concept_id, store_product_id, is_valid_match, source, relevance_version, match_kind)
     VALUES (?, ?, ?, ?, 3, ?)
     ON CONFLICT(concept_id, store_product_id) DO UPDATE SET
       is_valid_match = excluded.is_valid_match, source = excluded.source,
       relevance_version = excluded.relevance_version, match_kind = excluded.match_kind`,
    conceptId,
    storeProductId,
    bool(isValid),
    source,
    matchKind,
  );
  if (isValid) {
    run(
      "UPDATE product_preferences SET concept_id = COALESCE(concept_id, ?) WHERE store_product_id = ?",
      conceptId,
      storeProductId,
    );
  }
}

export interface CachedConceptMatches {
  concept: CanonicalConcept;
  validProductIds: string[];
  alternativeProductIds: string[];
  invalidProductIds: string[];
}

/** Cached LLM/history/manual matches for a concept slug or any equivalent alias slugs. */
export function getCachedConceptMatches(
  slug: string,
  aliasSlugs: string[] = [],
): CachedConceptMatches | null {
  const concepts = findEquivalentConcepts([slug, ...aliasSlugs]);
  if (concepts.length === 0) return null;
  const primary = concepts[0];
  const validSet = new Set<string>();
  const alternativeSet = new Set<string>();
  const exactSet = new Set<string>();
  const invalidSet = new Set<string>();
  for (const c of concepts) {
    const rows = all(
      `SELECT store_product_id, is_valid_match, source, relevance_version, match_kind FROM concept_product_links
       WHERE concept_id = ?
         AND (source <> 'llm' OR relevance_version >= 3)`,
      c.id,
    );
    for (const r of rows) {
      const pid = String(r.store_product_id);
      if (r.is_valid_match) {
        validSet.add(pid);
        invalidSet.delete(pid);
        if (r.match_kind === "alternative" && !exactSet.has(pid)) alternativeSet.add(pid);
        else if (r.match_kind !== "alternative") {
          exactSet.add(pid);
          alternativeSet.delete(pid);
        }
      } else if (!validSet.has(pid)) {
        invalidSet.add(pid);
      }
    }
  }
  return {
    concept: primary,
    validProductIds: [...validSet],
    alternativeProductIds: [...alternativeSet],
    invalidProductIds: [...invalidSet],
  };
}

/* ------------------------ Purchase history & preferences -------------------- */

export interface PurchaseHistoryInput {
  provider: StoreProviderId;
  txId: string;
  purchasedAt: string;
  storeProductId?: string | null;
  rawName: string;
  quantity?: number;
  totalCents?: number;
}

/** Inserts history rows, deduplicated by (provider, tx_id, raw_name). Returns rows actually inserted. */
export function insertPurchaseHistory(entries: PurchaseHistoryInput[]): number {
  if (entries.length === 0) return 0;
  return withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO purchase_history
         (provider, tx_id, purchased_at, store_product_id, raw_name, quantity, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const e of entries) {
      const res = stmt.run(
        e.provider,
        e.txId,
        e.purchasedAt,
        e.storeProductId ?? null,
        e.rawName,
        e.quantity ?? 1,
        e.totalCents ?? 0,
      );
      inserted += Number(res.changes);
    }
    return inserted;
  });
}

export function listPurchaseHistory(limit = 500): PurchaseHistoryEntry[] {
  return all("SELECT * FROM purchase_history ORDER BY purchased_at DESC LIMIT ?", limit).map((r) => ({
    id: Number(r.id),
    provider: r.provider as StoreProviderId,
    txId: String(r.tx_id),
    purchasedAt: String(r.purchased_at),
    storeProductId: str(r.store_product_id),
    rawName: String(r.raw_name),
    quantity: Number(r.quantity),
    totalCents: Number(r.total_cents),
  }));
}

export function listRecentPurchaseSuggestions(referenceDate = new Date()): string[] {
  const since = new Date(referenceDate.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  return all(
    `WITH recent AS (
       SELECT h.provider, h.tx_id, h.purchased_at,
              COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(p.title), ''), NULLIF(TRIM(h.raw_name), '')) AS name
       FROM purchase_history h
       LEFT JOIN store_products p ON p.id = h.store_product_id
       LEFT JOIN product_preferences pp ON pp.store_product_id = h.store_product_id
       LEFT JOIN canonical_concepts c ON c.id = COALESCE(
         pp.concept_id,
         (SELECT l.concept_id FROM concept_product_links l
          WHERE l.store_product_id = h.store_product_id AND l.is_valid_match = 1 AND l.match_kind = 'exact'
          ORDER BY CASE l.source WHEN 'history' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, l.concept_id
          LIMIT 1)
       )
       WHERE julianday(h.purchased_at) >= julianday(?)
         AND julianday(h.purchased_at) <= julianday(?)
     )
     SELECT MIN(name) AS name
     FROM recent
     WHERE name IS NOT NULL
     GROUP BY LOWER(name)
     ORDER BY COUNT(DISTINCT provider || ':' || tx_id) DESC,
              MAX(julianday(purchased_at)) DESC, LOWER(name)
     LIMIT 4`,
    since,
    referenceDate.toISOString(),
  ).map((row) => String(row.name));
}

/** Affinity grows logarithmically with purchases; manual picks/rejects shift it directly. */
export function computeAffinity(timesBought: number, manualPicks: number, manualRejects: number): number {
  const score = Math.log(1 + timesBought) + 1.5 * manualPicks - 1.5 * manualRejects;
  return Math.round(score * 10000) / 10000;
}

function rowToPreference(r: Row): ProductPreference {
  return {
    storeProductId: String(r.store_product_id),
    conceptId: num(r.concept_id),
    timesBought: Number(r.times_bought),
    lastBoughtAt: str(r.last_bought_at),
    manualPicks: Number(r.manual_picks),
    manualRejects: Number(r.manual_rejects),
    affinityScore: Number(r.affinity_score),
  };
}

/**
 * Rebuilds times_bought / last_bought_at from purchase_history (distinct transactions per product)
 * while keeping manual picks/rejects, then refreshes affinity scores.
 */
export function recomputeProductPreferences(): void {
  withTransaction((db) => {
    db.exec(
      `INSERT INTO product_preferences (store_product_id, concept_id, times_bought, last_bought_at)
       SELECT h.store_product_id,
              (SELECT l.concept_id FROM concept_product_links l
                 WHERE l.store_product_id = h.store_product_id AND l.is_valid_match = 1 LIMIT 1),
              COUNT(DISTINCT h.provider || ':' || h.tx_id), MAX(h.purchased_at)
       FROM purchase_history h JOIN store_products p ON p.id = h.store_product_id
       WHERE h.store_product_id IS NOT NULL
       GROUP BY h.store_product_id
       ON CONFLICT(store_product_id) DO UPDATE SET
         times_bought = excluded.times_bought,
         last_bought_at = excluded.last_bought_at,
         concept_id = COALESCE(product_preferences.concept_id, excluded.concept_id)`,
    );
    const rows = db
      .prepare("SELECT store_product_id, times_bought, manual_picks, manual_rejects FROM product_preferences")
      .all() as unknown as Row[];
    const upd = db.prepare("UPDATE product_preferences SET affinity_score = ? WHERE store_product_id = ?");
    for (const r of rows) {
      upd.run(
        computeAffinity(Number(r.times_bought), Number(r.manual_picks), Number(r.manual_rejects)),
        String(r.store_product_id),
      );
    }
  });
}

function recordManual(
  storeProductId: string,
  conceptId: number | null | undefined,
  column: "manual_picks" | "manual_rejects",
): void {
  withTransaction((db) => {
    db.prepare("INSERT OR IGNORE INTO product_preferences (store_product_id) VALUES (?)").run(storeProductId);
    db.prepare(
      `UPDATE product_preferences SET ${column} = ${column} + 1,
         concept_id = COALESCE(?, concept_id) WHERE store_product_id = ?`,
    ).run(conceptId ?? null, storeProductId);
    const r = db
      .prepare("SELECT times_bought, manual_picks, manual_rejects FROM product_preferences WHERE store_product_id = ?")
      .get(storeProductId) as unknown as Row;
    db.prepare("UPDATE product_preferences SET affinity_score = ? WHERE store_product_id = ?").run(
      computeAffinity(Number(r.times_bought), Number(r.manual_picks), Number(r.manual_rejects)),
      storeProductId,
    );
  });
}

/** The user picked this product for a concept: boost it and remember it as a valid manual match. */
export function recordManualPick(storeProductId: string, conceptId?: number | null): void {
  recordManual(storeProductId, conceptId, "manual_picks");
  if (conceptId) linkConceptToProduct(conceptId, storeProductId, true, "manual");
}

/** The user swapped this product away: penalise its affinity (the match stays valid). */
export function recordManualReject(storeProductId: string, conceptId?: number | null): void {
  recordManual(storeProductId, conceptId, "manual_rejects");
}

export function getProductPreference(storeProductId: string): ProductPreference | null {
  const r = one("SELECT * FROM product_preferences WHERE store_product_id = ?", storeProductId);
  return r ? rowToPreference(r) : null;
}

export function getPreferencesForProducts(ids: string[]): Map<string, ProductPreference> {
  const out = new Map<string, ProductPreference>();
  if (ids.length === 0) return out;
  const rows = all(
    `SELECT * FROM product_preferences WHERE store_product_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  for (const r of rows) out.set(String(r.store_product_id), rowToPreference(r));
  return out;
}

/** Highest-affinity preferences, optionally restricted to one concept. */
export function getTopPreferences(options: { conceptId?: number; limit?: number } = {}): ProductPreference[] {
  const limit = options.limit ?? 50;
  const rows =
    options.conceptId !== undefined
      ? all(
          "SELECT * FROM product_preferences WHERE concept_id = ? ORDER BY affinity_score DESC, times_bought DESC LIMIT ?",
          options.conceptId,
          limit,
        )
      : all("SELECT * FROM product_preferences ORDER BY affinity_score DESC, times_bought DESC LIMIT ?", limit);
  return rows.map(rowToPreference);
}

export interface ConceptRecentPurchase {
  storeProductId: string;
  provider: StoreProviderId;
  purchasedAt: string;
  quantity: number;
  brand: string | null;
  isHouseBrand: boolean;
  baseUnit: BaseUnit;
}

function equivalentConceptIdsFor(conceptId: number): number[] {
  const c = getConceptById(conceptId);
  if (!c) return [conceptId];
  const eq = findEquivalentConcepts([c.slug]).map((x) => x.id);
  return eq.includes(conceptId) ? eq : [conceptId, ...eq];
}

/** Recent purchase history rows for products belonging to `conceptId` (or equivalent concepts / explicit candidate productIds). */
export function getRecentConceptPurchases(
  conceptId: number,
  productIds: string[] = [],
  limit = 20,
): ConceptRecentPurchase[] {
  const cids = equivalentConceptIdsFor(conceptId);
  const cidPlaceholders = cids.map(() => "?").join(",");
  const extraClause = productIds.length > 0 ? `OR h.store_product_id IN (${productIds.map(() => "?").join(",")})` : "";
  const rows = all(
    `SELECT h.store_product_id, h.provider, h.purchased_at, h.quantity, p.brand, p.is_house_brand, p.base_unit
     FROM purchase_history h
     JOIN store_products p ON p.id = h.store_product_id
     WHERE h.store_product_id IS NOT NULL
       AND (
         EXISTS (
           SELECT 1 FROM concept_product_links l
           WHERE l.concept_id IN (${cidPlaceholders}) AND l.store_product_id = h.store_product_id AND l.is_valid_match = 1
         )
         OR EXISTS (
           SELECT 1 FROM product_preferences pp
           WHERE pp.concept_id IN (${cidPlaceholders}) AND pp.store_product_id = h.store_product_id
         )
         ${extraClause}
       )
     ORDER BY h.purchased_at DESC, h.id DESC
     LIMIT ?`,
    ...cids,
    ...cids,
    ...productIds,
    limit,
  );
  return rows.map((r) => ({
    storeProductId: String(r.store_product_id),
    provider: r.provider as StoreProviderId,
    purchasedAt: String(r.purchased_at),
    quantity: Number(r.quantity),
    brand: str(r.brand),
    isHouseBrand: !!r.is_house_brand,
    baseUnit: (r.base_unit as BaseUnit) ?? "piece",
  }));
}

export interface BrandLoyalty {
  conceptId: number;
  totalPurchases: number;
  topBrand: string | null;
  /** 0..1 share of purchases that went to `topBrand`. */
  topBrandShare: number;
  topBrandIsHouseBrand: boolean;
  /** 0..1 share of purchases in `piece` unit vs weight/volume. */
  piecePurchaseShare?: number;
  brands: Array<{ brand: string; timesBought: number; share: number; isHouseBrand: boolean }>;
}

/** Brand distribution of a concept's purchases (loyalty when one brand exceeds ~75%). */
export function getBrandLoyalty(conceptId: number): BrandLoyalty {
  const cids = equivalentConceptIdsFor(conceptId);
  const cidPlaceholders = cids.map(() => "?").join(",");
  const rows = all(
    `SELECT COALESCE(p.brand, '') AS brand, MAX(p.is_house_brand) AS house, SUM(pp.times_bought) AS n,
            SUM(CASE WHEN p.base_unit = 'piece' THEN pp.times_bought ELSE 0 END) AS piece_n
     FROM product_preferences pp JOIN store_products p ON p.id = pp.store_product_id
     WHERE (
       pp.concept_id IN (${cidPlaceholders})
       OR EXISTS (
         SELECT 1 FROM concept_product_links l
         WHERE l.concept_id IN (${cidPlaceholders}) AND l.store_product_id = pp.store_product_id AND l.is_valid_match = 1
       )
     )
       AND pp.times_bought > 0
     GROUP BY COALESCE(p.brand, '') ORDER BY n DESC`,
    ...cids,
    ...cids,
  );
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const pieceTotal = rows.reduce((s, r) => s + Number(r.piece_n ?? 0), 0);
  const brands = rows
    .filter((r) => r.brand !== "")
    .map((r) => ({
      brand: String(r.brand),
      timesBought: Number(r.n),
      share: total ? Number(r.n) / total : 0,
      isHouseBrand: !!r.house,
    }));
  const top = rows[0];
  return {
    conceptId,
    totalPurchases: total,
    topBrand: top && top.brand !== "" ? String(top.brand) : null,
    topBrandShare: top && total ? Number(top.n) / total : 0,
    topBrandIsHouseBrand: !!top?.house,
    piecePurchaseShare: total ? pieceTotal / total : 0,
    brands,
  };
}

/* ------------------------------ Shopping list ------------------------------ */

export interface ShoppingListItemInput {
  rawInput: string;
  displayName: string;
  requestedQty?: number;
  requestedUnitRaw?: string | null;
  targetBaseAmount?: number | null;
  targetBaseUnit?: BaseUnit | null;
  conceptId?: number | null;
  allowOvershoot?: boolean;
  assignedProvider?: ActiveShoppingProviderId | null;
  isProviderLocked?: boolean;
  ahProductId?: string | null;
  ahQty?: number;
  ahTotalCents?: number | null;
  picnicProductId?: string | null;
  picnicQty?: number;
  picnicTotalCents?: number | null;
  radarDeals?: RadarDeal[];
  isChecked?: boolean;
  pushedToStoreAt?: string | null;
  recordedInStatsAt?: string | null;
  cheapestProductId?: string | null;
  cheapestOverallCents?: number | null;
  sortOrder?: number;
}

export type ShoppingListItemPatch = Partial<ShoppingListItemInput>;

function displayUnitFor(baseUnit: BaseUnit | null | undefined): DisplayUnit {
  return baseUnit === "g" ? "kg" : baseUnit === "ml" ? "l" : "stuk";
}

function centsPerBase1000(p: NormalizedStoreProduct | null): number | null {
  if (!p || p.baseAmount <= 0) return null;
  return p.baseUnit === "piece"
    ? Math.round(p.currentPriceCents / p.baseAmount)
    : Math.round((p.currentPriceCents / p.baseAmount) * 1000);
}

function rowToItem(r: Row, products: Map<string, NormalizedStoreProduct>): ShoppingListItem {
  const ahProduct = r.ah_product_id ? (products.get(String(r.ah_product_id)) ?? null) : null;
  const picnicProduct = r.picnic_product_id ? (products.get(String(r.picnic_product_id)) ?? null) : null;
  const cheapestProduct = r.cheapest_product_id ? (products.get(String(r.cheapest_product_id)) ?? null) : null;
  const assigned = (r.assigned_provider as ActiveShoppingProviderId | null) ?? null;
  const activeProduct = assigned === "ah" ? ahProduct : assigned === "picnic" ? picnicProduct : null;
  const activeQty = assigned === "ah" ? Number(r.ah_qty) : assigned === "picnic" ? Number(r.picnic_qty) : 0;
  const activeTotal = assigned === "ah" ? num(r.ah_total_cents) : assigned === "picnic" ? num(r.picnic_total_cents) : null;
  const savings =
    activeProduct && activeTotal !== null ? Math.max(0, activeProduct.regularPriceCents * activeQty - activeTotal) : 0;
  const baseUnit = (r.target_base_unit as BaseUnit | null) ?? ahProduct?.baseUnit ?? picnicProduct?.baseUnit ?? null;

  return {
    id: Number(r.id),
    rawInput: String(r.raw_input),
    displayName: String(r.display_name),
    requestedQty: Number(r.requested_qty),
    requestedUnitRaw: str(r.requested_unit_raw),
    targetBaseAmount: num(r.target_base_amount),
    targetBaseUnit: (r.target_base_unit as BaseUnit | null) ?? null,
    conceptId: num(r.concept_id),
    allowOvershoot: !!r.allow_overshoot,
    assignedProvider: assigned,
    isProviderLocked: !!r.is_provider_locked,
    ahProductId: str(r.ah_product_id),
    ahQty: Number(r.ah_qty),
    ahTotalCents: num(r.ah_total_cents),
    picnicProductId: str(r.picnic_product_id),
    picnicQty: Number(r.picnic_qty),
    picnicTotalCents: num(r.picnic_total_cents),
    radarDeals: r.radar_deals_json ? (JSON.parse(String(r.radar_deals_json)) as RadarDeal[]) : [],
    isChecked: !!r.is_checked,
    pushedToStoreAt: str(r.pushed_to_store_at),
    recordedInStatsAt: str(r.recorded_in_stats_at),
    cheapestProductId: str(r.cheapest_product_id),
    cheapestOverallCents: num(r.cheapest_overall_cents),
    sortOrder: Number(r.sort_order),
    updatedAt: String(r.updated_at),
    ahProduct,
    picnicProduct,
    cheapestProduct,
    unitPriceComparison: {
      ahCentsPerBase1000: centsPerBase1000(ahProduct),
      picnicCentsPerBase1000: centsPerBase1000(picnicProduct),
      displayUnit: displayUnitFor(baseUnit),
      ...(ahProduct && picnicProduct && ahProduct.baseUnit !== picnicProduct.baseUnit
        ? {
            ahDisplayUnit: displayUnitFor(ahProduct.baseUnit),
            picnicDisplayUnit: displayUnitFor(picnicProduct.baseUnit),
          }
        : {}),
    },
    savingsCents: savings,
    loyaltyNote: null,
  };
}

function hydrate(rows: Row[]): ShoppingListItem[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.ah_product_id) ids.add(String(r.ah_product_id));
    if (r.picnic_product_id) ids.add(String(r.picnic_product_id));
    if (r.cheapest_product_id) ids.add(String(r.cheapest_product_id));
  }
  const map = new Map(getStoreProducts([...ids]).map((p) => [p.id, p]));
  return rows.map((r) => rowToItem(r, map));
}

/** All list items in sort order, hydrated with their AH/Picnic store products. */
export function listShoppingItems(): ShoppingListItem[] {
  return hydrate(all("SELECT * FROM shopping_list_items ORDER BY sort_order ASC, id ASC"));
}

export function getShoppingItem(id: number): ShoppingListItem | null {
  return hydrate(all("SELECT * FROM shopping_list_items WHERE id = ?", id))[0] ?? null;
}

/** Allocates `count` ascending sort_order values strictly before the current top of the list. */
export function allocateTopSortOrders(count: number): number[] {
  if (count <= 0) return [];
  const minOrder = Number(one("SELECT COALESCE(MIN(sort_order), 1) AS n FROM shopping_list_items")!.n);
  return Array.from({ length: count }, (_, idx) => minOrder - count + idx);
}

export function insertShoppingItem(input: ShoppingListItemInput): ShoppingListItem {
  const nextOrder =
    input.sortOrder ?? Number(one("SELECT COALESCE(MIN(sort_order), 1) - 1 AS n FROM shopping_list_items")!.n);
  const res = run(
    `INSERT INTO shopping_list_items (raw_input, display_name, requested_qty, requested_unit_raw,
       target_base_amount, target_base_unit, concept_id, allow_overshoot, assigned_provider, is_provider_locked,
       ah_product_id, ah_qty, ah_total_cents, picnic_product_id, picnic_qty, picnic_total_cents,
       radar_deals_json, is_checked, pushed_to_store_at, recorded_in_stats_at,
       cheapest_product_id, cheapest_overall_cents, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.rawInput,
    input.displayName,
    input.requestedQty ?? 1,
    input.requestedUnitRaw ?? null,
    input.targetBaseAmount ?? null,
    input.targetBaseUnit ?? null,
    input.conceptId ?? null,
    bool(input.allowOvershoot),
    input.assignedProvider ?? null,
    bool(input.isProviderLocked),
    input.ahProductId ?? null,
    input.ahQty ?? 0,
    input.ahTotalCents ?? null,
    input.picnicProductId ?? null,
    input.picnicQty ?? 0,
    input.picnicTotalCents ?? null,
    input.radarDeals ? JSON.stringify(input.radarDeals) : null,
    bool(input.isChecked),
    input.pushedToStoreAt ?? null,
    input.recordedInStatsAt ?? null,
    input.cheapestProductId ?? null,
    input.cheapestOverallCents ?? null,
    nextOrder,
    now(),
  );
  return getShoppingItem(Number(res.lastInsertRowid))!;
}

const PATCH_COLUMNS: Record<keyof ShoppingListItemPatch, [string, (v: never) => SQLInputValue]> = {
  rawInput: ["raw_input", (v) => v],
  displayName: ["display_name", (v) => v],
  requestedQty: ["requested_qty", (v) => v],
  requestedUnitRaw: ["requested_unit_raw", (v) => v ?? null],
  targetBaseAmount: ["target_base_amount", (v) => v ?? null],
  targetBaseUnit: ["target_base_unit", (v) => v ?? null],
  conceptId: ["concept_id", (v) => v ?? null],
  allowOvershoot: ["allow_overshoot", (v) => bool(v)],
  assignedProvider: ["assigned_provider", (v) => v ?? null],
  isProviderLocked: ["is_provider_locked", (v) => bool(v)],
  ahProductId: ["ah_product_id", (v) => v ?? null],
  ahQty: ["ah_qty", (v) => v],
  ahTotalCents: ["ah_total_cents", (v) => v ?? null],
  picnicProductId: ["picnic_product_id", (v) => v ?? null],
  picnicQty: ["picnic_qty", (v) => v],
  picnicTotalCents: ["picnic_total_cents", (v) => v ?? null],
  radarDeals: ["radar_deals_json", (v) => (v ? JSON.stringify(v) : null)],
  isChecked: ["is_checked", (v) => bool(v)],
  pushedToStoreAt: ["pushed_to_store_at", (v) => v ?? null],
  recordedInStatsAt: ["recorded_in_stats_at", (v) => v ?? null],
  cheapestProductId: ["cheapest_product_id", (v) => v ?? null],
  cheapestOverallCents: ["cheapest_overall_cents", (v) => v ?? null],
  sortOrder: ["sort_order", (v) => v],
};

/** Applies only the provided fields; returns the refreshed item or null when the id is unknown. */
export function updateShoppingItem(id: number, patch: ShoppingListItemPatch): ShoppingListItem | null {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const key of Object.keys(patch) as Array<keyof ShoppingListItemPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    const [column, convert] = PATCH_COLUMNS[key];
    sets.push(`${column} = ?`);
    values.push(convert(value as never));
  }
  sets.push("updated_at = ?");
  values.push(now(), id);
  run(`UPDATE shopping_list_items SET ${sets.join(", ")} WHERE id = ?`, ...values);
  return getShoppingItem(id);
}

export function deleteShoppingItem(id: number): boolean {
  return Number(run("DELETE FROM shopping_list_items WHERE id = ?", id).changes) > 0;
}

/** Removes all checked items; returns how many were deleted. */
export function clearCheckedShoppingItems(): number {
  return Number(run("DELETE FROM shopping_list_items WHERE is_checked = 1").changes);
}

/** Sets sort_order following the given id order (unknown ids are ignored). */
export function reorderShoppingItems(orderedIds: number[]): void {
  withTransaction((db) => {
    const stmt = db.prepare("UPDATE shopping_list_items SET sort_order = ?, updated_at = ? WHERE id = ?");
    const ts = now();
    orderedIds.forEach((id, idx) => stmt.run(idx, ts, id));
  });
}

/* ------------------------ Completed savings ledger ------------------------- */

export interface CompletedShoppingItemInput {
  completedAt?: string;
  triggerSource: SavingsTriggerSource;
  rawInput: string;
  displayName: string;
  conceptId?: number | null;
  chosenProvider: ActiveShoppingProviderId;
  chosenProductId?: string | null;
  chosenProductTitle?: string | null;
  chosenBrand?: string | null;
  isHouseBrand?: boolean;
  chosenQty: number;
  baselineCents: number;
  chosenRegularCents: number;
  chosenPaidCents: number;
  otherProviderCents?: number | null;
  cheapestStoreCents: number;
  cheapestOverallCents: number;
  cheapestProductTitle?: string | null;
}

export function insertCompletedShoppingItems(entries: CompletedShoppingItemInput[]): number {
  if (entries.length === 0) return 0;
  return withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT INTO completed_shopping_items (
         completed_at, trigger_source, raw_input, display_name, concept_id,
         chosen_provider, chosen_product_id, chosen_product_title, chosen_brand, is_house_brand,
         chosen_qty, baseline_cents, chosen_regular_cents, chosen_paid_cents,
         other_provider_cents, cheapest_store_cents, cheapest_overall_cents, cheapest_product_title
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    const ts = now();
    for (const e of entries) {
      const res = stmt.run(
        e.completedAt ?? ts,
        e.triggerSource,
        e.rawInput,
        e.displayName,
        e.conceptId ?? null,
        e.chosenProvider,
        e.chosenProductId ?? null,
        e.chosenProductTitle ?? null,
        e.chosenBrand ?? null,
        bool(e.isHouseBrand),
        Math.max(1, e.chosenQty),
        Math.max(0, Math.round(e.baselineCents)),
        Math.max(0, Math.round(e.chosenRegularCents)),
        Math.max(0, Math.round(e.chosenPaidCents)),
        e.otherProviderCents === undefined || e.otherProviderCents === null ? null : Math.round(e.otherProviderCents),
        Math.max(0, Math.round(e.cheapestStoreCents)),
        Math.max(0, Math.round(e.cheapestOverallCents)),
        e.cheapestProductTitle ?? null,
      );
      inserted += Number(res.changes);
    }
    return inserted;
  });
}

export function listCompletedShoppingItems(limit = 1000): CompletedShoppingItem[] {
  return all("SELECT * FROM completed_shopping_items ORDER BY completed_at DESC, id DESC LIMIT ?", limit).map((r) => ({
    id: Number(r.id),
    completedAt: String(r.completed_at),
    triggerSource: r.trigger_source as SavingsTriggerSource,
    rawInput: String(r.raw_input),
    displayName: String(r.display_name),
    conceptId: num(r.concept_id),
    chosenProvider: r.chosen_provider as ActiveShoppingProviderId,
    chosenProductId: str(r.chosen_product_id),
    chosenProductTitle: str(r.chosen_product_title),
    chosenBrand: str(r.chosen_brand),
    isHouseBrand: !!r.is_house_brand,
    chosenQty: Number(r.chosen_qty),
    baselineCents: Number(r.baseline_cents),
    chosenRegularCents: Number(r.chosen_regular_cents),
    chosenPaidCents: Number(r.chosen_paid_cents),
    otherProviderCents: num(r.other_provider_cents),
    cheapestStoreCents: Number(r.cheapest_store_cents),
    cheapestOverallCents: Number(r.cheapest_overall_cents),
    cheapestProductTitle: str(r.cheapest_product_title),
  }));
}
