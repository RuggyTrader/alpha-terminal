// Home Activity feed: genuine events from GET /api/dashboard/events (trade events, signals, engine candles,
// observation gaps), plus the one thing only this device can observe: the Worker connection dropping and returning.
// Polled only while the Home page is visible, every ACTIVITY_INTERVAL_MS, never overlapping.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { fetchMirrorOverview, type MirrorOverview } from "./mirror";
import { aliasText } from "./botNames";

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

/** Recorded events, newest first. `before` (an item's `at`) pages back through older history: the Worker returns items
 *  recorded at or before it (bounded by `limit`); the caller drops the ids it already holds. Bot names in the Worker's
 *  text are shown with their display aliases (botNames.ts); ids, links and figures are untouched. */
export async function fetchActivity(limit = ACTIVITY_LIMIT, before: string | null = null): Promise<ActivityItem[]> {
  const q = `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const env = await api.get<{ ok: boolean; data?: { items: ActivityItem[] }; code?: string; message?: string }>(`/api/dashboard/events?${q}`);
  if (!env?.ok || !env.data || !Array.isArray(env.data.items)) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected events response");
  return env.data.items.map((it) => ({ ...it, title: aliasText(String(it.title ?? "")), outcome: aliasText(String(it.outcome ?? "")) }));
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
export function useActivity(reconnected: boolean, offline: boolean, limit = ACTIVITY_LIMIT): ActivityState {
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
          server.current = await fetchActivity(limit);
          if (alive) setState((s) => ({ ...s, items: mergeActivity(server.current, local.current, limit), error: null, at: Date.now() }));
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

// ---------------------------------------------------------------------------------------------------------------------
// Home ALPHA Activity: an ACCUMULATING, chronological stream (oldest first, newest at the bottom) of the same recorded
// events. The newest page is polled while visible; older pages are fetched only when the reader scrolls up
// (`before` cursor). Items are deduplicated by their recorded id. Strategy Mirror items are left to the Mirror pages.

export const STREAM_PAGE = 30;
export const STREAM_CAP = 600;

export interface StreamState {
  /** Oldest first. */
  items: ActivityItem[];
  loaded: boolean;
  error: string | null;
  at: number | null;
  loadingOlder: boolean;
  /** True once an older page brought nothing new: the recorded history ends here. */
  exhausted: boolean;
}

const chrono = (a: ActivityItem, b: ActivityItem) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Merges a page into the stream: unique ids (a newer copy replaces an older one), chronological, capped at the OLD
 *  end when `keep` is "newest" (live polling) or at the NEW end when "oldest" (reading history). */
export function mergeStream(cur: ActivityItem[], page: ActivityItem[], keep: "newest" | "oldest" = "newest", cap = STREAM_CAP): ActivityItem[] {
  // The newest page is authoritative for the time it covers: the Worker shows one item per execution (an accepted
  // order is replaced by its fill event once that is recorded), so an earlier copy it no longer lists is dropped.
  let base = cur;
  if (keep === "newest" && page.length) {
    const ids = new Set(page.map((x) => x.id));
    const from = page.reduce((m, x) => (x.at < m ? x.at : m), page[0].at);
    base = cur.filter((x) => x.source === "device" || x.at < from || ids.has(x.id));
  }
  const byId = new Map<string, ActivityItem>(base.map((x) => [x.id, x]));
  for (const x of page) byId.set(x.id, x);
  const all = [...byId.values()].sort(chrono);
  return all.length <= cap ? all : keep === "newest" ? all.slice(all.length - cap) : all.slice(0, cap);
}

export const forHome = (x: ActivityItem) => x.source !== "mirror";

export function useActivityStream(reconnected: boolean, offline: boolean, fetcher: typeof fetchActivity = fetchActivity) {
  const [st, setSt] = useState<StreamState>({ items: [], loaded: false, error: null, at: null, loadingOlder: false, exhausted: false });
  const items = useRef<ActivityItem[]>([]);
  const wasOffline = useRef(false);
  const apply = (next: ActivityItem[], patch: Partial<StreamState> = {}) => { items.current = next; setSt((s) => ({ ...s, ...patch, items: next })); };

  useEffect(() => {
    if (offline && !wasOffline.current) { wasOffline.current = true; apply(mergeStream(items.current, [deviceItem("lost")])); }
  }, [offline]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!reconnected) return;
    wasOffline.current = false;
    apply(mergeStream(items.current, [deviceItem("back")]));
  }, [reconnected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true, running = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!alive || running) return;
      running = true;
      window.clearTimeout(timer);
      if (visible()) {
        try {
          const page = (await fetcher(STREAM_PAGE)).filter(forHome);
          if (alive) apply(mergeStream(items.current, page, "newest"), { loaded: true, error: null, at: Date.now() });
        } catch (e) {
          if (alive) setSt((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : "Events unavailable" }));
        }
      }
      running = false;
      if (alive) timer = window.setTimeout(tick, ACTIVITY_INTERVAL_MS);
    };
    void tick();
    const onVis = () => { if (visible() && alive) void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = async () => {
    const oldest = items.current.find((x) => x.source !== "device");
    if (!oldest || st.loadingOlder || st.exhausted) return;
    setSt((s) => ({ ...s, loadingOlder: true }));
    try {
      const page = (await fetcher(STREAM_PAGE, oldest.at)).filter(forHome);
      const fresh = page.filter((x) => !items.current.some((y) => y.id === x.id));
      apply(mergeStream(items.current, fresh, "oldest"), { loadingOlder: false, exhausted: fresh.length === 0 });
    } catch (e) {
      setSt((s) => ({ ...s, loadingOlder: false, error: e instanceof Error ? e.message : "Older events unavailable" }));
    }
  };
  return { ...st, loadOlder };
}
