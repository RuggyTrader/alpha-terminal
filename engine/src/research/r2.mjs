// RESEARCH ROUND 2: higher-timeframe strategy families for a ~$100 account. Separate from production execution.
//
// Execution model (conservative, bar data only):
//   * Signals are computed on a COMPLETED bar's close; entries and signal exits fill at the NEXT bar's open (market
//     order, taker fee) moved against us by `slip`.
//   * Protective / trailing stops are stop-market orders: a bar whose low (long) / high (short) reaches the stop fills at
//     the stop, or at the open if the bar gapped through it (worse), then `slip` against us. The stop is live from the
//     entry bar (a stop hit on the entry bar is filled there). Stops are only moved on bar closes.
//   * Fee `fee` % on EVERY fill (no maker pricing assumed). No leverage: notional <= cash. SHORT = fully collateralised
//     PAPER short (cash reserved = notional); borrowing / funding costs of a real short are NOT modelled.
//   * Size = riskPct % of the strategy's current equity / stop distance, capped by cash; skipped below the venue
//     minimum (Kraken: SOL 0.05, BTC 0.00005, cost >= $0.50). Gains are reinvested (risk follows equity).
//   * Equity is marked to market on every bar close (drawdown includes open-trade losses).
export const MIN = { SOL: { qty: 0.05, cost: 0.5 }, BTC: { qty: 0.00005, cost: 0.5 } };

// ------------------------------------------------------------------------------------------------ indicators
export const sma = (xs, n) => xs.map((_, i) => (i + 1 < n ? null : xs.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n));
export function ema(xs, n) { const a = 2 / (n + 1); let e = null; return xs.map((v, i) => (e = e === null ? v : e + a * (v - e), i + 1 < n ? null : e)); }
export function atr(K, n) {
  const tr = K.map((k, i) => (i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - K[i - 1].c), Math.abs(k.l - K[i - 1].c))));
  let a = null; return tr.map((v, i) => (a = a === null ? v : (a * (n - 1) + v) / n, i + 1 < n ? null : a)); // Wilder
}
export const hh = (K, n) => K.map((_, i) => (i < n ? null : Math.max(...K.slice(i - n, i).map((k) => k.h)))); // previous n bars
export const ll = (K, n) => K.map((_, i) => (i < n ? null : Math.min(...K.slice(i - n, i).map((k) => k.l))));
export function rsi(xs, n) {
  let g = null, l = null; return xs.map((v, i) => {
    if (i === 0) return null; const d = v - xs[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    g = g === null ? up : (g * (n - 1) + up) / n; l = l === null ? dn : (l * (n - 1) + dn) / n;
    return i < n ? null : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  });
}

/** 4h candles from 1h candles (UTC-aligned). A bucket with missing hours is built from the hours present and counted. */
export function to4h(H) {
  const m = new Map();
  for (const k of H) { const b = Math.floor(k.t / 14_400_000) * 14_400_000; (m.get(b) ?? m.set(b, []).get(b)).push(k); }
  let partial = 0;
  const out = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, ks]) => { if (ks.length < 4) partial++; return { t, o: ks[0].o, h: Math.max(...ks.map((k) => k.h)), l: Math.min(...ks.map((k) => k.l)), c: ks.at(-1).c, v: ks.reduce((s, k) => s + k.v, 0) }; });
  return { candles: out, partial };
}

// ------------------------------------------------------------------------------------------------ strategies
// Each returns per-bar { enter: 1 | -1 | 0, exit: bool, stop0: (entry, side) => price } from completed-bar data only.
// `p.short` enables SHORT entries (LONG + SHORT) — otherwise long-only.
export const FAMILIES = {
  // Donchian breakout: close above the previous N-bar high -> long (below the N-bar low -> short); exit on the
  // M-bar opposite channel; ATR stop k x ATR. Classic turtle-style trend following.
  donchian: (K, p) => {
    const H = hh(K, p.n), L = ll(K, p.n), He = hh(K, p.m), Le = ll(K, p.m);
    return K.map((k, i) => ({ enter: H[i] !== null && k.c > H[i] ? 1 : p.short && L[i] !== null && k.c < L[i] ? -1 : 0,
      exitLong: Le[i] !== null && k.c < Le[i], exitShort: He[i] !== null && k.c > He[i] }));
  },
  // Moving-average trend: long while close > SMA(n) (short while below, if enabled); exit on the cross back.
  ma: (K, p) => {
    const S = sma(K.map((k) => k.c), p.n);
    return K.map((k, i) => ({ enter: S[i] === null ? 0 : k.c > S[i] ? 1 : p.short && k.c < S[i] ? -1 : 0, exitLong: S[i] !== null && k.c < S[i], exitShort: S[i] !== null && k.c > S[i] }));
  },
  // EMA crossover fast/slow.
  cross: (K, p) => {
    const F = ema(K.map((k) => k.c), p.f), S = ema(K.map((k) => k.c), p.s);
    return K.map((_, i) => ({ enter: F[i] === null || S[i] === null ? 0 : F[i] > S[i] ? 1 : p.short && F[i] < S[i] ? -1 : 0, exitLong: F[i] !== null && S[i] !== null && F[i] < S[i], exitShort: F[i] !== null && S[i] !== null && F[i] > S[i] }));
  },
  // Trend pullback: trend up (EMA50 > EMA200 and close > EMA200); enter when RSI(14) recovers above `r` after
  // dipping below it (a pullback ending); exit when the trend flips (EMA50 < EMA200). Mirror for shorts.
  pullback: (K, p) => {
    const C = K.map((k) => k.c), E50 = ema(C, 50), E200 = ema(C, 200), R = rsi(C, 14);
    return K.map((k, i) => {
      const up = E50[i] !== null && E200[i] !== null && E50[i] > E200[i] && k.c > E200[i];
      const dn = E50[i] !== null && E200[i] !== null && E50[i] < E200[i] && k.c < E200[i];
      const longSig = up && R[i - 1] !== null && R[i - 1] < p.r && R[i] >= p.r;
      const shortSig = p.short && dn && R[i - 1] !== null && R[i - 1] > 100 - p.r && R[i] <= 100 - p.r;
      return { enter: longSig ? 1 : shortSig ? -1 : 0, exitLong: E50[i] !== null && E200[i] !== null && E50[i] < E200[i], exitShort: E50[i] !== null && E200[i] !== null && E50[i] > E200[i] };
    });
  },
};

// ------------------------------------------------------------------------------------------------ simulation
/**
 * One strategy on one market. K: candles (t = bar open, ms), barMs; family + params p; capital; asset ("SOL"/"BTC");
 * cost { fee, slip } in %; window [fromMs, toMs): trades only open inside it; open position closed at the window end.
 * Exits: the family's signal exit, the protective stop (k x ATR from entry) and the ATR trailing stop (trail x ATR
 * from the best close) when p.trail > 0.
 */
export function simulate({ K, barMs, family, p, capital, asset, fee, slip, riskPct, fromMs, toMs, borrow4h = 0 }) {
  const sig = FAMILIES[family](K, p);
  const A = atr(K, 14);
  const f = fee / 100, s = slip / 100, min = MIN[asset];
  let cash = capital, pos = null, peak = capital, maxDD = 0, maxDDpct = 0, pendingEnter = 0, pendingExit = false;
  const trades = [], equity = [], skipped = { min: 0 };
  const close = (k, px, reason, i) => {
    const side = pos.side, exitPx = px * (1 - side * s); // slippage against us
    const gross = (exitPx - pos.entry) * pos.qty * side;
    const exitFee = exitPx * pos.qty * f;
    // A real spot SHORT borrows the asset: margin rollover `borrow4h` % of notional per started 4 hours (0 = not modelled).
    const borrow = side === -1 && borrow4h > 0 ? pos.collateral * (borrow4h / 100) * Math.ceil((k.t - pos.t) / 14_400_000) : 0;
    cash += pos.collateral + gross - exitFee - borrow;
    trades.push({ side: side === 1 ? "LONG" : "SHORT", entryT: pos.t, exitT: k.t + (reason === "open" ? 0 : 0), entry: pos.entry, exit: exitPx, qty: pos.qty,
      gross: gross + (pos.entryRaw - pos.entry) * 0, fees: pos.entryFee + exitFee + borrow, borrow, net: gross - pos.entryFee - exitFee - borrow, holdH: (k.t - pos.t) / 3_600_000, reason, notional: pos.collateral });
    pos = null;
  };
  for (let i = 1; i < K.length; i++) {
    const k = K[i];
    if (k.t >= toMs) break;
    const live = k.t >= fromMs;
    // 1) orders decided at the previous close fill at this bar's open
    if (pos && pendingExit) { close(k, k.o, "signal", i); pendingExit = false; }
    if (!pos && pendingEnter && live) {
      const side = pendingEnter, a = A[i - 1];
      if (a !== null) {
        const entry = k.o * (1 + side * s), stop = entry - side * p.k * a, dist = Math.abs(entry - stop);
        const equityNow = cash;
        let qty = Math.min((equityNow * riskPct / 100) / dist, cash / (entry * (1 + f)));
        qty = Math.floor(qty / 1e-8) * 1e-8;
        if (qty < min.qty || qty * entry < min.cost) skipped.min++;
        else {
          const notional = qty * entry, entryFee = notional * f;
          cash -= notional + entryFee;
          pos = { side, t: k.t, entry, entryRaw: k.o, qty, stop, best: entry, collateral: notional, entryFee };
        }
      }
    }
    pendingEnter = 0;
    // 2) stop inside this bar (from the entry bar on)
    if (pos) {
      const hit = pos.side === 1 ? k.l <= pos.stop : k.h >= pos.stop;
      if (hit) close(k, pos.side === 1 ? Math.min(k.o, pos.stop) : Math.max(k.o, pos.stop), "stop", i);
    }
    // 3) at this bar's close: trail the stop, decide exits / entries for the next open
    if (pos) {
      pos.best = pos.side === 1 ? Math.max(pos.best, k.c) : Math.min(pos.best, k.c);
      if (p.trail > 0 && A[i] !== null) { const t = pos.best - pos.side * p.trail * A[i]; pos.stop = pos.side === 1 ? Math.max(pos.stop, t) : Math.min(pos.stop, t); }
      if ((pos.side === 1 && sig[i].exitLong) || (pos.side === -1 && sig[i].exitShort)) pendingExit = true;
    } else if (live && sig[i].enter !== 0) pendingEnter = sig[i].enter;
    const mtm = cash + (pos ? pos.collateral + (k.c - pos.entry) * pos.qty * pos.side : 0);
    if (live) { peak = Math.max(peak, mtm); maxDD = Math.max(maxDD, peak - mtm); maxDDpct = Math.max(maxDDpct, (peak - mtm) / peak); equity.push([k.t, mtm]); }
  }
  // window end: close at the last bar's close (marked, with exit fee + slippage)
  const lastIdx = K.findLastIndex((k) => k.t < toMs);
  if (pos && lastIdx >= 0) close({ ...K[lastIdx], t: K[lastIdx].t + barMs }, K[lastIdx].c, "window_end", lastIdx);
  return { trades, equity, end: cash, maxDD, maxDDpct, skipped };
}

// ------------------------------------------------------------------------------------------------ metrics
export function metrics(r, capital) {
  const T = r.trades, nets = T.map((t) => t.net);
  const wins = nets.filter((v) => v > 0), losses = nets.filter((v) => v <= 0);
  let streak = 0, worst = 0; for (const v of nets) { streak = v <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  const mean = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : null;
  // bootstrap 95 % interval of the mean net per trade (2000 resamples, fixed seed)
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let ci = null;
  if (nets.length >= 5) {
    const ms = []; for (let b = 0; b < 2000; b++) { let s = 0; for (let j = 0; j < nets.length; j++) s += nets[Math.floor(rnd() * nets.length)]; ms.push(s / nets.length); }
    ms.sort((a, b) => a - b); ci = [ms[50], ms[1949]];
  }
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  return {
    trades: T.length, long: T.filter((t) => t.side === "LONG").length, short: T.filter((t) => t.side === "SHORT").length,
    gross: +sum(T.map((t) => t.gross)).toFixed(2), fees: +sum(T.map((t) => t.fees)).toFixed(2), net: +(r.end - capital).toFixed(2),
    return_pct: +(((r.end - capital) / capital) * 100).toFixed(1), win_rate: T.length ? +(wins.length / T.length).toFixed(3) : null,
    profit_factor: losses.length && sum(losses) < 0 ? +(sum(wins) / -sum(losses)).toFixed(2) : wins.length ? 99 : null,
    avg_net: mean === null ? null : +mean.toFixed(3), avg_net_ci95: ci && ci.map((v) => +v.toFixed(3)),
    max_dd: +r.maxDD.toFixed(2), max_dd_pct: +(r.maxDDpct * 100).toFixed(1),
    avg_hold_h: T.length ? +(sum(T.map((t) => t.holdH)) / T.length).toFixed(1) : null, longest_losing_streak: worst, skipped_min_size: r.skipped.min,
  };
}

/** Buy and hold (one entry and one exit fill, fees and slippage), and cash. */
export function buyHold(K, { capital, fee, slip, fromMs, toMs }) {
  const ks = K.filter((k) => k.t >= fromMs && k.t < toMs);
  const entry = ks[0].o * (1 + slip / 100), qty = capital / (entry * (1 + fee / 100));
  let peak = capital, dd = 0, ddp = 0; const equity = [];
  for (const k of ks) { const v = qty * k.c; peak = Math.max(peak, v); dd = Math.max(dd, peak - v); ddp = Math.max(ddp, (peak - v) / peak); equity.push([k.t, v]); }
  const exit = ks.at(-1).c * (1 - slip / 100), end = qty * exit * (1 - fee / 100);
  return { net: +(end - capital).toFixed(2), return_pct: +(((end - capital) / capital) * 100).toFixed(1), max_dd: +dd.toFixed(2), max_dd_pct: +(ddp * 100).toFixed(1), equity };
}
