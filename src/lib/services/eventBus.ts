import type { SseEventPayload } from "@/lib/types";

type Listener = (event: SseEventPayload) => void;

declare global {
  // eslint-disable-next-line no-var
  var __boodschappenEventBus: { listeners: Set<Listener> } | undefined;
}

// Process-wide so Next.js dev HMR and standalone route bundles share one subscriber set.
function bus(): { listeners: Set<Listener> } {
  globalThis.__boodschappenEventBus ??= { listeners: new Set<Listener>() };
  return globalThis.__boodschappenEventBus;
}

export function subscribe(listener: Listener): () => void {
  const { listeners } = bus();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitEvent(payload: SseEventPayload): void {
  for (const listener of [...bus().listeners]) {
    try {
      listener(payload);
    } catch {
      // a broken subscriber must never block the mutation that emitted the event
    }
  }
}

export function subscriberCount(): number {
  return bus().listeners.size;
}

export const nowIso = (): string => new Date().toISOString();
