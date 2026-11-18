import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getRuntimeConfig } from "../config";
import { SCHEMA_SQL } from "./schema";

const DB_SCHEMA_VERSION = 5;

declare global {
  // eslint-disable-next-line no-var
  var __boodschappenDb: { dataDir: string; db: DatabaseSync; schemaVersion?: number } | undefined;
}

function inferPieceCountFromText(unitSizeRaw: string, title: string, baseUnit: string, baseAmount: number): number | null {
  const multi = /^\s*(\d+)\s*[x×]\s*\d/i.exec(unitSizeRaw);
  if (multi) return Math.max(1, Number(multi[1]));
  const rawPieces = /\b(\d+)\s*(?:stuks?|stk|st|pack|blikjes|rollen|zakjes|bakjes|flesjes)\b/i.exec(unitSizeRaw);
  if (rawPieces) return Math.max(1, Number(rawPieces[1]));
  const titlePieces = /\b(\d+)\s*(?:stuks?|stk|-?\s*pack|blikjes)\b/i.exec(title);
  if (titlePieces) return Math.max(1, Number(titlePieces[1]));
  if (baseUnit === "piece" && baseAmount >= 1 && Number.isInteger(baseAmount)) return baseAmount;
  return null;
}

function runMigrations(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(store_products)").all() as Array<{ name?: string }>;
  if (!cols.some((c) => c.name === "piece_count")) {
    db.exec("ALTER TABLE store_products ADD COLUMN piece_count INTEGER;");
  }

  const linkCols = db.prepare("PRAGMA table_info(concept_product_links)").all() as Array<{ name?: string }>;
  if (!linkCols.some((c) => c.name === "relevance_version")) {
    db.exec("ALTER TABLE concept_product_links ADD COLUMN relevance_version INTEGER NOT NULL DEFAULT 1;");
  }
  if (!linkCols.some((c) => c.name === "match_kind")) {
    db.exec("ALTER TABLE concept_product_links ADD COLUMN match_kind TEXT NOT NULL DEFAULT 'exact';");
  }

  const expansionCols = db.prepare("PRAGMA table_info(search_query_expansions)").all() as Array<{ name?: string }>;
  if (!expansionCols.some((c) => c.name === "expansion_version")) {
    db.exec("ALTER TABLE search_query_expansions ADD COLUMN expansion_version INTEGER NOT NULL DEFAULT 1;");
  }

  const listCols = db.prepare("PRAGMA table_info(shopping_list_items)").all() as Array<{ name?: string }>;
  if (!listCols.some((c) => c.name === "recorded_in_stats_at")) {
    db.exec("ALTER TABLE shopping_list_items ADD COLUMN recorded_in_stats_at TEXT;");
  }
  if (!listCols.some((c) => c.name === "cheapest_product_id")) {
    db.exec("ALTER TABLE shopping_list_items ADD COLUMN cheapest_product_id TEXT;");
  }
  if (!listCols.some((c) => c.name === "cheapest_overall_cents")) {
    db.exec("ALTER TABLE shopping_list_items ADD COLUMN cheapest_overall_cents INTEGER;");
  }

  db.exec(`
    UPDATE product_preferences
    SET concept_id = (
      SELECT l.concept_id FROM concept_product_links l
      WHERE l.store_product_id = product_preferences.store_product_id AND l.is_valid_match = 1
      LIMIT 1
    )
    WHERE concept_id IS NULL
      AND EXISTS (
        SELECT 1 FROM concept_product_links l
        WHERE l.store_product_id = product_preferences.store_product_id AND l.is_valid_match = 1
      );
  `);

  const migratedV2 = db
    .prepare("SELECT value FROM app_settings WHERE key = 'migration_v2_data_fixes'")
    .get() as { value?: string } | undefined;
  if (migratedV2?.value !== "1") {
    db.exec(`
      UPDATE store_products
      SET base_amount = 5, piece_count = 5
      WHERE LOWER(TRIM(unit_size_raw)) = 'tros'
        AND LOWER(title) LIKE '%bana%'
        AND base_unit = 'piece'
        AND base_amount <= 1;
    `);

    const products = db
      .prepare("SELECT id, title, unit_size_raw, base_unit, base_amount FROM store_products WHERE piece_count IS NULL")
      .all() as Array<{ id: string; title: string; unit_size_raw: string; base_unit: string; base_amount: number }>;
    const updPiece = db.prepare("UPDATE store_products SET piece_count = ? WHERE id = ?");
    for (const p of products) {
      const pc = inferPieceCountFromText(p.unit_size_raw ?? "", p.title ?? "", p.base_unit, Number(p.base_amount));
      if (pc !== null) updPiece.run(pc, p.id);
    }

    // Clear previously pre-filter-poisoned rejections on multi-word concepts (e.g. "Picnic Cheese onion" for "cheese-onion-chips").
    db.exec(`
      DELETE FROM concept_product_links
      WHERE source = 'llm'
        AND is_valid_match = 0
        AND concept_id IN (SELECT id FROM canonical_concepts WHERE slug LIKE '%-%');
    `);

    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migration_v2_data_fixes', '1', ?)",
    ).run(new Date().toISOString());
  }

  const migratedV3 = db
    .prepare("SELECT value FROM app_settings WHERE key = 'migration_v3_pushed_backfill'")
    .get() as { value?: string } | undefined;
  if (migratedV3?.value !== "1") {
    const pushedRows = db
      .prepare(
        `SELECT * FROM shopping_list_items
         WHERE pushed_to_store_at IS NOT NULL
           AND recorded_in_stats_at IS NULL
           AND assigned_provider IN ('ah','picnic')`,
      )
      .all() as Array<Record<string, unknown>>;
    if (pushedRows.length > 0) {
      const prodStmt = db.prepare(
        "SELECT title, brand, is_house_brand, regular_price_cents, base_amount, base_unit, piece_count FROM store_products WHERE id = ?",
      );
      const insCompleted = db.prepare(
        `INSERT INTO completed_shopping_items (
           completed_at, trigger_source, raw_input, display_name, concept_id,
           chosen_provider, chosen_product_id, chosen_product_title, chosen_brand, is_house_brand,
           chosen_qty, baseline_cents, chosen_regular_cents, chosen_paid_cents,
           other_provider_cents, cheapest_store_cents, cheapest_overall_cents, cheapest_product_title
         ) VALUES (?, 'push', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updRecorded = db.prepare("UPDATE shopping_list_items SET recorded_in_stats_at = ? WHERE id = ?");
      for (const r of pushedRows) {
        const prov = String(r.assigned_provider) as "ah" | "picnic";
        const chosenProdId = prov === "ah" ? (r.ah_product_id as string | null) : (r.picnic_product_id as string | null);
        const otherProdId = prov === "ah" ? (r.picnic_product_id as string | null) : (r.ah_product_id as string | null);
        const chosenQty = Math.max(1, Number(prov === "ah" ? r.ah_qty : r.picnic_qty) || 1);
        const otherQty = Math.max(1, Number(prov === "ah" ? r.picnic_qty : r.ah_qty) || 1);
        const chosenPaid = Number((prov === "ah" ? r.ah_total_cents : r.picnic_total_cents) ?? 0);
        const rawOther = prov === "ah" ? r.picnic_total_cents : r.ah_total_cents;
        const chosenProd = chosenProdId
          ? (prodStmt.get(chosenProdId) as {
              title: string;
              brand: string | null;
              is_house_brand: number;
              regular_price_cents: number;
              base_amount: number;
              base_unit: string;
              piece_count: number | null;
            } | undefined)
          : undefined;
        const otherProd = otherProdId
          ? (prodStmt.get(otherProdId) as {
              base_amount: number;
              base_unit: string;
              piece_count: number | null;
            } | undefined)
          : undefined;
        let otherNorm: number | null = rawOther === null || rawOther === undefined ? null : Number(rawOther);
        if (otherNorm !== null && r.target_base_amount === null && chosenProd && otherProd) {
          if (chosenProd.base_unit === otherProd.base_unit && chosenProd.base_amount > 0 && otherProd.base_amount > 0) {
            const supC = chosenProd.base_amount * chosenQty;
            const supO = otherProd.base_amount * otherQty;
            if (supC !== supO) otherNorm = Math.round((otherNorm / supO) * supC);
          } else if (chosenProd.piece_count && otherProd.piece_count) {
            const supC = chosenProd.piece_count * chosenQty;
            const supO = otherProd.piece_count * otherQty;
            if (supC !== supO) otherNorm = Math.round((otherNorm / supO) * supC);
          }
        }
        const chosenReg = chosenProd ? Number(chosenProd.regular_price_cents) * chosenQty : chosenPaid;
        const baseline = Math.max(chosenReg, otherNorm ?? chosenReg, chosenPaid);
        const cheapestStore = otherNorm !== null ? Math.min(chosenPaid, otherNorm) : chosenPaid;
        const at = String(r.pushed_to_store_at);
        insCompleted.run(
          at,
          String(r.raw_input),
          String(r.display_name),
          r.concept_id === null || r.concept_id === undefined ? null : Number(r.concept_id),
          prov,
          chosenProdId ?? null,
          chosenProd?.title ?? null,
          chosenProd?.brand ?? null,
          chosenProd?.is_house_brand ? 1 : 0,
          chosenQty,
          baseline,
          chosenReg,
          chosenPaid,
          otherNorm,
          cheapestStore,
          cheapestStore,
          chosenProd?.title ?? null,
        );
        updRecorded.run(at, Number(r.id));
      }
    }
    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('migration_v3_pushed_backfill', '1', ?)",
    ).run(new Date().toISOString());
  }
}

/** Returns the shared connection for the current DATA_DIR (opened + migrated on first use, or re-migrated after HMR). */
export function getDb(): DatabaseSync {
  const { dataDir } = getRuntimeConfig();
  const existing = globalThis.__boodschappenDb;
  if (existing && existing.dataDir === dataDir) {
    if (existing.schemaVersion !== DB_SCHEMA_VERSION) {
      existing.db.exec(SCHEMA_SQL);
      runMigrations(existing.db);
      existing.schemaVersion = DB_SCHEMA_VERSION;
    }
    return existing.db;
  }
  if (existing) {
    try {
      existing.db.close();
    } catch {
      /* already closed */
    }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "boodschappen.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  globalThis.__boodschappenDb = { dataDir, db, schemaVersion: DB_SCHEMA_VERSION };
  return db;
}

/** Closes and forgets the singleton so tests can switch DATA_DIR. */
export function resetDbConnectionForTests(): void {
  const existing = globalThis.__boodschappenDb;
  if (existing) {
    try {
      existing.db.close();
    } catch {
      /* already closed */
    }
  }
  globalThis.__boodschappenDb = undefined;
}

/** Runs `fn` inside a transaction (rolls back on throw). */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export { SCHEMA_SQL };
export * from "./repositories";
