// RESEARCH: trade economics and fee sensitivity of the four ORIGINAL strategy profiles (unchanged inputs).
//   node src/cli/economics.mjs --sol1 data/SOLUSD-1m-….json --btc1 data/BTCUSD-1m-….json --from 2026-11-01T00:00:00Z --to 2026-11-12T00:00:00Z --out runs/economics
// Everything is computed from real Kraken candles through the engine's own onBar path:
//   * reference trades: TradingView semantics, fixed $10 risk, unlimited buying power (exact entry/exit/qty per trade);
//   * fee scenarios 0.00–0.20% per fill are RESEARCH SCENARIOS applied to those exact trades, not offers by any exchange;
//   * funded matrix: each bot ALONE in its own wallet (independent-wallet + profit-sweep rules of FleetLedgerSim), per
//     allocation and per fee scenario, plus spread/slippage scenarios at the official 0.20% Ndax benchmark.
// Warm-up candles before --from run the strategy but their trades are excluded.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createState, onBar } from "../ote.mjs";
import { aggregate, profileInputs, runFleetBacktest } from "./fleet-backtest.mjs";

export const FEES = [0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2];
export const ALLOCATIONS = [5, 10, 25, 50, 100, 500, 1000];
export const SLIPPAGE = [0, 0.02, 0.05, 0.1]; // % per side, research spread/slippage scenarios
const r2 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Exact reference trades (TradingView semantics) with each trade's planned stop and target from the engine's IN_TRADE record. */
export function referenceTrades({ candles, symbol, intervalMin, inputs, fromMs, fill, pivotTies }) {
  const S = createState({ symbol, timeframeMin: intervalMin, inputs, fill, pivotTies });
  const plans = [];
  for (const k of candles) for (const e of onBar(S, k)) if (e.type === "IN_TRADE") plans.push({ t: k.t, entry: e.entry, stop: e.stop, tp: e.tp2 });
  return S.broker.closed.filter((t) => fromMs === null || t.entryTime >= fromMs).map((t) => {
    const plan = plans.find((p) => p.t >= t.entryTime && p.t <= t.exitTime) ?? null;
    const dir = t.side === 1 ? 1 : -1;
    return { side: t.side === 1 ? "LONG" : "SHORT", qty: t.qty, entry: t.entryPrice, exit: t.exitPrice, entryTime: t.entryTime, exitTime: t.exitTime, exitKind: t.exitKind,
      gross: t.pnl, entryNotional: t.qty * t.entryPrice, exitNotional: t.qty * t.exitPrice, movePct: ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100 * dir,
      stopPct: plan?.stop ? (Math.abs(t.entryPrice - plan.stop) / t.entryPrice) * 100 : null, tpPct: plan?.tp ? (Math.abs(plan.tp - t.entryPrice) / t.entryPrice) * 100 : null,
      holdMin: (t.exitTime - t.entryTime) / 60_000 };
  });
}

function maxDD(nets) { let eq = 0, pk = 0, dd = 0; for (const x of nets) { eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); } return dd; }
function pf(nets) { const w = nets.filter((x) => x > 0).reduce((s, x) => s + x, 0), l = -nets.filter((x) => x < 0).reduce((s, x) => s + x, 0); return l > 0 ? w / l : w > 0 ? null : null; }

/** The economics of a set of exact trades at a per-fill fee rate (percent). riskUSD = the planned risk per trade. */
export function economics(trades, feePct = 0.2, riskUSD = 10) {
  const fee = (t) => (t.entryNotional + t.exitNotional) * feePct / 100;
  const nets = trades.map((t) => t.gross - fee(t));
  const gross = trades.reduce((s, t) => s + t.gross, 0);
  const notional = trades.reduce((s, t) => s + t.entryNotional + t.exitNotional, 0);
  const fees = trades.reduce((s, t) => s + fee(t), 0);
  const wins = trades.filter((t) => t.gross > 0), losses = trades.filter((t) => t.gross < 0);
  const bePerFill = notional > 0 ? (gross / notional) * 100 : null;
  return {
    trades: trades.length,
    total_entry_notional: r2(trades.reduce((s, t) => s + t.entryNotional, 0)), total_exit_notional: r2(trades.reduce((s, t) => s + t.exitNotional, 0)),
    avg_position_notional: r2(mean(trades.map((t) => t.entryNotional))),
    gross: r2(gross), fees: r2(fees), net: r2(gross - fees),
    avg_gross_per_trade: r2(mean(trades.map((t) => t.gross))), avg_net_per_trade: r2(mean(nets)),
    avg_win: r2(mean(wins.map((t) => t.gross))), avg_loss: r2(mean(losses.map((t) => t.gross))), win_rate: trades.length ? r4(wins.length / trades.length) : null,
    avg_move_pct: r4(mean(trades.map((t) => t.movePct))), median_move_pct: r4(median(trades.map((t) => t.movePct))),
    avg_abs_move_pct: r4(mean(trades.map((t) => Math.abs(t.movePct)))),
    avg_stop_pct: r4(mean(trades.map((t) => t.stopPct).filter((x) => x !== null))), avg_tp_pct: r4(mean(trades.map((t) => t.tpPct).filter((x) => x !== null))),
    avg_hold_min: r2(mean(trades.map((t) => t.holdMin))),
    gross_expectancy: r2(mean(trades.map((t) => t.gross))), net_expectancy: r2(mean(nets)),
    net_profit_factor: r4(pf(nets)), gross_profit_factor: r4(pf(trades.map((t) => t.gross))), max_drawdown_net: r2(maxDD(nets)),
    break_even_fee_pct_per_fill: r4(bePerFill), break_even_round_trip_pct: bePerFill === null ? null : r4(bePerFill * 2),
    fee_to_gross_profit: gross > 0 ? r4(fees / gross) : null,
    avg_fee_to_planned_risk: trades.length ? r4(mean(trades.map((t) => fee(t) / riskUSD))) : null,
  };
}

export function bySide(trades, feePct, riskUSD) {
  return { all: economics(trades, feePct, riskUSD), LONG: economics(trades.filter((t) => t.side === "LONG"), feePct, riskUSD), SHORT: economics(trades.filter((t) => t.side === "SHORT"), feePct, riskUSD) };
}

/** One bot alone in its own wallet (production-style accounting): allocation × fee × slippage. */
export function fundedMatrix(bot, { fromMs, fees = FEES, allocations = ALLOCATIONS, slippage = SLIPPAGE }) {
  const rows = [];
  for (const per of allocations) {
    for (const feePct of fees) {
      for (const slip of feePct === 0.2 ? slippage : [0]) {
        const r = runFleetBacktest({ bots: [{ ...bot, priority: 1 }], main: per, allocations: [{ group: bot.group, amountUsd: per }], feePct, slippagePct: slip, fromMs });
        const f = r.per_bot[bot.id].funded;
        rows.push({ allocation: per, fee_pct_per_fill: feePct, slippage_pct_per_side: slip, trades: f.trades, long: f.long_trades, short: f.short_trades,
          gross: r2(f.gross), fees: r2(f.fees), net: r2(f.net), net_profit_factor: f.profit_factor === null ? null : r4(f.profit_factor), max_drawdown: r2(f.max_drawdown),
          net_expectancy: f.trades ? r2(f.net / f.trades) : null, return_on_allocation_pct: r2((f.net / per) * 100), swept_to_main: r2(f.swept_to_main),
          wallet_end: r2(f.wallet_end), skipped: f.skipped, refused: f.refused, reduced_to_fit: f.reduced_to_fit, reconciles: r.combined.reconciles });
      }
    }
  }
  return rows;
}

export const BOT_DEFS = [
  { id: "ALPHA-01", group: "SOLANA", symbol: "SOLUSD", intervalMin: 1, profile: "solusd-1m", src: "sol1" },
  { id: "ALPHA-02", group: "SOLANA", symbol: "SOLUSD", intervalMin: 5, profile: "solusd-5m", src: "sol1" },
  { id: "ALPHA-03", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 1, profile: "btcusd-1m", src: "btc1" },
  { id: "ALPHA-04", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 5, profile: "btcusd-5m", src: "btc1" },
];

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/economics.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const fromMs = Date.parse(arg("from", "2026-11-01T00:00:00Z")), toMs = arg("to", null) ? Date.parse(arg("to")) : Infinity;
  const only = arg("bots", null)?.split(",") ?? null;
  const src = { sol1: arg("sol1", null), btc1: arg("btc1", null) };
  const load = (f) => JSON.parse(readFileSync(f, "utf8")).candles.filter((k) => k.t < toMs);
  const cache = {};
  const out = arg("out", join("runs", `economics-${Date.now()}`));
  mkdirSync(out, { recursive: true });
  const report = { generated_at: new Date().toISOString(), window: { from: new Date(fromMs).toISOString(), to: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null },
    label: "RESEARCH — original profiles unchanged; fee rates other than 0.20% are hypothetical scenarios, not available offers", bots: {} };
  for (const d of BOT_DEFS) {
    if (only && !only.includes(d.id)) continue;
    if (!src[d.src]) continue;
    cache[d.src] ??= load(src[d.src]);
    const candles = d.intervalMin === 1 ? cache[d.src] : aggregate(cache[d.src], d.intervalMin);
    const inputs = profileInputs(process.cwd(), d.profile);
    const trades = referenceTrades({ candles, symbol: d.symbol, intervalMin: d.intervalMin, inputs, fromMs });
    const bot = { ...d, candles, inputs, riskUSD: 10 };
    report.bots[d.id] = {
      symbol: d.symbol, timeframe: `${d.intervalMin}m`, profile: d.profile, candles: candles.length, first_candle: new Date(candles[0].t).toISOString(),
      reference_economics_at_0_20: bySide(trades, 0.2, 10),
      reference_fee_sensitivity: FEES.map((f) => ({ fee_pct_per_fill: f, ...economics(trades, f, 10) })),
      funded_matrix: arg("no-funded", null) ? null : fundedMatrix(bot, { fromMs }),
    };
    writeFileSync(join(out, `trades-${d.id}.json`), JSON.stringify(trades));
    console.error(`${d.id}: ${trades.length} trades`);
  }
  writeFileSync(join(out, "economics.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ out, bots: Object.keys(report.bots) }));
}
