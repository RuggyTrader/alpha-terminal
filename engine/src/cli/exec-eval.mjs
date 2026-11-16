#!/usr/bin/env node
// RESEARCH: each bot's ORIGINAL profile under the PRODUCTION execution model (Stage C), on recorded Kraken candles.
//
//   node src/cli/exec-eval.mjs --sol1 <SOL 1m json> --btc1 <BTC 1m json> --sol5 <SOL 5m json> [--wallet 20] [--out file.json]
//
// Execution (identical to production): the strategy (onBar) places its OTE limit order at the candle close; the broker
// emulator fills it on a LATER completed candle by TradingView's intrabar rules (a limit at its price or the better gap
// open; stops at the stop or the worse gap open; targets at the limit); the PAPER ledger (FleetLedgerSim) fills at that
// strategy price, sizes from the bot's OWN wallet (dollar risk reduced to fit, venue minimums), posts 100% SHORT
// collateral, charges the fee on every fill and sweeps positive net profit to MAIN. Pending orders expire with the
// setup (maxAge). No lookahead: every decision uses completed candles only.
// What candles cannot prove: that an exchange limit at that price would actually have been filled (queue position,
// liquidity, partial fills). A limit touched by a candle's low/high is treated as filled.
//
// Reported per bot: development (first 60 %) and untouched out-of-sample (last 40 %) periods, fee levels
// 0 / 0.02 / 0.05 / 0.10 / 0.20 % per fill, the earlier candle-close model at 0.20 % for comparison, and weekly
// market regimes (trend and volatility) at 0.20 %.

import { readFileSync, writeFileSync } from "node:fs";
import { aggregate, profileInputs, runFleetBacktest } from "./fleet-backtest.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
// Several files (comma-separated) are merged by candle time (duplicates dropped), e.g. Aug-Oct + Oct-Nov.
const load = (fs) => {
  const m = new Map();
  for (const f of String(fs).split(",")) for (const k of JSON.parse(readFileSync(f, "utf8")).candles) m.set(k.t, k);
  return [...m.values()].sort((a, b) => a.t - b.t);
};
const sol1 = arg("sol1") ? load(arg("sol1")) : null, btc1 = load(arg("btc1")), sol5file = arg("sol5") ? load(arg("sol5")) : null;
const WALLET = Number(arg("wallet", "20"));
const FEES = (arg("fees", "0,0.02,0.05,0.1,0.2")).split(",").map(Number);
const variant = arg("variant", null) ? JSON.parse(arg("variant")) : {};
const only = arg("bots", "ALPHA-01,ALPHA-02,ALPHA-03,ALPHA-04").split(",");
const WARMUP_MS = 2 * 86_400_000;
const TF = Number(arg("tf", "5")); // timeframe for the two "5m" profiles (higher-timeframe research: 15, 30, 60)
const SLIP = Number(arg("slip", "0"));
// strict acceptance timing; --strict-limit: a size-only change does not restart the order's age
const FILL = process.argv.includes("--strict-limit") ? { entryDelayBars: 1, entryAgeKey: "limit" } : process.argv.includes("--strict") ? { entryDelayBars: 1 } : undefined; // % slippage applied by the backtest's fill model (sensitivity)

const defs = [
  { id: "ALPHA-01", group: "SOLANA", symbol: "SOLUSD", intervalMin: 1, priority: 2, profile: "solusd-1m", candles: sol1 },
  { id: "ALPHA-02", group: "SOLANA", symbol: "SOLUSD", intervalMin: TF, priority: 1, profile: "solusd-5m", candles: TF === 5 && sol5file ? sol5file : sol1 ? aggregate(sol1, TF) : sol5file && TF % 5 === 0 ? aggregate(sol5file, TF / 5) : null },
  { id: "ALPHA-03", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 1, priority: 3, profile: "btcusd-1m", candles: btc1 },
  { id: "ALPHA-04", group: "BITCOIN", symbol: "BTCUSD", intervalMin: TF, priority: 4, profile: "btcusd-5m", candles: aggregate(btc1, TF) },
].filter((d) => d.candles && only.includes(d.id));

const iso = (ms) => new Date(ms).toISOString();
function metrics(T) {
  const nets = T.map((t) => t.net / 1e6), gross = T.reduce((s, t) => s + t.gross, 0) / 1e6, fees = T.reduce((s, t) => s + t.entryFee + t.exitFee, 0) / 1e6;
  const turnover = T.reduce((s, t) => s + t.collateral + Math.round(t.qty * t.exit * 1e6), 0) / 1e6;
  const wins = nets.filter((v) => v > 0), losses = nets.filter((v) => v < 0);
  let cum = 0, peak = 0, dd = 0;
  for (const v of nets) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const lossSum = -losses.reduce((s, v) => s + v, 0);
  return {
    trades: T.length, long: T.filter((t) => t.side === "LONG").length, short: T.filter((t) => t.side === "SHORT").length,
    gross: +gross.toFixed(4), fees: +fees.toFixed(4), net: +(gross - fees).toFixed(4), turnover: +turnover.toFixed(2),
    win_rate: T.length ? +(wins.length / T.length).toFixed(3) : null,
    profit_factor: lossSum > 0 ? +(wins.reduce((s, v) => s + v, 0) / lossSum).toFixed(3) : null,
    expectancy: T.length ? +((gross - fees) / T.length).toFixed(4) : null, max_drawdown: +dd.toFixed(4),
    gross_per_turnover_pct: turnover > 0 ? +((gross / turnover) * 100).toFixed(4) : null,
  };
}
function runOne(d, { feePct, fillModel, fromMs, toMs }) {
  const bot = { ...d, inputs: { ...profileInputs(process.cwd(), d.profile), ...variant }, riskUSD: 10 };
  const r = runFleetBacktest({ bots: [bot], main: WALLET, allocations: [{ group: d.group, amountUsd: WALLET }], feePct, fillModel, fromMs, toMs, slippagePct: SLIP, fill: FILL });
  return r;
}
// The ledger's own trade list (with prices, qty, fees) from a run: re-run the simulation and capture its trades.
import { FleetLedgerSim } from "../capital.mjs";
const trades = [];
const origClose = FleetLedgerSim.prototype.close;
FleetLedgerSim.prototype.close = function (...a) { const r = origClose.apply(this, a); if (r?.trade) trades.push(r.trade); return r; };
function tradesOf(d, opts) { trades.length = 0; runOne(d, opts); return trades.slice(); }

const report = { label: "RESEARCH (recorded Kraken candles; not production results)", wallet_per_bot: WALLET, variant, timeframe_5m_profiles: TF, slippage_pct: SLIP, fee_levels_pct_per_fill: FEES, bots: {} };
for (const d of defs) {
  const t0 = d.candles[0].t + WARMUP_MS, t1 = d.candles.at(-1).t, split = t0 + Math.floor((t1 - t0) * 0.6);
  const periods = { development: [t0, split], out_of_sample: [split, t1 + 1], full: [t0, t1 + 1] };
  const out = { symbol: d.symbol, timeframe: `${d.intervalMin}m`, profile: d.profile, data: { from: iso(d.candles[0].t), to: iso(t1), candles: d.candles.length, warmup_until: iso(t0), split: iso(split) }, periods: {} };
  for (const [name, [a, b]] of Object.entries(periods)) {
    const p = { strategy_fills: {}, candle_close_fills_at_0_20: null };
    for (const f of FEES) p.strategy_fills[`${f}%`] = metrics(tradesOf(d, { feePct: f, fillModel: "strategy", fromMs: a, toMs: b }));
    p.candle_close_fills_at_0_20 = metrics(tradesOf(d, { feePct: 0.2, fillModel: "close", fromMs: a, toMs: b }));
    const at0 = p.strategy_fills["0%"], at20 = p.strategy_fills["0.2%"];
    // Break-even fee per fill: the rate at which this run's net is zero = gross (zero-fee run) / turnover (both fills).
    p.break_even_fee_pct_per_fill = at0.turnover > 0 ? +((at0.gross / at0.turnover) * 100).toFixed(4) : null;
    p.check_at_0_20 = { gross: at20.gross, fees: at20.fees, net: at20.net };
    out.periods[name] = p;
  }
  // Weekly regimes on the full period at 0.20 %: trend = |weekly return| vs median; volatility = weekly range vs median.
  const T = tradesOf(d, { feePct: 0.2, fillModel: "strategy", fromMs: t0, toMs: t1 + 1 });
  const week = 7 * 86_400_000, weeks = [];
  for (let a = t0; a < t1; a += week) {
    const cs = d.candles.filter((k) => k.t >= a && k.t < a + week);
    if (cs.length < 10) continue;
    const ret = Math.abs(cs.at(-1).c / cs[0].o - 1), rng = Math.max(...cs.map((k) => k.h)) / Math.min(...cs.map((k) => k.l)) - 1;
    weeks.push({ a, ret, rng, T: T.filter((t) => t.openTime >= a && t.openTime < a + week) });
  }
  const med = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const mRet = med(weeks.map((w) => w.ret)), mRng = med(weeks.map((w) => w.rng));
  const groups = {};
  for (const w of weeks) {
    const k = `${w.ret >= mRet ? "trending" : "sideways"} + ${w.rng >= mRng ? "high volatility" : "low volatility"}`;
    (groups[k] ??= { weeks: 0, trades: [] }).weeks += 1; groups[k].trades.push(...w.T);
  }
  out.regimes_full_at_0_20 = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { weeks: g.weeks, ...metrics(g.trades) }]));
  report.bots[d.id] = out;
  console.error(`${d.id} done`);
}
const file = arg("out", null);
if (file) writeFileSync(file, JSON.stringify(report, null, 1));
for (const [id, b] of Object.entries(report.bots)) {
  const f = b.periods.full, o = b.periods.out_of_sample;
  console.log(id, b.timeframe, b.data.from.slice(0, 10), "→", b.data.to.slice(0, 10), "| full: trades", f.strategy_fills["0%"].trades,
    "gross@0", f.strategy_fills["0%"].gross, "net@0.2", f.strategy_fills["0.2%"].net, "close-model net@0.2", f.candle_close_fills_at_0_20.net,
    "| break-even fee/fill", f.break_even_fee_pct_per_fill + "%", "| OOS net@0.2", o.strategy_fills["0.2%"].net, "OOS break-even", o.break_even_fee_pct_per_fill + "%");
}
