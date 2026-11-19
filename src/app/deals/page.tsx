"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Plus, RotateCcw, Search } from "lucide-react";
import { PageHeader, Card, ProductThumb, STORE_NAME } from "@/components/ui";
import { SwipeRow } from "@/components/SwipeRow";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
import { formatEuro } from "@/lib/format";
import { dealDiscount } from "@/lib/engine/dealDiscount";
import type { DealsResponse, RadarDeal, StoreProviderId } from "@/lib/types";

type Sort = "saving" | "bought" | "az";

const SORTS: Array<[Sort, string]> = [
  ["saving", "Grootste besparing"],
  ["bought", "Vaakst gekocht"],
  ["az", "A–Z"],
];

const norm = (s: string) => s.trim().toLowerCase();
const savingCents = (d: RadarDeal) => dealDiscount(d)?.savingCents ?? 0;

const chip = (active: boolean) =>
  `inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold transition-colors ${
    active ? "bg-[#007AFF] text-white dark:bg-[#0A84FF]" : "bg-black/[0.06] text-black/70 dark:bg-white/10 dark:text-white/75"
  }`;

export default function DealsPage() {
  const [data, setData] = useState<DealsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [store, setStore] = useState<StoreProviderId | "all">("all");
  const [sort, setSort] = useState<Sort>("saving");
  const [showDismissed, setShowDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<DealsResponse>("/api/deals"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Laden mislukt");
    }
  }, []);

  const { connected } = useHouseholdSync(load);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = (body: Record<string, unknown>) => api("/api/preferences", { method: "PATCH", body });

  const addDeal = async (title: string) => {
    try {
      await api("/api/list", { method: "POST", body: { inputs: [title] } });
      toast.success("Op je lijstje gezet");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toevoegen mislukt");
    }
  };

  const restoreDeal = async (dealKey: string, silent = false) => {
    try {
      await patch({ restoreDealKey: dealKey });
      if (!silent) toast.success("Deal hersteld");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Herstellen mislukt");
    }
  };

  const dismissDeal = async (dealKey: string, title: string) => {
    try {
      await patch({ dismissDealKey: dealKey, dismissDealLabel: title });
      await load();
      toast("Uit deals verwijderd", {
        action: { label: "Herstel", onClick: () => void restoreDeal(dealKey, true) },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verbergen mislukt");
    }
  };

  const restoreAllDeals = async () => {
    try {
      await patch({ restoreAllDeals: true });
      toast.success("Verborgen deals hersteld");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Herstellen mislukt");
    }
  };

  const q = norm(query);
  const all = useMemo(() => data?.weekDeals ?? [], [data]);

  const storeCounts = useMemo(() => {
    const counts = new Map<StoreProviderId, number>();
    for (const d of all) counts.set(d.provider, (counts.get(d.provider) ?? 0) + 1);
    return counts;
  }, [all]);

  const filtered = useMemo(() => {
    const list = all.filter(
      (d) =>
        (store === "all" || d.provider === store) &&
        (!q || norm(d.title).includes(q) || norm(d.promoLabel ?? "").includes(q) || norm(STORE_NAME[d.provider]).includes(q)),
    );
    const cmp: Record<Sort, (a: RadarDeal, b: RadarDeal) => number> = {
      saving: (a, b) => savingCents(b) - savingCents(a) || a.title.localeCompare(b.title, "nl"),
      bought: (a, b) => (b.timesBought ?? 0) - (a.timesBought ?? 0) || a.title.localeCompare(b.title, "nl"),
      az: (a, b) => a.title.localeCompare(b.title, "nl"),
    };
    return list.sort(cmp[sort]);
  }, [all, store, q, sort]);

  const filtersActive = q !== "" || store !== "all";

  const dismissed = useMemo(
    () => (data?.dismissedDeals ?? []).filter((d) => !q || norm(d.label ?? d.dealKey).includes(q)),
    [data, q],
  );

  const clearFilters = () => {
    setQuery("");
    setStore("all");
  };

  const renderDeal = (d: RadarDeal, i: number) => {
    const key = d.dealKey ?? `${d.provider}-${d.title}-${i}`;
    const discount = dealDiscount(d);
    const regular = d.regularPriceCents ?? d.priceCents;
    const unitPrice = discount?.effectiveUnitCents ?? d.priceCents;
    const summary = `${d.title}${unitPrice !== null ? `, nu ${formatEuro(unitPrice)}` : ""}${
      discount && regular ? `, was ${formatEuro(regular)}` : ""
    }, ${d.promoLabel}`;
    const row = (
      <div data-testid="deal-row" className="flex items-start gap-3 px-3 py-2.5">
        <ProductThumb url={d.imageUrl} title={d.title} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[16px] font-semibold leading-snug">{d.title}</p>
          <p className="mt-0.5 text-[13px] text-black/60 dark:text-white/60">
            {STORE_NAME[d.provider]}
            {d.timesBought ? ` · ${d.timesBought}× gekocht` : ""}
          </p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {unitPrice !== null && <span className="text-[18px] font-bold tabular-nums">{formatEuro(unitPrice)}</span>}
            {discount && regular && (
              <span className="text-[13px] tabular-nums text-black/50 line-through dark:text-white/50">{formatEuro(regular)}</span>
            )}
            {discount ? (
              <span className="rounded-full bg-[#34C759]/15 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[#1E8E3E] dark:text-[#5DDB7E]">
                {discount.effectiveUnitCents !== null
                  ? `${d.promoLabel} · −${discount.percent}%`
                  : `−${formatEuro(discount.savingCents)} · ${discount.percent}%`}
              </span>
            ) : (
              <span className="rounded-full bg-[#FF9500]/15 px-2 py-0.5 text-[12px] font-semibold text-[#B25E00] dark:text-[#FFB340]">
                {d.promoLabel}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          aria-label={`Voeg toe aan lijst: ${summary}`}
          onClick={() => void addDeal(d.title)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#007AFF]/12 text-[#0062CC] dark:text-[#64B0FF]"
        >
          <Plus className="h-5 w-5" strokeWidth={2.4} />
        </button>
      </div>
    );
    return (
      <li key={key}>
        {d.dealKey ? (
          <SwipeRow label="Verberg" keyboardHint onSwipe={() => void dismissDeal(d.dealKey!, d.title)}>
            {row}
          </SwipeRow>
        ) : (
          row
        )}
      </li>
    );
  };

  const dealList = (deals: RadarDeal[]) => (
    <Card>
      <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">{deals.map(renderDeal)}</ul>
    </Card>
  );

  return (
    <main className="mx-auto max-w-xl overflow-x-clip pb-safe">
      <PageHeader title="Deals" connected={connected} />
      <div className="space-y-5 px-4 pt-2">
        {data === null && <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Laden…</p>}

        {data && (
          <>
            <div className="space-y-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/45 dark:text-white/45" />
                <input
                  type="search"
                  data-testid="deals-search"
                  aria-label="Zoeken in deals"
                  placeholder="Zoek in deals…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-h-[44px] w-full rounded-[12px] bg-black/[0.06] pl-9 pr-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-[#007AFF] dark:bg-white/10"
                />
              </div>

              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]" role="group" aria-label="Filter op winkel">
                <button type="button" aria-pressed={store === "all"} onClick={() => setStore("all")} className={chip(store === "all")}>
                  Alle winkels <span className="tabular-nums opacity-70">{all.length}</span>
                </button>
                {[...storeCounts].map(([provider, count]) => (
                  <button
                    key={provider}
                    type="button"
                    aria-pressed={store === provider}
                    onClick={() => setStore(store === provider ? "all" : provider)}
                    className={chip(store === provider)}
                  >
                    {STORE_NAME[provider]} <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 px-1">
                <p className="text-[14px] text-black/65 dark:text-white/65" role="status" aria-live="polite">
                  <span className="font-semibold text-black dark:text-white">
                    {filtered.length} {filtered.length === 1 ? "deal" : "deals"}
                  </span>
                </p>
                <select
                  data-testid="deals-sort"
                  aria-label="Sorteren"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as Sort)}
                  className="min-h-[44px] shrink-0 rounded-[10px] bg-black/[0.06] px-2 text-[14px] font-medium text-black dark:bg-white/10 dark:text-white"
                >
                  {SORTS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {filtered.length === 0 ? (
              <Card className="space-y-2 p-4 text-[15px] text-black/65 dark:text-white/65">
                {filtersActive ? (
                  <>
                    <p>Geen deals gevonden{q ? ` voor “${query.trim()}”` : ""}.</p>
                    <button type="button" onClick={clearFilters} className="min-h-[44px] text-[14px] font-semibold text-[#007AFF] dark:text-[#64B0FF]">
                      Wis filters
                    </button>
                  </>
                ) : data.dismissedDealsCount > 0 ? (
                  <p>Alle huidige deals zijn verborgen.</p>
                ) : (
                  <>
                    <p>Nog geen deals gevonden. Zodra je kassabonnen zijn gesynchroniseerd zie je hier aanbiedingen.</p>
                    <Link href="/winkels" className="inline-flex min-h-[44px] items-center text-[14px] font-semibold text-[#007AFF] dark:text-[#64B0FF]">
                      Koppel een winkel
                    </Link>
                  </>
                )}
              </Card>
            ) : (
              <section aria-labelledby="deals-regular">
                <h2 id="deals-regular" className="px-1 pb-2 text-[20px] font-bold tracking-tight">
                  Aanbiedingen op jouw vaste producten
                </h2>
                {dealList(filtered)}
              </section>
            )}

            {data.dismissedDealsCount > 0 && (
              <section aria-labelledby="deals-dismissed">
                <div className="flex items-center justify-between gap-2">
                  <h2 id="deals-dismissed" className="text-[20px] font-bold tracking-tight">
                    <button
                      type="button"
                      data-testid="toggle-dismissed-deals"
                      aria-expanded={showDismissed}
                      onClick={() => setShowDismissed((open) => !open)}
                      className="flex min-h-[44px] items-center gap-1 px-1"
                    >
                      <ChevronRight className={`h-5 w-5 transition-transform ${showDismissed ? "rotate-90" : ""}`} />
                      Verborgen ({data.dismissedDealsCount})
                    </button>
                  </h2>
                  {showDismissed && (
                    <button
                      type="button"
                      data-testid="restore-all-deals"
                      onClick={() => void restoreAllDeals()}
                      className="inline-flex min-h-[44px] items-center gap-1.5 text-[14px] font-semibold text-[#007AFF] dark:text-[#64B0FF]"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Alles herstellen
                    </button>
                  )}
                </div>
                {showDismissed &&
                  (dismissed.length === 0 ? (
                    <Card className="p-4 text-[15px] text-black/65 dark:text-white/65">Geen verborgen deals gevonden.</Card>
                  ) : (
                    <Card>
                      <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                        {dismissed.map((d) => (
                          <li key={d.dealKey}>
                            <SwipeRow label="Herstel" tone="primary" onSwipe={() => void restoreDeal(d.dealKey)}>
                              <div className="flex items-center gap-2.5 px-3 py-1.5">
                                <p className="line-clamp-2 min-w-0 flex-1 text-[15px] font-medium leading-snug">{d.label ?? d.dealKey}</p>
                                <button
                                  type="button"
                                  data-testid="restore-deal"
                                  aria-label={`${d.label ?? d.dealKey} herstellen`}
                                  onClick={() => void restoreDeal(d.dealKey)}
                                  className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full bg-[#007AFF]/12 px-3 text-[14px] font-semibold text-[#0062CC] dark:text-[#64B0FF]"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  Herstel
                                </button>
                              </div>
                            </SwipeRow>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
