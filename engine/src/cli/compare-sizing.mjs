// Compares the original fixed-risk sizing with the small-account (percent) sizing on recorded real Kraken candles.
//   node src/cli/compare-sizing.mjs --candles data/SOLUSD-5m-25d.json [--history-from 2026-10-19T00:00:00Z]
//                                   [--profile solusd-5m] [--fee 0.4] [--out runs/sizing-compare]
// Uses the engine's own strategy code (onBar). Past results on a short window; not a forecast. Fees are an assumption
// (Kraken returned no fee schedule); the ALPHA PAPER ledger itself charges no fee.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { DEFAULT_SIZING } from "../sizing.mjs";
import { runBacktest } from "./backtest.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

/** Account statistics from a run: net of the assumed fees, drawdown on the closed-trade equity curve. */
export function stats(run, startCapital) {
  const t = run.trades;
  const fees = t.reduce((s, x) => s + (x.fee ?? 0), 0);
  const gross = t.reduce((s, x) => s + x.pnl, 0);
  let eq = startCapital ?? 0, peak = eq, ddUsd = 0, ddPct = 0;
  for (const x of t) {
    eq += x.pnl - (x.fee ?? 0);
    peak = Math.max(peak, eq);
    ddUsd = Math.max(ddUsd, peak - eq);
    if (peak > 0) ddPct = Math.max(ddPct, ((peak - eq) / peak) * 100);
  }
  const skipped = {};
  for (const e of run.events) if (e.type === "ORDER_SKIPPED") skipped[e.code] = (skipped[e.code] ?? 0) + 1;
  const refused = {};
  for (const r of run.account?.refused ?? []) refused[r.code] = (refused[r.code] ?? 0) + 1;
  const net = gross - fees;
  const qtys = t.map((x) => x.qty);
  const values = t.map((x) => x.qty * x.entryPrice);
  return {
    trades: t.length, wins: t.filter((x) => x.pnl - (x.fee ?? 0) > 0).length, longs: t.filter((x) => x.side === "LONG").length,
    gross_pnl: +gross.toFixed(2), fees: +fees.toFixed(2), net_pnl: +net.toFixed(2),
    start_capital: startCapital, end_capital: startCapital === null ? null : +(startCapital + net).toFixed(2),
    return_pct: startCapital ? +((net / startCapital) * 100).toFixed(2) : null,
    max_drawdown_usd: +ddUsd.toFixed(2), max_drawdown_pct: startCapital ? +ddPct.toFixed(2) : null,
    qty_min: qtys.length ? +Math.min(...qtys).toFixed(6) : null, qty_max: qtys.length ? +Math.max(...qtys).toFixed(6) : null,
    order_value_median: values.length ? +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2) : null,
    order_value_max: values.length ? +Math.max(...values).toFixed(2) : null,
    skipped_orders: skipped, refused_entries: refused,
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/compare-sizing.mjs")) {
  const doc = JSON.parse(readFileSync(arg("candles"), "utf8"));
  const from = arg("history-from", "2026-10-19T00:00:00Z");
  const h = Date.parse(from);
  const candles = doc.candles.filter((k) => k.t >= h);
  const cfg = loadConfig({ ...process.env, ENGINE_PROFILE: arg("profile", "solusd-5m"), ENGINE_ENV_FILE: "none" }, process.cwd());
  const fee = Number(arg("fee", String(DEFAULT_SIZING.feePct)));
  const maxNotional = 5000; // the Worker's MAX_ORDER_NOTIONAL
  const base = { candles, symbol: doc.symbol, intervalMin: doc.intervalMin, inputs: cfg.inputs };
  const fixedRisk = cfg.inputs.riskUSD;

  const rows = [];
  const add = (name, run, cap) => rows.push({ variant: name, ...stats(run, cap) });

  add(`A. Original: fixed $${fixedRisk} risk, unlimited capital, long+short, no fees (TradingView-style)`, runBacktest(base), null);
  add(`A'. Same, fees ${fee}%/side`, runBacktest({ ...base, ledger: { startCapital: 1e12, feePct: fee, maxNotional: null, longOnly: false } }), null);
  for (const cap of [10, 50, 100]) {
    add(`B. Original fixed $${fixedRisk} risk on a $${cap} PAPER balance (ledger rules, long-only, fees ${fee}%)`,
      runBacktest({ ...base, ledger: { startCapital: cap, feePct: fee, maxNotional, longOnly: true } }), cap);
  }
  for (const pctRisk of [1]) {
    for (const cap of [10, 50, 100]) {
      for (const f of [...new Set([0, 0.05, 0.1, 0.25, fee])]) {
        add(`C. Small-account ${pctRisk}% risk, $${cap} start, compounding, fees ${f}%/side`,
          runBacktest({ ...base, sizing: { mode: "percent", riskPct: pctRisk, feePct: fee }, ledger: { startCapital: cap, feePct: f, maxNotional, longOnly: true } }), cap);
      }
    }
  }
  // Break-even fee: the per-side fee at which gross P&L is used up by fees (gross ÷ traded value both ways).
  const turnover = (run) => run.trades.reduce((s, x) => s + x.qty * (x.entryPrice + x.exitPrice), 0);
  const be = (run) => { const g = run.trades.reduce((s, x) => s + x.pnl, 0); const tv = turnover(run); return tv > 0 ? +((g / tv) * 100).toFixed(4) : null; };
  const breakEven = {
    original_fixed_unlimited: be(runBacktest(base)),
    small_account_1pct_100: be(runBacktest({ ...base, sizing: { mode: "percent", riskPct: 1, feePct: fee }, ledger: { startCapital: 100, feePct: 0, maxNotional, longOnly: true } })),
  };
  const out = arg("out", join("runs", "sizing-compare"));
  mkdirSync(out, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    data: { source: doc.source, symbol: doc.symbol, intervalMin: doc.intervalMin, from: new Date(candles[0].t).toISOString(), to: doc.to, candles: candles.length },
    profile: cfg.profile, assumptions: {
      fee_pct_per_side: fee, fee_note: "assumption: Kraken returned no fee schedule; the ALPHA PAPER ledger charges no fee",
      kraken_rules: "ordermin 0.05 SOL, costmin $0.50, 8 decimals (Kraken AssetPairs, 2026-11-09)",
      ledger: "long-only; an entry is refused when qty x the fill candle's close exceeds the available balance or $5,000",
      sizing_buffers: { priceBufferPct: DEFAULT_SIZING.priceBufferPct, feeReservePct: fee },
    },
    break_even_fee_pct_per_side: breakEven,
    rows,
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
}
