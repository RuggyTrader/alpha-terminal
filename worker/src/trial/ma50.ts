// Candidate B (research round 2): BTCUSD daily, 50-day SMA trend, LONG only. FROZEN for the forward PAPER trial.
// The decision rules are the research implementation (engine/src/research/r2.mjs, family "ma", long only) line for
// line; `replayBars` reproduces the research backtest exactly (parity test: worker/test/trial_parity.test.mjs). The live
// trial (trial.ts) uses the same functions with minute-level execution instead of daily-bar execution.

export interface Candle { t: number; o: number; h: number; l: number; c: number } // t = candle open, ms UTC

export const PARAMS = Object.freeze({
  strategy: "BTC-MA50-LONG", version: 1, symbol: "BTCUSD", pair: "XBTUSD", timeframe: "1d",
  sma: 50, atr: 14, stopAtr: 3, trailAtr: 3, riskPct: 2, // risk = 2 % of current strategy equity per trade
  feePct: 0.2, slipPct: 0.05, minQty: 0.00006, minCost: 0.5, qtyStep: 1e-8, startEquityUsd: 100, // minimums: Kraken XBTUSD AssetPairs, 2026-11-15
  long: true, short: false, leverage: false,
});
export type Params = typeof PARAMS;
/** A stable fingerprint of the frozen settings (recorded with the trial account; any change is a different strategy). */
export const paramsKey = (p: Params = PARAMS) => JSON.stringify(p);

// ---- indicators: exactly the research formulas -------------------------------------------------------------------
export function sma(xs: number[], n: number): (number | null)[] {
  return xs.map((_, i) => (i + 1 < n ? null : xs.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n));
}
/** Wilder ATR seeded with the first true range (as research r2.mjs). */
export function atr(K: Candle[], n: number): (number | null)[] {
  const tr = K.map((k, i) => (i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - K[i - 1].c), Math.abs(k.l - K[i - 1].c))));
  let a: number | null = null;
  return tr.map((v, i) => { a = a === null ? v : (a * (n - 1) + v) / n; return i + 1 < n ? null : a; });
}
export function indicators(K: Candle[], p: Params = PARAMS) { return { S: sma(K.map((k) => k.c), p.sma), A: atr(K, p.atr) }; }

/** At a completed daily close: long entry while flat if close > SMA; exit while long if close < SMA. */
export function signalAt(K: Candle[], S: (number | null)[], i: number) {
  const s = S[i];
  return { enter: s !== null && K[i].c > s, exit: s !== null && K[i].c < s };
}

/** Entry sizing at the actual fill price: protective stop = fill − 3 × ATR(signal day); risk 2 % of equity; no leverage. */
export function sizeEntry(cash: number, entry: number, atrSignal: number, p: Params = PARAMS):
  { ok: true; qty: number; stop: number; notional: number; fee: number; riskUsd: number } | { ok: false; code: string; qty: number } {
  const stop = entry - p.stopAtr * atrSignal, dist = Math.abs(entry - stop), f = p.feePct / 100;
  let qty = Math.min((cash * p.riskPct / 100) / dist, cash / (entry * (1 + f)));
  qty = Math.floor(qty / p.qtyStep) * p.qtyStep;
  if (qty < p.minQty || qty * entry < p.minCost) return { ok: false, code: "BELOW_VENUE_MINIMUM", qty };
  const notional = qty * entry;
  return { ok: true, qty, stop, notional, fee: notional * f, riskUsd: qty * dist };
}
/** Trailing stop after a daily close: 3 × ATR below the best close; it can only rise (never loosened). */
export function trailedStop(stop: number, bestClose: number, atrNow: number | null, p: Params = PARAMS) {
  if (!(p.trailAtr > 0) || atrNow === null) return stop;
  return Math.max(stop, bestClose - p.trailAtr * atrNow);
}
/** A sell-stop hit on a candle: at the stop, or at the open if the candle gapped below it; then slippage. */
export const stopFill = (open: number, stop: number, p: Params = PARAMS) => Math.min(open, stop) * (1 - p.slipPct / 100);
export const marketBuy = (price: number, p: Params = PARAMS) => price * (1 + p.slipPct / 100);
export const marketSell = (price: number, p: Params = PARAMS) => price * (1 - p.slipPct / 100);

// ---- research-parity replay (daily-bar execution, as the research backtest) ----------------------------------------
export interface ReplayTrade { entryT: number; exitT: number; entry: number; exit: number; qty: number; gross: number; fees: number; net: number; reason: string }
export function replayBars(K: Candle[], o: { fromMs: number; toMs: number; capital?: number; p?: Params }) {
  const p = o.p ?? PARAMS, { S, A } = indicators(K, p), f = p.feePct / 100;
  let cash = o.capital ?? p.startEquityUsd, pendingEnter = false, pendingExit = false, skipped = 0;
  let pos: { t: number; entry: number; qty: number; stop: number; best: number; collateral: number; entryFee: number } | null = null;
  const trades: ReplayTrade[] = [];
  const close = (t: number, px: number, reason: string) => {
    const exitPx = marketSell(px, p), gross = (exitPx - pos!.entry) * pos!.qty, exitFee = exitPx * pos!.qty * f;
    cash += pos!.collateral + gross - exitFee;
    trades.push({ entryT: pos!.t, exitT: t, entry: pos!.entry, exit: exitPx, qty: pos!.qty, gross, fees: pos!.entryFee + exitFee, net: gross - pos!.entryFee - exitFee, reason });
    pos = null;
  };
  for (let i = 1; i < K.length; i++) {
    const k = K[i];
    if (k.t >= o.toMs) break;
    const live = k.t >= o.fromMs;
    if (pos && pendingExit) { close(k.t, k.o, "signal"); pendingExit = false; }
    if (!pos && pendingEnter && live) {
      const a = A[i - 1];
      if (a !== null) {
        const entry = marketBuy(k.o, p), sz = sizeEntry(cash, entry, a, p);
        if (!sz.ok) skipped++;
        else { cash -= sz.notional + sz.fee; pos = { t: k.t, entry, qty: sz.qty, stop: sz.stop, best: entry, collateral: sz.notional, entryFee: sz.fee }; }
      }
    }
    pendingEnter = false;
    if (pos && k.l <= pos.stop) close(k.t, Math.min(k.o, pos.stop), "stop");
    if (pos) {
      pos.best = Math.max(pos.best, k.c);
      pos.stop = trailedStop(pos.stop, pos.best, A[i], p);
      if (signalAt(K, S, i).exit) pendingExit = true;
    } else if (live && signalAt(K, S, i).enter) pendingEnter = true;
  }
  const last = K.findLastIndex((k) => k.t < o.toMs);
  if (pos && last >= 0) close(K[last].t + 86_400_000, K[last].c, "window_end");
  return { trades, end: cash, skipped };
}
