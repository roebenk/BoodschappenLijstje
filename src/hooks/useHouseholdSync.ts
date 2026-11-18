"use client";

import { useEffect, useRef, useState } from "react";
import type { SseEventPayload } from "@/lib/types";

const REFRESH_EVENTS = new Set(["list.changed", "list.cleared", "stores.changed", "preferences.changed"]);

/** Subscribes to /api/events; calls `onRefresh` for data-changing events and auto-reconnects. */
export function useHouseholdSync(onRefresh: () => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onRefresh);
  useEffect(() => {
    cb.current = onRefresh;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data) as SseEventPayload;
          if (REFRESH_EVENTS.has(payload.type)) cb.current();
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (!disposed) timer = setTimeout(connect, 2000);
      };
    };
    connect();

    const onVisible = () => {
      if (document.visibilityState === "visible") cb.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { connected };
}
