// RESEARCH: fee-aware variants of the ORIGINAL strategy (engine/research/variants.json), in-sample vs out-of-sample,
// at zero cost and at the official Ndax 0.20%/fill benchmark, per market regime. Nothing here touches the original
// profiles, the funded bots or the mirror.
//   node src/cli/research-variants.mjs --profile solusd-5m --candles data/SOLUSD-5m-150d.json --split 2026-09-20T00:00:00Z --out runs/research-sol5m.json
//   node src/cli/research-variants.mjs --profile btcusd-1m --chunks data/chunks/BTCUSD-1m --files data/BTCUSD-1m-11d.json --tf 1 --split 2026-11-04T00:00:00Z
// Selection discipline: a variant is only "promising" if it is better than the original IN-SAMPLE *and* stays net
// positive OUT-OF-SAMPLE at 0.20%; the out-of-sample period is never used to choose anything.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { economics, referenceTrades } from "./economics.mjs";
import { aggregate, profileInputs } from "./fleet-backtest.mjs";
import { loadCandles } from "./parity-convergence.mjs";

const r2 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** Month-by-month regime from the candles themselves: trend = |close change| ≥ 10%, high volatility = mean bar range above the median month. */
export function regimes(candles) {
  const months = new Map();
  for (const k of candles) { const m = new Date(k.t).toISOString().slice(0, 7); const x = months.get(m) ?? { first: k.o, last: k.c, rng: 0, n: 0 }; x.last = k.c; x.rng += (k.h - k.l) / k.c; x.n += 1; months.set(m, x); }
  const rows = [...months.entries()].map(([m, x]) => ({ month: m, change_pct: ((x.last - x.first) / x.first) * 100, mean_range_pct: (x.rng / x.n) * 100 }));
  const med = [...rows.map((r) => r.mean_range_pct)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;
  return rows.map((r) => ({ ...r, change_pct: r2(r.change_pct), mean_range_pct: +r.mean_range_pct.toFixed(4), trend: Math.abs(r.change_pct) >= 10 ? "TRENDING" : "RANGING", volatility: r.mean_range_pct > med ? "HIGH" : "LOW" }));
}

function runVariant(v, { base, inputs, symbol, tf }) {
  if (v.kind === "timeframe") {
    if (v.timeframe_min % tf !== 0 || v.timeframe_min <= tf) return null;
    return referenceTrades({ candles: aggregate(base, v.timeframe_min), symbol, intervalMin: v.timeframe_min, inputs, fromMs: null });
  }
  const t = referenceTrades({ candles: base, symbol, intervalMin: tf, inputs: v.kind === "overrides" ? { ...inputs, ...v.overrides } : inputs, fromMs: null });
  if (v.kind === "posthoc_min_tp_pct") return t.filter((x) => x.tpPct !== null && x.tpPct >= v.min_tp_pct);
  if (v.kind === "posthoc_min_stop_pct") return t.filter((x) => x.stopPct !== null && x.stopPct >= v.min_stop_pct);
  return t;
}

const slim = (e) => ({ trades: e.trades, gross: e.gross, fees: e.fees, net: e.net, net_profit_factor: e.net_profit_factor, gross_profit_factor: e.gross_profit_factor,
  max_drawdown_net: e.max_drawdown_net, net_expectancy: e.net_expectancy, avg_position_notional: e.avg_position_notional, avg_stop_pct: e.avg_stop_pct, avg_tp_pct: e.avg_tp_pct,
  break_even_fee_pct_per_fill: e.break_even_fee_pct_per_fill });

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/research-variants.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const profile = arg("profile");
  const tf = Number(arg("tf", "5"));
  const split = Date.parse(arg("split"));
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "research", "variants.json"), "utf8"));
  let base;
  if (arg("candles", null)) base = JSON.parse(readFileSync(arg("candles"), "utf8")).candles;
  else base = loadCandles({ chunks: arg("chunks", null), files: (arg("files", "") || "").split(",").filter(Boolean) });
  const src = Number(arg("src-tf", String(tf)));
  if (src !== tf) base = aggregate(base, tf);
  const symbol = profile.startsWith("btc") ? "BTCUSD" : "SOLUSD";
  const inputs = profileInputs(process.cwd(), profile);
  const out = { label: cfg._label, profile, timeframe: `${tf}m`, data: { first: new Date(base[0].t).toISOString(), last: new Date(base.at(-1).t).toISOString(), candles: base.length },
    split: { in_sample: `${new Date(base[0].t).toISOString()} → ${new Date(split).toISOString()}`, out_of_sample: `${new Date(split).toISOString()} → ${new Date(base.at(-1).t).toISOString()}` },
    regimes: regimes(base), variants: [] };
  const orig = {};
  for (const v of cfg.variants) {
    const t = runVariant(v, { base, inputs, symbol, tf });
    if (!t) { out.variants.push({ id: v.id, skipped: "not applicable to this timeframe" }); continue; }
    const IS = t.filter((x) => x.entryTime < split), OOS = t.filter((x) => x.entryTime >= split);
    const byMonth = {};
    for (const x of t) { const m = new Date(x.entryTime).toISOString().slice(0, 7); (byMonth[m] ??= []).push(x); }
    const row = { id: v.id, kind: v.kind, note: v.note,
      in_sample: { zero_cost: slim(economics(IS, 0)), ndax_0_20: slim(economics(IS, 0.2)) },
      out_of_sample: { zero_cost: slim(economics(OOS, 0)), ndax_0_20: slim(economics(OOS, 0.2)) },
      by_month_net_0_20: Object.fromEntries(Object.entries(byMonth).map(([m, xs]) => [m, economics(xs, 0.2).net])),
      by_month_gross: Object.fromEntries(Object.entries(byMonth).map(([m, xs]) => [m, economics(xs, 0).gross])) };
    if (v.kind === "original") Object.assign(orig, row);
    out.variants.push(row);
  }
  for (const r of out.variants) {
    if (r.skipped || r.kind === "original") continue;
    const betterIS = r.in_sample.ndax_0_20.net > orig.in_sample.ndax_0_20.net;
    const oosPositive = r.out_of_sample.ndax_0_20.net > 0 && r.out_of_sample.ndax_0_20.trades >= 20;
    const tooFew = r.out_of_sample.ndax_0_20.trades < 20 || r.in_sample.ndax_0_20.trades < 20;
    r.verdict = tooFew ? `INSUFFICIENT SAMPLE (${r.in_sample.ndax_0_20.trades} in-sample / ${r.out_of_sample.ndax_0_20.trades} out-of-sample trades): no conclusion`
      : betterIS && oosPositive ? "PROMISING (in-sample better, out-of-sample net positive at 0.20%; needs more data)"
      : betterIS ? "IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20%" : "NOT BETTER IN-SAMPLE";
  }
  if (arg("out", null)) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
  for (const r of out.variants) {
    if (r.skipped) { console.log(r.id, r.skipped); continue; }
    console.log(r.id.padEnd(22), "IS", r.in_sample.ndax_0_20.trades, "gross", r.in_sample.zero_cost.gross, "net@0.2", r.in_sample.ndax_0_20.net, "| OOS", r.out_of_sample.ndax_0_20.trades, "gross", r.out_of_sample.zero_cost.gross, "net@0.2", r.out_of_sample.ndax_0_20.net, "BE/fill", r.out_of_sample.zero_cost.break_even_fee_pct_per_fill, "|", r.verdict ?? "control");
  }
}
