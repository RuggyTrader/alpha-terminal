// One polling store for the whole app, so switching tabs never shows a loader:
// pages read the last real response immediately while fresh data loads.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { newMilestones, reachedMilestones, toastForEvent } from "../lib/derive";
import type {
  ActivityEvent, AlertBrief, EngineOverview, PositionsResponse, SettingsView, Summary, TradeRow,
} from "../types/api";
import { useToasts } from "../components/ToastManager";

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  updatedAt: number | null;
  loading: boolean;
}

const empty = <T,>(): Resource<T> => ({ data: null, error: null, updatedAt: null, loading: true });

type Key = "summary" | "engine" | "trades" | "alerts" | "positions" | "settings";

const SOURCES: Record<Key, { path: string; every: number }> = {
  summary: { path: "/api/summary", every: 8000 },
  engine: { path: "/api/engine", every: 8000 },
  trades: { path: "/api/trades?limit=500", every: 10000 },
  alerts: { path: "/api/alerts?limit=200", every: 12000 },
  positions: { path: "/api/positions", every: 12000 },
  settings: { path: "/api/settings", every: 60000 },
};

interface Store {
  summary: Resource<Summary>;
  engine: Resource<EngineOverview>;
  trades: Resource<{ trades: TradeRow[] }>;
  alerts: Resource<{ alerts: AlertBrief[] }>;
  positions: Resource<PositionsResponse>;
  settings: Resource<SettingsView>;
  activity: { events: ActivityEvent[]; error: ApiError | null; loaded: boolean; freshIds: Set<number> };
  refresh: (...keys: (Key | "activity")[]) => Promise<void>;
  celebrate: number; // increments when a real milestone is reached
}

const Ctx = createContext<Store | null>(null);

const MILESTONE_KEY = "alpha.milestones.v1";
function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(MILESTONE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}
function writeSeen(keys: string[]) {
  try { localStorage.setItem(MILESTONE_KEY, JSON.stringify(keys)); } catch { /* storage unavailable */ }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const toasts = useToasts();
  const [res, setRes] = useState<Record<Key, Resource<unknown>>>(() => ({
    summary: empty(), engine: empty(), trades: empty(), alerts: empty(), positions: empty(), settings: empty(),
  }));
  const [activity, setActivity] = useState<Store["activity"]>({ events: [], error: null, loaded: false, freshIds: new Set() });
  const [celebrate, setCelebrate] = useState(0);
  const lastActivityId = useRef<number | null>(null);

  const load = useCallback(async (key: Key) => {
    try {
      const data = await api.get<unknown>(SOURCES[key].path);
      setRes((r) => ({ ...r, [key]: { data, error: null, updatedAt: Date.now(), loading: false } }));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e));
      setRes((r) => ({ ...r, [key]: { ...r[key], error: err, loading: false } }));
    }
  }, []);

  const loadActivity = useCallback(async () => {
    const first = lastActivityId.current === null;
    try {
      const qs = first ? "?limit=100" : `?after_id=${lastActivityId.current}&limit=100`;
      const r = await api.get<{ events: ActivityEvent[] }>(`/api/activity${qs}`);
      if (r.events.length) {
        lastActivityId.current = Math.max(lastActivityId.current ?? 0, ...r.events.map((e) => e.id));
        if (!first) {
          // Only events that arrived after the dashboard opened can raise a banner.
          [...r.events].reverse().forEach((e) => {
            const t = toastForEvent(e);
            if (t) toasts.push(t);
          });
        }
      } else if (first) {
        lastActivityId.current = 0;
      }
      setActivity((a) => ({
        events: [...r.events, ...a.events].slice(0, 300),
        error: null,
        loaded: true,
        freshIds: first ? new Set() : new Set(r.events.map((e) => e.id)),
      }));
    } catch (e) {
      setActivity((a) => ({ ...a, error: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)), loaded: true }));
    }
  }, [toasts]);

  const refresh = useCallback(async (...keys: (Key | "activity")[]) => {
    const list = keys.length ? keys : ([...Object.keys(SOURCES), "activity"] as (Key | "activity")[]);
    await Promise.all(list.map((k) => (k === "activity" ? loadActivity() : load(k))));
  }, [load, loadActivity]);

  useEffect(() => {
    void refresh();
    const timers = (Object.keys(SOURCES) as Key[]).map((k) =>
      window.setInterval(() => { if (document.visibilityState === "visible") void load(k); }, SOURCES[k].every));
    timers.push(window.setInterval(() => { if (document.visibilityState === "visible") void loadActivity(); }, 4000));
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { timers.forEach((t) => window.clearInterval(t)); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh, load, loadActivity]);

  // Real milestones only, celebrated once per device.
  const trades = res.trades.data as { trades: TradeRow[] } | null;
  const summary = res.summary.data as Summary | null;
  useEffect(() => {
    if (!trades || !summary) return;
    const reached = reachedMilestones(trades.trades, summary.closed_trades);
    const seen = readSeen();
    const fresh = newMilestones(reached, seen);
    writeSeen(Array.from(new Set([...(seen ?? []), ...reached.map((m) => m.key)])));
    if (fresh.length) {
      fresh.forEach((m) => toasts.push({ key: `ms-${m.key}`, title: m.title, body: m.body, tone: "success" }));
      setCelebrate((c) => c + 1);
    }
  }, [trades, summary, toasts]);

  const value = useMemo<Store>(() => ({
    summary: res.summary as Resource<Summary>,
    engine: res.engine as Resource<EngineOverview>,
    trades: res.trades as Resource<{ trades: TradeRow[] }>,
    alerts: res.alerts as Resource<{ alerts: AlertBrief[] }>,
    positions: res.positions as Resource<PositionsResponse>,
    settings: res.settings as Resource<SettingsView>,
    activity,
    refresh,
    celebrate,
  }), [res, activity, refresh, celebrate]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}
