// BTC daily MA-50 long-only (k3, trail 3): every reported figure, every period; costs; risk; regimes.
import { readFileSync, writeFileSync } from "node:fs";
import { metrics, simulate } from "../final-wt/engine/src/research/r2.mjs";
const DIR = "C:/Users/hujhj/Documents/Codex/2026-10-18/ok-should-i-make-a-completly/outputs/alpha-terminal/engine/data/research2";
const D = Date.parse;
const P = { dev: [D("2021-07-01"), D("2024-01-01")], val: [D("2024-01-01"), D("2025-07-01")], test: [D("2025-07-01"), D("2026-11-15")] };
const R = JSON.parse(readFileSync(new URL("./r2.json", import.meta.url), "utf8"));
const out = {};
for (const [asset, prod] of [["BTC", "BTC-USD"], ["SOL", "SOL-USD"]]) {
  const K = JSON.parse(readFileSync(`${DIR}/${prod}-86400.json`, "utf8")).candles;
  const run = (per, o = {}) => { const r = simulate({ K, barMs: 86_400_000, family: "ma", p: { n: 50, k: 3, trail: 3, short: false }, capital: o.cap ?? 100, asset, fee: o.fee ?? 0.2, slip: o.slip ?? 0.05, riskPct: o.risk ?? 2, fromMs: P[per][0], toMs: P[per][1] }); return { r, m: metrics(r, o.cap ?? 100) }; };
  const row = { periods: {}, costs: {}, risk: {}, capital: {}, regimes: {} };
  for (const per of Object.keys(P)) {
    row.periods[per] = run(per).m;
    row.costs[per] = [[0, 0], [0.2, 0.05], [0.2, 0.15], [0.4, 0.05], [0.4, 0.15]].map(([fee, slip]) => ({ fee, slip, net: run(per, { fee, slip }).m.net }));
    row.risk[per] = [1, 2, 3].map((risk) => ({ risk, net: run(per, { risk }).m.net, dd: run(per, { risk }).m.max_dd_pct }));
    row.capital[per] = [20, 50, 100].map((cap) => ({ cap, net: run(per, { cap }).m.net, trades: run(per, { cap }).m.trades }));
  }
  const full = simulate({ K, barMs: 86_400_000, family: "ma", p: { n: 50, k: 3, trail: 3, short: false }, capital: 100, asset, fee: 0.2, slip: 0.05, riskPct: 2, fromMs: P.dev[0], toMs: P.test[1] });
  for (const t of full.trades) {
    const q = R.regimes[asset].find((x) => t.entryT >= x.from && t.entryT < x.to); if (!q) continue;
    for (const k of [q.trend, q.vol]) { const o = (row.regimes[k] ??= { trades: 0, net: 0 }); o.trades++; o.net = +(o.net + t.net).toFixed(2); }
  }
  out[asset] = row;
}
writeFileSync(new URL("./longonly.json", import.meta.url), JSON.stringify(out, null, 1));
for (const [a, r] of Object.entries(out)) {
  console.log(`\n${a} MA-50 long-only`);
  for (const [p, m] of Object.entries(r.periods)) console.log(" ", p, JSON.stringify(m));
  for (const p of Object.keys(r.costs)) console.log(" ", p, "costs", r.costs[p].map((c) => `${c.fee}/${c.slip}:${c.net}`).join(" "), "| risk", r.risk[p].map((x) => `${x.risk}%:${x.net}(dd ${x.dd}%)`).join(" "), "| capital", r.capital[p].map((x) => `$${x.cap}:${x.net} n${x.trades}`).join(" "));
  console.log("  regimes", JSON.stringify(r.regimes));
}
