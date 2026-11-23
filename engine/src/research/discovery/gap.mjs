// Discovery P1/P2: Ndax cross-currency gap reversion backtester (docs/research/discovery/PREREGISTRATION.md).
// Long-only spot, no leverage, shared cash, up to `slots` positions (one per market). Generic bar size (daily or hourly).
//   premium p(t) = Ndax close / (ref close x fx close) - 1 ; deviation x(t) = p(t) - median(p over the previous `win` bars)
//   signal at bar t close: x < -cost and Ndax quote volume >= minVol -> order for the NEXT bar's open, executed only if
//   the open-based deviation is still < -cost/2 (else MISSED). Exit at the open after the first close with x >= 0, or after
//   `hold` bars. Fills at open x (1 +/- cSide), fee on notional. Drawdown: marks at lows / HWM incl. highs (worst case).
export function backtestGap(markets, p, { from, to }) {
  const { f = 1, slots = 3, hold = 7, win = 30, minVol = 10_000, fee = 0.002, capital = 100, bar } = p;
  const M = markets.map((m) => ({ ...m, nd: new Map(m.bars.map((b) => [b.t, b])), hist: [] }));
  const times = [...new Set(markets.flatMap((m) => m.bars.map((b) => b.t)))].filter((t) => t >= from && t < to).sort((a, b) => a - b);
  let cash = capital, hwm = capital, dd = 0, missed = 0;
  const pos = new Map(), pend = new Map(), trades = [], curve = [];
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  for (const t of times) {
    // 1) exits at the open
    for (const [name, P] of [...pos]) {
      if (!P.exit) continue; const m = M.find((x) => x.name === name), b = m.nd.get(t); if (!b) continue;
      const px = b.o * (1 - m.cSide), gross = P.qty * px, fe = gross * fee;
      cash += gross - fe; trades.push({ market: name, entryT: P.t, exitT: t, net: gross - fe - P.cost, ret: (gross - fe) / P.cost - 1, reason: P.exit }); pos.delete(name);
    }
    // 2) entries at the open (signal from the previous bar's close, still present at this open)
    const eqOpen = cash + [...pos].reduce((s, [name, P]) => { const b = M.find((x) => x.name === name).nd.get(t); return s + P.qty * (b ? b.o : P.last); }, 0);
    for (const [name, S] of [...pend]) {
      pend.delete(name);
      const m = M.find((x) => x.name === name), b = m.nd.get(t), r = m.ref.get(t), fx = m.fx.get(t);
      if (!b || !r || !fx || pos.has(name)) { missed++; continue; }
      const xOpen = b.o / (r.o * fx.o) - 1 - S.med;
      if (!(xOpen < -m.cost / 2) || pos.size >= slots) { missed++; continue; }
      const px = b.o * (1 + m.cSide), notional = Math.min((eqOpen * f) / slots, cash / (1 + fee));
      if (!(notional >= Math.max(1, (m.minQty ?? 0) * px))) { missed++; continue; }
      const qty = notional / px, fe = notional * fee;
      cash -= notional + fe; pos.set(name, { qty, cost: notional + fe, t, bars: 0, last: b.o, exit: null });
    }
    // 3) marks (worst case: high before low) and drawdown
    let eqL = cash, eqH = cash, eqC = cash;
    for (const [name, P] of pos) { const b = M.find((x) => x.name === name).nd.get(t); const lo = b ? b.l : P.last, hi = b ? b.h : P.last, c = b ? b.c : P.last; eqL += P.qty * lo; eqH += P.qty * hi; eqC += P.qty * c; if (b) P.last = b.c; }
    dd = Math.max(dd, 1 - eqL / Math.max(hwm, eqH)); hwm = Math.max(hwm, eqH, eqC);
    curve.push([t, eqC]);
    // 4) signals and exit flags at the close
    for (const m of M) {
      const b = m.nd.get(t), r = m.ref.get(t), fx = m.fx.get(t); if (!b || !r || !fx) continue;
      const prem = b.c / (r.c * fx.c) - 1;
      if (m.hist.length >= win) {
        const med = median(m.hist.slice(-win)), x = prem - med;
        const P = pos.get(m.name);
        if (P) { P.bars++; if (x >= 0) P.exit ??= "REVERTED"; else if (P.bars >= hold) P.exit ??= "TIME"; }
        else if (x < -m.cost && b.v * b.c >= minVol) pend.set(m.name, { med });
      }
      m.hist.push(prem);
    }
  }
  const final = curve.length ? curve.at(-1)[1] : capital, years = (to - from) / (365.25 * 86_400_000);
  return { final, cagr_pct: ((final / capital) ** (1 / years) - 1) * 100, dd_pct: dd * 100, trades, missed, curve, open_at_end: pos.size };
}
