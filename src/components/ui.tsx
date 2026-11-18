"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { StoreProviderId } from "@/lib/types";

export const STORE_TINT: Record<string, string> = {
  ah: "bg-[#00ADE6]/12 text-[#0086B3] dark:text-[#38C6F4]",
  picnic: "bg-[#E1191E]/12 text-[#C81015] dark:text-[#FF5A5F]",
  jumbo: "bg-[#FFC800]/20 text-[#8A6D00] dark:text-[#FFD740]",
  plus: "bg-[#34C759]/15 text-[#1E8E3E] dark:text-[#5DDB7E]",
};

export const STORE_NAME: Record<StoreProviderId, string> = {
  ah: "Albert Heijn",
  picnic: "Picnic",
  jumbo: "Jumbo",
  plus: "Plus",
};

export function StoreBadge({ provider, label }: { provider: StoreProviderId; label?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${STORE_TINT[provider]}`}>
      {label ?? STORE_NAME[provider]}
    </span>
  );
}

export function PromoPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-[#FF9500]/15 px-2 py-0.5 text-[11.5px] font-semibold leading-tight text-[#B25E00] dark:text-[#FFB340]">
      {children}
    </span>
  );
}

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-black/[0.07] bg-white dark:border-white/[0.09] dark:bg-[#1C1C1E] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

const COLLAPSE_DISTANCE_PX = 64;

/** Publishes scroll progress (0 = top, 1 = fully scrolled) as `--collapse` on <html> for iOS-style large-title shrinking. */
function useCollapseProgress(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const p = Math.min(1, Math.max(0, window.scrollY / COLLAPSE_DISTANCE_PX));
      root.style.setProperty("--collapse", p.toFixed(3));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty("--collapse");
    };
  }, [enabled]);
}

export function PageHeader({
  title,
  eyebrow,
  right,
  collapseOnScroll = false,
}: {
  title: string;
  eyebrow?: ReactNode;
  right?: ReactNode;
  collapseOnScroll?: boolean;
}) {
  useCollapseProgress(collapseOnScroll);

  if (!collapseOnScroll) {
    return (
      <header className="pt-safe sticky top-0 z-30 bg-[var(--canvas)] px-4 pb-2">
        {eyebrow && <div className="mb-0.5">{eyebrow}</div>}
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 flex-1 truncate text-[28px] font-bold leading-tight tracking-tight">{title}</h1>
          {right && <div className="shrink-0">{right}</div>}
        </div>
      </header>
    );
  }

  return (
    <header
      className="px-4"
      style={{
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem - 0.5rem * var(--collapse, 0))",
        paddingBottom: "calc(0.5rem - 0.25rem * var(--collapse, 0))",
      }}
    >
      {eyebrow && (
        <div
          className="overflow-hidden"
          style={{
            maxHeight: "calc(1.5rem * (1 - var(--collapse, 0)))",
            opacity: "calc(1 - var(--collapse, 0))",
            marginBottom: "calc(0.125rem * (1 - var(--collapse, 0)))",
          }}
        >
          {eyebrow}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <h1
          className="min-w-0 flex-1 truncate font-bold leading-tight tracking-tight"
          style={{ fontSize: "calc(28px - 9px * var(--collapse, 0))" }}
        >
          {title}
        </h1>
        {right && <div className="shrink-0">{right}</div>}
      </div>
    </header>
  );
}

export function SyncPill({ connected, compact = false }: { connected: boolean; compact?: boolean }) {
  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-black/55 dark:text-white/55">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[#34C759]" : "bg-[#FF9500]"}`} />
        {connected ? "Gezin live" : "Verbinden…"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-black/[0.05] px-2.5 py-1 text-[13px] font-medium text-black/70 dark:bg-white/10 dark:text-white/75">
      <span className={`h-2 w-2 rounded-full ${connected ? "bg-[#34C759]" : "bg-[#FF9500]"}`} />
      {connected ? "Gezin live" : "Verbinden…"}
    </span>
  );
}

const THUMB_SIZES = {
  xs: "h-10 w-10 rounded-lg text-[14px]",
  sm: "h-11 w-11 rounded-xl text-[15px]",
  md: "h-14 w-14 rounded-xl text-[18px]",
  lg: "h-16 w-16 rounded-xl text-[20px]",
} as const;

export function ProductThumb({
  url,
  title,
  size = "md",
}: {
  url: string | null | undefined;
  title: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [url]);

  const cls = THUMB_SIZES[size];
  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={title}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${cls} shrink-0 border border-black/[0.06] bg-white p-0.5 object-contain dark:border-white/10`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex ${cls} shrink-0 items-center justify-center bg-black/[0.06] font-bold text-black/40 dark:bg-white/10 dark:text-white/45`}
    >
      {title.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export const btnPrimary =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#007AFF] px-4 text-[16px] font-semibold text-white active:opacity-80 disabled:opacity-50 dark:bg-[#0A84FF]";
export const btnSecondary =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-black/[0.06] px-4 text-[16px] font-semibold text-[#007AFF] active:opacity-70 disabled:opacity-50 dark:bg-white/10 dark:text-[#0A84FF]";
export const inputCls =
  "min-h-[44px] w-full rounded-xl bg-[#E9E9EE] px-3.5 text-[16px] text-black outline-none placeholder:text-black/40 dark:bg-[#2C2C2E] dark:text-white dark:placeholder:text-white/40";
