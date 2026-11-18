"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Sheet } from "./Sheet";
import { Card, StoreBadge, btnPrimary, btnSecondary } from "./ui";
import { api } from "@/hooks/api";
import { formatEuro } from "@/lib/format";
import type {
  ActiveShoppingProviderId,
  PushListResponse,
  StoresResponse,
  StoreAuthState,
} from "@/lib/types";

const MIN_PICNIC_CENTS = 3500;

export function PushToStoresSheet({
  open,
  onClose,
  onPushed,
}: {
  open: boolean;
  onClose: () => void;
  onPushed?: () => void;
}) {
  const [preview, setPreview] = useState<PushListResponse | null>(null);
  const [auth, setAuth] = useState<Record<string, StoreAuthState>>({});
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState<string | null>(null);
  const [autoCheckPushed, setAutoCheckPushed] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([
        api<PushListResponse>("/api/list/push", { method: "POST", body: { mode: "preview" } }),
        api<StoresResponse>("/api/stores"),
      ]);
      setPreview(p);
      setAuth(Object.fromEntries(s.stores.map((x) => [x.provider, x.auth])));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Voorbeeld laden mislukt");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else setPreview(null);
  }, [open, load]);

  const push = async (providers: ActiveShoppingProviderId[]) => {
    setPushing(providers.join("+"));
    try {
      const res = await api<PushListResponse>("/api/list/push", {
        method: "POST",
        body: { mode: "push", providers, autoCheckPushed },
      });
      let anySucceeded = false;
      for (const r of res.results ?? []) {
        const name = r.provider === "ah" ? "Albert Heijn" : "Picnic";
        if (r.success) {
          anySucceeded = true;
          toast.success(
            `${name}: ${r.itemsPushed} items klaargezet${autoCheckPushed ? " en afgevinkt" : ""}`,
          );
        } else {
          toast.error(`${name}: ${r.message ?? "Klaarzetten mislukt"}`);
        }
      }
      if (anySucceeded) {
        onPushed?.();
        await load();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Klaarzetten mislukt");
    } finally {
      setPushing(null);
    }
  };

  const providers = ["ah", "picnic"] as const;
  const readyProviders = providers.filter((p) => {
    const pv = preview?.previews.find((x) => x.provider === p);
    return pv && pv.items.length > 0 && auth[p]?.status === "authenticated";
  });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Zet klaar in de apps" description="Stuur je lijstje naar het officiële AH- of Picnic-account">
      {loading && !preview && <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Voorbeeld maken…</p>}
      {preview && (
        <div className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-black/[0.04] p-3.5 dark:bg-white/[0.06]">
            <input
              type="checkbox"
              data-testid="auto-check-pushed"
              checked={autoCheckPushed}
              onChange={(e) => setAutoCheckPushed(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 rounded accent-[#007AFF]"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold leading-snug">
                Vink klaargezette items automatisch af
              </span>
              <span className="mt-0.5 block text-[13px] leading-snug text-black/60 dark:text-white/60">
                Haalt ze direct van je open lijstje. Vink uit als je deze items open op het lijstje wilt behouden.
              </span>
            </span>
          </label>

          {providers.map((p) => {
            const pv = preview.previews.find((x) => x.provider === p);
            const state = auth[p];
            const loggedIn = state?.status === "authenticated";
            const items = pv?.items ?? [];
            const belowMin = p === "picnic" && items.length > 0 && (pv?.subtotalCents ?? 0) < MIN_PICNIC_CENTS;
            return (
              <Card key={p}>
                <div className="flex items-center justify-between px-4 pt-3">
                  <StoreBadge provider={p} label={p === "ah" ? "AH Boodschappenlijst" : "Picnic Winkelmandje"} />
                  <span className="text-[16px] font-bold tabular-nums">{formatEuro(pv?.subtotalCents ?? 0)}</span>
                </div>
                {items.length === 0 ? (
                  <p className="px-4 py-3 text-[15px] text-black/60 dark:text-white/60">Niets voor deze winkel.</p>
                ) : (
                  <ul className="px-4 py-2">
                    {items.map((i) => (
                      <li key={i.itemId} className="flex gap-3 py-1 text-[15px]">
                        <span className="w-8 shrink-0 font-semibold tabular-nums">{i.quantity}×</span>
                        <span className="min-w-0 flex-1">{i.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {!loggedIn && items.length > 0 && (
                  <div className="mx-4 mb-3 flex items-start gap-2 rounded-xl bg-[#FF9500]/15 p-3 text-[14px] text-[#8A4B00] dark:text-[#FFB340]">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Nog niet ingelogd.{" "}
                      <Link href="/winkels" onClick={onClose} className="font-semibold underline">
                        Koppel {p === "ah" ? "Albert Heijn" : "Picnic"} bij Winkels
                      </Link>
                    </span>
                  </div>
                )}
                {belowMin && (
                  <div className="mx-4 mb-3 flex items-start gap-2 rounded-xl bg-[#FF9500]/15 p-3 text-[14px] text-[#8A4B00] dark:text-[#FFB340]">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Onder het Picnic-minimum van € 35,00 — bezorging is pas mogelijk vanaf dat bedrag.</span>
                  </div>
                )}
                {loggedIn && items.length > 0 && (
                  <div className="px-4 pb-3">
                    <button disabled={!!pushing} onClick={() => push([p])} className={`${btnSecondary} w-full`}>
                      {pushing === p ? "Bezig…" : `Zet klaar bij ${p === "ah" ? "AH" : "Picnic"}`}
                    </button>
                  </div>
                )}
              </Card>
            );
          })}
          {readyProviders.length > 1 && (
            <button disabled={!!pushing} onClick={() => push([...readyProviders])} className={`${btnPrimary} w-full`}>
              <CheckCircle2 className="h-5 w-5" /> Zet bij beide klaar
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
