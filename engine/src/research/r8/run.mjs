#!/usr/bin/env node
// Round 8 driver (docs/research/round8/PREREGISTRATION.md + addendum A1): development -> selection -> validation ->
// independent, with every gate computed exactly as pre-registered. Research only.
//   ALPHA_RESEARCH_DATA=<engine/data/research2> node src/research/r8/run.mjs --out r8-results.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { blockBootstrap, buyHold, rotate } from "./xsmom.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = process.env.ALPHA_RESEARCH_DATA, D = Date.parse;
const DEV = [D("2021-07-01"), D("2024-07-01")], VAL = [D("2024-07-01"), D("2026-11-15")], IND = [D("2022-01-01"), D("2026-11-15")];
const DEVM = ["BTC", "ETH", "SOL", "LTC", "LINK", "AVAX", "ADA", "BCH", "DOGE", "XRP"];
const INDM_LISTED = ["NEAR", "MKR", "COMP", "CRV", "GRT", "SNX", "MANA", "SAND", "XTZ", "ICP", "BAT", "YFI"];
const SECM = ["DOT", "ATOM", "UNI", "AAVE", "XLM", "ETC", "FIL", "ALGO"];
const COST = { selected: { feePct: 0.2, slipPct: 0.05 }, stress: { feePct: 0.4, slipPct: 0.1 }, kraken_taker: { feePct: 0.8, slipPct: 0.05 } };
const GRID = [{ L: 30, K: 2 }, { L: 30, K: 3 }, { L: 90, K: 2 }, { L: 90, K: 3 }];

const provenance = {};
const load = (m) => {
  const raw = readFileSync(`${DIR}/${m}-USD-86400.json`);
  provenance[m] = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return JSON.parse(raw).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
};
const universe = (ms) => Object.fromEntries(ms.map((m) => [m, load(m)]));
const r2 = (x) => +x.toFixed(2);
const brief = (r) => ({ net: r2(r.net), fees: r2(r.fees), entries: r.entries, mdd_pct: r2(r.mdd * 100), exposure_pct: r2(r.exposure * 100), turnover_usd: r2(r.grossTraded),
  by_year: Object.fromEntries(Object.entries(r.byYear).map(([y, v]) => [y, r2(v)])), pnl_by_market: Object.fromEntries(Object.entries(r.pnl).map(([m, v]) => [m, r2(v)])) });

// independent universe: the pre-registered data rule (history on or before 2022-01-01), never extended
const excluded = [], INDM = [];
for (const m of INDM_LISTED) { const b = load(m); (b.length && b[0].t <= IND[0] ? INDM : excluded).push(m); }

const dev = universe(DEVM), ind = universe(INDM), sec = universe(SECM);
const devRuns = GRID.map((g) => ({ ...g, ...brief(rotate(dev, { ...g, from: DEV[0], to: DEV[1], ...COST.selected })) }));
const eligible = devRuns.filter((r) => r.entries >= 30).sort((a, b) => b.net - a.net);
const pick = eligible[0] ?? null;
const out = { preregistration: "docs/research/round8/PREREGISTRATION.md", generated_at: new Date().toISOString(), costs: COST, grid: GRID,
  universes: { development: DEVM, independent: INDM, independent_excluded: excluded, secondary: SECM }, development: devRuns, selected: pick ? { L: pick.L, K: pick.K } : null, provenance };
if (pick) {
  const cfg = { L: pick.L, K: pick.K };
  const val = rotate(dev, { ...cfg, from: VAL[0], to: VAL[1], ...COST.selected });
  const i = rotate(ind, { ...cfg, from: IND[0], to: IND[1], ...COST.selected });
  const iS = rotate(ind, { ...cfg, from: IND[0], to: IND[1], ...COST.stress });
  const iK = rotate(ind, { ...cfg, from: IND[0], to: IND[1], ...COST.kraken_taker });
  const s = rotate(sec, { ...cfg, from: IND[0], to: IND[1], ...COST.selected });
  const boot = blockBootstrap(i.weekly, { block: 4, n: 10_000, alpha: 0.05 });
  const profit = Object.values(i.pnl).filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const top = Object.entries(i.pnl).sort((a, b) => b[1] - a[1])[0];
  const topShare = i.net > 0 && top ? top[1] / i.net : null;
  const yearsPos = [2022, 2023, 2024, 2025, 2026].filter((y) => (i.byYear[y] ?? 0) > 0).length;
  const gates = {
    "1 development net > 0": pick.net > 0,
    "2 validation net > 0": val.net > 0,
    "3 independent net > 0": i.net > 0,
    "4 independent net > 0 at 0.40% + 0.10%": iS.net > 0,
    "5 >= 30 independent entries": i.entries >= 30,
    "6 weekly block-bootstrap 95% lower bound > 0": boot.lo > 0,
    "7 independent max drawdown <= 40%": i.mdd <= 0.4,
    "8 positive in >= 3 of 5 years 2022-2026": yearsPos >= 3,
    "9 no market > 50% of independent net profit": topShare !== null && topShare <= 0.5,
    "data: >= 8 independent markets": INDM.length >= 8,
  };
  const pass = Object.values(gates).every(Boolean);
  Object.assign(out, {
    validation: brief(val), independent: brief(i), independent_stress: brief(iS), independent_kraken_taker: brief(iK), secondary: brief(s),
    bootstrap_weekly: { lo: +boot.lo.toFixed(5), mean: +boot.mean.toFixed(5), hi: +boot.hi.toFixed(5), weeks: i.weekly.length },
    concentration: { top_market: top?.[0] ?? null, top_pnl: top ? r2(top[1]) : null, top_share_of_net: topShare === null ? null : r2(topShare), gross_profit_markets: r2(profit) },
    years_positive: yearsPos,
    baselines: { buy_hold_development_val: r2(buyHold(dev, { from: VAL[0], to: VAL[1], ...COST.selected }).net), buy_hold_independent: r2(buyHold(ind, { from: IND[0], to: IND[1], ...COST.selected }).net),
      buy_hold_secondary: r2(buyHold(sec, { from: IND[0], to: IND[1], ...COST.selected }).net), cash: 0 },
    gates, status: pass ? "ELIGIBLE FOR FURTHER VALIDATION" : (i.net > 0 && val.net > 0 ? "INCONCLUSIVE" : "FAILED"),
  });
}
writeFileSync(arg("out", "r8-results.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ selected: out.selected, development: devRuns.map((r) => `${r.L}/${r.K}: ${r.net} (${r.entries})`), validation: out.validation?.net, independent: out.independent?.net,
  stress: out.independent_stress?.net, mdd: out.independent?.mdd_pct, boot: out.bootstrap_weekly, conc: out.concentration, years: out.independent?.by_year, gates: out.gates, status: out.status, baselines: out.baselines, secondary: out.secondary?.net, excluded }, null, 1));
