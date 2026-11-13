// PARITY (report windows): replays the ORIGINAL profile from a candidate history start and reports what a TradingView
// Strategy Report would show at each candidate cutoff: closed-trade P&L, profit factor and max drawdown (closed trades),
// plus the open trade's unrealized P&L at the cutoff candle's close ("Total P&L" = closed + open, as the screenshots show).
//   node src/cli/tv-window.mjs --symbol SOLUSD --profile solusd-1m --starts 2026-11-01T00:00:00Z,2026-11-02T00:00:00Z --from-cutoff 2026-11-12T00:00:00Z --to-cutoff 2026-11-13T00:20:00Z
//        --target-pf 2.033 --target-total 382.50 --target-dd 61.80
// Prints the cutoffs whose closed-trade PF rounds to the target, with the total and drawdown there. Nothing is fitted:
// the strategy is never changed, only the observation boundaries.

import { candlesFor, engineTrades } from "./tv-parity.mjs";

export function reportAt(trades, candles, cutoffMs) {
  const closed = trades.filter((t) => t.exitTime + 60_000 <= cutoffMs);
  const open = trades.find((t) => t.entryTime < cutoffMs && t.exitTime + 60_000 > cutoffMs) ?? null;
  const g = closed.map((t) => t.gross);
  const w = g.filter((x) => x > 0).reduce((s, x) => s + x, 0), l = -g.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  let eq = 0, pk = 0, dd = 0; for (const x of g) { eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const last = candles.filter((k) => k.t + 60_000 <= cutoffMs).at(-1);
  const unreal = open && last ? (open.side === "LONG" ? 1 : -1) * (last.c - open.entry) * open.qty : 0;
  return { cutoff: new Date(cutoffMs).toISOString(), closed: closed.length, closed_pnl: +eq.toFixed(2), profit_factor: l > 0 ? +(w / l).toFixed(3) : null, max_drawdown_closed: +dd.toFixed(2),
    open: open ? { side: open.side, entry: open.entry, qty: +open.qty.toFixed(4), unrealized: +unreal.toFixed(2) } : null, total_incl_open: +(eq + unreal).toFixed(2),
    wins: g.filter((x) => x > 0).length, losses: g.filter((x) => x < 0).length };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/tv-window.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const symbol = arg("symbol"), profile = arg("profile");
  const c = candlesFor(symbol);
  const lo = Date.parse(arg("from-cutoff")), hi = Date.parse(arg("to-cutoff"));
  const tpf = Number(arg("target-pf")), ttot = Number(arg("target-total")), tdd = Number(arg("target-dd", "NaN"));
  for (const s of arg("starts").split(",")) {
    const startMs = Date.parse(s);
    const trades = engineTrades({ symbol, profile, candles: c, startMs, toMs: hi });
    let best = null, hits = [];
    for (let t = lo; t <= hi; t += 60_000) {
      const r = reportAt(trades, c, t);
      if (r.profit_factor !== null && r.profit_factor.toFixed(3) === tpf.toFixed(3)) hits.push(r);
      const score = Math.abs(r.total_incl_open - ttot);
      if (!best || score < best.score) best = { score, r };
    }
    const span = hits.length ? `${hits[0].cutoff} … ${hits.at(-1).cutoff}` : "none";
    console.log(JSON.stringify({ start: s, cutoffs_with_target_pf: hits.length, span, first_hit: hits[0] ?? null, last_hit: hits.at(-1) ?? null, closest_total: best.r, target: { pf: tpf, total: ttot, dd: tdd } }));
  }
}
