// Home Activity feed: genuine events from GET /api/dashboard/events (trade events, signals, engine candles,
// observation gaps), plus the one thing only this device can observe: the Worker connection dropping and returning.
// Polled only while the Home page is visible, every ACTIVITY_INTERVAL_MS, never overlapping.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { fetchMirrorOverview, type MirrorOverview } from "./mirror";

export type ActivitySource = "funded" | "mirror" | "system" | "device";
export interface ActivityItem {
  id: string;
  at: string;
  source: ActivitySource;
  symbol: string | null;
  title: string;
  outcome: string;
  tone: "ok" | "bad" | "warn" | "info" | "muted";
  url: string | null;
  classification?: string;
}

export const ACTIVITY_INTERVAL_MS = 20_000;
export const MIRROR_INTERVAL_MS = 60_000;
export const ACTIVITY_LIMIT = 30;

export const SOURCE_LABEL: Record<ActivitySource, string> = {
  funded: "ALPHA PAPER", mirror: "STRATEGY MIRROR", system: "SYSTEM", device: "THIS DEVICE",
};

export async function fetchActivity(limit = ACTIVITY_LIMIT): Promise<ActivityItem[]> {
  const env = await api.get<{ ok: boolean; data?: { items: ActivityItem[] }; code?: string; message?: string }>(`/api/dashboard/events?limit=${limit}`);
  if (!env?.ok || !env.data || !Array.isArray(env.data.items)) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected events response");
  return env.data.items;
}

/** Newest first; ids unique (a later copy of the same id replaces the earlier one); capped. */
export function mergeActivity(server: ActivityItem[], local: ActivityItem[] = [], cap = ACTIVITY_LIMIT): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const it of [...local, ...server]) byId.set(it.id, it);
  return [...byId.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, cap);
}

export interface ActivityState {
  items: ActivityItem[] | null;
  error: string | null;
  mirror: MirrorOverview | null;
  /** When the events list was last fetched successfully. */
  at: number | null;
}

/** A connection change observed by this device (the only client-side item in the feed). */
export function deviceItem(kind: "lost" | "back", at = new Date().toISOString()): ActivityItem {
  return kind === "lost"
    ? { id: `D-off-${at}`, at, source: "device", symbol: null, title: "Worker connection lost", outcome: "Showing the last good data, marked stale.", tone: "warn", url: null }
    : { id: `D-on-${at}`, at, source: "device", symbol: null, title: "Worker reconnected", outcome: "Live data resumed.", tone: "ok", url: null };
}

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Polls the events (and, less often, the mirror overview) while mounted and the page is visible.
 * `reconnected` (from the dashboard store) adds a timestamped "Worker reconnected" item seen by this device.
 */
export function useActivity(reconnected: boolean, offline: boolean): ActivityState {
  const [state, setState] = useState<ActivityState>({ items: null, error: null, mirror: null, at: null });
  const local = useRef<ActivityItem[]>([]);
  const server = useRef<ActivityItem[]>([]);
  const wasOffline = useRef(false);

  useEffect(() => {
    if (offline && !wasOffline.current) {
      wasOffline.current = true;
      local.current = [...local.current, deviceItem("lost")].slice(-5);
      setState((s) => ({ ...s, items: mergeActivity(server.current, local.current) }));
    }
  }, [offline]);
  useEffect(() => {
    if (!reconnected) return;
    wasOffline.current = false;
    local.current = [...local.current, deviceItem("back")].slice(-5);
    setState((s) => ({ ...s, items: mergeActivity(server.current, local.current) }));
  }, [reconnected]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let lastMirror = 0;
    let running = false; // a visibility change never starts a second, overlapping request
    const tick = async () => {
      if (!alive || running) return;
      running = true;
      window.clearTimeout(timer);
      if (visible()) {
        try {
          server.current = await fetchActivity();
          if (alive) setState((s) => ({ ...s, items: mergeActivity(server.current, local.current), error: null, at: Date.now() }));
        } catch (e) {
          if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Events unavailable" }));
        }
        if (Date.now() - lastMirror >= MIRROR_INTERVAL_MS) {
          lastMirror = Date.now();
          try {
            const m = await fetchMirrorOverview();
            if (alive) setState((s) => ({ ...s, mirror: m }));
          } catch {
            /* the mirror line is simply omitted */
          }
        }
      }
      running = false;
      if (alive) timer = window.setTimeout(tick, ACTIVITY_INTERVAL_MS);
    };
    void tick();
    const onVis = () => {
      if (visible() && alive) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return state;
}
