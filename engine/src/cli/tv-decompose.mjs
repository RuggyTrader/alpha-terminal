// PARITY: why the original (1–12 Nov) TradingView reports showed more profit than the current (8–12 Nov) ones.
// Original profiles only; reference semantics (zero commission, unlimited buying power). Prints Experiments A–D, the
// decomposition of original vs current P&L, and daily P&L with cumulative equity.
//   node src/cli/tv-decompose.mjs --out ../docs/research/2026-11-13-parity.json
// History starts and report cutoffs come from the parity search (src/cli/tv-window.mjs): TradingView's report dated
// "Nov 1" begins its history at 2 Nov 00:00 UTC and the one dated "Nov 8" at 9 Nov 00:00 UTC.

import { writeFileSync } from "node:fs";
import { candlesFor, engineTrades } from "./tv-parity.mjs";

/** TradingView's report figures at a cutoff: closed P&L, PF, max drawdown (peak of closed equity to the worst intrabar
 *  equity including the open trade — reproduces all four screenshot drawdowns to the cent), and the open trade. */
export function tvReport(trades, candles, startMs, cutoffMs, reportFromMs = startMs) {
  const T = trades.filter((t) => t.entryTime >= reportFromMs && t.entryTime < cutoffMs);
  const closed = T.filter((t) => t.exitTime + 60_000 <= cutoffMs);
  const g = closed.map((t) => t.gross);
  const w = g.filter((x) => x > 0).reduce((s, x) => s + x, 0), l = -g.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  let peak = 0, dd = 0;
  for (const k of candles) {
    if (k.t < reportFromMs || k.t + 60_000 > cutoffMs) continue;
    const realized = T.filter((t) => t.exitTime <= k.t).reduce((s, t) => s + t.gross, 0);
    const open = T.find((t) => t.entryTime <= k.t && t.exitTime > k.t) ?? null;
    let worst = realized;
    if (open) { const d = open.side === "LONG" ? 1 : -1; worst += d * ((d === 1 ? k.l : k.h) - open.entry) * open.qty; }
    peak = Math.max(peak, realized); dd = Math.max(dd, peak - worst);
  }
  const open = T.find((t) => t.exitTime + 60_000 > cutoffMs) ?? null;
  const last = candles.filter((k) => k.t + 60_000 <= cutoffMs).at(-1);
  const unreal = open && last ? (open.side === "LONG" ? 1 : -1) * (last.c - open.entry) * open.qty : 0;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { closed: closed.length, wins: g.filter((x) => x > 0).length, losses: g.filter((x) => x < 0).length, closed_pnl: r2(w - l), profit_factor: l > 0 ? +(w / l).toFixed(3) : null,
    max_drawdown: r2(dd), open: open ? { side: open.side, entry: open.entry, unrealized_at_cutoff: r2(unreal) } : null, total_incl_open: r2(w - l + unreal) };
}

export function daily(trades, fromMs, toMs) {
  const d = {};
  for (const t of trades) { if (t.exitTime < fromMs || t.exitTime >= toMs) continue; const k = new Date(t.exitTime).toISOString().slice(0, 10); (d[k] ??= { trades: 0, pnl: 0 }); d[k].trades++; d[k].pnl += t.gross; }
  let cum = 0;
  return Object.keys(d).sort().map((k) => { cum += d[k].pnl; return { day: k, trades: d[k].trades, pnl: Math.round(d[k].pnl * 100) / 100, cumulative: Math.round(cum * 100) / 100 }; });
}

const BOTS = [
  { sym: "SOLUSD", profile: "solusd-1m", origCut: "2026-11-12T05:00:00Z", curCut: "2026-11-12T23:57:00Z", // trade 43 open; +$19.81 at the 23:56 close (screenshot +$19.80)
    tv: { original: { total: 382.50, pf: 2.033, dd: 61.80 }, current: { total: 206.48, closed: 185.22, pf: 2.082, dd: 53.35 } } },
  { sym: "BTCUSD", profile: "btcusd-1m", origCut: "2026-11-12T05:14:00Z", curCut: "2026-11-12T23:59:00Z", tv: { original: { total: 374.65, pf: 1.945, dd: 67.21 }, current: { total: 77.38, closed: 77.38, pf: 1.634, dd: 49.94 } } },
];

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/tv-decompose.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const LONG = Date.parse("2026-11-02T00:00:00Z"), SHORT = Date.parse("2026-11-09T00:00:00Z"), END = Date.parse("2026-11-13T00:20:00Z");
  const out = { label: "Reference parity (zero commission, unlimited buying power), ORIGINAL profiles", history_starts: { original_report: "2026-11-02T00:00:00Z", current_report: "2026-11-09T00:00:00Z" }, bots: {} };
  for (const b of BOTS) {
    const c = candlesFor(b.sym);
    const longT = engineTrades({ symbol: b.sym, profile: b.profile, candles: c, startMs: LONG, toMs: END });
    const shortT = engineTrades({ symbol: b.sym, profile: b.profile, candles: c, startMs: SHORT, toMs: END });
    const buggyLong = engineTrades({ symbol: b.sym, profile: b.profile, candles: c, startMs: LONG, toMs: END, inputsOverride: { tp2Ext: -0.27 } });
    const oc = Date.parse(b.origCut), cc = Date.parse(b.curCut);
    const A = tvReport(longT, c, LONG, oc);
    const B = tvReport(shortT, c, SHORT, cc);
    const C = tvReport(longT, c, LONG, cc, SHORT);     // long history, report restricted to 9–12 Nov (no reset)
    const D = B;                                        // initialized at the shorter dataset's start, same window
    const Afull = tvReport(longT, c, LONG, cc);        // the long history to the current cutoff
    const Abug = tvReport(buggyLong, c, LONG, oc);     // the original window with the loader defect (TP2 -0.27)
    const Dbug = tvReport(engineTrades({ symbol: b.sym, profile: b.profile, candles: c, startMs: SHORT, toMs: END, inputsOverride: { tp2Ext: -0.27 } }), c, SHORT, cc);
    // Decomposition (TOTAL incl. open trade at each report's cutoff):
    const before9 = tvReport(longT, c, LONG, SHORT);   // trades closed before 9 Nov (the omitted days 2–8 Nov)
    const omitted = before9.closed_pnl;
    const sameWindowEnd = tvReport(longT, c, LONG, oc, SHORT); // 9 Nov → original cutoff, long history
    const endEffect = C.total_incl_open - sameWindowEnd.total_incl_open; // later cutoff: trades/open P&L after the original report
    const initEffect = C.total_incl_open - D.total_incl_open;             // same window/cutoff, different starting state
    const bridge = { original_engine_total: A.total_incl_open, minus_omitted_days_2_to_8_nov: -omitted, minus_open_trade_and_window_overlap: +(sameWindowEnd.total_incl_open - (A.total_incl_open - omitted)).toFixed(2),
      plus_later_cutoff: +endEffect.toFixed(2), minus_initial_state: +(-initEffect).toFixed(2), equals_current_engine_total: D.total_incl_open };
    out.bots[b.sym] = {
      tradingview: b.tv,
      experiment_A_original_window: { history_start: "2026-11-02T00:00Z", cutoff: b.origCut, ...A },
      experiment_B_current_window: { history_start: "2026-11-09T00:00Z", cutoff: b.curCut, ...B },
      experiment_C_long_history_report_9_to_12: { history_start: "2026-11-02T00:00Z", report_from: "2026-11-09T00:00Z", cutoff: b.curCut, ...C },
      experiment_D_short_history_report_9_to_12: { history_start: "2026-11-09T00:00Z", cutoff: b.curCut, ...D },
      long_history_to_current_cutoff: Afull,
      defect_effect_tp2_minus_0_27: { original_window: Abug, current_window: Dbug },
      decomposition: { tv_original_total: b.tv.original.total, tv_current_total: b.tv.current.total, engine_long_window_total: A.total_incl_open, engine_short_window_total: D.total_incl_open,
        omitted_days_2_to_8_nov_closed_pnl: omitted, initial_state_effect_on_9_to_12: +initEffect.toFixed(2), later_end_cutoff_effect: +endEffect.toFixed(2),
        engine_defect_effect: "none in the engine's own config path; the research loader defect (TP2 -0.27) is shown separately above and is fixed",
        unexplained_original: +(b.tv.original.total - A.total_incl_open).toFixed(2), unexplained_current: +(b.tv.current.total - D.total_incl_open).toFixed(2), bridge },
      daily_long_history: daily(longT, LONG, END),
      daily_short_history: daily(shortT, SHORT, END),
    };
  }
  if (arg("out", null)) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
  for (const [s, b] of Object.entries(out.bots)) {
    console.log(`== ${s}`);
    for (const k of ["experiment_A_original_window", "experiment_B_current_window", "experiment_C_long_history_report_9_to_12"]) { const x = b[k]; console.log(k, "closed", x.closed, "pnl", x.closed_pnl, "PF", x.profit_factor, "DD", x.max_drawdown, "open", JSON.stringify(x.open), "total", x.total_incl_open); }
    console.log("decomposition", JSON.stringify(b.decomposition));
    console.log("defect (TP2 -0.27)", JSON.stringify(b.defect_effect_tp2_minus_0_27.original_window), JSON.stringify(b.defect_effect_tp2_minus_0_27.current_window));
    console.log("daily", b.daily_long_history.map((d) => `${d.day.slice(5)}:${d.pnl}(${d.trades})`).join(" "));
  }
}
