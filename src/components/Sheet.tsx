"use client";

import { Drawer } from "vaul";
import type { ReactNode } from "react";

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} shouldScaleBackground>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] max-w-xl flex-col rounded-t-[28px] bg-[#F2F2F7] outline-none dark:bg-[#1C1C1E]">
          <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-black/20 dark:bg-white/25" />
          <Drawer.Title className="px-5 pt-3 text-[22px] font-bold tracking-tight">{title}</Drawer.Title>
          <Drawer.Description className={description ? "px-5 pt-0.5 text-[14px] text-black/65 dark:text-white/65" : "sr-only"}>
            {description ?? "Details"}
          </Drawer.Description>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-3">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
