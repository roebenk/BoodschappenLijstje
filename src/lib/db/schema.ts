/** SQLite schema (node:sqlite). Idempotent: safe to run on every connection. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS store_accounts (
  provider TEXT PRIMARY KEY,
  encrypted_tokens TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_synced_at TEXT,
  account_meta_json TEXT
);

CREATE TABLE IF NOT EXISTS canonical_concepts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  base_unit TEXT NOT NULL DEFAULT 'g' CHECK (base_unit IN ('g','ml','piece')),
  is_shelf_stable INTEGER NOT NULL DEFAULT 0,
  brand_preference_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (brand_preference_mode IN ('auto','house_brand','pinned_brand')),
  pinned_brand TEXT
);

CREATE TABLE IF NOT EXISTS store_products (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  pos_id INTEGER,
  title TEXT NOT NULL,
  brand TEXT,
  is_house_brand INTEGER NOT NULL DEFAULT 0,
  unit_size_raw TEXT NOT NULL DEFAULT '',
  base_amount REAL NOT NULL DEFAULT 1,
  base_unit TEXT NOT NULL DEFAULT 'piece' CHECK (base_unit IN ('g','ml','piece')),
  piece_count INTEGER,
  regular_price_cents INTEGER NOT NULL DEFAULT 0,
  current_price_cents INTEGER NOT NULL DEFAULT 0,
  promo_label TEXT,
  promo_tier_json TEXT,
  is_online_only_promo INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  category TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  is_mock_fallback INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_store_products_provider ON store_products(provider);
CREATE INDEX IF NOT EXISTS idx_store_products_title ON store_products(title);

CREATE TABLE IF NOT EXISTS concept_product_links (
  concept_id INTEGER NOT NULL REFERENCES canonical_concepts(id) ON DELETE CASCADE,
  store_product_id TEXT NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  is_valid_match INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'llm' CHECK (source IN ('llm','history','manual')),
  relevance_version INTEGER NOT NULL DEFAULT 1,
  match_kind TEXT NOT NULL DEFAULT 'exact' CHECK (match_kind IN ('exact','alternative')),
  PRIMARY KEY (concept_id, store_product_id)
);
CREATE INDEX IF NOT EXISTS idx_links_product ON concept_product_links(store_product_id);

CREATE TABLE IF NOT EXISTS purchase_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  tx_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  store_product_id TEXT,
  raw_name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  total_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, tx_id, raw_name)
);
CREATE INDEX IF NOT EXISTS idx_history_product ON purchase_history(store_product_id);
CREATE INDEX IF NOT EXISTS idx_history_purchased ON purchase_history(purchased_at);

CREATE TABLE IF NOT EXISTS product_preferences (
  store_product_id TEXT PRIMARY KEY REFERENCES store_products(id) ON DELETE CASCADE,
  concept_id INTEGER REFERENCES canonical_concepts(id) ON DELETE SET NULL,
  times_bought INTEGER NOT NULL DEFAULT 0,
  last_bought_at TEXT,
  manual_picks INTEGER NOT NULL DEFAULT 0,
  manual_rejects INTEGER NOT NULL DEFAULT 0,
  affinity_score REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prefs_concept ON product_preferences(concept_id);

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_input TEXT NOT NULL,
  display_name TEXT NOT NULL,
  requested_qty REAL NOT NULL DEFAULT 1,
  requested_unit_raw TEXT,
  target_base_amount REAL,
  target_base_unit TEXT CHECK (target_base_unit IS NULL OR target_base_unit IN ('g','ml','piece')),
  concept_id INTEGER REFERENCES canonical_concepts(id) ON DELETE SET NULL,
  allow_overshoot INTEGER NOT NULL DEFAULT 0,
  assigned_provider TEXT CHECK (assigned_provider IS NULL OR assigned_provider IN ('ah','picnic')),
  is_provider_locked INTEGER NOT NULL DEFAULT 0,
  ah_product_id TEXT REFERENCES store_products(id) ON DELETE SET NULL,
  ah_qty INTEGER NOT NULL DEFAULT 0,
  ah_total_cents INTEGER,
  picnic_product_id TEXT REFERENCES store_products(id) ON DELETE SET NULL,
  picnic_qty INTEGER NOT NULL DEFAULT 0,
  picnic_total_cents INTEGER,
  radar_deals_json TEXT,
  is_checked INTEGER NOT NULL DEFAULT 0,
  pushed_to_store_at TEXT,
  recorded_in_stats_at TEXT,
  cheapest_product_id TEXT REFERENCES store_products(id) ON DELETE SET NULL,
  cheapest_overall_cents INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_list_sort ON shopping_list_items(sort_order);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_query_expansions (
  query TEXT PRIMARY KEY,
  alternatives_json TEXT NOT NULL,
  expansion_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dismissed_week_deals (
  deal_key TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS completed_shopping_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  completed_at TEXT NOT NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('push','checked_clear')),
  raw_input TEXT NOT NULL,
  display_name TEXT NOT NULL,
  concept_id INTEGER REFERENCES canonical_concepts(id) ON DELETE SET NULL,
  chosen_provider TEXT NOT NULL CHECK (chosen_provider IN ('ah','picnic')),
  chosen_product_id TEXT REFERENCES store_products(id) ON DELETE SET NULL,
  chosen_product_title TEXT,
  chosen_brand TEXT,
  is_house_brand INTEGER NOT NULL DEFAULT 0,
  chosen_qty INTEGER NOT NULL DEFAULT 1,
  baseline_cents INTEGER NOT NULL DEFAULT 0,
  chosen_regular_cents INTEGER NOT NULL DEFAULT 0,
  chosen_paid_cents INTEGER NOT NULL DEFAULT 0,
  other_provider_cents INTEGER,
  cheapest_store_cents INTEGER NOT NULL DEFAULT 0,
  cheapest_overall_cents INTEGER NOT NULL DEFAULT 0,
  cheapest_product_title TEXT
);
CREATE INDEX IF NOT EXISTS idx_completed_items_date ON completed_shopping_items(completed_at);
`;
