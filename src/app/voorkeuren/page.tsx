"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RotateCcw, X } from "lucide-react";
import { PageHeader, Card, ProductThumb, PromoPill, StoreBadge, SyncPill, btnPrimary, btnSecondary } from "@/components/ui";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
import { formatEuro } from "@/lib/format";
import { AI_MODELS, estimatedMonthlyCost } from "@/lib/llm/models";
import type {
  ActiveShoppingProviderId,
  BrandPreferenceMode,
  DemoSeedResponse,
  PreferencesResponse,
} from "@/lib/types";

const MODES: Array<[BrandPreferenceMode, string]> = [
  ["auto", "Slim automatisch"],
  ["house_brand", "Altijd huismerk"],
  ["pinned_brand", "Vast merk"],
];

const DEFAULT_STORES: Array<[ActiveShoppingProviderId, string]> = [
  ["ah", "Albert Heijn"],
  ["picnic", "Picnic"],
];

export default function VoorkeurenPage() {
  const [data, setData] = useState<PreferencesResponse | null>(null);
  const [modes, setModes] = useState<Record<number, BrandPreferenceMode>>({});
  const [defaultProvider, setDefaultProviderState] = useState<ActiveShoppingProviderId>("ah");
  const [savingDefault, setSavingDefault] = useState(false);
  const [savingAiModel, setSavingAiModel] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<PreferencesResponse>("/api/preferences");
      setData(next);
      if (next.settings?.defaultProvider) {
        setDefaultProviderState(next.settings.defaultProvider);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Laden mislukt");
    }
  }, []);

  const { connected } = useHouseholdSync(load);
  useEffect(() => {
    void load();
  }, [load]);

  const addDeal = async (title: string) => {
    try {
      await api("/api/list", { method: "POST", body: { inputs: [title] } });
      toast.success("Op je lijstje gezet");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toevoegen mislukt");
    }
  };

  const dismissDeal = async (dealKey: string | undefined, title: string) => {
    if (!dealKey) return;
    const prev = data;
    setData((curr) =>
      curr
        ? {
            ...curr,
            weekDeals: curr.weekDeals.filter((d) => d.dealKey !== dealKey),
            dismissedDealsCount: (curr.dismissedDealsCount ?? 0) + 1,
          }
        : curr,
    );
    try {
      await api("/api/preferences", {
        method: "PATCH",
        body: { dismissDealKey: dealKey, dismissDealLabel: title },
      });
      toast("Uit weekdeals verwijderd", {
        action: {
          label: "Herstel",
          onClick: () => {
            void api("/api/preferences", {
              method: "PATCH",
              body: { restoreDealKey: dealKey },
            }).then(() => load());
          },
        },
      });
    } catch (e) {
      setData(prev);
      toast.error(e instanceof Error ? e.message : "Verbergen mislukt");
    }
  };

  const restoreAllDeals = async () => {
    try {
      await api("/api/preferences", {
        method: "PATCH",
        body: { restoreAllDeals: true },
      });
      toast.success("Verborgen weekdeals hersteld");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Herstellen mislukt");
    }
  };

  const changeDefaultStore = async (provider: ActiveShoppingProviderId) => {
    if (provider === defaultProvider || savingDefault) return;
    const prev = defaultProvider;
    setDefaultProviderState(provider);
    setSavingDefault(true);
    try {
      await api("/api/preferences", {
        method: "PATCH",
        body: { defaultProvider: provider },
      });
      toast.success(`Standaardwinkel ingesteld op ${provider === "ah" ? "Albert Heijn" : "Picnic"}`);
    } catch (e) {
      setDefaultProviderState(prev);
      toast.error(e instanceof Error ? e.message : "Opslaan mislukt");
    } finally {
      setSavingDefault(false);
    }
  };

  const changeAiModel = async (model: string) => {
    if (!data?.settings || model === data.settings.aiModel || savingAiModel) return;
    const previous = data.settings.aiModel;
    setData((curr) => curr?.settings ? { ...curr, settings: { ...curr.settings, aiModel: model } } : curr);
    setSavingAiModel(true);
    try {
      await api("/api/preferences", { method: "PATCH", body: { aiModel: model } });
      toast.success("AI-model bijgewerkt");
    } catch (e) {
      setData((curr) => curr?.settings ? { ...curr, settings: { ...curr.settings, aiModel: previous } } : curr);
      toast.error(e instanceof Error ? e.message : "Opslaan mislukt");
    } finally {
      setSavingAiModel(false);
    }
  };

  const setMode = async (conceptId: number, mode: BrandPreferenceMode, brand: string | null) => {
    const prev = modes[conceptId];
    setModes((m) => ({ ...m, [conceptId]: mode }));
    try {
      await api("/api/preferences", {
        method: "PATCH",
        body: { conceptId, brandPreferenceMode: mode, pinnedBrand: mode === "pinned_brand" ? brand : null },
      });
      toast.success("Voorkeur bijgewerkt!");
    } catch (e) {
      setModes((m) => ({ ...m, [conceptId]: prev ?? "auto" }));
      toast.error(e instanceof Error ? e.message : "Opslaan mislukt");
    }
  };

  const seed = async () => {
    setSeeding(true);
    try {
      const r = await api<DemoSeedResponse>("/api/stores/demo-seed", { method: "POST" });
      toast.success(`${r.preferences} voorkeuren geleerd uit ${r.historyEntries} regels`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Laden mislukt");
    } finally {
      setSeeding(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl overflow-x-clip pb-safe">
      <PageHeader title="Voorkeuren" right={<SyncPill connected={connected} />} />
      <div className="space-y-6 px-4 pt-2">
        {data === null && <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Laden…</p>}

        {data && (
          <>
            <section>
              <h2 className="px-1 pb-2 text-[20px] font-bold tracking-tight">Winkelinstellingen</h2>
              <Card className="p-4">
                <p className="text-[16px] font-semibold">Standaardwinkel bij gelijke prijs</p>
                <p className="mt-0.5 text-[14px] leading-snug text-black/65 dark:text-white/65">
                  Nieuwe en niet-vergrendelde items komen standaard bij deze winkel terecht wanneer de prijs gelijk is.
                </p>
                <div className="mt-3 flex rounded-[10px] bg-black/[0.06] p-0.5 dark:bg-white/10">
                  {DEFAULT_STORES.map(([provider, label]) => {
                    const active = defaultProvider === provider;
                    return (
                      <button
                        key={provider}
                        type="button"
                        data-testid={`default-provider-${provider}`}
                        aria-pressed={active}
                        disabled={savingDefault}
                        onClick={() => void changeDefaultStore(provider)}
                        className={`min-h-[42px] flex-1 rounded-[8px] px-3 text-[14px] font-semibold transition-colors ${
                          active
                            ? provider === "ah"
                              ? "bg-white text-[#0086B3] shadow-sm dark:bg-[#636366] dark:text-[#38C6F4]"
                              : "bg-white text-[#C81015] shadow-sm dark:bg-[#636366] dark:text-[#FF5A5F]"
                            : "text-black/60 dark:text-white/65"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </Card>
            </section>

            <section>
              <h2 className="px-1 pb-2 text-[20px] font-bold tracking-tight">AI-model</h2>
              <Card className="p-4">
                <p className="text-[14px] leading-snug text-black/65 dark:text-white/65">
                  Voor zoektermen, productvergelijkingen en het indelen van kassabonnen. Bestaande resultaten blijven in de cache.
                </p>
                {!data.settings?.aiConfigured && (
                  <p className="mt-2 text-[14px] text-black/65 dark:text-white/65">
                    Stel een OpenRouter-sleutel in om AI te gebruiken.
                  </p>
                )}
                {data.settings?.aiModel && !AI_MODELS.some((model) => model.id === data.settings?.aiModel) && (
                  <p className="mt-2 text-[14px] text-black/65 dark:text-white/65">
                    Huidig model uit configuratie: {data.settings.aiModel}
                  </p>
                )}
                <div role="radiogroup" aria-label="AI-model" className="mt-3 space-y-2">
                  {AI_MODELS.map((model) => {
                    const active = data.settings?.aiModel === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={savingAiModel}
                        onClick={() => void changeAiModel(model.id)}
                        className={`flex min-h-[56px] w-full items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left ${
                          active ? "border-[#007AFF] bg-[#007AFF]/10" : "border-black/10 dark:border-white/15"
                        }`}
                      >
                        <span>
                          <span className="block text-[15px] font-semibold">{model.name}</span>
                          <span className="block text-[13px] text-black/60 dark:text-white/60">{model.description}</span>
                        </span>
                        <span className="shrink-0 text-[14px] font-semibold">
                          ~${estimatedMonthlyCost(model).toFixed(3)}/mnd
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 text-[12px] leading-snug text-black/60 dark:text-white/60">
                  Schatting voor 100 nieuwe zoekopdrachten per maand: per zoekopdracht een zoekuitbreiding
                  (500 invoer- en 100 uitvoertokens) en productbeoordeling (2.000 invoer- en 200 uitvoertokens).
                  Exclusief kassabonnen, herpogingen, reservemodel, eventuele reasoning-tokens en belastingen.
                  Gebaseerd op gepubliceerde vanaf-tarieven; aanbieder, cache en werkelijk tokenverbruik beïnvloeden de kosten.
                  Tarieven OpenRouter: 18 november 2026.
                </p>
                <p className="mt-2 text-[12px] text-black/60 dark:text-white/60">
                  Reservemodel bij fouten: {
                    data.settings?.aiFallbackModel && data.settings.aiFallbackModel !== data.settings.aiModel
                      ? data.settings.aiFallbackModel
                      : "geen"
                  }.
                </p>
              </Card>
            </section>

            <section>
              <div className="flex items-baseline justify-between gap-2 px-1 pb-2">
                <h2 className="text-[20px] font-bold tracking-tight">Weekdeals op jouw vaste boodschappen</h2>
              </div>
              {data.weekDeals.length === 0 ? (
                <Card className="p-4 text-[15px] text-black/65 dark:text-white/65">
                  <p>
                    {(data.dismissedDealsCount ?? 0) > 0
                      ? "Alle huidige weekdeals zijn verborgen."
                      : "Nog geen weekdeals gevonden. Zodra je kassabonnen zijn gesynchroniseerd zie je hier aanbiedingen."}
                  </p>
                  {(data.dismissedDealsCount ?? 0) > 0 && (
                    <button
                      type="button"
                      data-testid="restore-all-deals"
                      onClick={() => void restoreAllDeals()}
                      className="mt-2 inline-flex min-h-[38px] items-center gap-1.5 text-[14px] font-semibold text-[#007AFF] dark:text-[#64B0FF]"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {data.dismissedDealsCount} verborgen {data.dismissedDealsCount === 1 ? "deal" : "deals"} herstellen
                    </button>
                  )}
                </Card>
              ) : (
                <>
                  <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                    {data.weekDeals.map((d, i) => (
                      <div key={d.dealKey ?? `${d.provider}-${d.title}-${i}`} className="flex items-center gap-2.5 p-3">
                        <ProductThumb url={d.imageUrl} title={d.title} />
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-[16px] font-semibold leading-snug">{d.title}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <StoreBadge provider={d.provider} />
                            <PromoPill>{d.promoLabel}</PromoPill>
                            {d.priceCents !== null && <span className="text-[15px] font-bold tabular-nums">{formatEuro(d.priceCents)}</span>}
                            {d.timesBought !== undefined && d.timesBought > 0 && (
                              <span className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[12px] font-medium tabular-nums text-black/65 dark:bg-white/10 dark:text-white/65">
                                {d.timesBought}× gekocht
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => addDeal(d.title)}
                            className="min-h-[40px] shrink-0 rounded-full bg-[#007AFF]/12 px-3 text-[14px] font-semibold text-[#0062CC] dark:text-[#64B0FF]"
                          >
                            + Lijst
                          </button>
                          {d.dealKey && (
                            <button
                              type="button"
                              data-testid="dismiss-weekdeal"
                              aria-label={`${d.title} verwijderen uit weekdeals`}
                              title="Niet meer tonen in weekdeals"
                              onClick={() => void dismissDeal(d.dealKey, d.title)}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-black/45 transition-colors hover:bg-black/[0.06] hover:text-black/75 active:bg-black/10 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white/80"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </Card>
                  {(data.dismissedDealsCount ?? 0) > 0 && (
                    <div className="mt-2 px-1 text-right">
                      <button
                        type="button"
                        data-testid="restore-all-deals"
                        onClick={() => void restoreAllDeals()}
                        className="inline-flex min-h-[36px] items-center gap-1.5 text-[13px] font-semibold text-black/55 hover:text-[#007AFF] dark:text-white/55 dark:hover:text-[#64B0FF]"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {data.dismissedDealsCount} verborgen {data.dismissedDealsCount === 1 ? "deal" : "deals"} herstellen
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>

            <section>
              <h2 className="px-1 pb-2 text-[20px] font-bold tracking-tight">Geleerde voorkeuren</h2>
              {data.preferences.length === 0 ? (
                <Card className="space-y-3 p-5 text-center">
                  <p className="text-[17px] font-semibold">Nog niets geleerd</p>
                  <p className="text-[15px] text-black/65 dark:text-white/65">Synchroniseer je kassabonnen of laad demodata om te zien hoe voorkeuren werken.</p>
                  <div className="flex flex-col gap-2">
                    <button onClick={seed} disabled={seeding} className={btnPrimary}>
                      {seeding ? "Laden…" : "Laad demo-kassabonnen"}
                    </button>
                    <Link href="/winkels" className={btnSecondary}>
                      Koppel AH of Picnic
                    </Link>
                  </div>
                </Card>
              ) : (
                <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                  {data.preferences.map((p) => {
                    const cid = p.conceptId;
                    return (
                      <div key={p.storeProductId} className="p-3">
                        <div className="flex items-center gap-3">
                          <ProductThumb url={p.imageUrl} title={p.productTitle ?? p.storeProductId} />
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-[16px] font-semibold leading-snug">{p.productTitle ?? p.storeProductId}</p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[14px] text-black/70 dark:text-white/70">
                              {p.provider && <StoreBadge provider={p.provider} />}
                              {p.conceptName && <span>{p.conceptName}</span>}
                              {p.brand && <span>· {p.brand}</span>}
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full bg-black/[0.06] px-2.5 py-1 text-[14px] font-semibold tabular-nums dark:bg-white/10">
                            {p.timesBought}× gekocht
                          </span>
                        </div>
                        {cid !== null && (
                          <div className="mt-2 flex rounded-[10px] bg-black/[0.06] p-0.5 dark:bg-white/10">
                            {MODES.map(([mode, label]) => {
                              const current = modes[cid] ?? p.brandPreferenceMode ?? "auto";
                              return (
                                <button
                                  key={mode}
                                  aria-pressed={current === mode}
                                  onClick={() => setMode(cid, mode, p.brand)}
                                  className={`min-h-[40px] flex-1 rounded-[8px] px-1 text-[13px] font-semibold ${
                                    current === mode ? "bg-white shadow-sm dark:bg-[#636366]" : "text-black/60 dark:text-white/65"
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Card>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
