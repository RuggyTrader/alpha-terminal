// Status of the local/VPS OTE engine (engine/), shown on the dashboard.
// POST /webhook/engine-status {secret, status} stores the engine's latest heartbeat in app_meta. It changes no
// position, order or alert, and it is authenticated with the same WEBHOOK_SECRET the engine uses for signals.
// The dashboard derives ONLINE / STALE / OFFLINE from the heartbeat's age on the server, so a stopped engine
// can never look alive.

import { botAvailableMicro, resolveOwner, statusKeys } from "./bots";
import { secureEqual } from "./trade_core";
import { getInstrument } from "./instruments";
import { engineSettingsExchange } from "./portfolio";

interface EngineStatusEnv {
  DB: D1Database;
  WEBHOOK_SECRET: string;
  MAX_ORDER_NOTIONAL?: string;
  MAX_POSITION_EXPOSURE?: string;
  MAX_TOTAL_EXPOSURE?: string;
  MAX_OPEN_POSITIONS?: string;
}

const KEY = "engine_status";
// Per-bot status keys (bots.ts statusKeys): engine_status:<bot id>; the legacy bot also keeps KEY.
const MAX_BYTES = 8192;

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
  const rej = s.last_rejection && typeof s.last_rejection === "object" ? (s.last_rejection as Record<string, unknown>) : null;
  const link = pos && pos.ledger && typeof pos.ledger === "object" ? (pos.ledger as Record<string, unknown>) : null;
  const LINK = ["MIRRORED", "PENDING", "NOT_IN_LEDGER", "UNVERIFIED", "DIVERGED"];
  const chk = s.ledger_check && typeof s.ledger_check === "object" ? (s.ledger_check as Record<string, unknown>) : null;
  const sz = s.sizing && typeof s.sizing === "object" ? (s.sizing as Record<string, unknown>) : null;
  const szLast = sz && sz.last && typeof sz.last === "object" ? (sz.last as Record<string, unknown>) : null;
  return {
    engine: str(s.engine, 40), version: str(s.version, 20), mode: "PAPER",
    symbol: str(s.symbol, 16), timeframe: str(s.timeframe, 8), strategy: str(s.strategy, 64),
    bot_name: str(s.bot_name, 40),
    started_at: isoOrNull(s.started_at), warmed_up_at: isoOrNull(s.warmed_up_at), last_poll_at: isoOrNull(s.last_poll_at),
    last_candle_time: isoOrNull(s.last_candle_time), last_candle_close: num(s.last_candle_close),
    candles_processed: num(s.candles_processed), status_text: str(s.status_text, 80), sync: s.sync === true,
    profile: str(s.profile, 40), risk_usd: num(s.risk_usd),
    settings_version: num(s.settings && typeof s.settings === "object" ? (s.settings as Record<string, unknown>).version : null),
    remote_settings: s.remote_settings === true,
    position: pos ? {
      side: pos.side === "LONG" || pos.side === "SHORT" ? pos.side : null, qty: num(pos.qty), entry: num(pos.entry),
      stop: num(pos.stop), tp2: num(pos.tp2), unrealized_at_last_close: num(pos.unrealized_at_last_close),
      ledger: link && LINK.includes(String(link.status)) ? { status: String(link.status), reason: str(link.reason, 160) } : null,
    } : null,
    trades: { closed: num(trades.closed), wins: num(trades.wins), losses: num(trades.losses), net_pnl: num(trades.net_pnl) },
    outbox: { pending: num(outbox.pending), accepted: num(outbox.accepted), rejected: num(outbox.rejected), skipped: num(outbox.skipped), late: num(outbox.late) },
    ledger_check: chk && ["OK", "DIVERGED", "UNVERIFIED"].includes(String(chk.status)) ? {
      status: String(chk.status), at: isoOrNull(chk.at),
      issues: Array.isArray(chk.issues) ? chk.issues.slice(0, 5).map((x) => str(x, 200)).filter((x): x is string => x !== null) : [],
    } : null,
    last_rejection: rej ? { id: str(rej.id, 80), action: str(rej.action, 8), status: str(rej.status, 12), code: str(rej.code, 40), reason: str(rej.reason, 200) } : null,
    last_error: err ? { at: isoOrNull(err.at), where: str(err.where, 20), message: str(err.message, 200) } : null,
    refused_entries: num(s.refused_entries),
    // Position sizing reported by the engine (display only; the Worker's own checks are unchanged).
    sizing: sz && (sz.mode === "fixed" || sz.mode === "percent") ? {
      mode: sz.mode, risk_pct: num(sz.risk_pct), risk_usd_fixed: num(sz.risk_usd_fixed), fee_pct: num(sz.fee_pct),
      max_risk_usd: num(sz.max_risk_usd), fixed_reason: str(sz.fixed_reason, 160), symbol: str(sz.symbol, 16),
      price_buffer_pct: num(sz.price_buffer_pct), min_qty: num(sz.min_qty), min_cost: num(sz.min_cost), capital_usd: num(sz.capital_usd),
      last: szLast ? {
        status: szLast.status === "SIZED" || szLast.status === "SKIPPED" ? szLast.status : null,
        code: str(szLast.code, 40), reason: str(szLast.reason, 200), side: szLast.side === "LONG" || szLast.side === "SHORT" ? szLast.side : null,
        entry: num(szLast.entry), stop: num(szLast.stop), qty: num(szLast.qty), risk_target_usd: num(szLast.risk_target_usd),
        risk_actual_usd: num(szLast.risk_actual_usd), notional_usd: num(szLast.notional_usd), required_capital_usd: num(szLast.required_capital_usd),
        capped: szLast.capped === true, capped_by: ["BALANCE", "ORDER_LIMIT", "POSITION_LIMIT", "TOTAL_EXPOSURE"].includes(String(szLast.capped_by)) ? String(szLast.capped_by) : null,
        fee_estimate_usd: num(szLast.fee_estimate_usd), current: szLast.current === true,
        risk_capped_by_max: szLast.risk_capped_by_max === true, spend_limit_usd: num(szLast.spend_limit_usd), min_order_cost_usd: num(szLast.min_order_cost_usd),
        checks: szLast.checks && typeof szLast.checks === "object" ? {
          min_qty: (szLast.checks as Record<string, unknown>).min_qty === true, min_cost: (szLast.checks as Record<string, unknown>).min_cost === true,
          buying_power: (szLast.checks as Record<string, unknown>).buying_power === true } : null,
        outcome: szLast.outcome === "FULL_RISK" || szLast.outcome === "REDUCED_TO_FIT" ? szLast.outcome : null,
        explanation: str(szLast.explanation, 240),
      } : null,
    } : null,
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
  const raw = body.status as Record<string, unknown>;
  const who = await resolveOwner(env.DB, { bot_id: raw.bot_id, timeframe: raw.timeframe }, status.symbol);
  if (!who.ok) return json({ ok: false, code: who.code, message: who.message }, 400);
  const record = { ...status, bot_id: who.owner || null, received_at: new Date().toISOString() };
  for (const key of who.bot ? statusKeys(who.bot) : [KEY]) {
    await env.DB.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(key, JSON.stringify(record)).run();
  }
  // Risk setting handshake: only engines that opted in (remote_settings) confirm and receive website settings.
  const settings = status.remote_settings
    ? await engineSettingsExchange(env.DB, status.symbol, (body.status as Record<string, unknown>).settings)
    : null;
  return json({ ok: true, mode: "PAPER", broker_request_sent: false, settings });
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

/**
 * POST /webhook/engine-ledger {secret, symbol, alert_ids?}: READ-ONLY view of the ALPHA PAPER ledger for the engine,
 * so it can verify what D1 really holds before claiming a position is mirrored, and learn the outcome of a signal
 * whose delivery was uncertain. Writes nothing.
 */
export async function handleEngineLedger(request: Request, env: EngineStatusEnv): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BYTES * 2) return json({ ok: false, code: "TOO_LARGE" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, code: "INVALID_JSON" }, 400);
  }
  if (typeof body.secret !== "string" || !(await secureEqual(body.secret, env.WEBHOOK_SECRET))) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  if (!getInstrument(symbol)) return json({ ok: false, code: "INVALID_SYMBOL" }, 400);
  const ids = Array.isArray(body.alert_ids) ? body.alert_ids : [];
  if (ids.length > 50 || !ids.every((x) => typeof x === "string" && /^[\x21-\x7E]{1,128}$/.test(x))) {
    return json({ ok: false, code: "INVALID_ALERT_IDS" }, 400);
  }
  // The requesting bot's own position (bots.ts); a pre-fleet engine (no bot_id) maps to its market's legacy bot.
  const who = await resolveOwner(env.DB, { bot_id: body.bot_id, timeframe: body.timeframe }, symbol);
  if (!who.ok) return json({ ok: false, code: who.code, message: who.message }, 400);
  const cols = `symbol, side, status, qty, avg_entry_price, open_alert_id, last_order_id, opened_at`;
  let position: Record<string, unknown> | null;
  try {
    position = await env.DB.prepare(`SELECT ${cols} FROM paper_positions WHERE bot_id = ? AND symbol = ? AND status = 'OPEN'`)
      .bind(who.owner, symbol).first();
  } catch (e) {
    // Before migration 0007 there is no owner column: one position per symbol, as always.
    if (!/no such column: bot_id/i.test(String(e instanceof Error ? e.message : e))) throw e;
    position = await env.DB.prepare(`SELECT ${cols} FROM paper_positions WHERE symbol = ? AND status = 'OPEN'`).bind(symbol).first();
  }
  const alerts: Record<string, { status: string; response_code: string | null; rejection_reason: string | null }> = {};
  if (ids.length) {
    const rows = await env.DB.prepare(
      `SELECT alert_id, status, response_code, rejection_reason FROM alerts WHERE alert_id IN (${ids.map(() => "?").join(",")})`
    ).bind(...(ids as string[])).all<{ alert_id: string; status: string; response_code: string | null; rejection_reason: string | null }>();
    for (const r of rows.results) alerts[r.alert_id] = { status: r.status, response_code: r.response_code, rejection_reason: r.rejection_reason };
  }
  // The strategy's ALPHA PAPER balance, so a small-account engine sizes from the same money the risk checks use.
  const wallet = await env.DB.prepare(`SELECT available_micro, reserved_micro FROM portfolio_wallets WHERE wallet = ?`)
    .bind(symbol).first<{ available_micro: number; reserved_micro: number }>();
  const maxOrder = Number(env.MAX_ORDER_NOTIONAL);
  const limit = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  // Exposure for the shared sizing engine (cost basis of open ALPHA PAPER positions): this market's and the account's.
  const exp = await env.DB.prepare(
    `SELECT COALESCE(SUM(qty * avg_entry_price * multiplier), 0) AS total, COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN symbol = ? THEN qty * avg_entry_price * multiplier ELSE 0 END), 0) AS position
     FROM paper_positions WHERE status = 'OPEN'`
  ).bind(symbol).first<{ total: number; n: number; position: number }>();
  const balance = wallet ? {
    wallet: symbol, available_usd: Number(wallet.available_micro) / 1e6, reserved_usd: Number(wallet.reserved_micro) / 1e6,
    max_order_notional_usd: Number.isFinite(maxOrder) && maxOrder > 0 ? maxOrder : null,
    max_position_exposure_usd: limit(env.MAX_POSITION_EXPOSURE), max_total_exposure_usd: limit(env.MAX_TOTAL_EXPOSURE),
    max_open_positions: limit(env.MAX_OPEN_POSITIONS),
    position_exposure_usd: Number(exp?.position ?? 0), total_exposure_usd: Number(exp?.total ?? 0), open_positions: Number(exp?.n ?? 0),
    // The bot's own share (migration 0007): what it may still reserve, given its allocation cap.
    ...(who.bot ? {
      bot_id: who.bot.bot_id,
      bot_reserved_usd: who.bot.reserved_micro / 1e6,
      bot_allocation_cap_usd: who.bot.allocation_cap_micro === null ? null : who.bot.allocation_cap_micro / 1e6,
      bot_available_usd: botAvailableMicro(who.bot, Number(wallet.available_micro)) / 1e6,
    } : {}),
  } : null;
  return json({ ok: true, mode: "PAPER", symbol, position: position ?? null, alerts, balance, read_only: true });
}
