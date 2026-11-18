"use client";

import { Check, RotateCcw, Trash2 } from "lucide-react";
import type { StoreFilter } from "./OptimizerCard";
import { Card, ProductThumb } from "./ui";
import { formatAmount } from "@/lib/format";
import type { NormalizedStoreProduct, ShoppingListItem } from "@/lib/types";

function compactItemLabel(item: ShoppingListItem, product: NormalizedStoreProduct | null): {
  qty: number;
  name: string;
  size: string | null;
} {
  const provider = item.assignedProvider;
  const qty = Math.max(1, (provider === "picnic" ? item.picnicQty : item.ahQty) || item.requestedQty || 1);
  if (!product) {
    return { qty, name: item.displayName, size: null };
  }
  const name =
    product.brand && !product.title.toLowerCase().startsWith(product.brand.toLowerCase())
      ? `${product.brand} ${product.title}`
      : product.title;
  const rawSize = product.unitSizeRaw || formatAmount(product.baseAmount, product.baseUnit);
  const size = rawSize
    ? rawSize
        .replace(/\bmilliliter\b/gi, "ml")
        .replace(/\bkilogram\b/gi, "kg")
        .replace(/\bgram\b/gi, "g")
        .replace(/\bliter\b/gi, "L")
        .replace(/\bstuks?\b/gi, "st")
        .trim()
    : null;
  return { qty, name, size };
}

export function ShoppingModeView({
  items,
  filter,
  onFilter,
  onToggleCheck,
  onClearChecked,
}: {
  items: ShoppingListItem[];
  filter: StoreFilter;
  onFilter: (next: StoreFilter) => void;
  onToggleCheck: (id: number, nextChecked: boolean) => void;
  onClearChecked: () => void;
}) {
  const ahOpenCount = items.filter((i) => !i.isChecked && i.assignedProvider === "ah").length;
  const picnicOpenCount = items.filter((i) => !i.isChecked && i.assignedProvider === "picnic").length;
  const allOpenCount = items.filter((i) => !i.isChecked).length;

  const filtered = items.filter((i) => filter === "all" || i.assignedProvider === filter);
  const open = filtered.filter((i) => !i.isChecked);
  const checked = filtered.filter((i) => i.isChecked);
  const totalCount = filtered.length;
  const doneCount = checked.length;
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const filterOptions: Array<[StoreFilter, string, number]> = [
    ["all", "Alles", allOpenCount],
    ["ah", "Albert Heijn", ahOpenCount],
    ["picnic", "Picnic", picnicOpenCount],
  ];

  return (
    <div data-testid="shopping-mode-view" className="space-y-3 px-4 pt-1 pb-8">
      <div className="space-y-2">
        <div className="flex rounded-[10px] bg-black/[0.06] p-0.5 dark:bg-white/10">
          {filterOptions.map(([key, label, count]) => {
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => onFilter(key)}
                className={`min-h-[34px] flex-1 rounded-[8px] px-2 text-[13px] font-semibold tabular-nums transition-colors ${
                  active ? "bg-white shadow-xs dark:bg-[#525256]" : "text-black/60 dark:text-white/65"
                }`}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2.5 px-0.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/12">
            <div
              className="h-full rounded-full bg-[#34C759] transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="shrink-0 text-[12px] font-semibold tabular-nums text-black/55 dark:text-white/55">
            {doneCount}/{totalCount} in mandje
          </span>
        </div>
      </div>

      <Card>
        {open.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-[17px] font-bold">Alles in je mandje! 🎉</p>
            <p className="mt-1 text-[14px] text-black/60 dark:text-white/60">
              Geen open items meer voor deze selectie.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.09]">
            {open.map((item) => {
              const product = item.assignedProvider === "picnic" ? item.picnicProduct : item.ahProduct;
              const { qty, name, size } = compactItemLabel(item, product ?? null);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid="shopping-mode-row"
                    onClick={() => onToggleCheck(item.id, true)}
                    className="flex min-h-[54px] w-full items-center gap-2.5 px-3 py-2 text-left active:bg-black/[0.04] dark:active:bg-white/[0.06]"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-black/30 dark:border-white/35" />
                    <ProductThumb url={product?.imageUrl} title={name} size="xs" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[15px] font-semibold leading-snug">
                        {qty > 1 && (
                          <span className="mr-1.5 inline-block rounded-[5px] bg-[#007AFF]/14 px-1.5 py-0.2 text-[12.5px] font-bold tabular-nums text-[#0062CC] dark:text-[#64B0FF]">
                            {qty}×
                          </span>
                        )}
                        {name}
                      </p>
                      {(size || (filter === "all" && item.assignedProvider)) && (
                        <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-black/55 dark:text-white/55">
                          {size && <span>{size}</span>}
                          {filter === "all" && item.assignedProvider && (
                            <span
                              className={`rounded px-1.5 py-0.2 text-[11px] font-bold ${
                                item.assignedProvider === "ah"
                                  ? "bg-[#00ADE6]/15 text-[#007AA3] dark:text-[#38C6F4]"
                                  : "bg-[#E1191E]/15 text-[#C81015] dark:text-[#FF5A5F]"
                              }`}
                            >
                              {item.assignedProvider === "ah" ? "AH" : "Picnic"}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {checked.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[13px] font-semibold uppercase tracking-wide text-black/50 dark:text-white/50">
              In winkelwagen ({checked.length})
            </span>
            <button
              type="button"
              onClick={onClearChecked}
              className="inline-flex min-h-[34px] items-center gap-1 text-[13px] font-semibold text-[#FF3B30]"
            >
              <Trash2 className="h-3.5 w-3.5" /> Wis afgevinkt
            </button>
          </div>
          <Card>
            <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.08]">
              {checked.map((item) => {
                const product = item.assignedProvider === "picnic" ? item.picnicProduct : item.ahProduct;
                const { qty, name } = compactItemLabel(item, product ?? null);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onToggleCheck(item.id, false)}
                      className="flex min-h-[42px] w-full items-center gap-3 px-3.5 py-1.5 text-left opacity-55 active:opacity-80"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#34C759] text-white">
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[15px] line-through">
                        {qty > 1 ? `${qty}× ` : ""}
                        {name}
                      </span>
                      <RotateCcw className="h-3.5 w-3.5 shrink-0 text-black/45 dark:text-white/45" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
