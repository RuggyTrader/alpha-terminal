// Runner for docs/research/futures/PERP-PREREGISTRATION.md (THEORETICAL PAPER ONLY).
//   node run-perp.mjs <kraken-ohlcvt dir> <signals dir> <out.json>
import { writeFileSync } from "node:fs";
import { simulatePerp, periodStats, longestRecoveryDays, HOUR, DAY } from "./perp.mjs";
import { setup } from "./perp-setup.mjs";

const [KR, SIG, OUT] = process.argv.slice(2);
const { data, prev, SIGNALS, SIZING, COSTS, MARGIN, NT, WINDOWS, CYCLES } = setup(KR, SIG);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const rows = [];
for (const [hn, sig] of Object.entries(SIGNALS)) for (const [sn, size] of Object.entries(SIZING)) for (const [cn, cost] of Object.entries(COSTS)) for (const compound of [true, false]) {
  if (!compound && (sn.startsWith("EXPL") || cn === "ideal")) continue;
  const weightsSeen = { BTC: [], ETH: [] };
  let held = null;
  const decide = (d) => { const s = sig(d); if (s === null) return null; held = s; const w = {}; for (const a of ["BTC", "ETH"]) { const x = s[a]; w[a] = x === null || x === undefined ? 0 : x * size(a, d); if (w[a]) weightsSeen[a].push(Math.abs(w[a])); } return w; };
  for (const [w0, w1] of WINDOWS) {
    const from = Date.parse(w0), to = Date.parse(w1);
    const r = simulatePerp([data.BTC, data.ETH], decide, { capital: 100, compound, margin: MARGIN, band: 0.25, ...cost }, { from, to });
    const row = { hypothesis: hn, sizing: sn, cost: cn, compound, window: `${w0}..${w1}`, final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_pct: r2(r.dd_pct), liquidations: r.liquidations, ruined: r.ruined, fees: r2(r.fees), funding: r2(r.funding), slippage: r2(r.slipCost), missed: r.missed, trades: r.trades,
      p14: periodStats(r.daily, 14), p30: periodStats(r.daily, 30), p91: periodStats(r.daily, 91), p365: periodStats(r.daily, 365), longest_recovery_days: r2(longestRecoveryDays(r.daily)),
      worst_day_pct: r2(Math.min(...r.daily.slice(1).map((x, i) => (x[1] / r.daily[i][1] - 1) * 100))), status: "THEORETICAL PAPER ONLY" };
    if (w0 === "2017-01-01") row.cycles = CYCLES.map(([n, a, b]) => { const s = r.daily.filter(([t]) => t >= Date.parse(a) && t < Date.parse(b)); if (s.length < 2) return { cycle: n }; let pk = s[0][1], md = 0; for (const [, v] of s) { pk = Math.max(pk, v); md = Math.max(md, 1 - v / pk); } return { cycle: n, ret_pct: r2((s.at(-1)[1] / s[0][1] - 1) * 100), close_dd_pct: r2(md * 100) }; });
    rows.push(row);
  }
  // minimum executable capital (whole NinjaTrader perp-style contracts, overnight margin, 15 % buffer)
  const ex = {};
  for (const a of ["BTC", "ETH"]) {
    const ws = weightsSeen[a].sort((x, y) => x - y); if (!ws.length) continue;
    const typical = ws[ws.length >> 1], cn = NT.contractUnits[a] * NT.price[a];
    const one = cn / typical, five = 5 * one;
    const marginNeed = (C) => { const k = Math.max(1, Math.round((typical * C) / cn)); return (k * NT.overnight[a]) / 0.85; };
    ex[a] = { typical_weight: r2(typical), contract_notional: r2(cn), capital_for_1_contract: r2(Math.max(one, marginNeed(one))), capital_for_5_contracts: r2(Math.max(five, marginNeed(five))), leverage_allowed_by_NT_overnight_margin: r2(cn / NT.overnight[a]), this_leverage_allowed: typical <= cn / NT.overnight[a] };
  }
  for (const row of rows.filter((x) => x.hypothesis === hn && x.sizing === sn && x.cost === cn && x.compound === compound)) row.executable = ex;
}
const cand = [...new Set(rows.map((r) => `${r.hypothesis}|${r.sizing}`))].filter((k) => { const rs = rows.filter((r) => `${r.hypothesis}|${r.sizing}` === k && r.cost === "conservative" && r.compound && !r.sizing.startsWith("EXPL")); return rs.length === 3 && rs.every((r) => r.dd_pct <= 15) && rs[0].cagr_pct >= 15 && rs[2].final > 100; });
writeFileSync(OUT, JSON.stringify({ status: "THEORETICAL PAPER ONLY", prereg: "docs/research/futures/PERP-PREREGISTRATION.md", candidates: cand, rows }, null, 1) + "\n");
for (const r of rows) console.log(`${r.hypothesis.slice(0, 26).padEnd(26)} ${r.sizing.padEnd(15)} ${r.cost.slice(0, 5)} ${r.compound ? "cmp" : "fix"} ${r.window.slice(0, 7)} $${String(r.final).padStart(9)} ${String(r.cagr_pct).padStart(7)}%/yr DD ${String(r.dd_pct).padStart(6)}% liq ${r.liquidations} rec ${r.longest_recovery_days}d`);
console.log("CANDIDATES:", JSON.stringify(cand));
