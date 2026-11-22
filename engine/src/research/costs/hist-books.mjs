// Historical OBSERVED top-of-book (research only). Tardis.dev publishes Kraken's reconstructed order-book data and makes
// the FIRST DAY OF EACH MONTH free to download without an account or key. This streams the "quotes" (best bid/ask + size,
// every change) for selected dates, samples the book once per minute, and keeps only summary statistics (nothing raw is
// stored). Sequential downloads with a pause; public data only.
//   node hist-books.mjs <out.json>
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const OUT = process.argv[2];
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { source: "Tardis.dev free first-day-of-month Kraken 'quotes' (best bid/ask reconstructed from Kraken's public book feed)", rows: [] };
const have = new Set(done.rows.map((r) => `${r.date} ${r.symbol}`));
// quarterly from 2019-07 (Tardis' Kraken coverage starts 2019-06-04) + stress / cycle-turn dates
const dates = [];
for (let y = 2019; y <= 2026; y++) for (const m of [1, 4, 7, 10]) { const d = `${y}-${String(m).padStart(2, "0")}-01`; if (d >= "2019-07-01" && d <= "2026-10-01") dates.push(d); }
dates.push("2021-05-01", "2021-11-01", "2022-06-01", "2022-12-01", "2024-03-01", "2026-11-01");
dates.sort();
const symsFor = (d) => {
  const btc = d >= "2026-07-10" ? "BTC" : "XBT";
  const s = [`${btc}-USD`, `${btc}-CAD`, "ETH-USD", "ETH-CAD"];
  if (d >= "2021-07-01") s.push("SOL-USD");
  if (d >= "2024-12-01") s.push("SOL-CAD");
  if (d >= "2020-04-01") s.push("USD-CAD");
  return s;
};
const SIZES = [50, 100]; // quote-currency notional (CAD for CAD books, USD for USD books; USD-CAD book: USD amount)
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function one(date, sym) {
  const [y, m, d] = date.split("-");
  const url = `https://datasets.tardis.dev/v1/kraken/quotes/${y}/${m}/${d}/${sym}.csv.gz`;
  const r = await fetch(url, { headers: { "User-Agent": "research-client (read-only)" } });
  if (!r.ok) return { date, symbol: sym, error: `HTTP ${r.status}` };
  const rl = createInterface({ input: Readable.fromWeb(r.body).pipe(createGunzip()) });
  let header = true, nextMin = 0, cur = null;
  const spread = [], topCovers = Object.fromEntries(SIZES.map((s) => [s, 0])), halfBps = [];
  let n = 0, crossed = 0;
  const take = (c) => {
    const mid = (c.bid + c.ask) / 2, sp = ((c.ask - c.bid) / mid) * 1e4;
    if (!(c.bid > 0 && c.ask > 0)) return;
    if (sp <= 0) { crossed++; return; }
    n++; spread.push(sp); halfBps.push(sp / 2);
    for (const s of SIZES) if (c.ask * c.askQty >= s && c.bid * c.bidQty >= s) topCovers[s]++;
  };
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const f = line.split(",");
    const t = Number(f[2]) / 1000; // microseconds -> ms
    const c = { askQty: +f[4], ask: +f[5], bid: +f[6], bidQty: +f[7] };
    // sample the state in force at each whole minute
    while (cur && t >= nextMin) { take(cur); nextMin += 60_000; }
    if (!cur) nextMin = Math.ceil(t / 60_000) * 60_000;
    cur = c;
  }
  if (cur) take(cur);
  return {
    date, symbol: sym, minutes: n, crossed_or_locked: crossed,
    spread_bps: { median: q(spread, 0.5), p10: q(spread, 0.1), p90: q(spread, 0.9), p99: q(spread, 0.99), mean: spread.reduce((a, b) => a + b, 0) / (n || 1) },
    top_level_covers_pct: Object.fromEntries(SIZES.map((s) => [s, (100 * topCovers[s]) / (n || 1)])),
  };
}
for (const date of dates) for (const sym of symsFor(date)) {
  if (have.has(`${date} ${sym}`)) continue;
  let row;
  try { row = await one(date, sym); } catch (e) { row = { date, symbol: sym, error: e.message }; }
  done.rows.push(row);
  writeFileSync(OUT, JSON.stringify(done, null, 1) + "\n");
  console.log(date, sym, row.error ?? `n=${row.minutes} med ${row.spread_bps.median?.toFixed(2)} bps p90 ${row.spread_bps.p90?.toFixed(2)} top>=50 ${row.top_level_covers_pct[50].toFixed(0)}%`);
  await sleep(1500);
}
console.log("done");
