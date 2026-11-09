// Descriptive check (NOT a selection step): the variants that happened to be profitable after Ndax costs in the
// untouched out-of-sample period. Were they also good before it, and in every third of the history, and under worse
// execution? A variant that only shines out of sample is luck until shown otherwise.
//   node src/cli/research-oos-winners.mjs --candles data/SOLUSD-5m-150d.json --report runs/research-150d

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { VENUES } from "../costs.mjs";
import { equityCurve, evaluate, grid, runVariant, STRESS } from "./research.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const doc = JSON.parse(readFileSync(arg("candles"), "utf8"));
const dir = arg("report");
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const all = JSON.parse(readFileSync(join(dir, "all-variants.json"), "utf8"));
const profile = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, process.cwd()).inputs;
const t0 = Date.parse(report.method.in_sample[0]), tSplit = Date.parse(report.method.out_of_sample[0]), t1 = Date.parse(report.method.out_of_sample[1]);
const thirds = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3);
const winners = all.filter((v) => v.out_of_sample_ndax.net > 0).map((v) => v.id);
const out = winners.map((id) => {
  const v = grid().find((g) => g.id === id);
  const tr = runVariant(doc.candles, v, profile);
  const strict = runVariant(doc.candles, { ...v, limitThroughTicks: 3 }, profile);
  return {
    id,
    in_sample_ndax: evaluate(tr, VENUES.ndax, t0, tSplit),
    out_of_sample_ndax: evaluate(tr, VENUES.ndax, tSplit, t1),
    out_of_sample_kraken: evaluate(tr, VENUES.kraken, tSplit, t1),
    out_of_sample_ndax_slip0_3: evaluate(tr, STRESS.ndax_slip0_3, tSplit, t1),
    out_of_sample_ndax_strict_fills: evaluate(strict, VENUES.ndax, tSplit, t1),
    thirds_ndax: [0, 1, 2].map((i) => evaluate(tr, VENUES.ndax, thirds[i], thirds[i + 1]).returnPct),
    full_ndax: evaluate(tr, VENUES.ndax, t0, t1),
  };
});
writeFileSync(join(dir, "oos-winners.json"), JSON.stringify(out, null, 1));
// Equity curves for these variants, next to the baseline, in the same format as equity.json.
const baseId = "tf5|tp0.25|orig|stop>=0%|ema0|score>=1";
const ids = [baseId, ...winners];
writeFileSync(join(dir, "oos-winners-equity.json"), JSON.stringify({
  split: tSplit, from: t0, to: t1,
  curves: ids.map((id) => {
    const tr = runVariant(doc.candles, grid().find((g) => g.id === id), profile);
    return { id, ndax: equityCurve(tr, VENUES.ndax, t0, t1), kraken: equityCurve(tr, VENUES.kraken, t0, t1), none: equityCurve(tr, VENUES.none, t0, t1) };
  }),
}));
for (const w of out) {
  console.log(w.id, "| IS", w.in_sample_ndax.returnPct, "% /", w.in_sample_ndax.trades, "| OOS", w.out_of_sample_ndax.returnPct, "% /", w.out_of_sample_ndax.trades,
    "PF", w.out_of_sample_ndax.profitFactor, "| kraken OOS", w.out_of_sample_kraken.returnPct, "| slip0.3", w.out_of_sample_ndax_slip0_3.returnPct,
    "| strict", w.out_of_sample_ndax_strict_fills.returnPct, "| thirds", w.thirds_ndax.join(" / "), "| full", w.full_ndax.returnPct, "% DD", w.full_ndax.maxDDPct);
}
