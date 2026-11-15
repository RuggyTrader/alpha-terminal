// Builds research-round-2.html from the result files (every number on the page comes from them).
import { readFileSync, writeFileSync } from "node:fs";
const j = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const curves = j("./curves.json"), lo = j("./longonly.json"), grid = j("./magrid.json"), r2 = j("./r2.json"), cand = j("./cand.json");
const keep = ["BTC MA-50 long only ($100)", "BTC MA-50 LONG+SHORT ($100, short borrowing 0.02%/4h)", "$50 BTC + $50 SOL MA-50 long only", "SMA-200 trend, long only, fully invested BTC", "Buy and hold BTC ($100)", "Buy and hold SOL ($100)", "Cash"];
const label = { "BTC MA-50 long only ($100)": "BTC 50-day trend, long only", "BTC MA-50 LONG+SHORT ($100, short borrowing 0.02%/4h)": "BTC 50-day trend, LONG+SHORT (with borrowing)", "$50 BTC + $50 SOL MA-50 long only": "$50 BTC + $50 SOL, 50-day trend", "SMA-200 trend, long only, fully invested BTC": "BTC above 200-day average, fully invested", "Buy and hold BTC ($100)": "Buy and hold BTC", "Buy and hold SOL ($100)": "Buy and hold SOL", Cash: "Cash" };
const series = Object.fromEntries(keep.map((k) => [label[k], curves.series[k]]));
const B = lo.BTC.periods, A = cand.candidates.find((c) => c.id.startsWith("BTC 1d MA-50")).periods;
const candidates = [
  { name: "BTC daily 50-day trend, long only", dev: B.dev.net, val: B.val.net, test: B.test.net, trades: B.test.trades, pf: B.test.profit_factor, dd: B.test.max_dd_pct, avg: B.test.avg_net, ci: B.test.avg_net_ci95, status: "hypothesis" },
  { name: "BTC daily 50-day trend, LONG+SHORT, short borrowing 0.02%/4h", dev: A.dev.borrow_002_per_4h.net, val: A.val.borrow_002_per_4h.net, test: A.test.borrow_002_per_4h.net, trades: A.test.borrow_002_per_4h.trades, pf: A.test.borrow_002_per_4h.profit_factor, dd: A.test.borrow_002_per_4h.max_dd_pct, avg: A.test.borrow_002_per_4h.avg_net, ci: A.test.borrow_002_per_4h.avg_net_ci95, status: "not accepted" },
  { name: "SOL daily 50-day trend, long only", dev: lo.SOL.periods.dev.net, val: lo.SOL.periods.val.net, test: lo.SOL.periods.test.net, trades: lo.SOL.periods.test.trades, pf: lo.SOL.periods.test.profit_factor, dd: lo.SOL.periods.test.max_dd_pct, avg: lo.SOL.periods.test.avg_net, ci: lo.SOL.periods.test.avg_net_ci95, status: "not accepted" },
];
const nice = (r) => `${r.asset} ${r.tf === "1d" ? "daily" : "4h"} ${({ donchian: "Donchian breakout", ma: `${r.chosen.n}-period average trend`, cross: `EMA ${r.chosen.fs} crossover`, pullback: "trend pullback" })[r.family]}, ${r.mode === "LONG only" ? "long only" : "LONG+SHORT"}`;
const gate = r2.results.filter((r) => r.passes_validation).map((r) => ({ name: nice(r), val: r.val.net, test: r.test.net, trades: r.test.trades, pf: r.test.profit_factor }));
const costs = lo.BTC.costs.dev.map((c, i) => ({ label: c.fee === 0 ? "No costs (edge before fees)" : `${c.fee}% fee + ${c.slip}% slippage`, dev: c.net, val: lo.BTC.costs.val[i].net, test: lo.BTC.costs.test[i].net }));
const g = grid.filter((r) => r.asset === "BTC").map((r) => ({ label: `${r.n}-day · ${r.k}×ATR stop · ${r.trail ? "3×ATR trail" : "no trail"}`, dev: r.dev.net, val: r.val.net, test: r.test.net }));
const bt = r2.benchmarks.test;
const bench = [
  { name: "Cash", net: 0, dd: 0 },
  { name: "Buy and hold BTC", net: bt.buy_hold_BTC.net, dd: bt.buy_hold_BTC.max_dd_pct },
  { name: "Buy and hold SOL", net: bt.buy_hold_SOL.net, dd: bt.buy_hold_SOL.max_dd_pct },
  { name: "BTC above 200-day average, fully invested", net: bt.trend_SMA200_long_only_BTC.net, dd: bt.trend_SMA200_long_only_BTC.max_dd_pct },
  { name: "BTC 50-day trend, long only, 2% risk", net: B.test.net, dd: B.test.max_dd_pct },
];
const data = { series, candidates, gate, costs, grid: g, bench };
const html = readFileSync(new URL("./page-template.html", import.meta.url), "utf8").replace("__DATA__", JSON.stringify(data));
writeFileSync(new URL("./research-round-2.html", import.meta.url), html);
console.log("bytes", html.length, "series", Object.keys(series).length, "gate", gate.length);
