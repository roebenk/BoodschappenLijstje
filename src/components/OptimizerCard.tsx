"use client";

import { Check, ChevronUp, Send, ShoppingBasket, Sparkles, Store, Truck } from "lucide-react";
import { Sheet } from "./Sheet";
import { Card, btnPrimary, btnSecondary } from "./ui";
import { formatEuro } from "@/lib/format";
import type { ListResponse } from "@/lib/types";

export type StoreFilter = "all" | "ah" | "picnic";

export function BottomSummaryBar({
  list,
  hidden = false,
  onOpenSummary,
  onOpenPush,
}: {
  list: ListResponse;
  hidden?: boolean;
  onOpenSummary: () => void;
  onOpenPush: () => void;
}) {
  const { picnicAdvice: adv } = list;
  const openItems = list.items.filter((i) => !i.isChecked);
  const openCount = openItems.length;
  const ahCount = openItems.filter((i) => i.assignedProvider === "ah").length;
  const prCount = openItems.filter((i) => i.assignedProvider === "picnic").length;
  const showPicnic = prCount > 0 || adv.currentPicnicCents > 0;
  const pct = Math.min(100, Math.round((adv.currentPicnicCents / adv.minOrderCents) * 100));

  return (
    <div
      data-testid="bottom-summary-bar"
      aria-hidden={hidden || undefined}
      className={`pointer-events-none fixed inset-x-0 z-30 transition-all duration-200 ${
        hidden ? "translate-y-4 opacity-0" : "translate-y-0 opacity-100"
      }`}
      style={{ bottom: "calc(54px + env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto max-w-xl px-3 pb-2">
        <div className="pointer-events-auto flex items-center justify-between gap-2.5 rounded-2xl border border-black/[0.08] bg-white/94 py-2 pl-3.5 pr-2 shadow-[0_8px_28px_rgba(0,0,0,0.10)] backdrop-blur-2xl dark:border-white/[0.12] dark:bg-[#242426]/94 dark:shadow-[0_8px_28px_rgba(0,0,0,0.48)]">
          <button
            type="button"
            data-testid="open-summary-sheet"
            aria-label="Open kostenoverzicht en winkelverdeling"
            onClick={onOpenSummary}
            className="flex min-w-0 flex-1 flex-col justify-center text-left active:opacity-75"
          >
            <div className="flex items-center gap-2 tabular-nums">
              <span className={`inline-flex items-baseline gap-1 ${ahCount > 0 ? "" : "opacity-45"}`}>
                <span className="h-2 w-2 self-center rounded-full bg-[#00ADE6]" />
                <span className="text-[12px] font-semibold text-[#007AA3] dark:text-[#38C6F4]">AH</span>
                <span className="text-[14px] font-bold">{formatEuro(list.ahSubtotalCents)}</span>
              </span>
              <span className="text-[12px] text-black/25 dark:text-white/25">·</span>
              <span className={`inline-flex items-baseline gap-1 ${prCount > 0 ? "" : "opacity-45"}`}>
                <span className="h-2 w-2 self-center rounded-full bg-[#E1191E]" />
                <span className="text-[12px] font-semibold text-[#C81015] dark:text-[#FF5A5F]">Picnic</span>
                <span className="text-[14px] font-bold">{formatEuro(list.picnicSubtotalCents)}</span>
              </span>
              <ChevronUp className="h-3.5 w-3.5 shrink-0 text-black/40 dark:text-white/45" />
            </div>

            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-tight">
              {showPicnic && !adv.meetsMinimum ? (
                <>
                  <span className="h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-black/[0.09] dark:bg-white/15">
                    <span
                      className="block h-full rounded-full bg-[#FF9500] transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="truncate font-medium text-[#9A5700] dark:text-[#FFB340]">
                    Nog {formatEuro(adv.shortfallCents)} tot € 35 min. · Advies
                  </span>
                </>
              ) : showPicnic && adv.meetsMinimum ? (
                <>
                  <Check className="h-3 w-3 shrink-0 text-[#34C759]" strokeWidth={3} />
                  <span className="truncate font-medium text-[#1E8E3E] dark:text-[#5DDB7E]">
                    Picnic-min. gehaald
                    {list.totalSavingsCents > 0 ? ` · Bespaart ${formatEuro(list.totalSavingsCents)}` : ""}
                  </span>
                </>
              ) : list.totalSavingsCents > 0 ? (
                <span className="truncate font-medium text-[#1E8E3E] dark:text-[#5DDB7E]">
                  Bespaart {formatEuro(list.totalSavingsCents)} · Tik voor verdeling
                </span>
              ) : (
                <span className="truncate text-black/55 dark:text-white/55">
                  {openCount} {openCount === 1 ? "open item" : "open items"} · Totaal {formatEuro(list.totalCents)}
                </span>
              )}
            </div>
          </button>

          {openCount > 0 ? (
            <button
              type="button"
              data-testid="open-push-sheet"
              onClick={onOpenPush}
              className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl bg-[#007AFF] px-3.5 text-[14px] font-semibold text-white active:scale-[0.98] active:opacity-85 dark:bg-[#0A84FF]"
            >
              <Send className="h-3.5 w-3.5" /> Zet klaar
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenSummary}
              className="inline-flex min-h-[38px] shrink-0 items-center rounded-xl bg-black/[0.06] px-3 text-[13px] font-semibold text-black/75 dark:bg-white/10 dark:text-white/80"
            >
              Overzicht
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function BasketSummarySheet({
  open,
  onClose,
  list,
  filter,
  onFilter,
  busy,
  onOptimize,
  onStartShoppingMode,
  onOpenPush,
}: {
  open: boolean;
  onClose: () => void;
  list: ListResponse;
  filter: StoreFilter;
  onFilter: (f: StoreFilter) => void;
  busy: boolean;
  onOptimize: (mode: "optimal" | "all_ah") => void;
  onStartShoppingMode: (storeFilter?: StoreFilter) => void;
  onOpenPush: () => void;
}) {
  const { picnicAdvice: adv } = list;
  const openItems = list.items.filter((i) => !i.isChecked);
  const openCount = openItems.length;
  const ahCount = openItems.filter((i) => i.assignedProvider === "ah").length;
  const prCount = openItems.filter((i) => i.assignedProvider === "picnic").length;
  const pct = Math.min(100, Math.round((adv.currentPicnicCents / adv.minOrderCents) * 100));
  const showPicnic = prCount > 0 || adv.currentPicnicCents > 0;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Winkelverdeling & kosten"
      description={`Totaal ${formatEuro(list.totalCents)} over ${openCount} open ${openCount === 1 ? "item" : "items"}`}
    >
      <div data-testid="optimizer-card" className="space-y-3.5">
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => {
              onFilter(filter === "ah" ? "all" : "ah");
              onClose();
            }}
            className={`rounded-2xl bg-[#00ADE6]/10 p-3.5 text-left transition-all active:scale-[0.99] dark:bg-[#00ADE6]/15 ${
              filter === "ah" ? "ring-2 ring-[#00ADE6]" : ""
            }`}
          >
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#007AA3] dark:text-[#38C6F4]">
              <Store className="h-3.5 w-3.5" /> Albert Heijn · Winkel
            </p>
            <p className="mt-1 text-[22px] font-bold leading-tight tabular-nums">{formatEuro(list.ahSubtotalCents)}</p>
            <p className="mt-0.5 text-[13px] text-black/60 dark:text-white/65">
              {ahCount} {ahCount === 1 ? "item" : "items"} · Tik om te filteren
            </p>
          </button>

          <button
            type="button"
            onClick={() => {
              onFilter(filter === "picnic" ? "all" : "picnic");
              onClose();
            }}
            className={`rounded-2xl bg-[#E1191E]/10 p-3.5 text-left transition-all active:scale-[0.99] dark:bg-[#E1191E]/15 ${
              filter === "picnic" ? "ring-2 ring-[#E1191E]" : ""
            }`}
          >
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#C81015] dark:text-[#FF5A5F]">
              <Truck className="h-3.5 w-3.5" /> Picnic · Bezorging
            </p>
            <p className="mt-1 text-[22px] font-bold leading-tight tabular-nums">
              {formatEuro(list.picnicSubtotalCents)}
            </p>
            <p className="mt-0.5 text-[13px] text-black/60 dark:text-white/65">
              {prCount} {prCount === 1 ? "item" : "items"} · Tik om te filteren
            </p>
          </button>
        </div>

        {list.totalSavingsCents > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-[#34C759]/14 px-3.5 py-2.5 text-[14px] font-semibold text-[#1E8E3E] dark:text-[#5DDB7E]">
            <Sparkles className="h-4 w-4 shrink-0" />
            <span>Je bespaart {formatEuro(list.totalSavingsCents)} met aanbiedingen &amp; slimme verdeling</span>
          </div>
        )}

        {showPicnic && (
          <Card className="p-3.5">
            <div className="flex items-center justify-between text-[13.5px] font-semibold tabular-nums">
              <span>Picnic bezorgminimum</span>
              <span className="flex items-center gap-1">
                {adv.meetsMinimum && <Check className="h-4 w-4 text-[#34C759]" strokeWidth={3} />}
                {formatEuro(adv.currentPicnicCents)} / {formatEuro(adv.minOrderCents)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/15">
              <div
                className={`h-full rounded-full transition-all ${adv.meetsMinimum ? "bg-[#34C759]" : "bg-[#FF9500]"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {!adv.meetsMinimum && (
              <div className="mt-2.5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[13.5px] leading-snug text-[#8A4B00] dark:text-[#FFB340]">{adv.message}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onOptimize("all_ah")}
                  className="inline-flex min-h-[38px] shrink-0 items-center justify-center rounded-xl bg-[#FF9500]/18 px-3.5 text-[14px] font-semibold text-[#8A4B00] active:opacity-75 disabled:opacity-50 dark:bg-[#FF9F0A]/25 dark:text-[#FFB340]"
                >
                  Zet alles op AH
                </button>
              </div>
            )}
          </Card>
        )}

        <Card className="p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold">Slim verdelen</p>
              <p className="text-[12.5px] leading-snug text-black/60 dark:text-white/60">
                Zet niet-vergrendelde items op hun voordeligste winkel.
              </p>
            </div>
            <button
              type="button"
              data-testid="optimize-btn"
              disabled={busy}
              onClick={() => onOptimize("optimal")}
              className={`${btnSecondary} !min-h-[38px] shrink-0 !px-3.5 !text-[14px]`}
            >
              Optimaliseer
            </button>
          </div>
        </Card>

        {openCount > 0 && (
          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => {
                onClose();
                onStartShoppingMode(ahCount > 0 ? "ah" : "all");
              }}
              className={`${btnSecondary} w-full !text-[14px]`}
            >
              <ShoppingBasket className="h-4 w-4" />
              {ahCount > 0 ? `AH Winkelmodus (${ahCount})` : "Winkelmodus"}
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenPush();
              }}
              className={`${btnPrimary} w-full !text-[14px]`}
            >
              <Send className="h-4 w-4" /> Zet klaar
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
