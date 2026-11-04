// Status of the local/VPS OTE engine (engine/), shown on the dashboard.
// POST /webhook/engine-status {secret, status} stores the engine's latest heartbeat in app_meta. It changes no
// position, order or alert, and it is authenticated with the same WEBHOOK_SECRET the engine uses for signals.
// The dashboard derives ONLINE / STALE / OFFLINE from the heartbeat's age on the server, so a stopped engine
// can never look alive.

import { secureEqual } from "./trade_core";
import { getInstrument } from "./instruments";

interface EngineStatusEnv {
  DB: D1Database;
  WEBHOOK_SECRET: string;
}

const KEY = "engine_status";
const MAX_BYTES = 4096;

const json = (data: unknown, status = 200) => Response.json(data, { status });

const str = (v: unknown, max = 80): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isoOrNull = (v: unknown): string | null => {
  const s = str(v, 40);
  return s !== null && !Number.isNaN(Date.parse(s)) ? s : null;
};

/** Keeps only known fields with the right types; anything else in the payload is dropped. */
function clean(s: Record<string, unknown>) {
  const pos = s.position && typeof s.position === "object" ? (s.position as Record<string, unknown>) : null;
  const trades = s.trades && typeof s.trades === "object" ? (s.trades as Record<string, unknown>) : {};
  const outbox = s.outbox && typeof s.outbox === "object" ? (s.outbox as Record<string, unknown>) : {};
  const err = s.last_error && typeof s.last_error === "object" ? (s.last_error as Record<string, unknown>) : null;
  return {
    engine: str(s.engine, 40), version: str(s.version, 20), mode: "PAPER",
    symbol: str(s.symbol, 16), timeframe: str(s.timeframe, 8), strategy: str(s.strategy, 64),
    started_at: isoOrNull(s.started_at), warmed_up_at: isoOrNull(s.warmed_up_at), last_poll_at: isoOrNull(s.last_poll_at),
    last_candle_time: isoOrNull(s.last_candle_time), last_candle_close: num(s.last_candle_close),
    candles_processed: num(s.candles_processed), status_text: str(s.status_text, 80), sync: s.sync === true,
    position: pos ? {
      side: pos.side === "LONG" || pos.side === "SHORT" ? pos.side : null, qty: num(pos.qty), entry: num(pos.entry),
      stop: num(pos.stop), tp2: num(pos.tp2), unrealized_at_last_close: num(pos.unrealized_at_last_close),
    } : null,
    trades: { closed: num(trades.closed), wins: num(trades.wins), losses: num(trades.losses), net_pnl: num(trades.net_pnl) },
    outbox: { pending: num(outbox.pending), rejected: num(outbox.rejected), late: num(outbox.late) },
    last_error: err ? { at: isoOrNull(err.at), where: str(err.where, 20), message: str(err.message, 200) } : null,
  };
}

export async function handleEngineStatus(request: Request, env: EngineStatusEnv): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ ok: false, code: "TOO_LARGE" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400);
  }
  if (typeof body.secret !== "string" || !(await secureEqual(body.secret, env.WEBHOOK_SECRET))) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }
  const status = body.status && typeof body.status === "object" ? clean(body.status as Record<string, unknown>) : null;
  if (!status || !status.symbol || !getInstrument(status.symbol)) {
    return json({ ok: false, code: "INVALID_STATUS", message: "status.symbol must be a supported instrument" }, 400);
  }
  const record = { ...status, received_at: new Date().toISOString() };
  await env.DB.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(KEY, JSON.stringify(record)).run();
  return json({ ok: true, mode: "PAPER", broker_request_sent: false });
}

/** Latest engine status for the dashboard, with a server-side liveness verdict. */
export async function engineStatusForDashboard(env: { DB: D1Database }) {
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(KEY).first<{ value: string }>();
  if (!row) return { state: "NOT_RUNNING", age_seconds: null, status: null };
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(row.value);
  } catch {
    return { state: "NOT_RUNNING", age_seconds: null, status: null };
  }
  const age = Math.max(0, Math.round((Date.now() - Date.parse(String(s.received_at))) / 1000));
  const tfMin = Number(String(s.timeframe ?? "5").replace(/\D/g, "")) || 5;
  // ONLINE: heard from within two candles (+2 min slack); STALE: within 30 min; otherwise OFFLINE.
  const state = age <= tfMin * 120 + 120 ? "ONLINE" : age <= 1800 ? "STALE" : "OFFLINE";
  return { state, age_seconds: age, status: s };
}
