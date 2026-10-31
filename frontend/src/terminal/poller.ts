// Dashboard refresh loop, kept free of React so it can be tested directly.
//
// * loads immediately on start(), then every `intervalMs` after the previous
//   request finishes (setTimeout chain: requests can never overlap)
// * refresh() while a request is in flight joins that request
// * a failed refresh keeps the last good data and marks it stale
// * 401 stops the loop and reports "unauthorized"

import { ApiError } from "../api/client";
import type { DashboardData } from "./types";

export type FeedStatus = "loading" | "ok" | "stale" | "error" | "unauthorized";

export interface FeedError {
  status: number;
  code: string;
  message: string;
}

export interface FeedState {
  status: FeedStatus;
  data: DashboardData | null;
  error: FeedError | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  inFlight: boolean;
}

export interface PollerOptions {
  intervalMs?: number;
  now?: () => number;
  onUnauthorized?: () => void;
}

export const DEFAULT_INTERVAL_MS = 7000;

export const initialFeedState: FeedState = {
  status: "loading",
  data: null,
  error: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  inFlight: false,
};

function toFeedError(e: unknown): FeedError {
  if (e instanceof ApiError) return { status: e.status, code: e.code, message: e.message };
  return { status: 0, code: "CLIENT_ERROR", message: e instanceof Error ? e.message : "Unknown error" };
}

export class DashboardPoller {
  private state: FeedState = initialFeedState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly fetcher: () => Promise<DashboardData>, private readonly opts: PollerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  getState = (): FeedState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<FeedState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.refresh();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.clearTimer();
    if (this.running) this.timer = setTimeout(() => void this.refresh(), this.intervalMs);
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.clearTimer();
    this.set({ inFlight: true, lastAttemptAt: this.now() });
    this.pending = this.fetcher()
      .then((data) => {
        this.set({ status: "ok", data, error: null, lastSuccessAt: this.now(), inFlight: false });
      })
      .catch((e: unknown) => {
        const error = toFeedError(e);
        if (error.status === 401) {
          this.running = false;
          this.set({ status: "unauthorized", error, inFlight: false });
          this.opts.onUnauthorized?.();
          return;
        }
        // Keep the last good snapshot visible, but mark it stale.
        this.set({ status: this.state.data ? "stale" : "error", error, inFlight: false });
      })
      .finally(() => {
        this.pending = null;
        this.schedule();
      });
    return this.pending;
  }
}
