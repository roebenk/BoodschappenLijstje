"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { Card, PageHeader, StoreBadge, SyncPill, btnPrimary, btnSecondary, inputCls } from "@/components/ui";
import { api } from "@/hooks/api";
import { useHouseholdSync } from "@/hooks/useHouseholdSync";
import { formatDate } from "@/lib/format";
import type {
  AuthFlowInput,
  DemoSeedResponse,
  HealthResponse,
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
  const [health, setHealth] = useState<HealthResponse | null>(null);
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
      const [s, h] = await Promise.all([api<StoresResponse>("/api/stores"), api<HealthResponse>("/api/health")]);
      setStores(s.stores);
      setHealth(h);
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
      <PageHeader title="Winkels" right={<SyncPill connected={connected} />} />
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
            <div className="flex flex-col gap-2">
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
            <div className="flex flex-col gap-2">
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

        <Card className="space-y-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[17px] font-semibold">Slimme AI Matcher</p>
            {health?.openRouter.configured ? <Pill tone="green">Actief</Pill> : <Pill tone="amber">Sleutel nog niet ingesteld (tekst-filter actief)</Pill>}
          </div>
          {health?.openRouter.configured ? (
            <p className="text-[14px] text-black/70 dark:text-white/70">
              Model: <span className="font-medium">{health.openRouter.defaultModel}</span> · ~€0,05/mnd + SQLite cache
            </p>
          ) : (
            <p className="text-[14px] text-black/70 dark:text-white/70">
              Zet <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">OPENROUTER_API_KEY</code> in je <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">.env</code>. Die wordt live opgepikt, zonder herstart.
            </p>
          )}
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

        <Card className="space-y-2 p-4">
          <p className="text-[17px] font-semibold">Test- &amp; demodata</p>
          <p className="text-[14px] text-black/70 dark:text-white/70">Laad voorbeeld-kassabonnen om geleerde voorkeuren en loyaliteit meteen te zien.</p>
          <button
            data-testid="seed-demo-btn"
            disabled={!!busy}
            onClick={() =>
              run("seed", () => api<DemoSeedResponse>("/api/stores/demo-seed", { method: "POST" }), (r) =>
                toast.success(`${r.historyEntries} regels, ${r.products} producten, ${r.preferences} voorkeuren geladen`),
              )
            }
            className={btnSecondary}
          >
            {busy === "seed" ? "Laden…" : "Laad voorbeeld-kassabonnen"}
          </button>
        </Card>
      </div>

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
