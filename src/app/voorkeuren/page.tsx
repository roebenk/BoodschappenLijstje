"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader, Card, ProductThumb, StoreBadge, btnPrimary, btnSecondary } from "@/components/ui";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
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
      <PageHeader title="Voorkeuren" connected={connected} />
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
