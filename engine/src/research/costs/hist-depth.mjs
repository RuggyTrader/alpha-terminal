// Historical OBSERVED executable cost (research only): Tardis.dev free first-of-month Kraken "book_snapshot_5" (top 5
// levels each side, reconstructed from Kraken's public book feed). Once per minute, walks the book for a market BUY and a
// market SELL of 50 and 100 units of the quote currency and records the cost per side versus the mid:
//   buy: avgPx / mid - 1      sell: 1 - avgPx / mid      (so half-spread + impact, counted once)
// If five levels are not enough, the minute is flagged "beyond 5 levels" and its cost is a LOWER BOUND (remainder priced
// at the fifth level). Only summaries are kept. Sequential downloads with a pause.
//   node hist-depth.mjs <out.json>
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

const OUT = process.argv[2];
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { source: "Tardis.dev free first-day-of-month Kraken book_snapshot_5", rows: [] };
const have = new Set(done.rows.map((r) => `${r.date} ${r.symbol}`));
const DATES = ["2019-07-01", "2020-01-01", "2020-04-01", "2020-07-01", "2021-01-01", "2021-05-01", "2021-07-01", "2021-11-01", "2022-01-01", "2022-06-01", "2022-07-01", "2022-12-01",
  "2023-01-01", "2023-07-01", "2024-01-01", "2024-07-01", "2025-01-01", "2025-07-01", "2026-01-01", "2026-07-01", "2026-10-01", "2026-11-01"];
const USD_CHECK = new Set(["2019-07-01", "2022-06-01", "2024-07-01", "2026-11-01"]);
const symsFor = (d) => {
  const btc = d >= "2026-07-10" ? "BTC" : "XBT";
  const s = [`${btc}-CAD`, "ETH-CAD"];
  if (d >= "2024-12-01") s.push("SOL-CAD");
  if (d >= "2020-04-01") s.push("USD-CAD");
  if (d >= "2021-07-01") s.push("SOL-USD");
  if (USD_CHECK.has(d)) s.push(`${btc}-USD`, "ETH-USD");
  return s;
};
const SIZES = [50, 100];
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function walk(levels, notional) { // -> { avg, complete }
  let left = notional, qty = 0, last = null;
  for (const [p, a] of levels) { if (!(p > 0 && a > 0)) continue; last = p; const take = Math.min(left, p * a); qty += take / p; left -= take; if (left <= 1e-9) return { avg: notional / qty, complete: true }; }
  if (last === null) return null;
  qty += left / last; return { avg: notional / qty, complete: false };
}
async function one(date, sym) {
  const [y, m, d] = date.split("-");
  const r = await fetch(`https://datasets.tardis.dev/v1/kraken/book_snapshot_5/${y}/${m}/${d}/${sym}.csv.gz`, { headers: { "User-Agent": "research-client (read-only)" } });
  if (!r.ok) return { date, symbol: sym, error: `HTTP ${r.status}` };
  const rl = createInterface({ input: Readable.fromWeb(r.body).pipe(createGunzip()) });
  let header = true, nextMin = 0, cur = null;
  const cost = Object.fromEntries(SIZES.map((s) => [s, []])), incomplete = Object.fromEntries(SIZES.map((s) => [s, 0])), spread = [];
  const take = (f) => {
    const asks = [], bids = [];
    for (let i = 0; i < 5; i++) { asks.push([+f[4 + i * 4], +f[5 + i * 4]]); bids.push([+f[6 + i * 4], +f[7 + i * 4]]); }
    const ba = asks[0][0], bb = bids[0][0]; if (!(ba > bb && bb > 0)) return;
    const mid = (ba + bb) / 2; spread.push(((ba - bb) / mid) * 1e4);
    for (const s of SIZES) {
      const b = walk(asks, s), sl = walk(bids, s); if (!b || !sl) continue;
      cost[s].push((((b.avg / mid - 1) + (1 - sl.avg / mid)) / 2) * 1e4); // mean of buy and sell side, bps per side
      if (!b.complete || !sl.complete) incomplete[s]++;
    }
  };
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const f = line.split(","), t = Number(f[2]) / 1000;
    while (cur && t >= nextMin) { take(cur); nextMin += 60_000; }
    if (!cur) nextMin = Math.ceil(t / 60_000) * 60_000;
    cur = f;
  }
  if (cur) take(cur);
  const n = spread.length;
  return {
    date, symbol: sym, minutes: n, spread_bps: { median: q(spread, 0.5), p90: q(spread, 0.9) },
    cost_per_side_bps: Object.fromEntries(SIZES.map((s) => [s, { median: q(cost[s], 0.5), mean: cost[s].reduce((a, b) => a + b, 0) / (cost[s].length || 1), p90: q(cost[s], 0.9), beyond_5_levels_pct: (100 * incomplete[s]) / (cost[s].length || 1) }])),
  };
}
for (const date of DATES) for (const sym of symsFor(date)) {
  if (have.has(`${date} ${sym}`)) continue;
  let row; try { row = await one(date, sym); } catch (e) { row = { date, symbol: sym, error: e.message }; }
  done.rows.push(row); writeFileSync(OUT, JSON.stringify(done, null, 1) + "\n");
  console.log(date, sym, row.error ?? `n=${row.minutes} spread med ${row.spread_bps.median?.toFixed(1)} | C$50 cost/side med ${row.cost_per_side_bps[50].median?.toFixed(1)} mean ${row.cost_per_side_bps[50].mean?.toFixed(1)} p90 ${row.cost_per_side_bps[50].p90?.toFixed(1)} bps, beyond5 ${row.cost_per_side_bps[50].beyond_5_levels_pct.toFixed(0)}%`);
  await sleep(1500);
}
console.log("done");
