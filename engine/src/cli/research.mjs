// Net-of-cost strategy research on recorded real Kraken SOLUSD candles. Research only: nothing here changes the
// production engine, its settings or the ledger.
//   node src/cli/research.mjs --candles data/SOLUSD-5m-150d.json [--out runs/research] [--split 0.6] [--folds 3]
//
// Method
// * Every variant runs the engine's own strategy code (onBar) once over the whole history, long-only, 1% risk
//   sizing capped to the balance (no leverage), with conservative limit fills (a resting limit fills only when price
//   trades 1 tick through it).
// * With percent sizing, each trade's size is a fixed fraction of the balance, so the same trade list compounds
//   exactly for any starting balance and any cost model. Costs per venue (src/costs.mjs): maker fee on limit entries
//   and take-profits, taker fee + slippage on stop / trailing / time exits.
// * Out of sample: variants are ranked on the first --split of the period only; the last part is never used to choose.
//   Walk-forward: --folds anchored folds, each picking the best variant on all data before it and testing it on the
//   next fold. Results are past performance on one market and period; they are not a forecast.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { VENUES } from "../costs.mjs";
import { runBacktest } from "./backtest.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

/** 5-minute candles → N-minute candles (only complete groups). */
export function aggregate(candles, minutes) {
  if (minutes === 5) return candles;
  const step = minutes * 60_000, out = [];
  let cur = null, n = 0;
  for (const k of candles) {
    const t = Math.floor(k.t / step) * step;
    if (!cur || cur.t !== t) {
      if (cur && n === minutes / 5) out.push(cur);
      cur = { t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v ?? 0 };
      n = 1;
    } else { cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.v += k.v ?? 0; n += 1; }
  }
  if (cur && n === minutes / 5) out.push(cur);
  return out;
}

const CAP = 100; // constant reference balance: only the fraction of the balance per trade is used

/** One strategy variant over the whole history → trades with the fraction of the balance each one used. */
export function runVariant(candles5, v, profileInputs) {
  const candles = aggregate(candles5, v.tf);
  const run = runBacktest({
    candles, symbol: "SOLUSD", intervalMin: v.tf, inputs: { ...profileInputs, ...v.inputs },
    fill: { limitThroughTicks: v.limitThroughTicks ?? 1, tick: 0.01 },
    sizing: { mode: "percent", riskPct: 1, feePct: 0.2, priceBufferPct: 0.5, minStopPct: v.minStopPct ?? 0, minQty: 0, minCost: 0 },
    ledger: { startCapital: CAP, feePct: 0, maxNotional: null, longOnly: true, fixedCapital: true },
  });
  return run.trades.map((t) => ({
    entryMs: Date.parse(t.entryTime), exitMs: Date.parse(t.exitTime), exitKind: t.exitKind, result: t.result,
    frac: (t.qty * t.entryPrice) / CAP, ret: t.exitPrice / t.entryPrice - 1, exitRatio: t.exitPrice / t.entryPrice,
  }));
}

/** Compounds a trade list over [fromMs, toMs) for one venue. Drawdown on the closed-trade equity curve. */
export function evaluate(trades, venue, fromMs, toMs, start = 100) {
  let eq = start, peak = start, dd = 0, ddUsd = 0, gross = 0, costs = 0, wins = 0, n = 0, gWin = 0, gLoss = 0;
  for (const t of trades) {
    if (t.entryMs < fromMs || t.entryMs >= toMs) continue;
    const taker = t.exitKind !== "TP";
    const costFrac = t.frac * (venue.makerPct / 100 + t.exitRatio * ((taker ? venue.takerPct + venue.takerSlipPct : venue.makerPct) / 100));
    const grossFrac = t.frac * t.ret;
    const pnl = eq * (grossFrac - costFrac);
    gross += eq * grossFrac;
    costs += eq * costFrac;
    eq += pnl;
    n += 1;
    if (pnl > 0) { wins += 1; gWin += pnl; } else gLoss -= pnl;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
    ddUsd = Math.max(ddUsd, peak - eq);
  }
  const r = (x) => Math.round(x * 100) / 100;
  return {
    trades: n, wins, winRate: n ? r((wins / n) * 100) : null, gross: r(gross), costs: r(costs), net: r(eq - start),
    returnPct: r(((eq - start) / start) * 100), maxDDPct: r(dd * 100), maxDDUsd: r(ddUsd), profitFactor: gLoss > 0 ? r(gWin / gLoss) : null,
    avgNetPerTrade: n ? Math.round(((eq - start) / n) * 10000) / 10000 : null,
  };
}

/** Balance after each closed trade over [fromMs, toMs) for one venue: [{t: exit time ms, eq}] starting at `start`. */
export function equityCurve(trades, venue, fromMs, toMs, start = 100) {
  let eq = start;
  const pts = [{ t: fromMs, eq }];
  for (const t of trades) {
    if (t.entryMs < fromMs || t.entryMs >= toMs) continue;
    const taker = t.exitKind !== "TP";
    eq *= 1 + t.frac * t.ret - t.frac * (venue.makerPct / 100 + t.exitRatio * ((taker ? venue.takerPct + venue.takerSlipPct : venue.makerPct) / 100));
    pts.push({ t: t.exitMs, eq: Math.round(eq * 100) / 100 });
  }
  return pts;
}

/**
 * Stress cost models (worse execution than the base assumptions). Kraken figures are VERIFIED (published fees,
 * measured book); Ndax fees are published but its SOL/CAD liquidity is NOT measured, so its slippage is an estimate.
 */
export const STRESS = Object.freeze({
  ndax_slip0_2: { ...VENUES.ndax, name: "Ndax, 0.20% slippage on stop exits", takerSlipPct: 0.2 },
  ndax_slip0_3: { ...VENUES.ndax, name: "Ndax, 0.30% slippage on stop exits", takerSlipPct: 0.3 },
  ndax_fee0_25: { ...VENUES.ndax, name: "Ndax at 0.25% fees, 0.10% slippage", makerPct: 0.25, takerPct: 0.25 },
  kraken_slip0_06: { ...VENUES.kraken, name: "Kraken Pro Tier 1, 0.06% slippage", takerSlipPct: 0.06 },
});

/** The candidate grid. "orig" reproduces the solusd-5m profile; everything else changes one rule family. */
export function grid() {
  const exits = {
    orig: {}, // break-even at 45% of the way to TP2, trailing from 5%
    none: { useTrail: false, useBE: false },
    late: { beFrac: 0.6, trailFrac: 0.5 },
  };
  const out = [];
  for (const tf of [5, 15, 30, 60]) {
    for (const tp2Ext of [0.25, 0, -0.27, -0.618]) {
      for (const [exitName, ex] of Object.entries(exits)) {
        for (const minStopPct of [0, 0.8, 1.5]) {
          for (const trendEma of [0, 200]) {
            for (const minScore of [1, 2]) {
              out.push({ id: `tf${tf}|tp${tp2Ext}|${exitName}|stop>=${minStopPct}%|ema${trendEma}|score>=${minScore}`, tf, minStopPct, inputs: { tp2Ext, minScore, trendEma, ...ex } });
            }
          }
        }
      }
    }
  }
  return out;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/research.mjs")) {
  const doc = JSON.parse(readFileSync(arg("candles"), "utf8"));
  const candles = doc.candles;
  const profile = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, process.cwd()).inputs;
  const split = Number(arg("split", "0.6"));
  const folds = Number(arg("folds", "3"));
  const warmMs = 2 * 86_400_000; // first two days: warm-up only, never counted
  const t0 = candles[0].t + warmMs, t1 = candles[candles.length - 1].t + 300_000;
  const tSplit = t0 + (t1 - t0) * split;
  const venues = ["ndax", "kraken", "none"];

  const variants = grid();
  const baselineId = "tf5|tp0.25|orig|stop>=0%|ema0|score>=1";
  const runs = new Map();
  for (const v of variants) runs.set(v.id, runVariant(candles, v, profile));
  // Reference: the original rules with the default (optimistic) touch fills, to show what the conservative fills cost.
  const touch = runVariant(candles, { ...variants.find((v) => v.id === baselineId), limitThroughTicks: 0 }, profile);

  const MIN_TRADES_IS = 15, MAX_DD = 15;
  const ok = (m) => m.trades >= MIN_TRADES_IS && m.maxDDPct <= MAX_DD;
  const rankOn = (venue, from, to) => [...runs].map(([id, tr]) => ({ id, m: evaluate(tr, VENUES[venue], from, to) }))
    .filter((x) => ok(x.m)).sort((a, b) => b.m.returnPct - a.m.returnPct || a.m.maxDDPct - b.m.maxDDPct);

  const report = {
    generated_at: new Date().toISOString(),
    data: { source: doc.source, from: new Date(candles[0].t).toISOString(), to: doc.to, candles5m: candles.length, check: doc.check?.againstKrakenOHLC ?? null },
    method: {
      sizing: "1% risk of balance, capped to the balance (no leverage), long-only, compounding from $100",
      fills: "limit orders fill only when price trades 1 tick through (conservative); stops at their level or the gap open",
      venues: Object.fromEntries(venues.map((v) => [v, VENUES[v]])),
      in_sample: [new Date(t0).toISOString(), new Date(tSplit).toISOString()],
      out_of_sample: [new Date(tSplit).toISOString(), new Date(t1).toISOString()],
      selection: `rank by in-sample Ndax net return among variants with >= ${MIN_TRADES_IS} in-sample trades and <= ${MAX_DD}% drawdown`,
      variants: variants.length,
    },
    baseline: {},
    top_in_sample: [],
    walk_forward: [],
    unprofitable_counts: {},
  };
  const base = runs.get(baselineId);
  for (const venue of venues) {
    report.baseline[venue] = {
      full: evaluate(base, VENUES[venue], t0, t1), in_sample: evaluate(base, VENUES[venue], t0, tSplit), out_of_sample: evaluate(base, VENUES[venue], tSplit, t1),
      full_touch_fills: evaluate(touch, VENUES[venue], t0, t1),
    };
  }
  for (const x of rankOn("ndax", t0, tSplit).slice(0, 10)) {
    const tr = runs.get(x.id);
    report.top_in_sample.push({
      id: x.id, in_sample_ndax: x.m,
      out_of_sample: Object.fromEntries(venues.map((v) => [v, evaluate(tr, VENUES[v], tSplit, t1)])),
      full_ndax: evaluate(tr, VENUES.ndax, t0, t1),
    });
  }
  // A stricter selection rule than "highest return": profitable after Ndax costs in BOTH halves of the selection
  // period, profit factor >= 1.2, same trade-count and drawdown limits.
  const tHalf = t0 + (tSplit - t0) / 2;
  const robust = [...runs].map(([id, tr]) => ({ id, m: evaluate(tr, VENUES.ndax, t0, tSplit), h1: evaluate(tr, VENUES.ndax, t0, tHalf), h2: evaluate(tr, VENUES.ndax, tHalf, tSplit) }))
    .filter((x) => ok(x.m) && x.h1.net > 0 && x.h2.net > 0 && (x.m.profitFactor ?? 0) >= 1.2)
    .sort((a, b) => b.m.returnPct - a.m.returnPct);
  report.robust_in_sample = robust.slice(0, 10).map((x) => ({ id: x.id, in_sample_ndax: x.m, is_first_half: x.h1.returnPct, is_second_half: x.h2.returnPct }));
  report.method.robust_selection = "Ndax-profitable in both halves of the selection period, profit factor >= 1.2, plus the trade and drawdown limits";

  // Detailed checks for the baseline, the top variants by in-sample return and the robust ones.
  const thirds = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3);
  const detailIds = [...new Set([baselineId, ...report.top_in_sample.map((x) => x.id), ...report.robust_in_sample.map((x) => x.id)])];
  report.detail = detailIds.map((id) => {
    const tr = runs.get(id);
    const v = variants.find((x) => x.id === id);
    const strict = runVariant(candles, { ...v, limitThroughTicks: 3 }, profile); // limits must trade 3 ticks through
    return {
      id, baseline: id === baselineId,
      out_of_sample: {
        ...Object.fromEntries(venues.map((vn) => [vn, evaluate(tr, VENUES[vn], tSplit, t1)])),
        ...Object.fromEntries(Object.entries(STRESS).map(([k, venue]) => [k, evaluate(tr, venue, tSplit, t1)])),
        ndax_strict_fills_3_ticks: evaluate(strict, VENUES.ndax, tSplit, t1),
      },
      thirds_ndax: [0, 1, 2].map((i) => evaluate(tr, VENUES.ndax, thirds[i], thirds[i + 1])),
      full: { ndax: evaluate(tr, VENUES.ndax, t0, t1), kraken: evaluate(tr, VENUES.kraken, t0, t1), none: evaluate(tr, VENUES.none, t0, t1) },
    };
  });

  // Anchored walk-forward over the whole period.
  const edges = Array.from({ length: folds + 2 }, (_, i) => t0 + ((t1 - t0) * i) / (folds + 1));
  let wfEq = 100;
  for (let f = 1; f <= folds; f++) {
    const best = rankOn("ndax", t0, edges[f])[0];
    const baseTest = evaluate(base, VENUES.ndax, edges[f], edges[f + 1]);
    const window = { train: [new Date(t0).toISOString(), new Date(edges[f]).toISOString()], test: [new Date(edges[f]).toISOString(), new Date(edges[f + 1]).toISOString()] };
    // No variant qualifies: the honest choice is not to trade (0%), not to pick the least bad one.
    if (!best) { report.walk_forward.push({ fold: f, ...window, chosen: null, note: "no variant met the in-sample constraints: stay flat", test_ndax: null, baseline_test_ndax: baseTest }); continue; }
    const test = evaluate(runs.get(best.id), VENUES.ndax, edges[f], edges[f + 1]);
    wfEq *= 1 + test.returnPct / 100;
    report.walk_forward.push({ fold: f, ...window, chosen: best.id, train_ndax: best.m, test_ndax: test, test_kraken: evaluate(runs.get(best.id), VENUES.kraken, edges[f], edges[f + 1]), baseline_test_ndax: baseTest });
  }
  report.walk_forward_compounded_return_pct_ndax = Math.round((wfEq - 100) * 100) / 100;
  for (const venue of venues) {
    const oos = [...runs].map(([, tr]) => evaluate(tr, VENUES[venue], tSplit, t1));
    report.unprofitable_counts[venue] = { variants: oos.length, oos_negative_or_zero: oos.filter((m) => m.net <= 0).length, oos_positive: oos.filter((m) => m.net > 0).length };
    const full = [...runs].map(([, tr]) => evaluate(tr, VENUES[venue], t0, t1));
    report.unprofitable_counts[venue].full_period_negative_or_zero = full.filter((m) => m.net <= 0).length;
  }
  const out = arg("out", join("runs", "research"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  // Equity curves (full period, $100 start) for the baseline and every variant in the detailed checks.
  writeFileSync(join(out, "equity.json"), JSON.stringify({
    split: tSplit, from: t0, to: t1,
    curves: detailIds.map((id) => ({ id, ...Object.fromEntries(venues.map((vn) => [vn, equityCurve(runs.get(id), VENUES[vn], t0, t1)])) })),
  }));
  writeFileSync(join(out, "all-variants.json"), JSON.stringify([...runs].map(([id, tr]) => ({
    id, full: Object.fromEntries(venues.map((v) => [v, evaluate(tr, VENUES[v], t0, t1)])),
    in_sample_ndax: evaluate(tr, VENUES.ndax, t0, tSplit), out_of_sample_ndax: evaluate(tr, VENUES.ndax, tSplit, t1),
  })), null, 1));
  console.log(JSON.stringify({ out, baseline: report.baseline, top3: report.top_in_sample.slice(0, 3), walk_forward: report.walk_forward, wf: report.walk_forward_compounded_return_pct_ndax, unprofitable: report.unprofitable_counts }, null, 1));
}
