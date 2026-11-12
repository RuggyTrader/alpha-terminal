// ONE shared source for GET /api/dashboard/bots (Home pipeline, Home performance selector, Bots, bot charts, ALPHA
// Assistant). Before this, each of them polled the same endpoint on its own timer.
//   * one request in flight at a time (concurrent callers share it);
//   * responses are applied in REQUEST order: an older response can never overwrite a newer snapshot;
//   * polling runs only while something is subscribed and the page is visible; it refreshes on reconnect
//     ("online") and when the page becomes visible again;
//   * invalidateFleet() after any owner action (allocation, risk, pause) refetches immediately;
//   * a failed refresh keeps the last good snapshot and reports its real age (never shown as live).

import { useEffect, useState } from "react";
import { fetchBots, type Fleet } from "./bots";

export interface FleetSnapshot {
  fleet: Fleet | null;
  error: string | null;
  /** When the snapshot shown was fetched (ms); null before the first success. */
  fetchedAt: number | null;
  /** True when the latest refresh failed and the snapshot shown is the last good one. */
  stale: boolean;
}

export const FLEET_POLL_MS = 20_000;

export function createFleetStore(fetcher: () => Promise<Fleet> = fetchBots, clock: () => number = Date.now) {
  let snap: FleetSnapshot = { fleet: null, error: null, fetchedAt: null, stale: false };
  let seq = 0;          // last request issued
  let applied = 0;      // last request whose result was applied
  let inflight: Promise<void> | null = null;
  const subs = new Set<(s: FleetSnapshot) => void>();
  const emit = () => subs.forEach((f) => f(snap));

  function refresh(force = false): Promise<void> {
    if (inflight && !force) return inflight;
    const mine = ++seq;
    const p = fetcher().then(
      (fleet) => { if (mine > applied) { applied = mine; snap = { fleet, error: null, fetchedAt: clock(), stale: false }; emit(); } },
      (e) => { if (mine > applied) { applied = mine; snap = { ...snap, error: String((e as Error)?.message ?? e), stale: snap.fleet !== null }; emit(); } },
    ).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }
  return {
    get: () => snap,
    refresh,
    /** After a mutation: fetch now, even if a (possibly older) request is in flight; that older one cannot win. */
    invalidate: () => refresh(true),
    subscribe(fn: (s: FleetSnapshot) => void) { subs.add(fn); return () => { subs.delete(fn); }; },
    subscribers: () => subs.size,
  };
}

const store = createFleetStore();
let timer: ReturnType<typeof setInterval> | null = null;
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
const onWake = () => { if (visible()) void store.refresh(); };

function start() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => { if (visible()) void store.refresh(); }, FLEET_POLL_MS);
  window.addEventListener("online", onWake);
  document.addEventListener("visibilitychange", onWake);
}
function stop() {
  if (!timer) return;
  clearInterval(timer); timer = null;
  window.removeEventListener("online", onWake);
  document.removeEventListener("visibilitychange", onWake);
}

export const invalidateFleet = () => store.invalidate();
export const refreshFleet = () => store.refresh();

/** The shared fleet snapshot. Subscribing starts the one poller; the last unsubscribe stops it. */
export function useFleet(): FleetSnapshot & { refresh: () => void } {
  const [s, setS] = useState<FleetSnapshot>(store.get());
  useEffect(() => {
    const off = store.subscribe(setS);
    start();
    const cur = store.get();
    if (!cur.fetchedAt || Date.now() - cur.fetchedAt > FLEET_POLL_MS / 2) void store.refresh();
    else setS(cur);
    return () => { off(); if (store.subscribers() === 0) stop(); };
  }, []);
  return { ...s, refresh: () => void store.refresh() };
}
