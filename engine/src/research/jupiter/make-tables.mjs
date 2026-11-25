// Generate the report tables directly from the committed result files (no hand transcription).
//   node make-tables.mjs <docs/research/jupiter dir>   -> writes TABLES.md there
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const D = process.argv[2];
const dev = JSON.parse(readFileSync(join(D, "results-dev.json"), "utf8")), ho = JSON.parse(readFileSync(join(D, "results-holdout.json"), "utf8"));
const g = (c, w, k) => dev.rows.find((r) => r.candidate === c && r.window === w && r.costs === k);
let s = "# Jupiter Perps research tables (generated from results-dev.json and results-holdout.json)\n\n";
s += "## Pre-registered checks\n\n| Candidate | Q1 DD<15 % & no shutdown | Q2 CAGR | Q3 no liquidation | Q4 P(−25 %/91 d)<5 % | Q5 breadth | Passes |\n|---|---|---|---|---|---|---|\n";
for (const [c, d] of Object.entries(dev.decisions)) s += `| ${c} | ${d.Q1 ? "pass" : "FAIL"} | ${d.Q2 ? "pass" : "FAIL"} | ${d.Q3 ? "pass" : "FAIL"} | ${d.Q4 ? "pass" : "FAIL"} | ${d.Q5 ? "pass" : "FAIL"} | ${d.passes_dev ? "yes" : "**no**"} |\n`;
s += `\n**Pick: ${dev.pick_before_holdout}**\n\n## DEV-2 (2018-04..2026-09), conservative costs, with DEV-3 and base-cost context\n\n`;
s += "| Candidate | CAGR | Max DD | $75 shutdown | DEV-3 CAGR / shutdown | Base-cost CAGR / DD | Trades | Win % | PF | Borrow $ | Open+close $ | P(−25 % in 91 d) | Holdout end $ / DD |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
for (const c of Object.keys(dev.decisions)) {
  const a = g(c, "DEV-2", "conservative"), b = g(c, "DEV-3", "conservative"), z = g(c, "DEV-2", "base"), e = dev.extra[c], h = ho.rows.find((r) => r.candidate === c && r.costs === "conservative");
  s += `| ${c} | ${a.cagr_pct} % | ${a.max_dd_pct} % | ${a.shutdown ?? "no"} | ${b.cagr_pct} % / ${b.shutdown ? b.shutdown.slice(0, 7) : "no"} | ${z.cagr_pct} % / ${z.max_dd_pct} % | ${a.trades} | ${a.win_rate ?? "–"} | ${a.profit_factor ?? "–"} | ${a.fees.borrow} | ${(a.fees.open + a.fees.close).toFixed(2)} | ${(e.rolling["91d"].p_loss25 * 100).toFixed(1)} % | ${h.final} / ${h.max_dd_pct} %${h.shutdown ? " (shutdown)" : ""} |\n`;
}
s += "\n## Rolling net returns, DEV-2 conservative, research mode without the shutdown: median / worst (%)\n\n| Candidate | 7 days | 14 days | 30 days | 91 days |\n|---|---|---|---|---|\n";
for (const [c, e] of Object.entries(dev.extra)) s += `| ${c} | ${["7d", "14d", "30d", "91d"].map((k) => `${e.rolling[k].median_pct} / ${e.rolling[k].worst_pct}`).join(" | ")} |\n`;
s += "\n## Per-asset CAGR, DEV-2 conservative (each asset alone, one-third sleeve)\n\n| Candidate | BTC | ETH | SOL |\n|---|---|---|---|\n";
for (const [c, e] of Object.entries(dev.extra)) s += `| ${c} | ${e.per_asset.BTC.cagr_pct} % | ${e.per_asset.ETH.cagr_pct} % | ${e.per_asset.SOL.cagr_pct} % |\n`;
const sh = dev.rows.filter((r) => r.shutdown);
s += `\n## Shutdown overshoot\n\nThe $75 shutdown triggered in ${sh.length} of ${dev.rows.length} DEV runs. Lowest equity reached: $${Math.min(...sh.map((r) => r.min_equity))}. Runs that ended below $75: ${sh.filter((r) => r.final < 75).length}.\n`;
s += `Liquidations in all DEV runs: ${dev.rows.reduce((t, r) => t + r.liquidations, 0)}. Stops fired: ${dev.rows.reduce((t, r) => t + r.counts.stopFired, 0)}; stop failures (retried): ${dev.rows.reduce((t, r) => t + r.counts.stopFailed, 0)}. Decisions skipped by the $10 minimum collateral: ${dev.rows.reduce((t, r) => t + r.counts.skippedMin, 0)}.\n`;
writeFileSync(join(D, "TABLES.md"), s);
console.log(s);
