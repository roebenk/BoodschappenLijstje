import fs from "node:fs";
import {
  deleteStoreAccount,
  getStoreAccount,
  saveStoreAccount,
} from "@/lib/db/repositories";
import type {
  AdapterCapabilities,
  AuthFlowInput,
  AuthFlowResult,
  NormalizedStoreProduct,
  RadarDeal,
  SearchOptions,
  SearchResponse,
  StoreAuthState,
  StoreProviderId,
  SupermarketAdapter,
} from "@/lib/types";
import { parseUnitQuantity } from "../picnic/parse";

/** One Checkjebon entry: n = name, l = link, p = price in euros, s = size. Optional `o` = regular price (euros). */
export interface CheckjebonItem {
  n: string;
  l?: string;
  p: number;
  s?: string;
  o?: number;
}
export interface CheckjebonSupermarket {
  n: string;
  d: CheckjebonItem[];
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cents(euros: number): number {
  return Math.round(euros * 100);
}

/** Parses Checkjebon `supermarkets.json` (array of chains, or a single chain) for one chain. */
export function parseCheckjebon(json: unknown, chain: StoreProviderId): NormalizedStoreProduct[] {
  const chains = Array.isArray(json) ? json : [json];
  const entry = chains.find((c): c is CheckjebonSupermarket => !!c && typeof c === "object" && (c as CheckjebonSupermarket).n === chain);
  if (!entry || !Array.isArray(entry.d)) return [];
  const out: NormalizedStoreProduct[] = [];
  for (const item of entry.d) {
    if (!item || typeof item.n !== "string" || typeof item.p !== "number" || !Number.isFinite(item.p)) continue;
    const unit = parseUnitQuantity(item.s);
    const current = cents(item.p);
    const regular = typeof item.o === "number" && item.o > item.p ? cents(item.o) : current;
    const externalId = item.l ?? item.n;
    out.push({
      id: `${chain}:${externalId}`,
      provider: chain,
      externalId,
      title: item.n,
      brand: null,
      isHouseBrand: false,
      unitSizeRaw: item.s ?? "",
      baseAmount: unit.baseAmount,
      baseUnit: unit.baseUnit,
      regularPriceCents: regular,
      currentPriceCents: current,
      promo: regular > current ? { type: "fixed_discount", label: "Aanbieding" } : null,
      isOnlineOnlyPromo: false,
      imageUrl: null,
      available: true,
    });
  }
  return out;
}

export function dealsFromProducts(products: NormalizedStoreProduct[]): RadarDeal[] {
  return products
    .filter((p) => p.regularPriceCents > p.currentPriceCents)
    .map((p) => ({
      provider: p.provider,
      title: p.title,
      priceCents: p.currentPriceCents,
      regularPriceCents: p.regularPriceCents,
      promoLabel: p.promo?.label ?? "Aanbieding",
      url: p.externalId.startsWith("http") ? p.externalId : null,
    }));
}

/**
 * Deal-radar adapter backed by an optional Checkjebon-format JSON (local file path or https URL).
 * Disabled (`disconnected`) until enabled via `authenticate({ step: "exchange_code", codeOrUrl })`.
 */
export class RadarSupermarketAdapter implements SupermarketAdapter {
  readonly channel = "radar" as const;
  readonly capabilities: AdapterCapabilities = { search: true, promotions: true, historySync: false, listPush: false };
  private cache: { loadedAt: number; products: NormalizedStoreProduct[] } | null = null;

  constructor(
    readonly id: StoreProviderId,
    readonly displayName: string,
  ) {}

  /** Injects parsed Checkjebon JSON directly (import/upload flow and tests). */
  loadFromJson(json: unknown): number {
    const products = parseCheckjebon(json, this.id);
    this.cache = { loadedAt: Date.now(), products };
    return products.length;
  }

  private source(): string | null {
    const meta = getStoreAccount(this.id)?.meta;
    return typeof meta?.source === "string" ? meta.source : null;
  }

  private isEnabled(): boolean {
    const account = getStoreAccount(this.id);
    return account?.status === "authenticated";
  }

  private async loadProducts(): Promise<NormalizedStoreProduct[]> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) return this.cache.products;
    const source = this.source();
    if (!source) return this.cache?.products ?? [];
    const text = /^https?:\/\//i.test(source)
      ? await (await fetch(source)).text()
      : await fs.promises.readFile(source, "utf8");
    this.loadFromJson(JSON.parse(text));
    return this.cache?.products ?? [];
  }

  async getAuthState(): Promise<StoreAuthState> {
    if (!this.isEnabled()) {
      return { provider: this.id, status: "disconnected", message: `${this.displayName}-radar staat uit` };
    }
    return { provider: this.id, status: "authenticated", message: `${this.displayName}-radar actief` };
  }

  async authenticate(input: AuthFlowInput): Promise<AuthFlowResult> {
    if (input.step === "exchange_code") {
      saveStoreAccount(this.id, { status: "authenticated", tokens: null, meta: { source: input.codeOrUrl.trim() } });
      this.cache = null;
      await this.loadProducts();
      return { state: await this.getAuthState() };
    }
    if (input.step === "logout") {
      deleteStoreAccount(this.id);
      this.cache = null;
      return { state: await this.getAuthState() };
    }
    throw new Error(`Stap '${input.step}' wordt niet ondersteund door de ${this.displayName}-radar`);
  }

  async searchProducts({ query, limit = 20 }: SearchOptions): Promise<SearchResponse> {
    if (!this.isEnabled() && !this.cache) {
      return { products: [], isMockFallback: false, sourceNote: `${this.displayName}-radar staat uit` };
    }
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const products = (await this.loadProducts())
      .filter((p) => tokens.every((t) => p.title.toLowerCase().includes(t)))
      .slice(0, limit);
    return { products, isMockFallback: false, sourceNote: "Checkjebon open prijsdata" };
  }

  async getPromotions(): Promise<RadarDeal[]> {
    if (!this.isEnabled() && !this.cache) return [];
    return dealsFromProducts(await this.loadProducts());
  }
}

export class JumboRadarAdapter extends RadarSupermarketAdapter {
  constructor() {
    super("jumbo", "Jumbo");
  }
}

export class PlusRadarAdapter extends RadarSupermarketAdapter {
  constructor() {
    super("plus", "Plus");
  }
}
