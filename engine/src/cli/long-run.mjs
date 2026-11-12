// ALPHA-02 (SOL 5m) over the 150-day Kraken file: mirror reference plus modelled Ndax 0.20%/fill. Run from engine/: node src/cli/long-run.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { runBacktest } from "./backtest.mjs";
import { profileInputs } from "./fleet-backtest.mjs";
const d = JSON.parse(readFileSync("data/SOLUSD-5m-150d.json", "utf8"));
const inputs = { ...profileInputs(".", "solusd-5m"), riskUSD: 10 };
const r = runBacktest({ candles: d.candles, symbol: d.symbol, intervalMin: 5, inputs });
const t = r.trades; const sum = (f) => t.reduce((s, x) => s + f(x), 0);
const gross = sum((x) => x.pnl), fee = sum((x) => x.qty * (x.entryPrice + x.exitPrice) * 0.002);
const gw = sum((x) => Math.max(0, x.pnl)), gl = -sum((x) => Math.min(0, x.pnl));
let eq = 0, pk = 0, dd = 0; for (const x of t) { eq += x.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
const months = {}; for (const x of t) { const m = x.exitTime.slice(0, 7); months[m] = (months[m] ?? 0) + x.pnl; }
const out = { window: [new Date(d.candles[0].t).toISOString(), new Date(d.candles.at(-1).t).toISOString()], candles: d.candles.length, trades: t.length,
  longs: t.filter((x) => x.side === "LONG").length, shorts: t.filter((x) => x.side === "SHORT").length,
  gross: +gross.toFixed(2), pf: +(gw / gl).toFixed(3), max_dd: +dd.toFixed(2), win_rate: +(t.filter((x) => x.pnl > 0).length / t.length).toFixed(3),
  modelled_fees_0_20: +fee.toFixed(2), modelled_net: +(gross - fee).toFixed(2), avg_notional: +(sum((x) => x.qty * x.entryPrice) / t.length).toFixed(2),
  by_month_gross: Object.fromEntries(Object.entries(months).map(([k, v]) => [k, +v.toFixed(2)])) };
writeFileSync("runs/alpha02-sol5m-150d.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
