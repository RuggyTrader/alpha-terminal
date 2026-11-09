// Verified trade history, fetched once per change in the ledger's closed-trade count (not on every poll).

import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { fetchPerformance } from "./api";
import { useDash } from "./store";
import type { PerformanceData } from "./types";

export interface VerifiedState {
  /** unsupported: the deployed Worker predates this route. */
  status: "loading" | "ok" | "unsupported" | "error";
  data: PerformanceData | null;
  error: string | null;
}

const LOADING: VerifiedState = { status: "loading", data: null, error: null };
let cache: { key: string; value: VerifiedState } | null = null;

/** Test helper: provides the result for a dashboard snapshot without a network request. */
export function primeVerified(key: string, data: PerformanceData | null, status: VerifiedState["status"] = "ok"): void {
  cache = { key, value: { status, data, error: null } };
}

export function verifiedKey(closed: number, total: number): string {
  return `${closed}|${total}`;
}

export function useVerified(): VerifiedState {
  const { state } = useDash();
  const c = state.data?.counts.trades;
  const key = c ? verifiedKey(c.closed, c.total) : null;
  const [v, setV] = useState<VerifiedState>(() => (key && cache?.key === key ? cache.value : LOADING));

  useEffect(() => {
    if (!key) return;
    if (cache?.key === key && cache.value.status === "ok") {
      setV(cache.value);
      return;
    }
    let live = true;
    fetchPerformance()
      .then((data) => {
        const value: VerifiedState = { status: "ok", data, error: null };
        cache = { key, value };
        if (live) setV(value);
      })
      .catch((e: unknown) => {
        const unsupported = e instanceof ApiError && e.status === 404;
        const value: VerifiedState = { status: unsupported ? "unsupported" : "error", data: null, error: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e) };
        if (unsupported) cache = { key, value };
        if (live) setV(value);
      });
    return () => { live = false; };
  }, [key]);
  return v;
}
