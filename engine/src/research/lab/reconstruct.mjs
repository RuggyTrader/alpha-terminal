// Research lab: reconstruct the OFFICIAL drawdown of a daily strategy from TIME-ORDERED 5-minute data (research only).
// The daily backtester (dd2/bt.mjs) gives a conservative candle-based bound: it assumes every daily bar's high came before
// its low. This replays the same fills (from its audit log) through 5-minute bars in time order:
//   * daily-open fills take effect at that day's 00:00 bar;
//   * a STOP exit takes effect in the first 5-minute bar of that day whose low reaches the stop. That bar is marked at the
//     fill price for the exiting position, then the sale is applied;
//   * equity (cash + positions) is marked at every 5-minute bar's high and low. Within a single 5-minute bar the high is
//     still assumed to come first, so the result remains (slightly) conservative.
import { DAY } from "./data.mjs";
const FIVE = 300_000;

/**
 * audit: bt.mjs audit entries; bars5: { asset: [5-minute bars sorted] }; capital; from/to (ms).
 * Returns { dd_official_5m_pct, final_marked, events, unresolved_stops }.
 */
export function reconstructOfficialDD(audit, bars5, { capital = 100, from, to }) {
  const idx = Object.fromEntries(Object.entries(bars5).map(([a, B]) => [a, new Map(B.map((b) => [b.t, b]))]));
  const firstIdx = (B, t) => { let lo = 0, hi = B.length; while (lo < hi) { const m = (lo + hi) >> 1; if (B[m].t < t) lo = m + 1; else hi = m; } return lo; };
  let unresolved = 0;
  const events = audit.map((x) => {
    let at = x.t;
    if (x.kind === "STOP") {
      const B = bars5[x.asset]; let i = firstIdx(B, x.t);
      for (; i < B.length && B[i].t < x.t + DAY; i++) if (B[i].l <= x.ref.stop) break;
      if (i < B.length && B[i].t < x.t + DAY) at = B[i].t; else { unresolved++; at = x.t; }
    }
    return { ...x, at };
  }).sort((a, b) => a.at - b.at || (a.side === "SELL" ? -1 : 1));
  const qty = {}, last = {};
  let cash = capital, hwm = capital, dd = 0, e = 0;
  for (let t = Math.ceil(from / FIVE) * FIVE; t < to; t += FIVE) {
    // fills effective at the open of this bar (all non-stop events at their day's 00:00; stops in their 5-minute bar)
    const stopsHere = [];
    while (e < events.length && events[e].at <= t) {
      const x = events[e++];
      if (x.kind === "STOP" && x.at === t) { stopsHere.push(x); continue; }
      apply(x);
    }
    let eqH = cash, eqL = cash, eqC = cash;
    for (const a of Object.keys(qty)) {
      const q = qty[a]; if (!q) continue;
      const b = idx[a].get(t), px = b ? null : last[a];
      const exiting = stopsHere.find((s) => s.asset === a);
      eqH += q * (b ? b.h : px);
      eqL += q * (exiting ? exiting.px : b ? b.l : px); // the exiting position's worst point is its fill price
      eqC += q * (b ? b.c : px);
    }
    dd = Math.max(dd, 1 - eqL / Math.max(hwm, eqH)); hwm = Math.max(hwm, eqH, eqC);
    for (const s of stopsHere) apply(s);
    for (const a of Object.keys(bars5)) { const b = idx[a].get(t); if (b) last[a] = b.c; }
  }
  function apply(x) {
    if (x.side === "BUY") { cash -= x.notional + x.fee; qty[x.asset] = (qty[x.asset] ?? 0) + x.qty; }
    else { cash += x.notional - x.fee; qty[x.asset] = Math.max(0, (qty[x.asset] ?? 0) - x.qty); if (qty[x.asset] < 1e-12) qty[x.asset] = 0; }
  }
  const final = cash + Object.entries(qty).reduce((s, [a, q]) => s + q * (last[a] ?? 0), 0);
  return { dd_official_5m_pct: dd * 100, final_marked: final, events: events.length, unresolved_stops: unresolved };
}
