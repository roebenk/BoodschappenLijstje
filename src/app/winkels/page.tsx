"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronRight, ExternalLink } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { Card, PageHeader, StoreBadge, btnPrimary, btnSecondary, inputCls } from "@/components/ui";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
import { formatDate } from "@/lib/format";
import { AI_MODELS, estimatedMonthlyCost } from "@/lib/llm/models";
import type {
  AppSettings,
  AuthFlowInput,
  PreferencesResponse,
  StoreAuthResponse,
  StoreInfo,
  StoreProviderId,
  StoreSyncResponse,
  StoresResponse,
} from "@/lib/types";

function Pill({ tone, children }: { tone: "green" | "amber" | "gray" | "red"; children: React.ReactNode }) {
  const cls = {
    green: "bg-[#34C759]/15 text-[#1E8E3E] dark:text-[#5DDB7E]",
    amber: "bg-[#FF9500]/15 text-[#B25E00] dark:text-[#FFB340]",
    gray: "bg-black/[0.06] text-black/70 dark:bg-white/10 dark:text-white/70",
    red: "bg-[#FF3B30]/12 text-[#D70015] dark:text-[#FF6961]",
  }[tone];
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[13px] font-semibold ${cls}`}>{children}</span>;
}

export default function WinkelsPage() {
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [aiOpen, setAiOpen] = useState(false);
  const [savingAiModel, setSavingAiModel] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [ahOpen, setAhOpen] = useState(false);
  const [ahUrl, setAhUrl] = useState<string | null>(null);
  const [ahCode, setAhCode] = useState("");

  const [pnOpen, setPnOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);

  const [radarOpen, setRadarOpen] = useState<StoreProviderId | null>(null);
  const [radarSource, setRadarSource] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api<StoresResponse>("/api/stores"), api<PreferencesResponse>("/api/preferences")]);
      setStores(s.stores);
      setSettings(p.settings);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Laden mislukt");
    } finally {
      setLoaded(true);
    }
  }, []);

  const { connected } = useHouseholdSync(load);
  useEffect(() => {
    void load();
  }, [load]);

  const get = (p: StoreProviderId) => stores.find((s) => s.provider === p);
  const ah = get("ah");
  const picnic = get("picnic");
  const pnAwaiting = needs2fa || picnic?.auth.status === "awaiting_2fa";

  const run = async <T,>(key: string, fn: () => Promise<T>, onOk?: (r: T) => void) => {
    setBusy(key);
    try {
      const r = await fn();
      onOk?.(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Er ging iets mis");
    } finally {
      setBusy(null);
    }
  };

  const auth = (p: StoreProviderId, body: AuthFlowInput) =>
    api<StoreAuthResponse>(`/api/stores/${p}/auth`, { method: "POST", body });

  const startAh = () => {
    setAhOpen(true);
    if (!ahUrl) {
      void run("ah-url", () => auth("ah", { step: "get_login_url" }), (r) => setAhUrl(r.loginUrl ?? null));
    }
  };

  const sync = (p: "ah" | "picnic") =>
    run(`${p}-sync`, () => api<StoreSyncResponse>(`/api/stores/${p}/sync`, { method: "POST" }), (r) => {
      toast.success(`${r.receiptsOrOrdersSynced} ${p === "ah" ? "kassabonnen" : "bezorgingen"} gesynchroniseerd · ${r.productsMapped} producten gekoppeld`);
      void load();
    });

  const logout = (p: StoreProviderId) =>
    run(`${p}-logout`, () => auth(p, { step: "logout" }), () => {
      toast.success("Ontkoppeld");
      void load();
    });

  const changeAiModel = async (key: "aiModel" | "aiFallbackModel", model: string) => {
    if (!settings || model === settings[key] || savingAiModel) return;
    const previous = settings[key];
    setSettings((current) => current ? { ...current, [key]: model } : current);
    setSavingAiModel(true);
    try {
      await api("/api/preferences", { method: "PATCH", body: { [key]: model } });
      toast.success(key === "aiModel" ? "AI-model bijgewerkt" : "Reservemodel bijgewerkt");
    } catch (e) {
      setSettings((current) => current ? { ...current, [key]: previous } : current);
      toast.error(e instanceof Error ? e.message : "Opslaan mislukt");
    } finally {
      setSavingAiModel(false);
    }
  };

  const ahStatus = () => {
    const s = ah?.auth.status;
    if (s === "authenticated") return <Pill tone="green">Gekoppeld</Pill>;
    if (s === "error" || s === "disconnected") return <Pill tone="red">Sessie verlopen</Pill>;
    return <Pill tone="amber">Anoniem actief (live prijzen &amp; Bonus)</Pill>;
  };

  const pnStatus = () => {
    const s = picnic?.auth.status;
    if (s === "authenticated") return <Pill tone="green">Gekoppeld</Pill>;
    if (s === "awaiting_2fa") return <Pill tone="amber">Wacht op SMS-code</Pill>;
    return <Pill tone="gray">Voorbeeldcatalogus (niet gekoppeld)</Pill>;
  };

  return (
    <main className="mx-auto max-w-xl overflow-x-clip pb-safe">
      <PageHeader title="Winkels" connected={connected} />
      <div className="space-y-4 px-4 pt-2">
        {!loaded && <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Laden…</p>}

        <Card className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <StoreBadge provider="ah" label="Albert Heijn" />
              <p className="mt-1 text-[14px] text-black/65 dark:text-white/65">Winkel + kassabonnen</p>
            </div>
            {ahStatus()}
          </div>
          <p className="text-[14px] text-black/65 dark:text-white/65">Laatste sync: {formatDate(ah?.auth.lastSyncedAt)}</p>
          {ah?.auth.status === "authenticated" ? (
            <div className="grid grid-cols-2 gap-2">
              <button disabled={!!busy} onClick={() => sync("ah")} className={btnPrimary}>
                {busy === "ah-sync" ? "Synchroniseren…" : "Synchroniseer kassabonnen"}
              </button>
              <button disabled={!!busy} onClick={() => logout("ah")} className={`${btnSecondary} !text-[#FF3B30]`}>
                Ontkoppel
              </button>
            </div>
          ) : (
            <button data-testid="connect-ah-btn" onClick={startAh} className={btnPrimary}>
              Koppel Albert Heijn
            </button>
          )}
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <StoreBadge provider="picnic" label="Picnic" />
              <p className="mt-1 text-[14px] text-black/65 dark:text-white/65">Thuisbezorging · minimum € 35,00</p>
            </div>
            {pnStatus()}
          </div>
          <p className="text-[14px] text-black/65 dark:text-white/65">Laatste sync: {formatDate(picnic?.auth.lastSyncedAt)}</p>
          {picnic?.auth.status === "authenticated" ? (
            <div className="grid grid-cols-2 gap-2">
              <button disabled={!!busy} onClick={() => sync("picnic")} className={btnPrimary}>
                {busy === "picnic-sync" ? "Synchroniseren…" : "Synchroniseer bezorgingen"}
              </button>
              <button disabled={!!busy} onClick={() => logout("picnic")} className={`${btnSecondary} !text-[#FF3B30]`}>
                Ontkoppel
              </button>
            </div>
          ) : (
            <button data-testid="connect-picnic-btn" onClick={() => setPnOpen(true)} className={btnPrimary}>
              Koppel Picnic
            </button>
          )}
        </Card>

        <Card>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={aiOpen}
            disabled={!settings}
            onClick={() => setAiOpen(true)}
            className="w-full space-y-2 p-4 text-left active:bg-black/[0.04] dark:active:bg-white/[0.06]"
          >
            <span className="flex items-start justify-between gap-2">
              <span className="text-[17px] font-semibold">Slimme AI Matcher</span>
              {settings?.aiConfigured ? <Pill tone="green">Actief</Pill> : <Pill tone="amber">Sleutel nog niet ingesteld (tekst-filter actief)</Pill>}
            </span>
            <span className="flex items-center justify-between gap-2 text-[14px] text-black/70 dark:text-white/70">
              <span className="min-w-0 break-words">
                {settings ? <>Model: <span className="font-medium">{settings.aiModel}</span> · SQLite cache</> : "Laden…"}
              </span>
              <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-black/35 dark:text-white/35" />
            </span>
          </button>
        </Card>

        <Card className="space-y-3 p-4">
          <p className="text-[17px] font-semibold">Deal-Radar uitbreidingen</p>
          <p className="text-[14px] text-black/70 dark:text-white/70">
            Jumbo en Plus werken als prijs- en actieradar: ze verschijnen als tip bij je items. Power users kunnen een Checkjebon JSON-URL of -pad koppelen.
          </p>
          {(["jumbo", "plus"] as const).map((p) => {
            const info = get(p);
            return (
              <div key={p} className="flex items-center justify-between gap-2 rounded-xl bg-black/[0.04] p-3 dark:bg-white/[0.06]">
                <div>
                  <StoreBadge provider={p} />
                  <p className="mt-1 text-[13px] text-black/65 dark:text-white/65">
                    {info?.auth.status === "authenticated" ? "Bron gekoppeld" : "Radar zonder eigen bron"}
                  </p>
                </div>
                <button onClick={() => { setRadarSource(""); setRadarOpen(p); }} className={btnSecondary}>
                  Bron koppelen
                </button>
              </div>
            );
          })}
        </Card>
      </div>

      <Sheet open={aiOpen} onOpenChange={setAiOpen} title="Slimme AI Matcher" description="Kies je AI-model">
        <Card className="p-4">
          <p className="text-[14px] leading-snug text-black/65 dark:text-white/65">
            Voor zoektermen, productvergelijkingen en het indelen van kassabonnen. Bestaande resultaten blijven in de cache.
          </p>
          {!settings?.aiConfigured && (
            <p className="mt-2 text-[14px] text-black/65 dark:text-white/65">
              Zet <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">OPENROUTER_API_KEY</code> in je <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">.env</code>. Die wordt live opgepikt, zonder herstart.
            </p>
          )}
          {settings?.aiModel && !AI_MODELS.some((model) => model.id === settings.aiModel) && (
            <p className="mt-2 text-[14px] text-black/65 dark:text-white/65">
              Huidig model uit configuratie: {settings.aiModel}
            </p>
          )}
          <div role="radiogroup" aria-label="AI-model" className="mt-3 space-y-2">
            {AI_MODELS.map((model) => {
              const active = settings?.aiModel === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!settings || savingAiModel}
                  onClick={() => void changeAiModel("aiModel", model.id)}
                  className={`flex min-h-[56px] w-full items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left ${
                    active ? "border-[#007AFF] bg-[#007AFF]/10" : "border-black/10 dark:border-white/15"
                  }`}
                >
                  <span className="min-w-0">
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
          <fieldset
            disabled={!settings || savingAiModel}
            aria-describedby="ai-fallback-description"
            className="mt-4 min-w-0"
          >
            <legend className="text-[15px] font-semibold">Reservemodel bij fouten</legend>
            <div className="mt-2 overflow-hidden rounded-[10px] border border-[var(--cp-border)] bg-[var(--cp-surface)]">
              {[
                { id: "", name: "Geen reservemodel" },
                ...(settings?.aiFallbackModel && !AI_MODELS.some((model) => model.id === settings.aiFallbackModel)
                  ? [{ id: settings.aiFallbackModel, name: `${settings.aiFallbackModel} (configuratie)` }]
                  : []),
                ...AI_MODELS,
              ].map((model) => (
                <label
                  key={model.id}
                  className="relative flex min-h-[48px] cursor-pointer items-center gap-3 border-b border-[var(--cp-border)] px-3 last:border-b-0 active:bg-[var(--cp-surface-soft)] has-[:disabled]:cursor-default has-[:disabled]:opacity-50"
                >
                  <input
                    type="radio"
                    name="ai-fallback-model"
                    value={model.id}
                    checked={(settings?.aiFallbackModel ?? "") === model.id}
                    onChange={() => void changeAiModel("aiFallbackModel", model.id)}
                    className="peer sr-only"
                  />
                  <span className="pointer-events-none absolute inset-0 peer-focus-visible:rounded-[4px] peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-[var(--cp-accent)]" />
                  <span className="min-w-0 flex-1 break-words py-3 text-[16px] text-[var(--cp-text)]">{model.name}</span>
                  <Check
                    aria-hidden="true"
                    className="h-5 w-5 shrink-0 text-[var(--cp-accent)] opacity-0 peer-checked:opacity-100"
                    strokeWidth={2.5}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <p id="ai-fallback-description" className="mt-2 text-[12px] leading-snug text-black/60 dark:text-white/60">
            Wordt alleen gebruikt als het hoofdmodel faalt. Kies een ander model dan het hoofdmodel voor een extra poging.
          </p>
        </Card>
        <button type="button" onClick={() => setAiOpen(false)} className={`${btnSecondary} mt-3 w-full`}>
          Gereed
        </button>
      </Sheet>

      <Sheet open={ahOpen} onOpenChange={setAhOpen} title="Koppel Albert Heijn" description="Inloggen in 2 stappen">
        <div className="space-y-4">
          <a
            href={ahUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!ahUrl}
            className={`${btnPrimary} w-full ${ahUrl ? "" : "pointer-events-none opacity-50"}`}
          >
            <ExternalLink className="h-5 w-5" /> Stap 1: Open AH Inlogpagina
          </a>
          <p className="text-[15px] leading-snug text-black/75 dark:text-white/75">
            Na het inloggen probeert je browser <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">appie://login-exit?code=...</code> te openen. Kopieer dat adres (of de code) uit de adresbalk en plak hem hieronder:
          </p>
          <input
            data-testid="ah-code-input"
            value={ahCode}
            onChange={(e) => setAhCode(e.target.value)}
            placeholder="appie://login-exit?code=…"
            autoCapitalize="off"
            autoCorrect="off"
            className={inputCls}
          />
          <button
            disabled={!ahCode.trim() || !!busy}
            onClick={() =>
              run("ah-code", () => auth("ah", { step: "exchange_code", codeOrUrl: ahCode.trim() }), () => {
                toast.success("Albert Heijn gekoppeld");
                setAhCode("");
                setAhOpen(false);
                void load();
              })
            }
            className={`${btnPrimary} w-full`}
          >
            {busy === "ah-code" ? "Koppelen…" : "Koppel account"}
          </button>
        </div>
      </Sheet>

      <Sheet open={pnOpen} onOpenChange={setPnOpen} title="Koppel Picnic" description={pnAwaiting ? "Vul de SMS-code in" : "Log in met je Picnic-account"}>
        {!pnAwaiting ? (
          <div className="space-y-3">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mailadres" autoComplete="email" autoCapitalize="off" className={inputCls} />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Wachtwoord" autoComplete="current-password" className={inputCls} />
            <button
              disabled={!email || !password || !!busy}
              onClick={() =>
                run("pn-login", () => auth("picnic", { step: "login", email, password }), (r) => {
                  setPassword("");
                  if (r.requires2fa || r.state.status === "awaiting_2fa") setNeeds2fa(true);
                  else {
                    toast.success("Picnic gekoppeld");
                    setPnOpen(false);
                  }
                  void load();
                })
              }
              className={`${btnPrimary} w-full`}
            >
              {busy === "pn-login" ? "Inloggen…" : "Inloggen"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[15px] text-black/75 dark:text-white/75">Picnic heeft je een SMS met een 6-cijferige code gestuurd.</p>
            <input
              data-testid="picnic-2fa-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              className={`${inputCls} text-center tracking-[0.4em]`}
            />
            <button
              disabled={smsCode.length < 6 || !!busy}
              onClick={() =>
                run("pn-2fa", () => auth("picnic", { step: "verify_2fa", code: smsCode }), () => {
                  toast.success("Picnic gekoppeld");
                  setSmsCode("");
                  setNeeds2fa(false);
                  setPnOpen(false);
                  void load();
                })
              }
              className={`${btnPrimary} w-full`}
            >
              {busy === "pn-2fa" ? "Verifiëren…" : "Verifieer SMS-code"}
            </button>
          </div>
        )}
      </Sheet>

      <Sheet
        open={radarOpen !== null}
        onOpenChange={(o) => !o && setRadarOpen(null)}
        title={`${radarOpen === "plus" ? "Plus" : "Jumbo"}-radar bron`}
        description="Checkjebon JSON-URL of bestandspad"
      >
        <div className="space-y-3">
          <input value={radarSource} onChange={(e) => setRadarSource(e.target.value)} placeholder="https://… of C:\pad\naar\bestand.json" autoCapitalize="off" className={inputCls} />
          <button
            disabled={!radarSource.trim() || !!busy}
            onClick={() =>
              radarOpen &&
              run("radar", () => auth(radarOpen, { step: "exchange_code", codeOrUrl: radarSource.trim() }), () => {
                toast.success("Radar-bron gekoppeld");
                setRadarOpen(null);
                void load();
              })
            }
            className={`${btnPrimary} w-full`}
          >
            Koppel bron
          </button>
          {radarOpen && get(radarOpen)?.auth.status === "authenticated" && (
            <button
              disabled={!!busy}
              onClick={() => run("radar-out", () => auth(radarOpen, { step: "logout" }), () => { setRadarOpen(null); void load(); })}
              className={`${btnSecondary} w-full !text-[#FF3B30]`}
            >
              Ontkoppel
            </button>
          )}
        </div>
      </Sheet>
    </main>
  );
}
