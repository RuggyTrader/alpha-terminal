// Dashboard calls to the ALPHA TERMINAL Worker. The user signs in with the
// dashboard passphrase (Worker secret DASHBOARD_PASSPHRASE, separate from the
// admin credential); after that the browser sends only the HttpOnly session
// cookie, which it cannot read. The admin credential is never used here.

import { api, ApiError } from "../api/client";
import type { DashboardData, DashboardEnvelope, PerformanceData, TradeProof } from "./types";

export const DASHBOARD_LIMIT = 50;

export async function fetchDashboard(limit = DASHBOARD_LIMIT): Promise<DashboardData> {
  const env = await api.get<DashboardEnvelope>(`/api/dashboard?limit=${limit}`);
  if (!env || !env.ok || !env.data) {
    throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected dashboard response");
  }
  // Refuse to render anything that does not identify itself as PAPER.
  if (env.data.mode !== "PAPER") {
    throw new ApiError(502, "UNEXPECTED_MODE", `Backend reported mode ${String(env.data.mode)}, expected PAPER`);
  }
  return env.data;
}

export function checkSession(): Promise<unknown> {
  return api.get("/auth/session");
}

/** remember=true asks the server for a 30-day read-only session instead of 12 hours. */
export function login(passphrase: string, remember = false): Promise<unknown> {
  return api.post("/auth/login", { passphrase, remember_device: remember });
}

export function logout(): Promise<unknown> {
  return api.post("/auth/logout");
}

// ---- ALPHA PAPER portfolio actions (simulated; each needs the passphrase typed again) ----

import type { BacktestResult } from "./simulator";

/** A fresh id per user action, so a retried request can never apply twice. */
export const newRequestId = (): string =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

export interface PaperActionResult {
  ok: boolean;
  duplicate?: boolean;
  message?: string;
}

export function paperFund(action: "deposit" | "withdraw", amountUsd: number, requestId: string, passphrase: string) {
  return api.post<PaperActionResult>("/api/paper/fund", { action, amount_usd: amountUsd, request_id: requestId, passphrase });
}

export function paperTransfer(from: string, to: string, amountUsd: number, requestId: string, passphrase: string) {
  return api.post<PaperActionResult>("/api/paper/transfer", { from, to, amount_usd: amountUsd, request_id: requestId, passphrase });
}

export function paperApplyRisk(strategy: string, riskUsd: number, requestId: string, passphrase: string) {
  return api.post<PaperActionResult>("/api/paper/risk", { strategy, risk_usd: riskUsd, request_id: requestId, passphrase });
}

export async function fetchBacktest(strategy: string): Promise<{ cached_at: string; result: BacktestResult } | null> {
  const env = await api.get<{ ok: boolean; data: { cached_at: string; result: BacktestResult } | null }>(`/api/dashboard/backtest?strategy=${encodeURIComponent(strategy)}`);
  return env?.ok ? env.data : null;
}

// ---- Verified performance and trade proof (read-only) ----

export async function fetchPerformance(): Promise<PerformanceData> {
  const env = await api.get<{ ok: boolean; data?: PerformanceData; code?: string; message?: string }>("/api/dashboard/performance");
  if (!env?.ok || !env.data || !Array.isArray(env.data.trades)) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected performance response");
  return env.data;
}

export async function fetchTradeProof(id: number): Promise<TradeProof> {
  const env = await api.get<{ ok: boolean; data?: TradeProof; code?: string; message?: string }>(`/api/dashboard/trade-proof?id=${encodeURIComponent(String(id))}`);
  if (!env?.ok || !env.data) throw new ApiError(502, env?.code ?? "BAD_RESPONSE", env?.message ?? "Unexpected trade proof response");
  return env.data;
}
