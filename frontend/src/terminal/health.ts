// Markets and system health from what the Worker actually reports. Pure functions.
// Unknown is never shown as healthy: missing data gives N/A, NOT CONFIGURED, STALE or OFFLINE.

import type { Tone } from "./classify";
import type { FeedState } from "./poller";
import type { DashboardData } from "./types";

export type HealthState = "HEALTHY" | "ACTIVE" | "DEGRADED" | "STALE" | "OFFLINE" | "STOPPED" | "NOT CONFIGURED" | "DISABLED" | "ERROR" | "N/A";

export interface HealthRow {
  key: string;
  name: string;
  state: HealthState;
  tone: Tone;
  detail: string;
}

const TONE: Record<HealthState, Tone> = {
  HEALTHY: "ok", ACTIVE: "ok", DEGRADED: "warn", STALE: "warn", OFFLINE: "bad", STOPPED: "muted",
  "NOT CONFIGURED": "muted", DISABLED: "muted", ERROR: "bad", "N/A": "muted",
};
const row = (key: string, name: string, state: HealthState, detail: string): HealthRow => ({ key, name, state, tone: TONE[state], detail });

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const tfMinutes = (tf: string | null | undefined): number | null => {
  const m = /^(\d+)\s*m?$/i.exec(tf ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * Age in seconds of the engine's newest COMPLETED candle, measured from its close. null when unknown.
 * last_candle_time is the candle's open time; the candle closes one interval later.
 */
export function candleAgeSeconds(d: DashboardData | null, now: number): number | null {
  const s = d?.bot?.status;
  const open = parse(s?.last_candle_time);
  const tf = tfMinutes(s?.timeframe);
  if (open === null || tf === null) return null;
  return Math.max(0, Math.round((now - (open + tf * 60_000)) / 1000));
}

/** A completed candle older than two intervals plus two minutes is stale (the engine polls every 20 s). */
export function candleFresh(d: DashboardData | null, now: number): boolean {
  const age = candleAgeSeconds(d, now);
  const tf = tfMinutes(d?.bot?.status?.timeframe);
  return age !== null && tf !== null && age <= tf * 2 * 60 + 120;
}

export interface MarketStatus {
  cls: "CRYPTO" | "STOCKS";
  state: HealthState;
  tone: Tone;
  provider: string;
  detail: string;
}

export function markets(d: DashboardData | null, now: number): MarketStatus[] {
  const bot = d?.bot ?? null;
  const s = bot?.status ?? null;
  let crypto: HealthState;
  let detail: string;
  if (!d) { crypto = "N/A"; detail = "No dashboard data"; }
  else if (!bot || bot.state === "NOT_RUNNING") { crypto = "STOPPED"; detail = "The legacy ALPHA 02 engine (SOLUSD 5m) has not reported; fleet bots report on the Bots page"; }
  else if (bot.state === "OFFLINE") { crypto = "OFFLINE"; detail = "The Kraken engine stopped reporting"; }
  else if (bot.state === "STALE") { crypto = "STALE"; detail = "The engine's last report is late"; }
  else if (!candleFresh(d, now)) { crypto = "DEGRADED"; detail = "Engine online, but its last Kraken candle is old"; }
  else { crypto = "ACTIVE"; detail = `${s?.symbol ?? "N/A"} ${s?.timeframe ?? ""} · completed candles`; }
  return [
    { cls: "CRYPTO", state: crypto, tone: TONE[crypto], provider: "Kraken", detail },
    // No stock data provider or stock strategy exists in this application. The optional Alpaca PAPER broker
    // panel is a brokerage account view, not a market data feed for any strategy.
    { cls: "STOCKS", state: "NOT CONFIGURED", tone: TONE["NOT CONFIGURED"], provider: "None", detail: "No stock data provider or stock strategy is connected" },
  ];
}

export function systemHealth(state: Pick<FeedState, "status" | "error" | "data">, now: number): HealthRow[] {
  const d = state.data;
  const bot = d?.bot ?? null;
  const s = bot?.status ?? null;
  const rows: HealthRow[] = [];

  // Backend API: the dashboard request itself.
  rows.push(
    state.status === "ok" ? row("api", "Backend API", "HEALTHY", "Cloudflare Worker answering")
      : state.status === "stale" ? row("api", "Backend API", "STALE", `Last refresh failed (${state.error?.code ?? "error"})`)
      : state.status === "loading" ? row("api", "Backend API", "N/A", "Connecting")
      : row("api", "Backend API", state.error?.status === 0 ? "OFFLINE" : "ERROR", state.error ? `${state.error.code}` : "No answer"),
  );

  // Database: the snapshot comes from D1; the ledger's accounting identities are rechecked on every read.
  if (!d) rows.push(row("db", "Database (D1)", "N/A", "No snapshot"));
  else if (d.portfolio && !d.portfolio.consistency.ok) rows.push(row("db", "Database (D1)", "ERROR", d.portfolio.consistency.issues[0] ?? "ledger consistency check failed"));
  else rows.push(row("db", "Database (D1)", "HEALTHY", d.portfolio ? "Connected · ledger consistency OK" : "Connected"));

  // Market data: Kraken candles (engine) and Kraken marks for open ledger positions (Worker).
  const err = s?.last_error;
  const marksStale = !!d?.paper?.performance.marks_stale;
  if (!d) rows.push(row("market", "Market data · Kraken", "N/A", "No snapshot"));
  else if (!bot || bot.state === "NOT_RUNNING") rows.push(row("market", "Market data · Kraken", "STOPPED", "No candles received (engine not running)"));
  else if (bot.state === "OFFLINE") rows.push(row("market", "Market data · Kraken", "OFFLINE", "No recent engine report"));
  else if (err && /market/i.test(err.where ?? "")) rows.push(row("market", "Market data · Kraken", "ERROR", err.message ?? "candle fetch failed"));
  else if (!candleFresh(d, now) || bot.state === "STALE") rows.push(row("market", "Market data · Kraken", "STALE", "Last completed candle is old"));
  else if (marksStale) rows.push(row("market", "Market data · Kraken", "DEGRADED", "Candles fresh; a ledger position mark failed"));
  else rows.push(row("market", "Market data · Kraken", "HEALTHY", `Last candle ${Math.round((candleAgeSeconds(d, now) ?? 0) / 60)} min after close`));

  // Scanner: the OTE engine evaluates every completed candle.
  if (!d) rows.push(row("scanner", "Strategy scanner · OTE", "N/A", "No snapshot"));
  else if (!bot || bot.state === "NOT_RUNNING") rows.push(row("scanner", "Strategy scanner · OTE", "STOPPED", "Engine not running"));
  else if (bot.state === "OFFLINE") rows.push(row("scanner", "Strategy scanner · OTE", "OFFLINE", `Last report ${bot.age_seconds ?? "?"} s ago`));
  else if (bot.state === "STALE") rows.push(row("scanner", "Strategy scanner · OTE", "STALE", `Last report ${bot.age_seconds ?? "?"} s ago`));
  else rows.push(row("scanner", "Strategy scanner · OTE", "HEALTHY", s?.status_text ?? "Running"));

  // Risk engine: server-side, PAPER only. A kill switch blocks new orders on the broker route.
  if (!d) rows.push(row("risk", "Risk engine", "N/A", "No snapshot"));
  else if (d.enable_trading || d.broker_submission || d.execution !== "DRY_RUN_ONLY") rows.push(row("risk", "Risk engine", "ERROR", "Backend reports a non-dry-run setting"));
  else rows.push(row("risk", "Risk engine", "HEALTHY", `Server-side checks on every signal · ${d.counts.risk.total} decisions recorded`));

  // PAPER execution: the ALPHA PAPER ledger and the engine's reconciliation against it.
  const lc = s?.ledger_check?.status ?? null;
  if (!d || !d.paper) rows.push(row("paper", "PAPER execution · ledger", d ? "N/A" : "N/A", d ? "Ledger not reported" : "No snapshot"));
  else if (lc === "DIVERGED") rows.push(row("paper", "PAPER execution · ledger", "ERROR", s?.ledger_check?.issues[0] ?? "Engine and ledger differ"));
  else if (lc === "UNVERIFIED") rows.push(row("paper", "PAPER execution · ledger", "DEGRADED", s?.ledger_check?.issues[0] ?? "Not checked against the ledger"));
  else if ((s?.outbox?.pending ?? 0) > 0) rows.push(row("paper", "PAPER execution · ledger", "DEGRADED", `${s?.outbox?.pending} signal(s) waiting to sync`));
  else if (lc === "OK") rows.push(row("paper", "PAPER execution · ledger", "HEALTHY", "Engine and ledger match"));
  else rows.push(row("paper", "PAPER execution · ledger", "N/A", "No reconciliation reported yet"));

  // Live / broker execution: must stay off.
  if (d) rows.push(d.enable_trading || d.broker_submission ? row("live", "Live execution", "ERROR", "Reported ON") : row("live", "Live execution", "DISABLED", "No broker orders are submitted"));
  return rows;
}
