"use client";

import { Check, ChevronRight, Lock, TrendingDown } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useRef, useState, type MouseEvent } from "react";
import { ProductThumb, PromoPill } from "./ui";
import { formatAmount, formatEuro, isTieredPromo, promoBadge } from "@/lib/format";
import type {
  ActiveShoppingProviderId,
  NormalizedStoreProduct,
  ShoppingListItem,
  UpdateListItemRequest,
} from "@/lib/types";

function displayProductName(product: NormalizedStoreProduct): string {
  if (product.brand && !product.title.toLowerCase().startsWith(product.brand.toLowerCase())) {
    return `${product.brand} ${product.title}`;
  }
  return product.title;
}

function compactUnitSize(raw: string): string {
  return raw
    .replace(/\bmilliliter\b/gi, "ml")
    .replace(/\bkilogram\b/gi, "kg")
    .replace(/\bgram\b/gi, "g")
    .replace(/\bliter\b/gi, "L")
    .replace(/\bstuks?\b/gi, "st")
    .trim();
}

const IGNORE_TOKENS = new Set(["x", "st", "stuk", "stuks", "gram", "g", "kg", "ml", "l", "liter", "blik", "blikje", "blikjes", "pak", "pot", "fles"]);

function typedQueryHint(displayName: string, productTitle: string): string | null {
  const lowerTitle = productTitle.toLowerCase();
  const tokens = displayName
    .toLowerCase()
    .replace(/[0-9.,]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !IGNORE_TOKENS.has(t));
  if (tokens.length === 0) return null;
  const anyMatches = tokens.some((t) => lowerTitle.includes(t));
  return anyMatches ? null : displayName;
}

export function ListRow({
  item,
  isJustAdded = false,
  onPatch,
  patchPending,
  onOpen,
  onDelete,
}: {
  item: ShoppingListItem;
  isJustAdded?: boolean;
  onPatch: (id: number, patch: UpdateListItemRequest) => void;
  patchPending: boolean;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const x = useMotionValue(0);
  const deleteBackgroundOpacity = useTransform(x, [-1, 0], [1, 0]);
  const reduceMotion = useReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const provider = item.assignedProvider;
  const product = provider === "picnic" ? item.picnicProduct : item.ahProduct;
  const otherProvider: ActiveShoppingProviderId = provider === "picnic" ? "ah" : "picnic";
  const otherProduct = provider === "picnic" ? item.ahProduct : item.picnicProduct;
  const otherTotal = provider === "picnic" ? item.ahTotalCents : item.picnicTotalCents;
  const otherQty = Math.max(1, (provider === "picnic" ? item.ahQty : item.picnicQty) || item.requestedQty || 1);
  const total = provider === "picnic" ? item.picnicTotalCents : item.ahTotalCents;
  const activeQty = Math.max(1, (provider === "picnic" ? item.picnicQty : item.ahQty) || item.requestedQty || 1);
  const regularTotal = product ? activeQty * product.regularPriceCents : null;
  const promo = promoBadge(product);
  const activePromoApplied = provider === "picnic" ? item.picnicPromoApplied : item.ahPromoApplied;
  const activePromoSummary = provider === "picnic" ? item.picnicPromoSummary : item.ahPromoSummary;
  const promoText = activePromoApplied ? promo : (activePromoSummary ?? promo);
  const promoIsTiered = isTieredPromo(product);
  const savingElsewhere =
    otherProduct && otherTotal !== null && total !== null && otherTotal < total ? total - otherTotal : 0;

  const headline = product ? displayProductName(product) : item.displayName;
  const rawSize = product ? compactUnitSize(product.unitSizeRaw || formatAmount(product.baseAmount, product.baseUnit)) : "";
  const sizeLabel = rawSize ? (activeQty > 1 ? `${activeQty} × ${rawSize}` : rawSize) : null;
  const queryHint = product ? typedQueryHint(item.displayName, headline) : null;

  const snapClosed = () => {
    setRevealed(false);
    animate(x, 0, {
      type: "spring",
      stiffness: 480,
      damping: 38,
      mass: 0.7,
    });
  };

  const remove = () => {
    if (deleting) return;
    setDeleting(true);
    const distance = Math.max(rowRef.current?.offsetWidth ?? 420, 420);
    animate(x, -distance, {
      duration: reduceMotion ? 0 : 0.22,
      ease: [0.32, 0.72, 0, 1],
      onComplete: () => onDelete(item.id),
    });
  };

  const handleDeleteGesture = (offset: number, velocity: number) => {
    const current = x.get();
    const width = rowRef.current?.offsetWidth ?? 360;
    const crossedFullSwipeThreshold = current <= -Math.min(220, width * 0.48);
    const fastIntentionalSwipe = velocity < -750 && offset < -44;

    if (crossedFullSwipeThreshold || fastIntentionalSwipe) {
      remove();
      return;
    }

    if (current < -42) {
      setRevealed(true);
      animate(x, -92, {
        type: "spring",
        stiffness: 480,
        damping: 38,
        mass: 0.7,
      });
      return;
    }

    snapClosed();
  };

  const handleForegroundClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!revealed && x.get() > -1) return;
    event.preventDefault();
    event.stopPropagation();
    snapClosed();
  };

  const handleStoreTap = (target: ActiveShoppingProviderId) => {
    if (provider === target && item.isProviderLocked) {
      onPatch(item.id, { isProviderLocked: false });
      return;
    }
    onPatch(item.id, { assignedProvider: target, isProviderLocked: true });
  };

  if (item.isChecked) {
    return (
      <motion.li
        ref={rowRef}
        data-testid="list-item-row"
        layout
        exit={{ height: 0, opacity: 0, transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.4, 0, 1, 1] } }}
        className="relative overflow-hidden"
      >
        <motion.button
          type="button"
          aria-label={`${headline} verwijderen`}
          onClick={remove}
          style={{ opacity: deleteBackgroundOpacity }}
          className="absolute inset-y-0 right-0 flex w-[92px] flex-col items-center justify-center gap-1 bg-[#FF3B30] text-[12px] font-semibold text-white"
        >
          <span className="text-[20px] leading-none">−</span>
          Verwijder
        </motion.button>

        <motion.div
          drag={deleting ? false : "x"}
          dragConstraints={{ left: -5000, right: 0 }}
          dragElastic={{ left: 0.08, right: 0.02 }}
          dragMomentum={false}
          onDragEnd={(_, info) => handleDeleteGesture(info.offset.x, info.velocity.x)}
          onClickCapture={handleForegroundClick}
          style={{ x, touchAction: "pan-y" }}
          className="relative z-10 flex items-center gap-2 bg-white py-2 pl-1.5 pr-3.5 dark:bg-[#1C1C1E]"
        >
          <button
            type="button"
            aria-label="Afvinken ongedaan maken"
            aria-pressed={true}
            onClick={() => onPatch(item.id, { isChecked: false })}
            className="flex h-9 w-9 shrink-0 items-center justify-center"
          >
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#007AFF] dark:bg-[#0A84FF]">
              <Check className="h-3.5 w-3.5 text-white" strokeWidth={3.2} />
            </span>
          </button>

          <button
            type="button"
            data-testid="open-item-sheet"
            onClick={() => onOpen(item.id)}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 py-0.5 text-left opacity-55 active:opacity-80"
          >
            <span className="truncate text-[14.5px] font-medium line-through">
              {activeQty > 1 ? `${activeQty}× ` : ""}
              {headline}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-black/60 dark:text-white/60">
              {provider && (
                <span className="text-[11.5px] font-semibold">
                  {provider === "picnic" ? "Picnic" : "AH"}
                </span>
              )}
              <span>{formatEuro(total)}</span>
            </span>
          </button>
        </motion.div>
      </motion.li>
    );
  }

  const renderStoreSegment = (p: ActiveShoppingProviderId, label: string, activeCls: string) => {
    const isActive = provider === p;
    const isLockedHere = isActive && item.isProviderLocked;
    const hasMatch = p === "ah" ? !!item.ahProduct : !!item.picnicProduct;
    const cheaperHere = !isActive && savingElsewhere > 0;
    return (
      <button
        type="button"
        data-testid={p === "ah" ? "toggle-ah" : "toggle-picnic"}
        disabled={patchPending}
        aria-pressed={isActive}
        title={
          cheaperHere
            ? `Goedkoper bij ${label}: ${formatEuro(savingElsewhere)} minder`
            : isLockedHere
            ? `Vastgezet op ${label} — tik nogmaals om te ontgrendelen`
            : isActive
              ? `Vastzetten op ${label}`
              : `Wissel naar ${label}`
        }
        onClick={() => handleStoreTap(p)}
        className={`inline-flex h-[27px] min-w-[40px] items-center justify-center gap-1 rounded-[7px] px-2 text-[12px] font-semibold transition-all ${
          isActive
            ? `${activeCls} shadow-xs`
            : cheaperHere
              ? "bg-[#34C759]/15 text-[#1E8E3E] dark:text-[#5DDB7E]"
            : hasMatch
              ? "text-black/55 active:text-black dark:text-white/55 dark:active:text-white"
              : "text-black/30 dark:text-white/30"
        }`}
      >
        {isLockedHere && <Lock className="h-2.5 w-2.5 shrink-0" strokeWidth={2.6} />}
        {cheaperHere && <TrendingDown data-testid="cheaper-here" className="h-3 w-3 shrink-0" strokeWidth={2.6} />}
        <span>{label}</span>
      </button>
    );
  };

  const activeStoreShort = provider === "picnic" ? "Picnic" : "AH";
  const otherStoreShort = otherProvider === "ah" ? "AH" : "Picnic";

  return (
    <motion.li
      ref={rowRef}
      data-testid="list-item-row"
      layout
      exit={{ height: 0, opacity: 0, transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.4, 0, 1, 1] } }}
      className="relative overflow-hidden"
    >
      <motion.button
        type="button"
        aria-label={`${headline} verwijderen`}
        onClick={remove}
        style={{ opacity: deleteBackgroundOpacity }}
        className="absolute inset-y-0 right-0 flex w-[92px] flex-col items-center justify-center gap-1 bg-[#FF3B30] text-[12px] font-semibold text-white"
      >
        <span className="text-[20px] leading-none">−</span>
        Verwijder
      </motion.button>

      <motion.div
        drag={deleting ? false : "x"}
        dragConstraints={{ left: -5000, right: 0 }}
        dragElastic={{ left: 0.08, right: 0.02 }}
        dragMomentum={false}
        onDragEnd={(_, info) => handleDeleteGesture(info.offset.x, info.velocity.x)}
        onClickCapture={handleForegroundClick}
        style={{ x, touchAction: "pan-y" }}
        className={`relative z-10 py-2.5 pl-1.5 pr-3 transition-colors duration-200 ${
          isJustAdded
            ? "bg-[#F2F7FF] dark:bg-[#11243B]"
            : "bg-white dark:bg-[#1C1C1E]"
        }`}
      >
        {isJustAdded && (
          <span
            aria-hidden="true"
            className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[#007AFF] dark:bg-[#0A84FF]"
          />
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Afvinken"
            aria-pressed={false}
            onClick={() => onPatch(item.id, { isChecked: true })}
            className="flex h-10 w-9 shrink-0 items-center justify-center"
          >
            <span className="flex h-[23px] w-[23px] items-center justify-center rounded-full border-2 border-black/25 transition-colors active:scale-95 dark:border-white/30" />
          </button>

          <button
            type="button"
            data-testid="open-item-sheet"
            onClick={() => onOpen(item.id)}
            className="flex min-w-0 flex-1 items-center gap-2.5 py-0.5 text-left active:opacity-70"
          >
            <ProductThumb url={product?.imageUrl} title={headline} size="xs" />

            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-[15px] font-semibold leading-[1.25] tracking-[-0.01em]">
                {activeQty > 1 && (
                  <span
                    data-testid="qty-value"
                    className="mr-1.5 inline-flex items-center rounded-[5px] bg-[#007AFF]/12 px-1.5 py-0.2 align-baseline text-[12.5px] font-bold tabular-nums text-[#0062CC] dark:bg-[#0A84FF]/22 dark:text-[#64B0FF]"
                  >
                    {activeQty}×
                  </span>
                )}
                {headline}
              </p>

              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] leading-tight text-black/55 dark:text-white/55">
                {queryHint && <span className="font-medium text-black/70 dark:text-white/70">{queryHint} ·</span>}
                {sizeLabel ? (
                  <span>{sizeLabel}</span>
                ) : !product ? (
                  <span className="text-[#FF9500]">Geen product gevonden</span>
                ) : null}
                {promoText &&
                  (promoIsTiered ? (
                    <span className="text-[11.5px] text-black/40 dark:text-white/40">{promoText}</span>
                  ) : (
                    <PromoPill>{promoText}</PromoPill>
                  ))}
                {product?.isMockFallback && (
                  <span className="text-[11px] text-black/40 dark:text-white/40">richtprijs</span>
                )}
              </div>
            </div>
          </button>

          <div className="flex shrink-0 flex-col items-end justify-between gap-1.5 self-stretch py-0.5">
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="flex items-baseline gap-1 tabular-nums active:opacity-70"
            >
              {regularTotal !== null && total !== null && total < regularTotal && (
                <span className="text-[11.5px] font-normal text-black/40 line-through dark:text-white/40">
                  {formatEuro(regularTotal)}
                </span>
              )}
              <span className="text-[15px] font-bold leading-tight">{formatEuro(total)}</span>
            </button>

            <div className="flex rounded-[8px] bg-black/[0.06] p-0.5 dark:bg-white/10">
              {renderStoreSegment("ah", "AH", "bg-white text-[#007AA3] dark:bg-[#525256] dark:text-[#38C6F4]")}
              {renderStoreSegment("picnic", "Picnic", "bg-white text-[#C81015] dark:bg-[#525256] dark:text-[#FF5A5F]")}
            </div>
          </div>
        </div>

        {isJustAdded && (
          <div
            data-testid="just-added-bar"
            className="mt-2 ml-9 flex items-center justify-between gap-2 rounded-xl bg-white/85 px-2.5 py-1.5 text-[12px] ring-1 ring-[#007AFF]/20 dark:bg-white/[0.06] dark:ring-[#0A84FF]/30"
          >
            <span className="min-w-0 truncate tabular-nums text-black/70 dark:text-white/75">
              <span className="font-semibold text-[#0062CC] dark:text-[#64B0FF]">
                Nieuw bij {activeStoreShort}
              </span>
              {otherProduct && otherTotal !== null ? (
                <>
                  {" · "}
                  {otherStoreShort} {otherQty !== activeQty ? `${otherQty}× ` : ""}
                  {formatEuro(otherTotal)}
                </>
              ) : !otherProduct && product ? (
                <> · Alleen bij {activeStoreShort}</>
              ) : null}
            </span>
            <button
              type="button"
              data-testid="swap-product-btn"
              onClick={() => onOpen(item.id)}
              className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-[#007AFF] active:opacity-70 dark:text-[#64B0FF]"
            >
              Ander item <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </motion.div>
    </motion.li>
  );
}
