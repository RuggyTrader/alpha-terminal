// S3 research-only forward SHADOW test (migration 0010): a fully SIMULATED $100 account, BTC $50 + ETH $50 sleeves,
// re-sized by the frozen S3 rule (./s3.ts). Run by the Worker's existing every-minute scheduled job; it does nothing
// until the owner activates it, and it never reads or writes the production portfolio or any funded PAPER ledger.
//
// Execution model (simulated; nothing is sent to an exchange), the same as the research backtest and the 0008 trial:
//   * Daily close (00:00 UTC, one minute of grace): the completed Kraken daily candles are validated; for each asset
//     the S3 target weight is computed from bars up to that close; a re-size creates a MARKET order accepted now.
//   * A market order fills at the OPEN of the first Kraken candle that STARTS at or after its acceptance, +/- 0.05 %
//     slippage, 0.20 % fee on the fill, quantity floored to Kraken's lot step (1e-8). Below Kraken's minimum quantity
//     (BTC 0.00006, ETH 0.002) or cost ($0.50) a partial re-size is SKIPPED and recorded; a full exit always trades.
//   * After an outage, pending orders fill from Kraken's history at the first candle after acceptance (coarser
//     candles when 1-minute history no longer reaches back, recorded). Decisions from daily closes missed during an
//     outage are recorded as MISSED, never back-dated.
//   * Each close records the signal (close, SMA, volatility, target, actual weight) per asset and the account's
//     equity, daily return, peak and drawdown. Drawdown ALERTS at 2 % and 30 % are recorded and reported; they are
//     NOT trading limits and never stop or change the simulation.
import { PARAMS, planOrder, signalAt, wantsOrder, type Asset, type Candle } from "./s3";
import { krakenOhlc, type OhlcFn, type TrialEnv } from "./trial";

export const S3_ACCOUNT_ID = "TRIAL-S3-SHADOW";
export const ALERT_LEVELS_PCT = Object.freeze([2, 30]);
const ASSETS: Asset[] = ["BTC", "ETH"];
const DAY = 86_400_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const A = S3_ACCOUNT_ID;

export type OhlcForPair = (pair: string) => OhlcFn;
/** minUsd: null = Kraken's own rule (default). A number per asset reproduces the research backtest's fixed minimum. */
export interface S3Options { minUsd?: Record<Asset, number> | null; round?: boolean }

interface Acct { status: string; last_daily_t: number | null }
interface Sleeve { asset: Asset; pair: string; cash_usd: number; qty: number; last_target: number }
interface Ord { order_id: string; asset: Asset; target: number; accepted_at: string }

const event = (db: D1Database, nowMs: number, kind: string, detail: unknown) =>
  db.prepare(`INSERT INTO trial_events (account_id, at, kind, detail_json) VALUES (?, ?, ?, ?)`).bind(A, iso(nowMs), kind, JSON.stringify(detail ?? null));

/** One scheduled run. Idempotent and safe to overlap (lock); everything it does is recorded. */
export async function runS3Shadow(env: TrialEnv, nowMs = Date.now(), ohlcFor: OhlcForPair = (pair) => krakenOhlc(env, nowMs, pair), opts: S3Options = {}) {
  const db = env.DB;
  const has = await db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'trial_alloc_sleeves'`).first().catch(() => null);
  if (!has) return { ran: false, reason: "not installed" };
  const acct0 = await db.prepare(`SELECT status, last_daily_t FROM trial_accounts WHERE account_id = ? AND status = 'ACTIVE'`).bind(A).first<Acct>();
  if (!acct0) return { ran: false, reason: "not active" };
  // The common case costs two reads: nothing pending and no daily close due -> nothing to do, nothing written.
  if (acct0.last_daily_t !== null && nowMs < acct0.last_daily_t + 2 * DAY + MIN) {
    const p = await db.prepare(`SELECT COUNT(*) AS n FROM trial_alloc_orders WHERE account_id = ? AND status = 'PENDING'`).bind(A).first<{ n: number }>();
    if (!p?.n) return { ran: false, reason: "idle (nothing pending, no daily close due)" };
  }
  const lock = await db.prepare(`UPDATE trial_accounts SET lock_until = ? WHERE account_id = ? AND (lock_until IS NULL OR lock_until < ?)`).bind(nowMs + 55_000, A, nowMs).run();
  if (!lock.meta.changes) return { ran: false, reason: "another run is in progress" };
  const log: string[] = [];
  try {
    await step(db, nowMs, ohlcFor, { minUsd: opts.minUsd ?? null, round: opts.round ?? true }, log);
    await db.prepare(`UPDATE trial_accounts SET lock_until = NULL, last_run_at = ?, last_error = NULL WHERE account_id = ?`).bind(iso(nowMs), A).run();
    return { ran: true, log };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
    await db.prepare(`UPDATE trial_accounts SET lock_until = NULL, last_run_at = ?, last_error = ? WHERE account_id = ?`).bind(iso(nowMs), msg, A).run();
    return { ran: true, error: msg, log };
  }
}

async function step(db: D1Database, nowMs: number, ohlcFor: OhlcForPair, o: Required<S3Options>, log: string[]) {
  const sleeves = async () => (await db.prepare(`SELECT asset, pair, cash_usd, qty, last_target FROM trial_alloc_sleeves WHERE account_id = ? ORDER BY asset`).bind(A).all<Sleeve>()).results;
  const daily = new Map<Asset, Candle[]>();
  const getDaily = async (s: Sleeve[]) => {
    for (const x of s) {
      if (daily.has(x.asset)) continue;
      const r = await ohlcFor(x.pair)(1440, null);
      if (!r.ok) { await event(db, nowMs, "MARKET_DATA_UNAVAILABLE", { asset: x.asset, interval: "1d", message: r.message }).run(); return false; }
      const gap = r.candles.findIndex((k, i) => i > 0 && k.t - r.candles[i - 1].t !== DAY);
      if (gap > 0) { await event(db, nowMs, "DATA_GAP", { asset: x.asset, interval: "1d", after: iso(r.candles[gap - 1].t) }).run(); return false; }
      daily.set(x.asset, r.candles);
    }
    return true;
  };
  let acct = (await db.prepare(`SELECT status, last_daily_t FROM trial_accounts WHERE account_id = ?`).bind(A).first<Acct>())!;
  // Start: the first decision is the first daily close AFTER activation (a forward test acts on nothing before it).
  if (acct.last_daily_t === null) {
    const s = await sleeves();
    if (!(await getDaily(s))) return;
    const last = Math.min(...s.map((x) => daily.get(x.asset)!.at(-1)!.t));
    await db.batch([
      db.prepare(`UPDATE trial_accounts SET last_daily_t = ? WHERE account_id = ?`).bind(last, A),
      event(db, nowMs, "TRIAL_STARTED", { first_decision_at: iso(last + 2 * DAY), last_completed_day: iso(last), params: PARAMS, alerts_drawdown_pct: ALERT_LEVELS_PCT }),
    ]);
    log.push(`started; first decision at ${iso(last + 2 * DAY)}`);
    return;
  }
  // 1) pending market orders fill first (a daily close is never processed while an earlier order is unfilled)
  if (!(await fillPending(db, nowMs, ohlcFor, o, log))) return;
  // 2) due daily closes, at most 3 per run (D1 queries per invocation are limited)
  for (let guard = 0; guard < 3; guard++) {
    acct = (await db.prepare(`SELECT status, last_daily_t FROM trial_accounts WHERE account_id = ?`).bind(A).first<Acct>())!;
    const day = acct.last_daily_t! + DAY;
    if (nowMs < day + DAY + MIN) break;
    const s = await sleeves();
    if (!(await getDaily(s))) break;
    const idx = s.map((x) => daily.get(x.asset)!.findIndex((k) => k.t === day));
    if (idx.some((i) => i < 0)) { await event(db, nowMs, "DAILY_CANDLE_MISSING", { day: iso(day) }).run(); break; }
    const latest = s.every((x) => daily.get(x.asset)!.at(-1)!.t === day);
    await dailyClose(db, nowMs, day, s, s.map((x, j) => ({ K: daily.get(x.asset)!, i: idx[j] })), latest, log);
    if (latest) break;
  }
}

/** Fill every pending order at the open of the first candle starting at or after its acceptance. false = still waiting. */
async function fillPending(db: D1Database, nowMs: number, ohlcFor: OhlcForPair, o: Required<S3Options>, log: string[]) {
  const pend = (await db.prepare(`SELECT order_id, asset, target, accepted_at FROM trial_alloc_orders WHERE account_id = ? AND status = 'PENDING' ORDER BY accepted_at, asset`).bind(A).all<Ord>()).results;
  let done = true;
  for (const ord of pend) {
    const acc = Date.parse(ord.accepted_at);
    // Kraken keeps its 720 most recent candles per interval: the finest interval whose history still reaches back.
    const backMin = (nowMs - acc) / MIN;
    const interval = backMin <= 11 * 60 ? 1 : backMin <= 7 * 1440 ? 15 : backMin <= 29 * 1440 ? 60 : 1440;
    const sl = (await db.prepare(`SELECT asset, pair, cash_usd, qty, last_target FROM trial_alloc_sleeves WHERE account_id = ? AND asset = ?`).bind(A, ord.asset).first<Sleeve>())!;
    const r = await ohlcFor(sl.pair)(interval, acc);
    if (!r.ok) { await event(db, nowMs, "MARKET_DATA_UNAVAILABLE", { asset: ord.asset, interval: `${interval}m`, message: r.message }).run(); done = false; continue; }
    const k = r.candles.find((c) => c.t >= acc);
    if (!k) { done = false; continue; } // the first candle after acceptance has not completed yet
    const a = PARAMS.assets[ord.asset];
    const x = planOrder(sl.cash_usd, sl.qty, ord.target, k.o, ord.asset, { minUsd: o.minUsd ? o.minUsd[ord.asset] : null, round: o.round });
    const late = Math.max(0, Math.round((nowMs - (k.t + interval * MIN)) / MIN));
    if (!x) {
      await db.prepare(`UPDATE trial_alloc_orders SET status = 'CANCELLED', ref_open = ?, recorded_at = ?, note = 'no change needed at the fill price' WHERE order_id = ? AND status = 'PENDING'`).bind(k.o, iso(nowMs), ord.order_id).run();
      continue;
    }
    const filled = x.qty > 0 && x.ok;
    const stmts = [
      db.prepare(`UPDATE trial_alloc_orders SET status = ?, side = ?, fill_candle_t = ?, fill_interval_min = ?, ref_open = ?, fill_price = ?, qty_raw = ?, qty = ?, notional_usd = ?, fee_usd = ?,
                  min_qty = ?, min_cost = ?, min_usd = ?, full_exit = ?, recorded_at = ?, recorded_late_min = ?, note = ? WHERE order_id = ? AND status = 'PENDING'`)
        .bind(filled ? "FILLED" : "SKIPPED_MIN", x.side, k.t, interval, k.o, x.px, x.qtyRaw, x.qty, x.notional, filled ? x.fee : 0, a.minQty, a.minCost, x.minUsd, x.fullExit ? 1 : 0, iso(nowMs), late,
          filled ? null : `below Kraken's minimum (${a.minQty} ${ord.asset} / $${a.minCost}${x.minUsd ? ` / $${x.minUsd}` : ""}): not traded`, ord.order_id),
    ];
    if (filled) {
      let cash = sl.cash_usd, qty = sl.qty;
      if (x.side === "BUY") { cash -= x.notional + x.fee; qty += x.qty; } else { cash += x.notional - x.fee; qty -= x.qty; }
      if (qty <= 1e-12) qty = 0;
      stmts.push(db.prepare(`UPDATE trial_alloc_sleeves SET cash_usd = ?, qty = ?, last_target = ? WHERE account_id = ? AND asset = ?`).bind(cash, qty, ord.target, A, ord.asset));
    }
    if (late > 5) stmts.push(event(db, nowMs, "FILL_RECORDED_LATE", { order: ord.order_id, candle: iso(k.t), interval_min: interval, late_min: late }));
    await db.batch(stmts);
    log.push(`${ord.asset} ${x.side} ${x.qty} @ ${x.px.toFixed(2)} ${filled ? "filled" : "SKIPPED (minimum)"} (${iso(k.t)})`);
  }
  return done;
}

/** A completed daily close for every asset: record the signal and the sleeve, decide re-sizes, mark the account. */
async function dailyClose(db: D1Database, nowMs: number, day: number, s: Sleeve[], bars: { K: Candle[]; i: number }[], latest: boolean, log: string[]) {
  const stmts: D1PreparedStatement[] = [];
  let equity = 0;
  s.forEach((x, j) => {
    const { K, i } = bars[j], k = K[i], sig = signalAt(K, i);
    const eqC = x.cash_usd + x.qty * k.c, actual = eqC > 0 ? (x.qty * k.c) / eqC : 0;
    equity += eqC;
    stmts.push(db.prepare(`INSERT OR REPLACE INTO trial_alloc_days (account_id, asset, day_t, close, sma, vol, target, actual_weight, cash_usd, qty, equity_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(A, x.asset, day, k.c, sig?.sma ?? null, sig?.vol ?? null, sig?.target ?? null, actual, x.cash_usd, x.qty, eqC));
    if (sig && wantsOrder(sig.target, actual, x.last_target) && (sig.target !== x.last_target || Math.abs(sig.target - actual) >= PARAMS.band)) {
      // A decision on a close processed after an outage is recorded, never back-dated into a market order.
      stmts.push(db.prepare(`INSERT OR IGNORE INTO trial_alloc_orders (order_id, account_id, asset, status, signal_candle_t, signal_close, sma, vol, target, actual_weight, accepted_at, recorded_at, note)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(`${A}-${x.asset}-${iso(day).slice(0, 10)}`, A, x.asset, latest ? "PENDING" : "MISSED", day, k.c, sig.sma, sig.vol, sig.target, actual, iso(nowMs), latest ? null : iso(nowMs),
          latest ? null : "decision from a close processed after an outage; market orders are never back-dated"));
      log.push(`${x.asset} ${latest ? "order" : "MISSED"}: target ${sig.target.toFixed(3)} vs actual ${actual.toFixed(3)} (${iso(day).slice(0, 10)})`);
    }
  });
  const prev = await db.prepare(`SELECT equity_usd, peak_usd, drawdown_pct FROM trial_alloc_equity WHERE account_id = ? AND day_t < ? ORDER BY day_t DESC LIMIT 1`).bind(A, day).first<{ equity_usd: number; peak_usd: number; drawdown_pct: number }>();
  const peak = Math.max(prev?.peak_usd ?? equity, equity), dd = peak > 0 ? (1 - equity / peak) * 100 : 0;
  const ret = prev ? (equity / prev.equity_usd - 1) * 100 : null;
  stmts.push(db.prepare(`INSERT OR REPLACE INTO trial_alloc_equity (account_id, day_t, equity_usd, peak_usd, drawdown_pct, return_pct) VALUES (?, ?, ?, ?, ?, ?)`).bind(A, day, equity, peak, dd, ret));
  for (const level of ALERT_LEVELS_PCT) {
    if (dd >= level && (prev?.drawdown_pct ?? 0) < level) {
      stmts.push(event(db, nowMs, "DRAWDOWN_ALERT", { level_pct: level, drawdown_pct: Math.round(dd * 100) / 100, equity_usd: Math.round(equity * 100) / 100, peak_usd: Math.round(peak * 100) / 100, day: iso(day),
        note: level === 2 ? "the owner's 2 % drawdown objective is exceeded (alert only; simulation continues)" : "30 % reporting threshold (alert only; NOT an approved trading risk limit; simulation continues)" }));
      log.push(`DRAWDOWN ALERT ${level}% (${dd.toFixed(2)}%)`);
    }
  }
  stmts.push(db.prepare(`UPDATE trial_accounts SET last_daily_t = ? WHERE account_id = ?`).bind(day, A));
  await db.batch(stmts);
}

/** Read-only report (GET /api/dashboard/trial/s3). A simulated research account: never part of the portfolio. */
export async function s3ShadowReport(db: D1Database) {
  const has = await db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'trial_alloc_sleeves'`).first().catch(() => null);
  if (!has) return { available: false };
  const a = await db.prepare(`SELECT account_id, name, status, strategy, activated_at, last_run_at, last_error, last_daily_t FROM trial_accounts WHERE account_id = ?`).bind(A).first<Record<string, unknown>>();
  if (!a) return { available: false };
  const sl = (await db.prepare(`SELECT asset, cash_usd, qty, last_target FROM trial_alloc_sleeves WHERE account_id = ? ORDER BY asset`).bind(A).all<Record<string, number & string>>()).results;
  const last = (await db.prepare(`SELECT asset, day_t, close, sma, vol, target, actual_weight, equity_usd FROM trial_alloc_days WHERE account_id = ? AND day_t = (SELECT MAX(day_t) FROM trial_alloc_days WHERE account_id = ?) ORDER BY asset`).bind(A, A).all()).results;
  const eq = (await db.prepare(`SELECT day_t, equity_usd, peak_usd, drawdown_pct, return_pct FROM trial_alloc_equity WHERE account_id = ? ORDER BY day_t`).bind(A).all<Record<string, number>>()).results;
  const counts = (await db.prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(fee_usd), 0) AS fees FROM trial_alloc_orders WHERE account_id = ? GROUP BY status`).bind(A).all<{ status: string; n: number; fees: number }>()).results;
  const orders = (await db.prepare(`SELECT order_id, asset, status, side, signal_candle_t, target, actual_weight, accepted_at, fill_candle_t, fill_interval_min, ref_open, fill_price, qty_raw, qty, notional_usd, fee_usd, min_qty, min_cost, min_usd, full_exit, recorded_late_min, note
                                     FROM trial_alloc_orders WHERE account_id = ? ORDER BY signal_candle_t DESC, asset LIMIT 40`).bind(A).all()).results;
  const events = (await db.prepare(`SELECT at, kind, detail_json FROM trial_events WHERE account_id = ? ORDER BY id DESC LIMIT 30`).bind(A).all()).results;
  const r2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const end = eq.at(-1)?.equity_usd ?? 100, maxDd = eq.reduce((m, e) => Math.max(m, e.drawdown_pct), 0);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  return {
    available: true,
    label: "S3 shadow test — a fully SIMULATED $100 research account; not part of your portfolio, its P&L, funding or any funded PAPER ledger. S3 is a candidate, not an approved strategy.",
    account: a, settings: { ...PARAMS, frozen: true },
    alerts: { drawdown_levels_pct: ALERT_LEVELS_PCT, note: "alerts only: 2 % is the owner's objective; 30 % is a reporting threshold, NOT an approved trading risk limit; neither stops the simulation" },
    equity: { start_usd: 100, equity_usd: r2(end), net_usd: r2(end - 100), return_pct: r2(end - 100), max_drawdown_pct: r2(maxDd), current_drawdown_pct: r2(eq.at(-1)?.drawdown_pct ?? 0), days: eq.length },
    sleeves: sl, latest_signals: last,
    orders: { filled: n("FILLED"), skipped_below_minimum: n("SKIPPED_MIN"), missed_after_outage: n("MISSED"), pending: n("PENDING"), fees_usd: r2(counts.reduce((s, c) => s + c.fees, 0)), recent: orders },
    equity_curve: eq.map((e) => [e.day_t, r2(e.equity_usd), r2(e.drawdown_pct)]),
    events,
  };
}
