"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ListChecks, Heart, Store, Tag } from "lucide-react";

const TABS = [
  { href: "/", label: "Lijstje", Icon: ListChecks },
  { href: "/deals", label: "Deals", Icon: Tag },
  { href: "/voorkeuren", label: "Voorkeuren", Icon: Heart },
  { href: "/statistieken", label: "Stats", Icon: BarChart3 },
  { href: "/winkels", label: "Winkels", Icon: Store },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <>
      <nav
        aria-label="Hoofdnavigatie"
        className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(54px+env(safe-area-inset-bottom,0px))] items-stretch border-t border-black/[0.07] bg-white/85 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-2xl dark:border-white/[0.09] dark:bg-[#161618]/85"
      >
        <div className="mx-auto flex w-full max-w-xl">
          {TABS.map(({ href, label, Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                  active ? "text-[#007AFF] dark:text-[#0A84FF]" : "text-black/50 dark:text-white/55"
                }`}
              >
                <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 1.9} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 -mb-16 h-16 bg-white/85 backdrop-blur-2xl dark:bg-[#161618]/85"
      />
    </>
  );
}
