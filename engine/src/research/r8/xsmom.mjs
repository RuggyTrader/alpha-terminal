// Round 8: cross-sectional momentum rotation (X1), exactly as pre-registered in docs/research/round8/PREREGISTRATION.md.
// Research only. Daily bars; decision at the close of every 7th day of the period; fills at the next day's open;
// top K by L-day return among markets with a positive L-day return, 1/K of equity each; held names are kept, leavers
// sold in full, entrants bought at 1/K of equity (capped by cash); fees + slippage on every fill; orders < $0.50 skipped.
const DAY = 86_400_000;

/** series: { [market]: [{t,o,h,l,c}] } (daily, UTC). Returns the equity path, trades, weekly returns and per-market P&L. */
// Optional (round 9 F5): eligible(m, t) filters candidates at a decision; minQty { [m]: qty } adds Kraken order minimums.
export function rotate(series, { L, K, from, to, feePct = 0.2, slipPct = 0.05, capital = 100, minNotional = 0.5, rebalanceDays = 7, eligible = null, minQty = {} }) {
  const markets = Object.keys(series).sort();
  const byT = {};
  const lastT = {};
  for (const m of markets) { byT[m] = new Map(series[m].map((b) => [b.t, b])); lastT[m] = series[m].length ? series[m].at(-1).t : -Infinity; }
  const days = [];
  for (let t = Math.ceil(from / DAY) * DAY; t < to; t += DAY) days.push(t);
  const f = feePct / 100, s = slipPct / 100;
  let cash = capital;
  const pos = new Map(); // market -> { qty, cost }
  const pnl = Object.fromEntries(markets.map((m) => [m, 0]));
  const trades = [];
  let skippedMin = 0, entries = 0, fees = 0, grossTraded = 0, pending = null, investedDays = 0;
  const equityAt = (t, field = "c") => cash + [...pos].reduce((a, [m, p]) => { const b = byT[m].get(t) ?? lastBar(m, t); return a + p.qty * (b ? b[field] : 0); }, 0);
  // the latest bar at or before t (a missing day is valued at the previous close, never at zero)
  const lastBar = (m, t) => { for (let k = 1; k <= 3650; k++) { const b = byT[m].get(t - k * DAY); if (b) return b; } return null; };
  const path = [];
  days.forEach((t, i) => {
    // 1) execute the previous close's decision at today's open
    if (pending) {
      const target = pending; pending = null;
      for (const [m, p] of [...pos]) {
        if (target.includes(m)) continue;
        const b = byT[m].get(t) ?? lastBar(m, t); if (!b) continue;
        const px = b.o * (1 - s), notional = p.qty * px, fee = notional * f;
        cash += notional - fee; fees += fee; grossTraded += notional;
        pnl[m] += notional - fee - p.cost;
        trades.push({ t, m, side: "SELL", px, qty: p.qty, net: notional - fee - p.cost });
        pos.delete(m);
      }
      const eq = equityAt(t, "o");
      for (const m of target) {
        if (pos.has(m)) continue;
        const b = byT[m].get(t); if (!b) continue; // no bar today: not bought (never at a stale price)
        const px = b.o * (1 + s), budget = Math.min(eq / K, cash);
        const notional = budget / (1 + f);
        if (notional < minNotional || notional / px < (minQty[m] ?? 0)) { skippedMin++; continue; }
        const fee = notional * f, qty = notional / px;
        cash -= notional + fee; fees += fee; grossTraded += notional; entries++;
        pos.set(m, { qty, cost: notional + fee });
        trades.push({ t, m, side: "BUY", px, qty });
      }
    }
    // 1b) data ended (delisted / renamed on the data source): sell at its LAST close, with costs (pre-registration addendum A1)
    for (const [m, p] of [...pos]) {
      if (t <= lastT[m]) continue;
      const b = byT[m].get(lastT[m]), px = b.c * (1 - s), notional = p.qty * px, fee = notional * f;
      cash += notional - fee; fees += fee; grossTraded += notional; pnl[m] += notional - fee - p.cost;
      trades.push({ t, m, side: "SELL", px, qty: p.qty, net: notional - fee - p.cost, reason: "DATA_ENDED" });
      pos.delete(m);
    }
    // 2) decide at today's close (completed bar), every rebalanceDays from the start of the period
    if (i % rebalanceDays === 0) {
      const scored = [];
      for (const m of markets) {
        const now = byT[m].get(t), then = byT[m].get(t - L * DAY);
        if (!now || !then) continue;
        if (eligible && !eligible(m, t)) continue;
        const r = now.c / then.c - 1;
        if (r > 0) scored.push([m, r]);
      }
      scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      pending = scored.slice(0, K).map(([m]) => m);
    }
    if (pos.size) investedDays++;
    path.push({ t, equity: equityAt(t) });
  });
  // open positions at the end: marked at the last close (unrealised), counted in per-market P&L
  const end = days.at(-1);
  for (const [m, p] of pos) { const b = byT[m].get(end) ?? lastBar(m, end); if (b) pnl[m] += p.qty * b.c - p.cost; }
  const weekly = [];
  for (let i = 7; i < path.length; i += 7) weekly.push(path[i].equity / path[i - 7].equity - 1);
  let peak = -Infinity, mdd = 0;
  for (const { equity } of path) { peak = Math.max(peak, equity); mdd = Math.max(mdd, 1 - equity / peak); }
  const final = path.at(-1)?.equity ?? capital;
  const byYear = {};
  for (let i = 1; i < path.length; i++) { const y = new Date(path[i].t).getUTCFullYear(); byYear[y] = (byYear[y] ?? 0) + path[i].equity - path[i - 1].equity; }
  return { net: final - capital, final, fees, grossTraded, entries, skippedMin, trades, weekly, mdd, pnl, byYear, exposure: investedDays / Math.max(1, days.length), path };
}

/** Equal-weight buy-and-hold of the markets with a bar on the first day (bought at that open, marked at the last close). */
export function buyHold(series, { from, to, feePct = 0.2, slipPct = 0.05, capital = 100 }) {
  const t0 = Math.ceil(from / DAY) * DAY;
  const ms = Object.keys(series).filter((m) => series[m].some((b) => b.t === t0));
  let v = 0;
  for (const m of ms) {
    const b0 = series[m].find((b) => b.t === t0), last = series[m].filter((b) => b.t < to).at(-1);
    const notional = capital / ms.length / (1 + feePct / 100);
    v += (notional / (b0.o * (1 + slipPct / 100))) * last.c * (1 - slipPct / 100) * (1 - feePct / 100);
  }
  return { net: v - capital, markets: ms.length };
}

/** Moving-block bootstrap of the mean (fixed seed). Returns the two-sided (1 - alpha) interval. */
export function blockBootstrap(x, { block = 4, n = 10_000, alpha = 0.05, seed = 20261117 } = {}) {
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 2 ** 32; };
  const means = [];
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    while (cnt < x.length) { const s0 = Math.floor(rnd() * Math.max(1, x.length - block + 1)); for (let j = 0; j < block && cnt < x.length; j++, cnt++) sum += x[s0 + j]; }
    means.push(sum / x.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor((alpha / 2) * n)], hi: means[Math.ceil((1 - alpha / 2) * n) - 1], mean: x.reduce((a, b) => a + b, 0) / x.length };
}
