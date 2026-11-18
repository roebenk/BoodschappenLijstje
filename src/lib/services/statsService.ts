import { getDb } from "@/lib/db";
import { listCompletedShoppingItems, type CompletedShoppingItemInput } from "@/lib/db/repositories";
import type {
  ActiveShoppingProviderId,
  PriceChangeStat,
  RecentSavedItemStat,
  SavingsBreakdown,
  StatsResponse,
  StoreHistorySummary,
  StoreProviderId,
  TopFavoriteStat,
} from "@/lib/types";
import { computeItemSavingsEntry, getFullListState } from "./shoppingService";

interface MinimalEntry {
  baselineCents: number;
  chosenRegularCents: number;
  chosenPaidCents: number;
  cheapestStoreCents: number;
  cheapestOverallCents: number;
}

export function summarizeSavingsEntries(entries: MinimalEntry[]): SavingsBreakdown {
  let totalPaidCents = 0;
  let baselineCents = 0;
  let promoSavingsCents = 0;
  let realizedSavingsCents = 0;
  let missedStoreSavingsCents = 0;
  let missedBrandSavingsCents = 0;

  for (const e of entries) {
    const paid = Math.max(0, e.chosenPaidCents);
    const reg = Math.max(paid, e.chosenRegularCents);
    const base = Math.max(reg, e.baselineCents);
    const cheapStore = Math.min(paid, Math.max(0, e.cheapestStoreCents));
    const cheapOverall = Math.min(cheapStore, Math.max(0, e.cheapestOverallCents));

    totalPaidCents += paid;
    baselineCents += base;
    promoSavingsCents += Math.max(0, reg - paid);
    realizedSavingsCents += Math.max(0, base - paid);
    missedStoreSavingsCents += Math.max(0, paid - cheapStore);
    missedBrandSavingsCents += Math.max(0, cheapStore - cheapOverall);
  }

  const storeSplitSavingsCents = Math.max(0, realizedSavingsCents - promoSavingsCents);
  const optimalSavingsCents = realizedSavingsCents + missedStoreSavingsCents + missedBrandSavingsCents;
  const captureRatePct =
    optimalSavingsCents > 0 ? Math.min(100, Math.round((realizedSavingsCents / optimalSavingsCents) * 100)) : 100;

  return {
    itemCount: entries.length,
    totalPaidCents,
    baselineCents,
    realizedSavingsCents,
    promoSavingsCents,
    storeSplitSavingsCents,
    optimalSavingsCents,
    missedStoreSavingsCents,
    missedBrandSavingsCents,
    captureRatePct,
  };
}

export function getStatsView(): StatsResponse {
  const completed = listCompletedShoppingItems(5000);
  const lifetime = summarizeSavingsEntries(completed);

  const listState = getFullListState();
  const activeEntries = listState.items
    .filter((i) => !i.isChecked && i.assignedProvider !== null)
    .map((i) => computeItemSavingsEntry(i, "push"))
    .filter((e): e is CompletedShoppingItemInput => e !== null);
  const activeList = summarizeSavingsEntries(activeEntries);

  const storeAgg: Record<ActiveShoppingProviderId, { itemCount: number; paidCents: number; savedCents: number }> = {
    ah: { itemCount: 0, paidCents: 0, savedCents: 0 },
    picnic: { itemCount: 0, paidCents: 0, savedCents: 0 },
  };
  for (const c of completed) {
    const bucket = storeAgg[c.chosenProvider];
    if (!bucket) continue;
    bucket.itemCount += 1;
    bucket.paidCents += c.chosenPaidCents;
    bucket.savedCents += Math.max(0, c.baselineCents - c.chosenPaidCents);
  }
  const completedByStore = (["ah", "picnic"] as const).map((provider) => ({
    provider,
    ...storeAgg[provider],
  }));

  const biggestCompletedWins: RecentSavedItemStat[] = completed
    .map((c) => ({
      id: c.id,
      completedAt: c.completedAt,
      title: c.chosenProductTitle ?? c.displayName,
      provider: c.chosenProvider,
      qty: c.chosenQty,
      paidCents: c.chosenPaidCents,
      savedCents: Math.max(0, c.baselineCents - c.chosenPaidCents),
      missedOptimalCents: Math.max(0, c.chosenPaidCents - c.cheapestOverallCents),
    }))
    .filter((w) => w.savedCents > 0)
    .sort((a, b) => b.savedCents - a.savedCents || b.completedAt.localeCompare(a.completedAt))
    .slice(0, 6);

  const db = getDb();

  const storeHistoryRows = db
    .prepare(
      `SELECT provider,
              COUNT(DISTINCT tx_id) AS order_count,
              COUNT(*) AS line_count,
              SUM(COALESCE(total_cents, 0)) AS total_spent_cents
       FROM purchase_history
       WHERE provider IN ('ah', 'picnic')
       GROUP BY provider
       ORDER BY total_spent_cents DESC`,
    )
    .all() as Array<{
    provider: string;
    order_count: number;
    line_count: number;
    total_spent_cents: number;
  }>;

  const receiptStoreSummary: StoreHistorySummary[] = storeHistoryRows.map((r) => {
    const orderCount = Number(r.order_count ?? 0);
    const totalSpentCents = Math.max(0, Math.round(Number(r.total_spent_cents ?? 0)));
    return {
      provider: r.provider as ActiveShoppingProviderId,
      orderCount,
      lineCount: Number(r.line_count ?? 0),
      totalSpentCents,
      averageBasketCents: orderCount > 0 ? Math.round(totalSpentCents / orderCount) : 0,
    };
  });

  const hbRow = db
    .prepare(
      `SELECT SUM(CASE WHEN p.is_house_brand = 1 THEN COALESCE(h.quantity, 1) ELSE 0 END) AS hb_qty,
              SUM(CASE WHEN p.is_house_brand = 0 THEN COALESCE(h.quantity, 1) ELSE 0 END) AS brand_qty
       FROM purchase_history h
       JOIN store_products p ON p.id = h.store_product_id`,
    )
    .get() as { hb_qty?: number | null; brand_qty?: number | null } | undefined;

  const houseBrandLines = Math.round(Number(hbRow?.hb_qty ?? 0));
  const brandedLines = Math.round(Number(hbRow?.brand_qty ?? 0));
  const totalHb = houseBrandLines + brandedLines;
  const houseBrandSharePct = totalHb > 0 ? Math.round((houseBrandLines / totalHb) * 100) : 0;

  const favRows = db
    .prepare(
      `SELECT pp.store_product_id, pp.times_bought, p.provider, p.title, p.image_url, p.current_price_cents
       FROM product_preferences pp
       JOIN store_products p ON p.id = pp.store_product_id
       WHERE pp.times_bought > 0
       ORDER BY pp.times_bought DESC, pp.affinity_score DESC
       LIMIT 6`,
    )
    .all() as Array<{
    store_product_id: string;
    times_bought: number;
    provider: string;
    title: string;
    image_url: string | null;
    current_price_cents: number;
  }>;

  const topFavorites: TopFavoriteStat[] = favRows.map((r) => ({
    storeProductId: r.store_product_id,
    provider: r.provider as StoreProviderId,
    title: r.title,
    imageUrl: r.image_url ?? null,
    timesBought: Number(r.times_bought),
    currentPriceCents: Number(r.current_price_cents),
  }));

  const moverRows = db
    .prepare(
      `SELECT h.store_product_id,
              p.provider,
              p.title,
              p.current_price_cents,
              COUNT(*) AS buy_count,
              AVG(CAST(h.total_cents AS REAL) / CASE WHEN h.quantity > 0 THEN h.quantity ELSE 1 END) AS avg_paid_cents
       FROM purchase_history h
       JOIN store_products p ON p.id = h.store_product_id
       WHERE h.total_cents > 25
         AND p.current_price_cents > 25
       GROUP BY h.store_product_id
       HAVING COUNT(*) >= 3`,
    )
    .all() as Array<{
    store_product_id: string;
    provider: string;
    title: string;
    current_price_cents: number;
    buy_count: number;
    avg_paid_cents: number;
  }>;

  const movers: PriceChangeStat[] = [];
  for (const r of moverRows) {
    const avgHistoricalCents = Math.round(Number(r.avg_paid_cents));
    const currentPriceCents = Number(r.current_price_cents);
    if (avgHistoricalCents <= 0) continue;
    const changeCents = currentPriceCents - avgHistoricalCents;
    const changePct = Math.round((changeCents / avgHistoricalCents) * 100);
    // Guard against receipt lines that recorded multi-pack totals as unit price.
    if (changePct < -70 || changePct > 140 || Math.abs(changeCents) < 15) continue;
    movers.push({
      storeProductId: r.store_product_id,
      provider: r.provider as StoreProviderId,
      title: r.title,
      timesBought: Number(r.buy_count),
      avgHistoricalCents,
      currentPriceCents,
      changeCents,
      changePct,
    });
  }

  const drops = [...movers]
    .filter((m) => m.changeCents < 0)
    .sort((a, b) => a.changeCents - b.changeCents)
    .slice(0, 4);
  const hikes = [...movers]
    .filter((m) => m.changeCents > 0)
    .sort((a, b) => b.changeCents - a.changeCents)
    .slice(0, 4);

  return {
    lifetime,
    activeList,
    completedByStore,
    receiptStoreSummary,
    houseBrandSharePct,
    houseBrandLines,
    brandedLines,
    topFavorites,
    biggestCompletedWins,
    priceMovers: { drops, hikes },
  };
}
