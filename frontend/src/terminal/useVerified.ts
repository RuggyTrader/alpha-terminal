// Complete lifetime metrics refresh on changes in either funded ledger, with bounded recovery polling.
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { fetchPerformance } from "./api";
import { useDash } from "./store";
import { useFleet } from "./fleetStore";
import type { PerformanceData } from "./types";
export interface VerifiedState {
  status: "loading" | "ok" | "unsupported" | "error";
  data: PerformanceData | null;
  error: string | null;
  stale?: boolean;
}
const LOADING: VerifiedState = { status: "loading", data: null, error: null };
let cache: { key: string; value: VerifiedState; at: number } | null = null;
export function primeVerified(key: string, data: PerformanceData | null, status: VerifiedState["status"] = "ok"): void {
  cache = { key, value: { status, data, error: null }, at: Date.now() };
}
export function verifiedKey(closed: number, total: number, fleetKey = ""): string {
  return `${closed}|${total}${fleetKey ? `|${fleetKey}` : ""}`;
}
export function useVerified(): VerifiedState {
  const { state } = useDash();
  const { fleet } = useFleet();
  const counts = state.data?.counts.trades;
  const signature = fleet?.available ? fleet.bots.map(b => `${b.bot_id}:${b.paper.trades}:${b.paper.net_usd}`).join(",") : "";
  const key = counts ? verifiedKey(counts.closed, counts.total, signature) : null;
  const [v, setV] = useState<VerifiedState>(() => key && cache?.key === key ? cache.value : LOADING);
  useEffect(() => {
    if (!key) return;
    if (cache?.key === key && cache.value.status === "ok" && Date.now() - cache.at < 60_000) {
      setV(cache.value); return;
    }
    let live = true;
    fetchPerformance().then(data => {
      if (!live) return;
      const value: VerifiedState = { status: "ok", data, error: null, stale: false };
      cache = { key, value, at: Date.now() }; setV(value);
    }).catch((e: unknown) => {
      if (!live) return;
      const unsupported = e instanceof ApiError && e.status === 404;
      setV(old => ({ status: unsupported ? "unsupported" : "error", data: old.data,
        stale: old.data !== null, error: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e) }));
    });
    return () => { live = false; };
  }, [key, state.lastSuccessAt]);
  return v;
}
