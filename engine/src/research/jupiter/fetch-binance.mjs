// Public Binance SPOT 1-hour candles for BTCUSDT / ETHUSDT / SOLUSDT (SUBSTITUTE price data for Jupiter's oracle prices;
// these are NOT Jupiter fills). Market-data-only endpoint data-api.binance.vision; no account, no keys. Polite pacing.
//   node fetch-binance.mjs <out dir>     -> <SYMBOL>-1h.json ({ source, fetched, rows: [[t, o, h, l, c, v], ...] }) + MANIFEST.json
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const OUT = process.argv[2]; if (!OUT) { console.error("usage: node fetch-binance.mjs <out dir>"); process.exit(2); }
const H = 3_600_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const START = { BTCUSDT: Date.parse("2017-08-17T00:00:00Z"), ETHUSDT: Date.parse("2017-08-17T00:00:00Z"), SOLUSDT: Date.parse("2020-08-11T00:00:00Z") };
const manifest = {};
for (const [sym, t0] of Object.entries(START)) {
  const rows = []; let t = t0; const end = Math.floor(Date.now() / H) * H; // only CLOSED hours
  while (t < end) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=1000&startTime=${t}`;
    let r; for (let k = 0; k < 4; k++) { try { r = await fetch(url, { headers: { "User-Agent": "research-client (read-only market data)" }, signal: AbortSignal.timeout(20_000) }); if (r.ok) break; } catch {} await sleep(2000 * (k + 1)); }
    if (!r?.ok) throw new Error(`${sym} ${new Date(t).toISOString()} HTTP ${r?.status}`);
    const b = await r.json(); if (!b.length) break;
    for (const x of b) if (x[0] < end) rows.push([x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]);
    t = b.at(-1)[0] + H; await sleep(300);
  }
  const text = JSON.stringify({ source: "Binance spot klines 1h via data-api.binance.vision (SUBSTITUTE for Jupiter oracle prices, not Jupiter fills)", symbol: sym, fetched: new Date().toISOString(), rows });
  writeFileSync(join(OUT, `${sym}-1h.json`), text);
  manifest[sym] = { rows: rows.length, first: new Date(rows[0][0]).toISOString(), last: new Date(rows.at(-1)[0]).toISOString(), sha256: createHash("sha256").update(text).digest("hex") };
  console.log(sym, JSON.stringify(manifest[sym]));
}
writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 1) + "\n");
