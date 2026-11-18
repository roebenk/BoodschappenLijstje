"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Lock, LockOpen, Minus, Plus, Sparkles, Star, Trash2 } from "lucide-react";
import { Sheet } from "./Sheet";
import { Card, ProductThumb, PromoPill, StoreBadge, btnSecondary } from "./ui";
import { api } from "@/hooks/api";
import { formatAmount, formatEuro, isTieredPromo, promoBadge } from "@/lib/format";
import type {
  ActiveShoppingProviderId,
  ItemComparisonResult,
  NormalizedStoreProduct,
  PricedCandidate,
  ShoppingListItem,
  StoreEvaluation,
  UpdateListItemRequest,
} from "@/lib/types";

type Details = ItemComparisonResult & { item: ShoppingListItem };

function candidateDisplayName(product: NormalizedStoreProduct): string {
  if (product.brand && !product.title.toLowerCase().startsWith(product.brand.toLowerCase())) {
    return `${product.brand} ${product.title}`;
  }
  return product.title;
}

export function ItemComparisonSheet({
  itemId,
  initialItem = null,
  onClose,
  onChanged,
  onPatch,
  patchPending,
}: {
  itemId: number | null;
  initialItem?: ShoppingListItem | null;
  onClose: () => void;
  onChanged: () => void;
  onPatch: (id: number, patch: UpdateListItemRequest) => Promise<boolean>;
  patchPending: boolean;
}) {
  const [data, setData] = useState<Details | null>(null);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const busy = removing || patchPending;
  const [tab, setTab] = useState<ActiveShoppingProviderId>("ah");
  const [showOther, setShowOther] = useState(false);
  const initializedForId = useRef<number | null>(null);
  const detailReadVersion = useRef(0);

  const load = useCallback(async (id: number) => {
    const version = ++detailReadVersion.current;
    setLoading(true);
    try {
      const next = await api<Details>(`/api/list/${id}`);
      if (version !== detailReadVersion.current) return;
      setData(next);
      if (initializedForId.current !== id) {
        initializedForId.current = id;
        setTab(next.item.assignedProvider ?? next.recommendedProvider ?? "ah");
        setShowOther(false);
      }
    } catch (e) {
      if (version === detailReadVersion.current) toast.error(e instanceof Error ? e.message : "Laden mislukt");
    } finally {
      if (version === detailReadVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (itemId === null) {
      setData(null);
      initializedForId.current = null;
      setShowOther(false);
      return;
    }
    void load(itemId);
    return () => { ++detailReadVersion.current; };
  }, [itemId, load]);

  const patch = async (body: UpdateListItemRequest, message?: string) => {
    if (itemId === null || busy) return;
    const version = detailReadVersion.current;
    if (!(await onPatch(itemId, body))) return;
    if (message) toast.success(message);
    if (version === detailReadVersion.current && body.isProviderLocked === undefined) {
      void load(itemId);
    }
  };

  const remove = async () => {
    if (itemId === null) return;
    setRemoving(true);
    try {
      await api(`/api/list/${itemId}`, { method: "DELETE" });
      toast.success("Verwijderd van je lijstje");
      onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verwijderen mislukt");
    } finally {
      setRemoving(false);
    }
  };

  const item = initialItem ?? (data?.item.id === itemId ? data.item : null);
  const parsed = data?.parsed;
  const target = parsed?.totalTargetAmount ? formatAmount(parsed.totalTargetAmount, parsed.baseUnit) : null;
  const evalFor = (p: ActiveShoppingProviderId): StoreEvaluation | undefined => (data ? data[p] : undefined);
  const selectedId = (p: ActiveShoppingProviderId) => (p === "ah" ? item?.ahProductId : item?.picnicProductId);
  const candidateCount = (p: ActiveShoppingProviderId) => {
    const ev = evalFor(p);
    if (!ev) return 0;
    return (ev.winner ? 1 : 0) + ev.alternatives.length;
  };
  const challengers = data
    ? (["ah", "picnic"] as const).flatMap((p) => {
        const c = data[p].houseBrandChallenger;
        return c ? [{ provider: p, cand: c }] : [];
      })
    : [];
  const activeQty = item
    ? Math.max(1, (item.assignedProvider === "picnic" ? item.picnicQty : item.ahQty) || item.requestedQty || 1)
    : 1;

  const renderCandidateRow = (c: PricedCandidate, isRecommended: boolean) => {
    const selectedForStore = selectedId(tab) === c.product.id;
    const isActiveChoice = selectedForStore && item?.assignedProvider === tab;
    const promo = promoBadge(c.product);
    const sizeText = c.product.unitSizeRaw || formatAmount(c.product.baseAmount, c.product.baseUnit);

    return (
      <div
        key={c.product.id}
        className={`flex items-start gap-3 p-3 transition-colors ${
          isActiveChoice
            ? "bg-[#34C759]/[0.07] dark:bg-[#34C759]/[0.12]"
            : isRecommended
              ? "bg-[#007AFF]/[0.04] dark:bg-[#0A84FF]/[0.08]"
              : ""
        }`}
      >
        <ProductThumb url={c.product.imageUrl} title={c.product.title} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {isRecommended && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#007AFF]/14 px-2 py-0.5 text-[12px] font-bold text-[#0062CC] dark:bg-[#0A84FF]/25 dark:text-[#64B0FF]">
                <Star className="h-3 w-3 fill-current" /> Aanbevolen voorkeur
              </span>
            )}
            {c.matchKind === "alternative" && (
              <span className="inline-flex items-center rounded-full bg-[#AF52DE]/12 px-2 py-0.5 text-[12px] font-semibold text-[#8944AB] dark:bg-[#BF5AF2]/20 dark:text-[#D58AFF]">
                Vergelijkbaar alternatief
              </span>
            )}
            {selectedForStore && !isActiveChoice && (
              <span className="inline-flex items-center rounded-full bg-black/[0.06] px-2 py-0.5 text-[12px] font-semibold text-black/70 dark:bg-white/10 dark:text-white/70">
                Geselecteerd voor {tab === "ah" ? "AH" : "Picnic"}
              </span>
            )}
            {promo &&
              (isTieredPromo(c.product) ? (
                <span className="text-[11.5px] text-black/40 dark:text-white/40">{promo}</span>
              ) : (
                <PromoPill>{promo}</PromoPill>
              ))}
            {(c.timesBought > 0 || c.product.previouslyBought) && (
              <span className="rounded-full bg-[#34C759]/15 px-2 py-0.5 text-[12px] font-semibold text-[#1E8E3E] dark:text-[#5DDB7E]">
                {c.timesBought > 0 ? `${c.timesBought}× gekocht` : "Eerder gekocht"}
              </span>
            )}
          </div>

          <p className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug">
            {candidateDisplayName(c.product)}
          </p>

          <p className="mt-0.5 text-[13px] text-black/65 dark:text-white/65">
            {c.packsNeeded > 1 ? `${c.packsNeeded}× ${sizeText}` : sizeText}
            {c.product.isHouseBrand ? " · Huismerk" : c.product.brand ? ` · ${c.product.brand}` : ""}
          </p>

          <p className="mt-0.5 text-[14px] font-medium tabular-nums">
            {formatEuro(Math.round(c.effectiveUnitPriceEuros * 100))}/{c.displayUnit} ·{" "}
            <span className="font-bold">{formatEuro(c.effectiveTotalCents)}</span>
            {c.savingsCents > 0 && (
              <span className="ml-1.5 text-[13px] font-normal text-black/45 line-through dark:text-white/45">
                {formatEuro(c.regularTotalCents)}
              </span>
            )}
          </p>

          {isRecommended && c.rankReason && (
            <p className="mt-0.5 text-[12px] leading-snug text-black/55 dark:text-white/55">
              Waarom voorkeur: {c.rankReason}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end justify-center self-center">
          {isActiveChoice ? (
            <span className="inline-flex min-h-[38px] items-center gap-1 rounded-full bg-[#34C759]/15 px-3 text-[14px] font-semibold text-[#1E8E3E] dark:text-[#5DDB7E]">
              <Check className="h-4 w-4" strokeWidth={2.8} /> Gekozen
            </span>
          ) : (
            <button
              disabled={busy}
              onClick={() => patch({ chosenProduct: { provider: tab, productId: c.product.id } }, "Voorkeur bijgewerkt!")}
              className="min-h-[44px] shrink-0 rounded-full bg-[#007AFF] px-3.5 text-[14px] font-semibold text-white active:opacity-80 dark:bg-[#0A84FF]"
            >
              Kies deze
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Sheet
      open={itemId !== null}
      onOpenChange={(o) => !o && onClose()}
      title={item?.displayName ?? "Product"}
      description={target ? `Doel: ${target} · Kies winkel, product of pas aantal aan` : "Kies winkel, wissel product of pas het aantal aan"}
    >
      {loading && !item && <p className="py-10 text-center text-[16px] text-black/60 dark:text-white/60">Prijzen vergelijken…</p>}
      {item && (
        <div className="space-y-3.5">
          <div className="flex items-center justify-between gap-2 rounded-2xl bg-white px-3.5 py-2.5 border border-black/[0.07] dark:border-white/[0.09] dark:bg-[#242426]">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-black/75 dark:text-white/80">Aantal</span>
              <div className="flex items-center rounded-xl bg-black/[0.06] p-0.5 dark:bg-white/10">
                <button
                  type="button"
                  data-testid="qty-minus"
                  aria-label="Minder"
                  disabled={busy || activeQty <= 1}
                  onClick={() => patch({ packCount: activeQty - 1 })}
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] active:bg-white disabled:opacity-35 dark:active:bg-[#636366]"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="min-w-[36px] px-1 text-center text-[15px] font-bold tabular-nums">{activeQty}×</span>
                <button
                  type="button"
                  data-testid="qty-plus"
                  aria-label="Meer"
                  disabled={busy}
                  onClick={() => patch({ packCount: activeQty + 1 })}
                  className="flex h-9 w-9 items-center justify-center rounded-[10px] active:bg-white disabled:opacity-35 dark:active:bg-[#636366]"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[#FF3B30]/10 px-3 text-[13.5px] font-semibold text-[#FF3B30] active:opacity-75 disabled:opacity-45"
            >
              <Trash2 className="h-4 w-4" /> Verwijder
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {(["ah", "picnic"] as const).map((p) => {
              const ev = data ? data[p] : undefined;
              const allForStore = ev
                ? [ev.winner, ...ev.alternatives, ...(ev.otherResults ?? [])].filter((c): c is PricedCandidate => !!c)
                : [];
              const activeCand = allForStore.find((c) => c.product.id === selectedId(p)) ?? ev?.winner ?? null;
              const fallbackProduct = p === "ah" ? item.ahProduct : item.picnicProduct;
              const fallbackTotal = p === "ah" ? item.ahTotalCents : item.picnicTotalCents;
              const fallbackQty = p === "ah" ? item.ahQty : item.picnicQty;
              const displayProd = activeCand?.product ?? fallbackProduct ?? null;
              const displayTotal = activeCand ? activeCand.effectiveTotalCents : fallbackTotal;
              const displayPacks = activeCand ? activeCand.packsNeeded : Math.max(1, fallbackQty || 1);

              const rec = data?.recommendedProvider === p;
              const isAssigned = item.assignedProvider === p;
              const isSelectedTab = tab === p;
              return (
                <Card
                  key={p}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setTab(p);
                    setShowOther(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setTab(p);
                      setShowOther(false);
                    }
                  }}
                  className={`flex cursor-pointer flex-col justify-between p-3 text-left transition-all ${
                    isSelectedTab
                      ? "ring-2 ring-[#007AFF] dark:ring-[#0A84FF]"
                      : rec
                        ? "ring-1 ring-[#34C759]"
                        : ""
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1">
                      <StoreBadge provider={p} label={p === "ah" ? "AH Winkel" : "Picnic"} />
                      {isAssigned && (
                        <span className="rounded-full bg-[#34C759]/15 px-2 py-0.5 text-[11px] font-bold text-[#1E8E3E] dark:text-[#5DDB7E]">
                          Actief
                        </span>
                      )}
                    </div>
                    {displayProd ? (
                      <>
                        <div className="mt-2.5 flex items-start gap-2">
                          <ProductThumb url={displayProd.imageUrl} title={displayProd.title} size="xs" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[18px] font-bold leading-tight tabular-nums">
                              {formatEuro(displayTotal)}
                            </p>
                            {activeCand && (
                              <p className="text-[12px] font-medium tabular-nums text-black/60 dark:text-white/60">
                                {formatEuro(Math.round(activeCand.effectiveUnitPriceEuros * 100))}/{activeCand.displayUnit}
                              </p>
                            )}
                          </div>
                        </div>
                        <p className="mt-2 line-clamp-2 text-[12.5px] font-medium leading-snug text-black/80 dark:text-white/80">
                          {displayPacks > 1 ? `${displayPacks}× ` : ""}
                          {candidateDisplayName(displayProd)}
                        </p>
                      </>
                    ) : (
                      <p className="mt-2 text-[13.5px] text-black/55 dark:text-white/55">Geen match</p>
                    )}
                  </div>

                  <div className="mt-2.5 flex items-center justify-between gap-1 pt-1">
                    <span className="text-[11.5px] font-semibold text-black/55 dark:text-white/60">
                      {data ? (
                        rec ? "★ Voordeligst" : `${candidateCount(p)} opties`
                      ) : (
                        <span className="inline-block h-[10px] w-14 animate-pulse rounded bg-black/[0.07] align-middle dark:bg-white/10" />
                      )}
                    </span>
                    {!isAssigned && displayProd && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void patch({ assignedProvider: p, isProviderLocked: true });
                        }}
                        className="rounded-full bg-[#007AFF]/12 px-2.5 py-1 text-[11.5px] font-bold text-[#0062CC] active:opacity-75 dark:bg-[#0A84FF]/22 dark:text-[#64B0FF]"
                      >
                        Kies {p === "ah" ? "AH" : "Picnic"}
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>

          {(item.loyaltyNote || item.radarDeals.length > 0) && (
            <div className="space-y-1.5 rounded-2xl bg-black/[0.04] px-3.5 py-2.5 text-[13px] leading-snug dark:bg-white/[0.06]">
              {item.loyaltyNote && (
                <p className="font-medium text-[#C2185B] dark:text-[#FF6FA5]">{item.loyaltyNote}</p>
              )}
              {item.radarDeals.length > 0 && (
                <p className="font-medium text-[#B25E00] dark:text-[#FFB340]">
                  📡 Ook in de bonus bij {item.radarDeals[0].provider === "jumbo" ? "Jumbo" : "Plus"}:{" "}
                  {item.radarDeals[0].promoLabel} ({item.radarDeals[0].title})
                </p>
              )}
            </div>
          )}

          {data ? (
            <>
              <div className="flex rounded-[10px] bg-black/[0.06] p-0.5 dark:bg-white/10" role="tablist">
                {(["ah", "picnic"] as const).map((p) => (
                  <button
                    key={p}
                    role="tab"
                    aria-selected={tab === p}
                    onClick={() => {
                      setTab(p);
                      setShowOther(false);
                    }}
                    className={`min-h-[38px] flex-1 rounded-[8px] px-2 text-[13.5px] font-semibold ${
                      tab === p ? "bg-white shadow-sm dark:bg-[#636366]" : "text-black/60 dark:text-white/65"
                    }`}
                  >
                    {p === "ah" ? `Albert Heijn opties (${candidateCount("ah")})` : `Picnic opties (${candidateCount("picnic")})`}
                  </button>
                ))}
              </div>

              <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                {(() => {
                  const ev = evalFor(tab);
                  const cands: PricedCandidate[] = ev
                    ? [ev.winner, ...ev.alternatives].filter((c): c is PricedCandidate => !!c)
                    : [];
                  if (cands.length === 0) {
                    return <p className="p-4 text-[15px] text-black/60 dark:text-white/60">Geen passende producten gevonden.</p>;
                  }
                  return cands.map((c) => renderCandidateRow(c, ev?.winner?.product.id === c.product.id));
                })()}
              </Card>

              {(() => {
                const other = evalFor(tab)?.otherResults ?? [];
                if (other.length === 0) return null;
                return (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowOther((v) => !v)}
                      className="flex min-h-[40px] w-full items-center justify-between rounded-xl bg-black/[0.05] px-3.5 text-[14px] font-semibold text-black/70 dark:bg-white/10 dark:text-white/75"
                    >
                      <span>Overige zoekresultaten bij {tab === "ah" ? "Albert Heijn" : "Picnic"} ({other.length})</span>
                      {showOther ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                    {showOther && (
                      <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                        {other.map((c) => renderCandidateRow(c, false))}
                      </Card>
                    )}
                  </div>
                );
              })()}

              {challengers.map(({ provider, cand }) => (
                <div key={provider} className="rounded-2xl bg-[#34C759]/12 p-3.5">
                  <p className="flex items-center gap-1.5 text-[15px] font-semibold text-[#1E8E3E] dark:text-[#5DDB7E]">
                    <Sparkles className="h-4 w-4" /> Huismerk-bespaartip
                  </p>
                  <p className="mt-1 text-[14px] leading-snug">
                    {candidateDisplayName(cand.product)} bij {provider === "ah" ? "AH" : "Picnic"} voor{" "}
                    {formatEuro(cand.effectiveTotalCents)}
                    {cand.savingsCents > 0 ? ` (bespaar ${formatEuro(cand.savingsCents)})` : ""}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => patch({ chosenProduct: { provider, productId: cand.product.id } }, "Voorkeur bijgewerkt!")}
                    className="mt-2 min-h-[38px] rounded-xl bg-[#34C759] px-3.5 text-[14px] font-semibold text-white active:opacity-80"
                  >
                    Wissel naar huismerk
                  </button>
                </div>
              ))}
            </>
          ) : (
            <div aria-busy="true" aria-label="Alternatieven laden" className="space-y-3.5">
              <div className="h-[46px] rounded-[10px] bg-black/[0.06] dark:bg-white/10" />
              <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex animate-pulse items-start gap-3 p-3">
                    <div className="h-14 w-14 shrink-0 rounded-lg bg-black/[0.07] dark:bg-white/10" />
                    <div className="min-w-0 flex-1 space-y-2 py-1">
                      <div className="h-3.5 w-3/4 rounded bg-black/[0.07] dark:bg-white/10" />
                      <div className="h-3 w-1/2 rounded bg-black/[0.07] dark:bg-white/10" />
                      <div className="h-3.5 w-2/5 rounded bg-black/[0.07] dark:bg-white/10" />
                    </div>
                    <div className="h-[44px] w-[84px] shrink-0 self-center rounded-full bg-black/[0.07] dark:bg-white/10" />
                  </div>
                ))}
              </Card>
            </div>
          )}

          <Card className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
            <div className="flex min-h-[50px] items-center justify-between gap-3 px-4 py-2">
              <span className="text-[14.5px] leading-snug">Grotere actiebundel toestaan (overshoot)</span>
              <button
                type="button"
                role="switch"
                aria-checked={item.allowOvershoot}
                disabled={busy}
                onClick={() => patch({ allowOvershoot: !item.allowOvershoot })}
                className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${
                  item.allowOvershoot ? "bg-[#34C759]" : "bg-black/20 dark:bg-white/25"
                }`}
              >
                <span
                  className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-all ${
                    item.allowOvershoot ? "left-[22px]" : "left-[2px]"
                  }`}
                />
              </button>
            </div>
            <div className="flex min-h-[50px] items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <p className="text-[14.5px] leading-snug">
                  {item.isProviderLocked
                    ? `Winkel vastgezet op ${item.assignedProvider === "picnic" ? "Picnic" : "Albert Heijn"}`
                    : "Automatisch voordeligste winkel"}
                </p>
                <p className="text-[12px] text-black/55 dark:text-white/55">
                  {item.isProviderLocked
                    ? "Blijft bij deze winkel, ook bij optimaliseren"
                    : "Kan automatisch naar een andere winkel verplaatsen"}
                </p>
              </div>
              <button
                type="button"
                disabled={busy || !item.assignedProvider}
                onClick={() =>
                  patch(item.isProviderLocked || !item.assignedProvider
                    ? { isProviderLocked: false }
                    : { assignedProvider: item.assignedProvider, isProviderLocked: true })
                }
                className={`inline-flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold ${
                  item.isProviderLocked
                    ? "bg-[#FF9500]/16 text-[#B25E00] dark:bg-[#FF9F0A]/22 dark:text-[#FFB340]"
                    : "bg-black/[0.06] text-black/70 dark:bg-white/10 dark:text-white/75"
                }`}
              >
                {item.isProviderLocked ? (
                  <>
                    <Lock className="h-3.5 w-3.5" /> Ontgrendel
                  </>
                ) : (
                  <>
                    <LockOpen className="h-3.5 w-3.5" /> Zet vast
                  </>
                )}
              </button>
            </div>
          </Card>
        </div>
      )}
    </Sheet>
  );
}
