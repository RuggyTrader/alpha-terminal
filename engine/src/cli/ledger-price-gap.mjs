// How far the ALPHA PAPER ledger's fill price can sit from the strategy's own fill price (research only).
// The engine sends a signal after the candle in which its order filled has CLOSED; the Worker then fills at the live
// Kraken reference price. This measures, on the 150-day Model A trades, the gap between the strategy's fill (limit
// entry, TP2 limit, stop) and that candle's close (the closest recorded proxy for the ledger's reference price), and
// how often a "maker" limit entry was actually marketable (the candle opened through the limit: a taker fill).
//   node src/cli/ledger-price-gap.mjs --candles data/SOLUSD-5m-150d.json [--out ../docs/research/fill-semantics/ledger-price-gap.json]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";
import { runBacktest } from "./backtest.mjs";

export function priceGaps(candles, trades) {
  const byT = new Map(candles.map((k) => [new Date(k.t).toISOString(), k]));
  const rows = trades.map((t) => {
    const ke = byT.get(t.entryTime), kx = byT.get(t.exitTime);
    const dir = t.side === "LONG" ? 1 : -1;
    // + = the ledger's price is WORSE for the trade than the strategy's fill (pays more on entry / gets less on exit)
    const entryGap = dir * (ke.c - t.entryPrice) * t.qty;
    const exitGap = -dir * (kx.c - t.exitPrice) * t.qty;
    const marketableEntry = dir === 1 ? ke.o < t.entryPrice + 1e-9 && ke.o === t.entryPrice : ke.o > t.entryPrice - 1e-9 && ke.o === t.entryPrice;
    return { side: t.side, exitKind: t.exitKind, entryGap, exitGap, marketableEntry, entryPct: (100 * dir * (ke.c - t.entryPrice)) / t.entryPrice, exitPct: (100 * -dir * (kx.c - t.exitPrice)) / t.exitPrice };
  });
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.floor(p * (s.length - 1))];
    return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4), p10: +q(0.1).toFixed(4), median: +q(0.5).toFixed(4), p90: +q(0.9).toFixed(4), total: +s.reduce((a, b) => a + b, 0).toFixed(2) };
  };
  return {
    note: "Positive = the ledger's price is worse for the trade than the strategy's own fill. Candle close is a proxy; the live reference is read moments later.",
    entry_usd: stats(rows.map((r) => r.entryGap)), entry_pct: stats(rows.map((r) => r.entryPct)),
    tp_exit_usd: stats(rows.filter((r) => r.exitKind === "TP").map((r) => r.exitGap)),
    stop_exit_usd: stats(rows.filter((r) => r.exitKind !== "TP").map((r) => r.exitGap)),
    entries_filled_at_the_open_gap_through: rows.filter((r) => r.marketableEntry).length,
    entries: rows.length,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, base);
  const candles = JSON.parse(readFileSync(arg("candles"), "utf8")).candles;
  const { trades } = runBacktest({ candles, symbol: "SOLUSD", intervalMin: 5, inputs: cfg.inputs });
  const res = priceGaps(candles, trades);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}
