// Forward PAPER trial of Candidate B, run by the Worker's scheduled job every minute (always online: stops are
// monitored even when the engine PC is off). An ISOLATED research account (migration 0008): it never reads or writes
// the production portfolio.
//
// Execution model (simulated; NOT an exchange-native order):
//   * Daily close (00:00 UTC): the completed Kraken daily candle is validated; the trailing stop is raised (never
//     lowered); an exit / entry signal creates a MARKET order, accepted by this ledger at that moment.
//   * A market order fills at the OPEN of the first Kraken candle that STARTS at or after its acceptance (never the daily
//     open that happened before the order existed), plus slippage, with the fee on the fill.
//   * The protective / trailing stop is a simulated stop-market order checked on 1-minute Kraken candles: a candle whose
//     low reaches the stop fills at the stop, or at the candle's open if it gapped below (worse), minus slippage.
//   * After a gap in processing (Worker or Kraken outage) the missed minutes are replayed in order from Kraken's
//     history: 1-minute candles while available (about 12 h), then 15-minute (7.5 days), 60-minute (30 days). Stops
//     are evaluated on what exists and the fill records its candle interval and how late it was recorded. Market orders
//     are never back-dated: a signal from a day missed during an outage is recorded as missed, not traded.
import { PARAMS, indicators, marketBuy, marketSell, signalAt, sizeEntry, stopFill, trailedStop, type Candle } from "./ma50";

export { PARAMS };
export const ACCOUNT_ID = "TRIAL-BTC-MA50";
const DAY = 86_400_000, MIN = 60_000;
const µ = (usd: number) => Math.round(usd * 1e6);
const iso = (ms: number) => new Date(ms).toISOString();

export type OhlcFn = (intervalMin: number, sinceMs: number | null) => Promise<{ ok: true; candles: Candle[] } | { ok: false; message: string }>;
export interface TrialEnv { DB: D1Database; KRAKEN_API_BASE?: string }

const krakenBase = (b?: string) => (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test((b ?? "").replace(/\/+$/, "")) ? b!.replace(/\/+$/, "") : "https://api.kraken.com");

/** Completed, validated Kraken OHLC candles for `pair` (default XBTUSD; the forming candle is never returned). */
export function krakenOhlc(env: TrialEnv, nowMs: number, pair: string = PARAMS.pair): OhlcFn {
  return async (intervalMin, sinceMs) => {
    try {
      const since = sinceMs === null ? "" : `&since=${Math.floor(sinceMs / 1000) - intervalMin * 60}`;
      const r = await fetch(`${krakenBase(env.KRAKEN_API_BASE)}/0/public/OHLC?pair=${pair}&interval=${intervalMin}${since}`, { signal: AbortSignal.timeout(8000) });
      const raw = (await r.json()) as { error?: string[]; result?: Record<string, unknown> };
      if (raw.error?.length || !raw.result) return { ok: false, message: (raw.error ?? ["no result"]).join("; ").slice(0, 160) };
      const rows = Object.entries(raw.result).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1] as unknown[][] | undefined;
      if (!rows) return { ok: false, message: "no candle rows" };
      const step = intervalMin * MIN;
      const candles = rows.map((x) => ({ t: Number(x[0]) * 1000, o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]) })).filter((k) => k.t + step <= nowMs);
      const bad = validate(candles, step);
      return bad ? { ok: false, message: bad } : { ok: true, candles };
    } catch (e) { return { ok: false, message: String(e instanceof Error ? e.message : e).slice(0, 160) }; }
  };
}
/** null when the candles are usable: positive prices, consistent OHLC, strictly increasing on the interval grid. */
export function validate(K: Candle[], stepMs: number): string | null {
  for (let i = 0; i < K.length; i++) {
    const k = K[i];
    if (![k.o, k.h, k.l, k.c].every((v) => Number.isFinite(v) && v > 0)) return `invalid price in candle ${iso(k.t)}`;
    if (k.h < Math.max(k.o, k.c) || k.l > Math.min(k.o, k.c)) return `inconsistent OHLC in candle ${iso(k.t)}`;
    if (k.t % stepMs !== 0) return `candle ${iso(k.t)} is off the ${stepMs / MIN}-minute grid`;
    if (i > 0 && k.t <= K[i - 1].t) return `candles out of order at ${iso(k.t)}`;
  }
  return null;
}

interface Acct { account_id: string; status: string; cash_micro: number; start_equity_micro: number; last_daily_t: number | null; last_minute_t: number | null; activated_at: string | null }
interface Pos { position_id: string; qty: number; entry_price: number; entry_fee_micro: number; cost_micro: number; initial_stop: number; stop: number; stop_active_from: number; best_close: number; opened_candle_t: number; opened_at: string; risk_usd: number }
interface Ord { order_id: string; kind: "ENTRY" | "EXIT"; side: "BUY" | "SELL"; accepted_at: string; atr_signal: number | null; signal_candle_t: number }

const event = (db: D1Database, nowMs: number, kind: string, detail: unknown) =>
  db.prepare(`INSERT INTO trial_events (account_id, at, kind, detail_json) VALUES (?, ?, ?, ?)`).bind(ACCOUNT_ID, iso(nowMs), kind, JSON.stringify(detail ?? null));

/** One scheduled run. Idempotent and safe to overlap (lock); everything it does is recorded. */
export async function runTrial(env: TrialEnv, nowMs = Date.now(), ohlc: OhlcFn = krakenOhlc(env, nowMs)) {
  const db = env.DB;
  const has = await db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'trial_accounts'`).first().catch(() => null);
  if (!has) return { ran: false, reason: "not installed" };
  const acct0 = await db.prepare(`SELECT * FROM trial_accounts WHERE account_id = ? AND status = 'ACTIVE'`).bind(ACCOUNT_ID).first<Acct>();
  if (!acct0) return { ran: false, reason: "not active" };
  // The common case costs only reads: flat, nothing pending, no daily close due -> nothing to do, nothing written.
  if (acct0.last_daily_t !== null && nowMs < acct0.last_daily_t + 2 * DAY + MIN) {
    const busy = await db.prepare(`SELECT (SELECT COUNT(*) FROM trial_positions WHERE account_id = ? AND status = 'OPEN') + (SELECT COUNT(*) FROM trial_orders WHERE account_id = ? AND status = 'PENDING') AS n`).bind(ACCOUNT_ID, ACCOUNT_ID).first<{ n: number }>();
    if (!busy?.n) return { ran: false, reason: "idle (flat, nothing pending, no daily close due)" };
  }
  const lock = await db.prepare(`UPDATE trial_accounts SET lock_until = ? WHERE account_id = ? AND (lock_until IS NULL OR lock_until < ?)`).bind(nowMs + 55_000, ACCOUNT_ID, nowMs).run();
  if (!lock.meta.changes) return { ran: false, reason: "another run is in progress" };
  const log: string[] = [];
  try {
    const out = await step(db, nowMs, ohlc, log);
    await db.prepare(`UPDATE trial_accounts SET lock_until = NULL, last_run_at = ?, last_error = NULL WHERE account_id = ?`).bind(iso(nowMs), ACCOUNT_ID).run();
    return { ran: true, ...out, log };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
    await db.prepare(`UPDATE trial_accounts SET lock_until = NULL, last_run_at = ?, last_error = ? WHERE account_id = ?`).bind(iso(nowMs), msg, ACCOUNT_ID).run();
    return { ran: true, error: msg, log };
  }
}

async function step(db: D1Database, nowMs: number, ohlc: OhlcFn, log: string[]) {
  let acct = (await db.prepare(`SELECT * FROM trial_accounts WHERE account_id = ?`).bind(ACCOUNT_ID).first<Acct>())!;
  // Daily candles: needed at the start and whenever a daily close is due (one request per run at most).
  let daily: Candle[] | null = null;
  const getDaily = async () => {
    if (daily) return daily;
    const r = await ohlc(1440, null);
    if (!r.ok) { await event(db, nowMs, "MARKET_DATA_UNAVAILABLE", { interval: "1d", message: r.message }).run(); return null; }
    const gap = r.candles.findIndex((k, i) => i > 0 && k.t - r.candles[i - 1].t !== DAY);
    if (gap > 0) { await event(db, nowMs, "DATA_GAP", { interval: "1d", after: iso(r.candles[gap - 1].t) }).run(); return null; }
    daily = r.candles; return daily;
  };
  // Start: the trial begins at the first daily close AFTER activation (a forward test acts on nothing that came before).
  if (acct.last_daily_t === null) {
    const d = await getDaily(); if (!d || !d.length) return { started: false };
    const last = d.at(-1)!;
    await db.batch([
      db.prepare(`UPDATE trial_accounts SET last_daily_t = ?, last_minute_t = ? WHERE account_id = ?`).bind(last.t, last.t + DAY, ACCOUNT_ID),
      event(db, nowMs, "TRIAL_STARTED", { first_decision_at: iso(last.t + 2 * DAY), last_completed_day: iso(last.t), params: PARAMS }),
    ]);
    log.push(`started; first decision at ${iso(last.t + 2 * DAY)}`);
    return { started: true };
  }
  // At most 3 daily closes per run: Cloudflare's free plan allows 50 D1 queries per invocation (each day needs about 9);
  // after a long outage the next scheduled runs continue the catch-up minute by minute.
  for (let guard = 0; guard < 3; guard++) {
    acct = (await db.prepare(`SELECT * FROM trial_accounts WHERE account_id = ?`).bind(ACCOUNT_ID).first<Acct>())!;
    const nextDay = acct.last_daily_t! + DAY, closeAt = nextDay + DAY;
    const dayDue = nowMs >= closeAt + MIN; // one minute of grace for the exchange to finalise the daily candle
    const horizon = dayDue ? closeAt : nowMs;
    const reached = await intraday(db, acct, horizon, nowMs, ohlc, log);
    if (!dayDue || reached < closeAt) break; // intraday data not yet available up to the close: wait for the next run
    const d = await getDaily(); if (!d) break;
    const i = d.findIndex((k) => k.t === nextDay);
    if (i < 0) { await event(db, nowMs, "DAILY_CANDLE_MISSING", { day: iso(nextDay) }).run(); break; }
    await dailyClose(db, d, i, nowMs, d.at(-1)!.t === nextDay, log);
  }
  return {};
}

/** Intraday: fills of pending market orders and stop checks, in time order, up to `horizon`. Returns how far it got. */
async function intraday(db: D1Database, acct: Acct, horizon: number, nowMs: number, ohlc: OhlcFn, log: string[]): Promise<number> {
  const from = acct.last_minute_t ?? horizon;
  if (from >= horizon) return from;
  const pos0 = await db.prepare(`SELECT * FROM trial_positions WHERE account_id = ? AND status = 'OPEN'`).bind(ACCOUNT_ID).first<Pos>();
  const pend0 = (await db.prepare(`SELECT * FROM trial_orders WHERE account_id = ? AND status = 'PENDING' ORDER BY accepted_at`).bind(ACCOUNT_ID).all<Ord>()).results;
  if (!pos0 && !pend0.length) return horizon; // nothing to execute or protect (a new order records where checking starts)
  // Kraken keeps only its 720 most recent candles per interval: pick the finest interval whose history still reaches
  // back to the first unchecked moment (measured from NOW, not from the horizon).
  const backMin = (nowMs - from) / MIN;
  const interval = backMin <= 11 * 60 ? 1 : backMin <= 7 * 1440 ? 15 : backMin <= 29 * 1440 ? 60 : 1440;
  const r = await ohlc(interval, from);
  if (!r.ok) { await event(db, nowMs, "MARKET_DATA_UNAVAILABLE", { interval: `${interval}m`, message: r.message }).run(); return from; }
  const step = interval * MIN;
  // Every candle that ends after the last checked moment and by the horizon. After a long outage the first coarse candle
  // can overlap minutes already checked: it is included (conservative: a stop is never missed; the fill records its
  // candle interval).
  const K = r.candles.filter((k) => k.t + step > from && k.t + step <= horizon);
  let pos = pos0, pend = [...pend0], cash = acct.cash_micro, reached = from;
  for (const k of K) {
    // 1) market orders: the first candle starting at or after acceptance; its open (+/- slippage)
    for (const o of [...pend]) {
      if (k.t < Date.parse(o.accepted_at)) continue;
      pend = pend.filter((x) => x !== o);
      if (o.kind === "EXIT") {
        if (!pos) { await db.batch([db.prepare(`UPDATE trial_orders SET status = 'CANCELLED', code = 'NO_POSITION', recorded_at = ? WHERE order_id = ? AND status = 'PENDING'`).bind(iso(nowMs), o.order_id)]); continue; }
        const px = marketSell(k.o);
        cash = await closePosition(db, pos, cash, px, k, interval, "SIGNAL_EXIT", nowMs, o);
        log.push(`exit ${px.toFixed(2)} (${iso(k.t)})`); pos = null;
      } else {
        if (pos) { await db.batch([db.prepare(`UPDATE trial_orders SET status = 'CANCELLED', code = 'ALREADY_LONG', recorded_at = ? WHERE order_id = ? AND status = 'PENDING'`).bind(iso(nowMs), o.order_id)]); continue; }
        const entry = marketBuy(k.o), sz = sizeEntry(cash / 1e6, entry, o.atr_signal!);
        if (!sz.ok) {
          await db.batch([db.prepare(`UPDATE trial_orders SET status = 'CANCELLED', code = ?, ref_price = ?, recorded_at = ?, note = ? WHERE order_id = ? AND status = 'PENDING'`)
            .bind(sz.code, k.o, iso(nowMs), `size ${sz.qty} BTC is below Kraken's minimum (${PARAMS.minQty} BTC / $${PARAMS.minCost})`, o.order_id)]);
          continue;
        }
        const cost = µ(sz.notional), fee = µ(sz.fee);
        pos = { position_id: o.order_id, qty: sz.qty, entry_price: entry, entry_fee_micro: fee, cost_micro: cost, initial_stop: sz.stop, stop: sz.stop, stop_active_from: k.t, best_close: entry, opened_candle_t: k.t, opened_at: iso(k.t), risk_usd: sz.riskUsd };
        cash -= cost + fee;
        await db.batch([
          db.prepare(`UPDATE trial_orders SET status = 'FILLED', fill_candle_t = ?, fill_interval_min = ?, ref_price = ?, fill_price = ?, slip_pct = ?, qty = ?, fee_micro = ?, filled_at = ?, recorded_at = ? WHERE order_id = ? AND status = 'PENDING'`)
            .bind(k.t, interval, k.o, entry, PARAMS.slipPct, sz.qty, fee, iso(k.t), iso(nowMs), o.order_id),
          db.prepare(`INSERT INTO trial_positions (position_id, account_id, status, qty, entry_price, entry_fee_micro, cost_micro, initial_stop, stop, stop_active_from, best_close, risk_usd, opened_candle_t, opened_at)
                      VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(o.order_id, ACCOUNT_ID, sz.qty, entry, fee, cost, sz.stop, sz.stop, k.t, entry, sz.riskUsd, k.t, iso(k.t)),
          db.prepare(`UPDATE trial_accounts SET cash_micro = ? WHERE account_id = ?`).bind(cash, ACCOUNT_ID),
        ]);
        log.push(`entry ${sz.qty} @ ${entry.toFixed(2)} stop ${sz.stop.toFixed(2)} (${iso(k.t)})`);
      }
    }
    // 2) the resting stop (from the entry candle on; a raised stop from the close at which it was raised)
    if (pos && k.t >= pos.stop_active_from && k.l <= pos.stop) {
      const px = stopFill(k.o, pos.stop);
      cash = await closePosition(db, pos, cash, px, k, interval, pos.stop > pos.initial_stop ? "TRAILING_STOP" : "PROTECTIVE_STOP", nowMs, null);
      log.push(`stop ${px.toFixed(2)} (${iso(k.t)})`); pos = null;
    }
    reached = k.t + step;
  }
  // Advance only over candles actually checked: a feed that lags never lets a stop be skipped.
  if (reached > from) await db.prepare(`UPDATE trial_accounts SET last_minute_t = ? WHERE account_id = ?`).bind(reached, ACCOUNT_ID).run();
  return reached;
}

async function closePosition(db: D1Database, pos: Pos, cash: number, px: number, k: Candle, interval: number, reason: string, nowMs: number, order: Ord | null) {
  const gross = (px - pos.entry_price) * pos.qty, exitFee = µ(px * pos.qty * PARAMS.feePct / 100);
  const proceeds = µ(px * pos.qty) - exitFee;
  const net = proceeds - pos.cost_micro - pos.entry_fee_micro;
  const exitAt = k.t + interval * MIN, late = Math.max(0, Math.round((nowMs - exitAt) / MIN));
  const newCash = cash + proceeds;
  const stmts = [
    db.prepare(`UPDATE trial_positions SET status = 'CLOSED', exit_price = ?, exit_fee_micro = ?, exit_reason = ?, exit_candle_t = ?, exit_interval_min = ?, closed_at = ?, gross_micro = ?, net_micro = ?, recorded_late_min = ? WHERE position_id = ? AND status = 'OPEN'`)
      .bind(px, exitFee, reason, k.t, interval, iso(k.t), µ(gross), net, late, pos.position_id),
    db.prepare(`UPDATE trial_accounts SET cash_micro = ? WHERE account_id = ?`).bind(newCash, ACCOUNT_ID),
  ];
  if (order) stmts.push(db.prepare(`UPDATE trial_orders SET status = 'FILLED', fill_candle_t = ?, fill_interval_min = ?, ref_price = ?, fill_price = ?, slip_pct = ?, qty = ?, fee_micro = ?, filled_at = ?, recorded_at = ? WHERE order_id = ? AND status = 'PENDING'`)
    .bind(k.t, interval, k.o, px, PARAMS.slipPct, pos.qty, exitFee, iso(k.t), iso(nowMs), order.order_id));
  if (late > 5) stmts.push(event(db, nowMs, "FILL_RECORDED_LATE", { position: pos.position_id, reason, candle: iso(k.t), interval_min: interval, late_min: late }));
  await db.batch(stmts);
  return newCash;
}

/** A completed daily close: raise the trailing stop (never lower it), then an exit or entry signal (latest day only). */
async function dailyClose(db: D1Database, D: Candle[], i: number, nowMs: number, latest: boolean, log: string[]) {
  const { S, A } = indicators(D);
  const k = D[i], closeAt = k.t + DAY, sig = signalAt(D, S, i);
  const pos = await db.prepare(`SELECT * FROM trial_positions WHERE account_id = ? AND status = 'OPEN'`).bind(ACCOUNT_ID).first<Pos>();
  const pending = (await db.prepare(`SELECT kind FROM trial_orders WHERE account_id = ? AND status = 'PENDING'`).bind(ACCOUNT_ID).all<{ kind: string }>()).results;
  const acct = (await db.prepare(`SELECT cash_micro FROM trial_accounts WHERE account_id = ?`).bind(ACCOUNT_ID).first<{ cash_micro: number }>())!;
  const stmts: D1PreparedStatement[] = [];
  const order = (kind: "ENTRY" | "EXIT") => {
    const id = `TRIAL-BTC-MA50-${iso(k.t).slice(0, 10)}-${kind}`;
    stmts.push(db.prepare(`INSERT OR IGNORE INTO trial_orders (order_id, account_id, kind, side, status, reason, signal_candle_t, signal_close, signal_sma, atr_signal, created_at, accepted_at)
                           VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, ACCOUNT_ID, kind, kind === "ENTRY" ? "BUY" : "SELL", kind === "ENTRY" ? "daily close above the 50-day average" : "daily close below the 50-day average",
        k.t, k.c, S[i], A[i], iso(nowMs), iso(nowMs)));
    log.push(`${kind} order on the ${iso(k.t).slice(0, 10)} close (${k.c} vs SMA ${S[i]?.toFixed(2)})`);
  };
  let qty = 0;
  if (pos) {
    qty = pos.qty;
    const best = Math.max(pos.best_close, k.c), stop = trailedStop(pos.stop, best, A[i]);
    if (stop > pos.stop) {
      stmts.push(db.prepare(`UPDATE trial_positions SET best_close = ?, stop = ?, stop_active_from = ? WHERE position_id = ? AND status = 'OPEN' AND ? > stop`).bind(best, stop, closeAt, pos.position_id, stop),
        db.prepare(`INSERT INTO trial_stop_changes (position_id, at_candle_t, old_stop, new_stop, best_close, atr, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(pos.position_id, k.t, pos.stop, stop, best, A[i], iso(nowMs)));
    } else if (best > pos.best_close) stmts.push(db.prepare(`UPDATE trial_positions SET best_close = ? WHERE position_id = ? AND status = 'OPEN'`).bind(best, pos.position_id));
    if (sig.exit && !pending.some((x) => x.kind === "EXIT")) { if (latest) order("EXIT"); else stmts.push(event(db, nowMs, "MISSED_SIGNAL", { day: iso(k.t), signal: "EXIT", note: "processed after an outage; market orders are never back-dated" })); }
  } else if (sig.enter && !pending.some((x) => x.kind === "ENTRY")) {
    if (latest && A[i] !== null) order("ENTRY"); else if (!latest) stmts.push(event(db, nowMs, "MISSED_SIGNAL", { day: iso(k.t), signal: "ENTRY", note: "processed after an outage; market orders are never back-dated" }));
  }
  const equity = acct.cash_micro + µ(qty * k.c);
  stmts.push(
    db.prepare(`INSERT OR REPLACE INTO trial_equity (account_id, day_t, close, cash_micro, position_qty, equity_micro) VALUES (?, ?, ?, ?, ?, ?)`).bind(ACCOUNT_ID, k.t, k.c, acct.cash_micro, qty, equity),
    // Intraday checking resumes from this close (a new order or a held position is watched from here on).
    db.prepare(`UPDATE trial_accounts SET last_daily_t = ?, last_minute_t = MAX(COALESCE(last_minute_t, 0), ?) WHERE account_id = ?`).bind(k.t, closeAt, ACCOUNT_ID),
  );
  await db.batch(stmts);
}
