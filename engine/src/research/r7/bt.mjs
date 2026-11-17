// RESEARCH backtester (round 7): one market, one strategy, one direction, bar by bar. Conservative and auditable.
//   * A strategy sees ONLY completed bars 0..i and decides at bar i's close; market orders fill at bar i+1's OPEN.
//   * Protective stops are resting orders from the bar after entry: filled at the stop, or at the open when the bar
//     gaps through it (worse). A target and a stop inside the same bar: the STOP is assumed first (intrabar ambiguity).
//   * Every fill pays feePct of its notional; market and stop fills also lose slipPct (adverse).
//   * Sizing: risk riskPct of current equity to the initial stop, capped by equity (no leverage); a SHORT is fully
//     collateralised by cash (PAPER model). Below the exchange minimum (qty or notional) the trade is skipped.
//   * Equity is marked at every close; drawdown is measured on that curve. Nothing uses future data.
// Strategy interface: make(bars) -> (i, pos) => null | { enter: { stop } } | { exit: true } | { stop: newStop }
//   pos is null or { side, entryIdx, entryPrice, qty, stop, bars } (bars held so far).

export function backtest(bars, make, { side = "LONG", capital = 100, riskPct = 2, feePct = 0.2, slipPct = 0.05, minQty = 0, minNotional = 0, from = -Infinity, to = Infinity } = {}) {
  const dir = side === "LONG" ? 1 : -1, fee = feePct / 100, slip = slipPct / 100;
  const decide = make(bars, side);
  let cash = capital, pos = null, pending = null; // pending: { kind: "ENTER", stop } | { kind: "EXIT" } decided at the previous close
  const trades = [], curve = [];
  let peak = capital, maxDD = 0, exposed = 0, counted = 0, signals = 0, skippedMin = 0; // signals: entries attempted; skippedMin: below the exchange minimum
  const close = (i, px, kind) => {
    const exitPx = px, gross = dir * (exitPx - pos.entryPrice) * pos.qty, exitFee = exitPx * pos.qty * fee;
    cash += gross - exitFee;
    trades.push({ side, entryT: bars[pos.entryIdx].t, exitT: bars[i].t, entry: pos.entryPrice, exit: exitPx, qty: pos.qty, gross, fees: pos.entryFee + exitFee, net: gross - pos.entryFee - exitFee, kind, bars: i - pos.entryIdx });
    pos = null;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], inWindow = b.t >= from && b.t < to;
    // 1. orders decided at the previous close execute at this bar's open
    if (pending) {
      if (pending.kind === "EXIT" && pos) close(i, b.o * (1 - dir * slip), "signal");
      else if (pending.kind === "ENTER" && !pos && inWindow) {
        const px = b.o * (1 + dir * slip), risk = Math.abs(px - pending.stop);
        const stopOk = dir === 1 ? pending.stop < px : pending.stop > px;
        if (stopOk && risk > 0) {
          signals++;
          let qty = Math.min((cash * riskPct / 100) / risk, (cash / (1 + fee)) / px);
          if (qty >= minQty && qty * px >= minNotional && qty > 0) {
            const entryFee = px * qty * fee;
            cash -= entryFee;
            pos = { side, entryIdx: i, entryPrice: px, qty, stop: pending.stop, entryFee, bars: 0 };
          } else skippedMin++;
        }
      }
      pending = null;
    }
    // 2. the resting stop (placed from the bar after entry; the entry bar itself is also exposed from its open)
    if (pos) {
      const hit = dir === 1 ? b.l <= pos.stop : b.h >= pos.stop;
      if (hit) {
        const raw = dir === 1 ? Math.min(pos.stop, b.o) : Math.max(pos.stop, b.o); // a gap through the stop fills at the open
        close(i, raw * (1 - dir * slip), "stop");
      }
    }
    // 3. mark to market, drawdown
    const eq = pos ? cash + dir * (b.c - pos.entryPrice) * pos.qty : cash;
    if (inWindow) { peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak : 0); curve.push({ t: b.t, eq }); counted++; if (pos) exposed++; }
    // 4. the strategy decides at this close (bars 0..i only)
    if (pos) pos.bars = i - pos.entryIdx;
    const d = decide(i, pos ? { ...pos } : null);
    if (d?.exit && pos) pending = { kind: "EXIT" };
    else if (d?.stop !== undefined && pos) { const s = d.stop; if (dir === 1 ? s > pos.stop : s < pos.stop) pos.stop = s; } // stops only tighten
    else if (d?.enter && !pos && inWindow && i + 1 < bars.length) pending = { kind: "ENTER", stop: d.enter.stop };
  }
  // an open position at the end is closed at the last close (no fee advantage: it pays exit fee and slippage)
  if (pos) close(bars.length - 1, bars.at(-1).c * (1 - dir * slip), "end");
  return { trades, curve, final: cash, maxDD, exposure: counted ? exposed / counted : 0, signals, skippedMin };
}

const sum = (x) => x.reduce((a, b) => a + b, 0);
/** Per-trade bootstrap confidence interval of the mean (deterministic seed). */
export function bootstrap(nets, level = 0.95, B = 4000, seed = 17) {
  if (nets.length < 5) return null;
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); const ms = [];
  for (let b = 0; b < B; b++) { let t = 0; for (let j = 0; j < nets.length; j++) t += nets[Math.floor(rnd() * nets.length)]; ms.push(t / nets.length); }
  ms.sort((a, b) => a - b); const lo = Math.floor(((1 - level) / 2) * B), hi = Math.ceil((1 - (1 - level) / 2) * B) - 1;
  return [ms[lo], ms[hi]];
}
export function summarize(r, capital = 100) {
  const n = r.trades.map((t) => t.net), w = n.filter((v) => v > 0), l = n.filter((v) => v <= 0);
  return { trades: n.length, gross: sum(r.trades.map((t) => t.gross)), fees: sum(r.trades.map((t) => t.fees)), net: r.final - capital, ret_pct: ((r.final - capital) / capital) * 100,
    pf: l.length && sum(l) < 0 ? sum(w) / -sum(l) : w.length ? Infinity : null, win: n.length ? w.length / n.length : null, avg: n.length ? sum(n) / n.length : null,
    max_dd_pct: r.maxDD * 100, exposure: r.exposure, nets: n };
}

// ---- indicators (each value at i uses bars 0..i only) ----
export const sma = (xs, n) => { let s = 0; return xs.map((v, i) => { s += v; if (i >= n) s -= xs[i - n]; return i + 1 < n ? null : s / n; }); };
export const std = (xs, n) => xs.map((_, i) => { if (i + 1 < n) return null; let m = 0; for (let j = i - n + 1; j <= i; j++) m += xs[j]; m /= n; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (xs[j] - m) ** 2; return Math.sqrt(v / n); });
export function atr(b, n = 14) { let a = null; return b.map((k, i) => { const tr = i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - b[i - 1].c), Math.abs(k.l - b[i - 1].c)); a = a === null ? tr : (a * (n - 1) + tr) / n; return i + 1 < n ? null : a; }); }
/** Highest high / lowest low of the N bars BEFORE i (excludes bar i, so a breakout is "close above the prior range"). */
export const priorHigh = (b, n) => b.map((_, i) => { if (i < n) return null; let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, b[j].h); return m; });
export const priorLow = (b, n) => b.map((_, i) => { if (i < n) return null; let m = Infinity; for (let j = i - n; j < i; j++) m = Math.min(m, b[j].l); return m; });
