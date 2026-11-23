// One-contract Micro Ether feasibility probe (docs/research/futures/PROBE-PREREGISTRATION.md).
//   node probe.mjs <kraken-ohlcvt dir> <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken } from "../lab/data.mjs";
import { sma, roc, priorHigh, priorLow } from "../dd2/bt.mjs";
import { simulateMET, HOUR, DAY } from "./met.mjs";

const [DIR, OUT] = process.argv.slice(2);
const D = loadKraken(join(DIR, "ETHUSD_1440.csv"), DAY).bars, H = loadKraken(join(DIR, "ETHUSD_60.csv"), HOUR).bars;
const idx = new Map(D.map((b, i) => [b.t, i])), c = D.map((b) => b.c);
const S200 = sma(c, 200), R56 = roc(c, 56), HI20 = priorHigh(D, 20), LO10 = priorLow(D, 10);
// state machines over daily closes; the decision for day d uses the close of day d-1 (index i = idx(d - DAY))
const stateful = (enter, exit) => { const st = new Array(D.length).fill(0); for (let i = 1; i < D.length; i++) st[i] = st[i - 1] ? (exit(i) ? 0 : 1) : (enter(i) ? 1 : 0); return st; };
const MOM = stateful((i) => R56[i] !== null && R56[i] > 0.05, (i) => R56[i] !== null && R56[i] < 0);
const BRK = stateful((i) => HI20[i] !== null && c[i] > HI20[i], (i) => LO10[i] !== null && c[i] < LO10[i]);
const at = (d) => idx.get(d - DAY);
const PROBES = {
  "P1 trend long/flat": (i) => (S200[i] === null ? 0 : c[i] > S200[i] ? 1 : 0),
  "P2 trend long/short": (i) => (S200[i] === null ? 0 : c[i] > S200[i] ? 1 : -1),
  "P3 momentum (rule A signal)": (i) => MOM[i],
  "P4 breakout 20/10 (rule D signal)": (i) => BRK[i],
};
const r2 = (x) => Math.round(x * 100) / 100;
const rows = [];
for (const [w0, w1] of [["2017-01-01", "2026-10-01"], ["2018-04-01", "2026-10-01"], ["2022-01-01", "2026-10-01"]])
  for (const [pn, sig] of Object.entries(PROBES)) for (const stopPct of [null, 0.03]) for (const [liqName, liq] of [["A ($50)", 50], ["B ($100)", 100]]) for (const basis of [0.08, 0, 0.15]) {
    if (liqName.startsWith("B") && basis !== 0.08) continue;
    const decide = (d) => { const i = at(d); if (i === undefined) return { pos: 0 }; return { pos: sig(i), stopPct }; };
    const r = simulateMET(H, decide, { liqThreshold: liq, openMin: liq, basisAnnual: basis, hours: "cme" }, { from: Date.parse(w0), to: Date.parse(w1) });
    rows.push({ window: `${w0}..${w1}`, probe: pn, stop: stopPct ? "3 %" : "none", liquidation: liqName, basis_pct: basis * 100, final: r2(r.final), cagr_pct: r2(r.cagr_pct), dd_official_pct: r2(r.dd_official_pct), trades: r.trades, liquidations: r.liquidations, ruined: r.ruined, fees: r2(r.fees) });
  }
const ok = (w) => rows.filter((x) => x.window === w && x.liquidation === "A ($50)" && x.basis_pct === 8 && x.dd_official_pct < 15 && x.final > 100).map((x) => `${x.probe} / stop ${x.stop}`);
const W = [...new Set(rows.map((x) => x.window))], feasible = ok(W[0]).filter((k) => W.every((w) => ok(w).includes(k)));
writeFileSync(OUT, JSON.stringify({ prereg: "docs/research/futures/PROBE-PREREGISTRATION.md", feasible_in_principle: feasible, rows }, null, 1) + "\n");
for (const x of rows.filter((y) => y.basis_pct === 8)) console.log(`${x.window} ${x.probe.padEnd(34)} stop ${x.stop.padEnd(4)} liq ${x.liquidation.padEnd(8)} $${String(x.final).padStart(8)} ${String(x.cagr_pct).padStart(7)}%/yr DD ${String(x.dd_official_pct).padStart(6)}% trades ${String(x.trades).padStart(4)} liq ${x.liquidations} ruin ${x.ruined}`);
console.log("FEASIBLE IN PRINCIPLE:", JSON.stringify(feasible));
