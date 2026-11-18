"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Award, PiggyBank, Receipt, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { Card, PageHeader, ProductThumb, StoreBadge, SyncPill } from "@/components/ui";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
import { formatEuro } from "@/lib/format";
import type { StatsResponse } from "@/lib/types";

export default function StatistiekenPage() {
  const [data, setData] = useState<StatsResponse | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<StatsResponse>("/api/stats"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Statistieken laden mislukt");
    }
  }, []);

  const { connected } = useHouseholdSync(load);
  useEffect(() => {
    void load();
  }, [load]);

  const life = data?.lifetime;
  const open = data?.activeList;

  return (
    <main className="mx-auto max-w-xl overflow-x-clip pb-safe">
      <PageHeader title="Statistieken" right={<SyncPill connected={connected} />} />

      <div className="space-y-6 px-4 pt-2 pb-6">
        {data === null && (
          <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Statistieken berekenen…</p>
        )}

        {data && life && open && (
          <>
            {/* Hero: Gerealiseerde besparing vs 100% Optimaal */}
            <section className="space-y-3">
              <Card className="overflow-hidden p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wide text-[#1E8E3E] dark:text-[#5DDB7E]">
                      <PiggyBank className="h-4 w-4" /> Totaal bespaard
                    </p>
                    <p
                      data-testid="lifetime-realized-savings"
                      className="mt-1 text-[34px] font-extrabold leading-none tracking-tight tabular-nums text-[#1E8E3E] dark:text-[#5DDB7E]"
                    >
                      {formatEuro(life.realizedSavingsCents)}
                    </p>
                    <p className="mt-1.5 text-[13px] text-black/60 dark:text-white/60">
                      Over {life.itemCount} afgeronde {life.itemCount === 1 ? "boodschap" : "boodschappen"} · besteed{" "}
                      <span className="font-semibold tabular-nums">{formatEuro(life.totalPaidCents)}</span>
                    </p>
                  </div>
                  <div className="rounded-2xl bg-[#34C759]/12 px-3 py-2 text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#1E8E3E] dark:text-[#5DDB7E]">
                      Benut
                    </p>
                    <p className="text-[22px] font-extrabold tabular-nums text-[#1E8E3E] dark:text-[#5DDB7E]">
                      {life.captureRatePct}%
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-black/[0.04] p-3 dark:bg-white/[0.06]">
                    <p className="text-[12px] text-black/60 dark:text-white/60">Aanbiedingen &amp; bundels</p>
                    <p className="mt-0.5 text-[17px] font-bold tabular-nums">{formatEuro(life.promoSavingsCents)}</p>
                  </div>
                  <div className="rounded-xl bg-black/[0.04] p-3 dark:bg-white/[0.06]">
                    <p className="text-[12px] text-black/60 dark:text-white/60">Slimme winkelkeuze</p>
                    <p className="mt-0.5 text-[17px] font-bold tabular-nums">{formatEuro(life.storeSplitSavingsCents)}</p>
                  </div>
                </div>

                {/* 100% Optimaal vergelijking */}
                <div className="mt-4 rounded-2xl bg-[#007AFF]/[0.08] p-3.5 dark:bg-[#0A84FF]/15">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-[14px] font-bold text-[#0055B3] dark:text-[#64B0FF]">
                      <Sparkles className="h-4 w-4" /> Als je 100% optimaal had geshopt
                    </p>
                    <span
                      data-testid="lifetime-optimal-savings"
                      className="text-[17px] font-extrabold tabular-nums text-[#0055B3] dark:text-[#64B0FF]"
                    >
                      {formatEuro(life.optimalSavingsCents)}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
                    <div
                      className="h-full rounded-full bg-[#007AFF] transition-all dark:bg-[#0A84FF]"
                      style={{ width: `${life.captureRatePct}%` }}
                    />
                  </div>
                  {life.missedStoreSavingsCents + life.missedBrandSavingsCents > 0 ? (
                    <div className="mt-2.5 space-y-1 text-[13px] text-black/70 dark:text-white/75">
                      {life.missedStoreSavingsCents > 0 && (
                        <div className="flex justify-between gap-2">
                          <span>Gemak / winkel vastgezet:</span>
                          <span className="font-semibold tabular-nums">
                            +{formatEuro(life.missedStoreSavingsCents)} mogelijk
                          </span>
                        </div>
                      )}
                      {life.missedBrandSavingsCents > 0 && (
                        <div className="flex justify-between gap-2">
                          <span>Favoriet merk boven goedkoopste huismerk:</span>
                          <span className="font-semibold tabular-nums">
                            +{formatEuro(life.missedBrandSavingsCents)} mogelijk
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-[13px] text-black/65 dark:text-white/70">
                      Je hebt tot nu toe elke mogelijke euro besparing gepakt!
                    </p>
                  )}
                </div>

                {life.itemCount === 0 && (
                  <p className="mt-3 text-[13px] text-black/55 dark:text-white/55">
                    Besparingen worden automatisch bijgehouden zodra je items klaarzet bij AH/Picnic of afgevinkte boodschappen wist.
                  </p>
                )}
              </Card>

              {/* Live huidig open lijstje */}
              {open.itemCount > 0 && (
                <Card className="p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[15px] font-bold">Nu op je open lijstje ({open.itemCount} items)</p>
                    <span className="text-[16px] font-extrabold tabular-nums text-[#1E8E3E] dark:text-[#5DDB7E]">
                      {formatEuro(open.realizedSavingsCents)} besparing
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] text-black/65 dark:text-white/65">
                    100% optimaal op dit lijstje is{" "}
                    <span className="font-semibold tabular-nums">{formatEuro(open.optimalSavingsCents)}</span>
                    {open.optimalSavingsCents > open.realizedSavingsCents
                      ? ` — nog ${formatEuro(open.optimalSavingsCents - open.realizedSavingsCents)} extra te pakken via goedkoopste winkel/huismerk.`
                      : " — dit lijstje staat al 100% optimaal!"}
                  </p>
                </Card>
              )}
            </section>

            {/* Kassabonhistorie & Huismerk-score */}
            {(data.receiptStoreSummary.length > 0 || data.houseBrandLines + data.brandedLines > 0) && (
              <section>
                <h2 className="flex items-center gap-1.5 px-1 pb-2 text-[20px] font-bold tracking-tight">
                  <Receipt className="h-5 w-5 text-[#007AFF]" /> Kassabon-inzichten
                </h2>
                <div className="space-y-3">
                  {data.receiptStoreSummary.length > 0 && (
                    <div className="grid grid-cols-2 gap-2.5">
                      {data.receiptStoreSummary.map((s) => (
                        <Card key={s.provider} className="p-3.5">
                          <StoreBadge provider={s.provider} label={s.provider === "ah" ? "Albert Heijn" : "Picnic"} />
                          <p className="mt-2 text-[20px] font-extrabold tabular-nums">
                            {formatEuro(s.totalSpentCents)}
                          </p>
                          <p className="mt-0.5 text-[12px] text-black/60 dark:text-white/60">
                            {s.orderCount} {s.orderCount === 1 ? "bon/bestelling" : "bonnen/bestellingen"} · {s.lineCount} regels
                          </p>
                          <p className="mt-1 text-[13px] font-semibold tabular-nums text-black/75 dark:text-white/80">
                            Gem. {formatEuro(s.averageBasketCents)} / keer
                          </p>
                        </Card>
                      ))}
                    </div>
                  )}

                  {data.houseBrandLines + data.brandedLines > 0 && (
                    <Card className="p-4">
                      <div className="flex items-baseline justify-between">
                        <p className="text-[15px] font-bold">Huismerk-score</p>
                        <span className="text-[18px] font-extrabold tabular-nums text-[#34C759]">
                          {data.houseBrandSharePct}% huismerk
                        </span>
                      </div>
                      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/12">
                        <div className="bg-[#34C759]" style={{ width: `${data.houseBrandSharePct}%` }} />
                      </div>
                      <div className="mt-1.5 flex justify-between text-[12px] text-black/60 dark:text-white/60">
                        <span>{data.houseBrandLines}× huismerk gekocht</span>
                        <span>{data.brandedLines}× A-merk / overig</span>
                      </div>
                    </Card>
                  )}
                </div>
              </section>
            )}

            {/* Grootste gepakte klappers op afgeronde lijstjes */}
            {data.biggestCompletedWins.length > 0 && (
              <section>
                <h2 className="flex items-center gap-1.5 px-1 pb-2 text-[20px] font-bold tracking-tight">
                  <Award className="h-5 w-5 text-[#FF9500]" /> Beste bespaarklappers
                </h2>
                <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                  {data.biggestCompletedWins.map((w) => (
                    <div key={w.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold">
                          {w.qty > 1 ? `${w.qty}× ` : ""}
                          {w.title}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-black/60 dark:text-white/60">
                          <StoreBadge provider={w.provider} />
                          <span>Betaald: {formatEuro(w.paidCents)}</span>
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#34C759]/15 px-2.5 py-1 text-[13px] font-bold tabular-nums text-[#1E8E3E] dark:text-[#5DDB7E]">
                        −{formatEuro(w.savedCents)}
                      </span>
                    </div>
                  ))}
                </Card>
              </section>
            )}

            {/* Top vaste klassiekers */}
            {data.topFavorites.length > 0 && (
              <section>
                <h2 className="px-1 pb-2 text-[20px] font-bold tracking-tight">Jouw vaste klassiekers</h2>
                <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                  {data.topFavorites.map((f, idx) => (
                    <div key={f.storeProductId} className="flex items-center gap-3 p-3">
                      <span className="w-5 shrink-0 text-center text-[14px] font-extrabold tabular-nums text-black/40 dark:text-white/40">
                        {idx + 1}
                      </span>
                      <ProductThumb url={f.imageUrl} title={f.title} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold">{f.title}</p>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-black/65 dark:text-white/65">
                          <StoreBadge provider={f.provider} />
                          <span className="tabular-nums">{formatEuro(f.currentPriceCents)}</span>
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-[#007AFF]/12 px-2.5 py-1 text-[13px] font-bold tabular-nums text-[#0062CC] dark:text-[#64B0FF]">
                        {f.timesBought}×
                      </span>
                    </div>
                  ))}
                </Card>
              </section>
            )}

            {/* Prijsdalers & stijgers t.o.v. wat je eerder betaalde */}
            {(data.priceMovers.drops.length > 0 || data.priceMovers.hikes.length > 0) && (
              <section className="space-y-3">
                <h2 className="px-1 text-[20px] font-bold tracking-tight">Prijsontwikkeling op jouw boodschappen</h2>

                {data.priceMovers.drops.length > 0 && (
                  <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                    <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-bold text-[#1E8E3E] dark:text-[#5DDB7E]">
                      <TrendingDown className="h-4 w-4" /> Nu goedkoper dan wat je gemiddeld betaalde
                    </div>
                    {data.priceMovers.drops.map((m) => (
                      <div key={m.storeProductId} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-semibold">{m.title}</p>
                          <p className="mt-0.5 text-[12px] tabular-nums text-black/60 dark:text-white/60">
                            Gem. betaald {formatEuro(m.avgHistoricalCents)} → nu {formatEuro(m.currentPriceCents)}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#34C759]/15 px-2.5 py-0.5 text-[13px] font-bold tabular-nums text-[#1E8E3E] dark:text-[#5DDB7E]">
                          {m.changePct}%
                        </span>
                      </div>
                    ))}
                  </Card>
                )}

                {data.priceMovers.hikes.length > 0 && (
                  <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                    <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-[13px] font-bold text-[#C81015] dark:text-[#FF6961]">
                      <TrendingUp className="h-4 w-4" /> Duurder geworden sinds je eerdere bonnen
                    </div>
                    {data.priceMovers.hikes.map((m) => (
                      <div key={m.storeProductId} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-semibold">{m.title}</p>
                          <p className="mt-0.5 text-[12px] tabular-nums text-black/60 dark:text-white/60">
                            Gem. betaald {formatEuro(m.avgHistoricalCents)} → nu {formatEuro(m.currentPriceCents)}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#FF3B30]/12 px-2.5 py-0.5 text-[13px] font-bold tabular-nums text-[#C81015] dark:text-[#FF6961]">
                          +{m.changePct}%
                        </span>
                      </div>
                    ))}
                  </Card>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
