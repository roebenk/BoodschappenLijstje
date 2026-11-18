import type { BaseUnit, DisplayUnit, NormalizedStoreProduct, ShoppingListItem } from "@/lib/types";

export function formatEuro(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `€ ${(cents / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatUnitPrice(centsPer1000: number | null | undefined, unit: DisplayUnit): string | null {
  if (centsPer1000 === null || centsPer1000 === undefined) return null;
  return `${formatEuro(centsPer1000)}/${unit}`;
}

export function formatAmount(amount: number | null | undefined, unit: BaseUnit | null | undefined): string {
  if (!amount || !unit) return "";
  if (unit === "g") return amount >= 1000 ? `${+(amount / 1000).toFixed(2)} kg` : `${amount} g`;
  if (unit === "ml") return amount >= 1000 ? `${+(amount / 1000).toFixed(2)} L` : `${amount} ml`;
  return `${amount} stuks`;
}

export function packLabel(item: ShoppingListItem): string {
  const product = item.assignedProvider === "picnic" ? item.picnicProduct : item.ahProduct;
  const qty = Math.max(1, (item.assignedProvider === "picnic" ? item.picnicQty : item.ahQty) || 1);
  if (!product) return "";
  const size = product.unitSizeRaw || formatAmount(product.baseAmount, product.baseUnit);
  return `${qty}× ${size}`;
}

export function promoBadge(product: NormalizedStoreProduct | null | undefined): string | null {
  if (!product?.promo || product.promo.type === "none") return null;
  if (product.promo.isPersonalBonus) return "Persoonlijke Bonus";
  return product.promo.label || "Bonus";
}

/** Volume/tier pricing ("Staffelprijs") is routine, unlike real deals such as 1+1 gratis or % korting. */
export function isTieredPromo(product: NormalizedStoreProduct | null | undefined): boolean {
  return product?.promo?.type === "tiered_price";
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "nog niet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "nog niet";
  return d.toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
