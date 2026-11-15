// The whole BTC/SOL daily MA long-only grid in every period (robustness view; no selection happens here).
import { readFileSync, writeFileSync } from "node:fs";
import { metrics, simulate } from "../final-wt/engine/src/research/r2.mjs";
const DIR = "C:/Users/hujhj/Documents/Codex/2026-10-18/ok-should-i-make-a-completly/outputs/alpha-terminal/engine/data/research2";
const D = Date.parse;
const P = { dev: [D("2021-07-01"), D("2024-01-01")], val: [D("2024-01-01"), D("2025-07-01")], test: [D("2025-07-01"), D("2026-11-15")] };
const rows = [];
for (const [asset, prod] of [["BTC", "BTC-USD"], ["SOL", "SOL-USD"]]) {
  const K = JSON.parse(readFileSync(`${DIR}/${prod}-86400.json`, "utf8")).candles;
  for (const n of [50, 100, 200]) for (const k of [2, 3]) for (const trail of [0, 3]) {
    const row = { asset, n, k, trail };
    for (const [per, [a, b]] of Object.entries(P)) {
      const r = simulate({ K, barMs: 86_400_000, family: "ma", p: { n, k, trail, short: false }, capital: 100, asset, fee: 0.2, slip: 0.05, riskPct: 2, fromMs: a, toMs: b });
      const m = metrics(r, 100);
      row[per] = { net: m.net, trades: m.trades, pf: m.profit_factor, dd: m.max_dd_pct, ci: m.avg_net_ci95, hold: m.avg_hold_h, streak: m.longest_losing_streak, win: m.win_rate, gross: m.gross, fees: m.fees, avg: m.avg_net };
    }
    rows.push(row);
  }
}
writeFileSync(new URL("./magrid.json", import.meta.url), JSON.stringify(rows, null, 1));
for (const r of rows) console.log(r.asset, `MA${r.n} k${r.k} trail${r.trail}`.padEnd(18), ["dev", "val", "test"].map((p) => `${p} ${String(r[p].net).padStart(7)} n${String(r[p].trades).padStart(3)} pf ${r[p].pf}`).join(" | "));
const pos = (a, p) => rows.filter((r) => r.asset === a && r[p].net > 0).length;
for (const a of ["BTC", "SOL"]) console.log(a, "positive configs: dev", pos(a, "dev"), "/12  val", pos(a, "val"), "/12  test", pos(a, "test"), "/12  all three", rows.filter((r) => r.asset === a && r.dev.net > 0 && r.val.net > 0 && r.test.net > 0).length);
