// Builds the verified backtest the website's risk simulator uses, and optionally uploads it to ALPHA TERMINAL.
//   node src/cli/simulate.mjs --candles data/SOLUSD-5m-25d.json [--profile solusd-5m] [--trades-from 2026-10-18]
//                             [--history-from 2026-10-19T00:00:00Z] [--out runs/sim-solusd-5m] [--upload]
// Runs the engine's own code on real recorded Kraken candles at the profile's risk per trade (the basis); the
// website rescales trades to other risks (exact under this model; see frontend/src/terminal/simulator.ts) and
// applies the PAPER capital constraints. --upload sends it to <ALPHA_API_BASE>/webhook/engine-backtest using the
// engine's env file (ENGINE_ENV_FILE / engine/.env). Nothing else is sent; no trading.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { runBacktest, checkFills } from "./backtest.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

export const EXECUTION_ASSUMPTIONS = [
  "Completed 5-minute Kraken candles; the strategy runs once per candle close (TradingView: On bar close).",
  "Orders placed at a candle close are worked from the next candle; intrabar path open→high→low→close when the open is nearer the high, otherwise open→low→high→close (TradingView emulator, no bar magnifier).",
  "Limit orders fill at their price, or at the open if the candle opens through them; stops fill at their price or the open on a gap.",
  "No commission, no slippage, pyramiding 0, leverage unlimited (TradingView Properties). Quantity = risk ÷ |entry − stop|, unrounded.",
  "Backtest fills are the engine's emulated prices. ALPHA PAPER ledger fills use the live Kraken reference price when the signal arrives, so ledger results can differ.",
];

export function buildResult({ doc, cfg, tradesFromMs, pivotTies }) {
  const { trades, events } = runBacktest({ candles: doc.candles, symbol: doc.symbol, intervalMin: doc.intervalMin, inputs: cfg.inputs, pivotTies, fromMs: tradesFromMs });
  const problems = checkFills(doc.candles, trades);
  if (problems.length) throw new Error(`fill invariants failed: ${problems.slice(0, 3).join("; ")}`);
  const hashInput = { symbol: doc.symbol, tf: doc.intervalMin, inputs: cfg.inputs, pivotTies: pivotTies ?? "strict/strict", tradesFrom: tradesFromMs };
  return {
    strategy: doc.symbol, profile: cfg.profile, risk_basis_usd: cfg.inputs.riskUSD,
    config_hash: createHash("sha256").update(JSON.stringify(hashInput)).digest("hex").slice(0, 16),
    inputs: cfg.inputs, pivot_ties: pivotTies ?? { left: "strict", right: "strict" },
    data: {
      source: doc.source, from: doc.from, to: doc.to, candles: doc.candles.length,
      trades_from: new Date(tradesFromMs).toISOString(), verified_against_kraken_ohlc: doc.check?.againstKrakenOHLC ?? null,
    },
    execution: EXECUTION_ASSUMPTIONS,
    generated_at: new Date().toISOString(),
    signals_considered: events.filter((e) => e.type === "ORDER_PLACED").length,
    trades: trades.map((t) => ({ ...t, entryTime: t.entryTime.replace(".000Z", "Z"), exitTime: t.exitTime.replace(".000Z", "Z") })),
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/simulate.mjs")) {
  const doc = JSON.parse(readFileSync(arg("candles"), "utf8"));
  // --history-from: start the strategy's history here (as TradingView's chart does); default: the file's first candle.
  if (arg("history-from", null)) {
    const h = Date.parse(arg("history-from"));
    doc.candles = doc.candles.filter((k) => k.t >= h);
    doc.from = new Date(h).toISOString();
  }
  const cfg = loadConfig({ ...process.env, ENGINE_PROFILE: arg("profile", "solusd-5m") }, process.cwd());
  const tradesFromMs = arg("trades-from", null) ? Date.parse(arg("trades-from")) : arg("history-from", null) ? doc.candles[0].t : doc.candles[0].t + 2 * 86_400_000;
  const pv = arg("pivots", null);
  const pivotTies = pv ? { left: pv.split("/")[0], right: pv.split("/")[1] } : undefined;
  const result = buildResult({ doc, cfg, tradesFromMs, pivotTies });
  const out = arg("out", join("runs", `sim-${cfg.profile}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "backtest.json"), JSON.stringify(result, null, 1));
  console.log(`${result.trades.length} trades from ${result.data.trades_from} to ${result.data.to}; basis risk $${result.risk_basis_usd}; written to ${out}/backtest.json`);
  if (process.argv.includes("--upload")) {
    if (!cfg.apiBase || !cfg.webhookSecret) throw new Error("--upload needs ALPHA_API_BASE and ALPHA_WEBHOOK_SECRET in the engine env file");
    const r = await fetch(`${cfg.apiBase}/webhook/engine-backtest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: cfg.webhookSecret, result }),
    });
    console.log(`upload: HTTP ${r.status} ${await r.text()}`);
    if (!r.ok) process.exit(1);
  }
}
