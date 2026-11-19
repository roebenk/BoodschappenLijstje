"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { SseEventPayload } from "@/lib/types";

const REFRESH_EVENTS = new Set(["list.changed", "list.cleared", "stores.changed", "preferences.changed"]);
const RECONNECT_MS = 2000;
// Keeps the stream open while navigating, when one page unmounts just before the next mounts.
const IDLE_CLOSE_MS = 5000;

// A single shared connection so the status survives page navigation.
let es: EventSource | null = null;
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const refreshListeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  stateListeners.forEach((l) => l());
}

function open() {
  if (es) return;
  es = new EventSource("/api/events");
  es.onopen = () => setConnected(true);
  es.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data) as SseEventPayload;
      if (REFRESH_EVENTS.has(payload.type)) refreshListeners.forEach((l) => l());
    } catch {
      /* ignore malformed frames */
    }
  };
  es.onerror = () => {
    setConnected(false);
    es?.close();
    es = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (refreshListeners.size > 0) open();
    }, RECONNECT_MS);
  };
}

function close() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  es?.close();
  es = null;
  setConnected(false);
}

function subscribeState(listener: () => void) {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Subscribes to /api/events; calls `onRefresh` for data-changing events and auto-reconnects. */
export function useHouseholdSync(onRefresh: () => void): { connected: boolean } {
  const cb = useRef(onRefresh);
  useEffect(() => {
    cb.current = onRefresh;
  });

  useEffect(() => {
    const listener = () => cb.current();
    refreshListeners.add(listener);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    open();

    const onVisible = () => {
      if (document.visibilityState === "visible") cb.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      refreshListeners.delete(listener);
      document.removeEventListener("visibilitychange", onVisible);
      if (refreshListeners.size === 0) {
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (refreshListeners.size === 0) close();
        }, IDLE_CLOSE_MS);
      }
    };
  }, []);

  const isConnected = useSyncExternalStore(
    subscribeState,
    () => connected,
    () => false,
  );
  return { connected: isConnected };
}
