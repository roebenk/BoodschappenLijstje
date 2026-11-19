"use client";

import { useRef, useState, type ReactNode } from "react";

const THRESHOLD = 90;

/** Row that can be swiped to the left to trigger an action (pointer events; vertical scrolling stays native). */
export function SwipeRow({
  children,
  onSwipe,
  label,
  tone = "danger",
  keyboardHint = false,
}: {
  children: ReactNode;
  onSwipe: () => void;
  label: string;
  tone?: "danger" | "primary";
  /** Makes the row focusable so Delete/Backspace triggers the action (keyboard alternative to swiping). */
  keyboardHint?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; locked: boolean } | null>(null);

  const reset = () => {
    start.current = null;
    setDragging(false);
    setDx(0);
  };

  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 flex items-center justify-end px-5 text-[14px] font-semibold text-white ${
          tone === "danger" ? "bg-[#FF3B30]" : "bg-[#007AFF]"
        }`}
        style={{ width: Math.max(-dx, 0), opacity: Math.min(-dx / 40, 1) }}
      >
        <span className="whitespace-nowrap">{label}</span>
      </div>
      <div
        className="relative select-none bg-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#007AFF] dark:bg-[#1C1C1E]"
        tabIndex={keyboardHint ? 0 : undefined}
        aria-keyshortcuts={keyboardHint ? "Delete" : undefined}
        onKeyDown={(e) => {
          if (keyboardHint && (e.key === "Delete" || e.key === "Backspace") && e.target === e.currentTarget) {
            e.preventDefault();
            onSwipe();
          }
        }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? "none" : "transform 180ms ease-out",
          touchAction: "pan-y",
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button,a,input")) return;
          start.current = { x: e.clientX, y: e.clientY, locked: false };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const moveX = e.clientX - s.x;
          const moveY = e.clientY - s.y;
          if (!s.locked) {
            if (Math.abs(moveY) > 10 && Math.abs(moveY) > Math.abs(moveX)) return reset();
            if (Math.abs(moveX) < 8) return;
            s.locked = true;
            setDragging(true);
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          setDx(Math.min(0, Math.max(moveX, -140)));
        }}
        onPointerUp={() => {
          const fire = start.current?.locked && dx <= -THRESHOLD;
          reset();
          if (fire) onSwipe();
        }}
        onPointerCancel={reset}
      >
        {children}
      </div>
    </div>
  );
}
