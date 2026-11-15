#!/usr/bin/env node
// RESEARCH DATA (round 2): real historical candles with documented provenance. Nothing is fabricated: a missing candle
// stays missing and is reported; invalid candles (h < max(o,c), l > min(o,c), non-positive) are reported and dropped.
//
//   node src/research/download.mjs --product SOL-USD --granularity 3600 --from 2021-06-01 --to 2026-11-15 --out file.json
//
// Source: Coinbase Exchange public market data, GET https://api.exchange.coinbase.com/products/<id>/candles
// (granularity in seconds; at most 300 candles per request; rows [time, low, high, open, close, volume], UTC).
// A Coinbase candle is omitted by the exchange when no trade happened in that interval; such gaps are listed.
import { writeFileSync } from "node:fs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const product = arg("product"), g = Number(arg("granularity", "3600"));
const from = Date.parse(arg("from")), to = Date.parse(arg("to")), out = arg("out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = new Map();
for (let a = from; a < to; a += 300 * g * 1000) {
  const b = Math.min(to, a + 300 * g * 1000);
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${g}&start=${new Date(a).toISOString()}&end=${new Date(b - 1000).toISOString()}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "research-client/1.0", Accept: "application/json" } });
    if (res.ok) { for (const r of await res.json()) rows.set(r[0] * 1000, r); break; }
    if (attempt >= 5) throw new Error(`${res.status} ${url}`);
    await sleep(1000 * (attempt + 1));
  }
  await sleep(150);
}
const invalid = [], candles = [];
for (const [t, [, l, h, o, c, v]] of [...rows.entries()].sort((x, y) => x[0] - y[0])) {
  if (!(o > 0 && h > 0 && l > 0 && c > 0) || h < Math.max(o, c) - 1e-12 || l > Math.min(o, c) + 1e-12) { invalid.push({ t: new Date(t).toISOString(), o, h, l, c }); continue; }
  candles.push({ t, o, h, l, c, v });
}
const gaps = [];
for (let i = 1; i < candles.length; i++) {
  const missing = Math.round((candles[i].t - candles[i - 1].t) / (g * 1000)) - 1;
  if (missing > 0) gaps.push({ after: new Date(candles[i - 1].t).toISOString(), missing });
}
const meta = {
  source: "Coinbase Exchange public market data API (api.exchange.coinbase.com/products/{id}/candles)", product, granularity_s: g,
  requested: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, downloaded_at: new Date().toISOString(),
  first: candles[0] ? new Date(candles[0].t).toISOString() : null, last: candles.at(-1) ? new Date(candles.at(-1).t).toISOString() : null,
  candles: candles.length, missing_candles: gaps.reduce((s, x) => s + x.missing, 0), gap_count: gaps.length, largest_gaps: [...gaps].sort((a, b) => b.missing - a.missing).slice(0, 10),
  invalid_dropped: invalid.length, invalid: invalid.slice(0, 20), fabricated: 0,
};
writeFileSync(out, JSON.stringify({ meta, candles }));
console.log(JSON.stringify(meta));
