// Downloads real Kraken candles for a backtest: builds them from Kraken's public trade list for the requested
// period, then checks every candle that overlaps Kraken's own OHLC endpoint (last ~60 h) for an exact match.
//   node src/cli/history.mjs --symbol SOLUSD --interval 5 --days 14 --out data/SOLUSD-5m.json

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { candlesFromTrades, fetchCompletedCandles } from "../kraken.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const symbol = arg("symbol", "SOLUSD");
const intervalMin = Number(arg("interval", "5"));
const days = Number(arg("days", "14"));
const out = arg("out", `data/${symbol}-${intervalMin}m.json`);

const step = intervalMin * 60_000;
const toMs = Math.floor(Date.now() / step) * step; // excludes the still-forming candle
const fromMs = toMs - days * 86_400_000;

const candles = await candlesFromTrades({
  symbol, intervalMin, fromMs, toMs,
  onProgress: (ms, n) => process.stderr.write(`\r${new Date(ms).toISOString()}  ${n} candles   `),
});
process.stderr.write("\n");

// Cross-check against Kraken's own candles where both exist.
const ohlc = await fetchCompletedCandles({ symbol, intervalMin });
const byTime = new Map(candles.map((k) => [k.t, k]));
let compared = 0, mismatched = 0;
const examples = [];
for (const k of ohlc) {
  const m = byTime.get(k.t);
  if (!m || k.t >= toMs) continue;
  compared += 1;
  if (m.o !== k.o || m.h !== k.h || m.l !== k.l || m.c !== k.c) {
    mismatched += 1;
    if (examples.length < 5) examples.push({ t: new Date(k.t).toISOString(), trades: m, ohlc: k });
  }
}

const doc = {
  source: `Kraken public Trades API (${symbol}), aggregated to ${intervalMin}m candles; completed candles only`,
  symbol, intervalMin, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fetchedAt: new Date().toISOString(),
  check: { againstKrakenOHLC: { compared, mismatched, examples } },
  candles,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc));
console.log(JSON.stringify({ out, candles: candles.length, from: doc.from, to: doc.to, check: doc.check.againstKrakenOHLC }, null, 1));
