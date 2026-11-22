// Historical Kraken TRADES (research only), from Kraken's official public REST "Trades" endpoint (full history, paged
// with `since`). Used where no free order-book history exists (before mid-2019, and crash days that are not the first of
// a month). Each trade carries its aggressor side, so a SPREAD ESTIMATE can be made: the median price gap between a
// buyer-initiated and a seller-initiated trade less than GAP seconds apart. This is an ESTIMATE, not an observed book;
// it is calibrated against observed books on overlapping dates (hist-books.mjs). Summaries only are stored.
//   node hist-trades.mjs <out.json>
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";

const OUT = process.argv[2];
const RAW = join(dirname(OUT), "kraken-trades-raw"); mkdirSync(RAW, { recursive: true });
const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { source: "Kraken public REST /0/public/Trades (official, unauthenticated)", rows: [] };
const have = new Set(done.rows.map((r) => `${r.date} ${r.pair}`));
const GAP = 10; // seconds
const MAX_PAGES = 40; // <= 40,000 trades per pair-day; coverage is recorded
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATES = [
  // 2016-2019 (before free book history): quarterly
  "2016-07-01", "2016-10-01", "2017-01-01", "2017-04-01", "2017-07-01", "2017-10-01", "2018-01-01", "2018-04-01", "2018-07-01", "2018-10-01", "2019-01-01", "2019-04-01",
  // stress days
  "2017-12-17", "2018-02-06", "2020-03-12", "2020-03-13", "2021-05-19", "2022-05-12", "2022-06-13", "2022-11-09",
  // calibration days (observed books exist for these)
  "2019-07-01", "2020-07-01", "2021-01-01", "2022-07-01", "2023-07-01", "2024-07-01", "2025-07-01", "2026-10-01",
];
const PAIRS = (d) => ["XBTUSD", "XBTCAD", "ETHUSD", "ETHCAD", ...(d >= "2021-07-01" ? ["SOLUSD"] : [])];
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function get(url) {
  for (let k = 0; k < 6; k++) {
    const r = await fetch(url, { headers: { "User-Agent": "research-client (read-only)" } });
    const j = await r.json().catch(() => null);
    if (j && !j.error?.length) return j.result;
    const msg = j?.error?.join(";") ?? `HTTP ${r.status}`;
    if (!/rate|limit|Too many|HTTP 5/i.test(msg)) throw new Error(msg);
    await sleep(5000 * (k + 1));
  }
  throw new Error("rate limited");
}
async function day(date, pair) {
  const t0 = Date.parse(date) / 1000, t1 = t0 + 86400;
  let since = BigInt(t0) * 1_000_000_000n, pages = 0;
  const tr = [];
  while (pages < MAX_PAGES) {
    const res = await get(`https://api.kraken.com/0/public/Trades?pair=${pair}&since=${since}&count=1000`);
    pages++;
    const rows = Object.entries(res).find(([k]) => k !== "last")[1];
    let past = false;
    for (const x of rows) { const t = +x[2]; if (t >= t1) { past = true; break; } if (t >= t0) tr.push({ t, px: +x[0], qty: +x[1], side: x[3] }); }
    if (past || !rows.length || BigInt(res.last) <= since) break;
    since = BigInt(res.last);
    await sleep(1100);
  }
  if (!tr.length) return { date, pair, trades: 0 };
  // raw trades kept (compressed) so the estimate can be re-derived offline
  writeFileSync(`${RAW}/${date}_${pair}.jsonl.gz`, gzipSync(tr.map((x) => `[${x.t},${x.px},${x.qty},"${x.side}"]`).join("\n")));
  // Kraken reports one taker order as several fills with the same timestamp; the FIRST fill of an order is at the best
  // quote on the opposite side. Group fills into orders (same time and side) and compare the first fill of consecutive
  // opposite-side orders < GAP s apart.
  const orders = [];
  for (const x of tr) { const o = orders.at(-1); if (o && o.t === x.t && o.side === x.side) continue; orders.push(x); }
  const gaps = [];
  let lastB = null, lastS = null;
  for (const x of orders) {
    if (x.side === "b") { lastB = x; if (lastS && x.t - lastS.t <= GAP) gaps.push(((x.px - lastS.px) / ((x.px + lastS.px) / 2)) * 1e4); }
    else { lastS = x; if (lastB && x.t - lastB.t <= GAP) gaps.push(((lastB.px - x.px) / ((x.px + lastB.px) / 2)) * 1e4); }
  }
  const vol = tr.reduce((s, x) => s + x.qty * x.px, 0);
  return {
    date, pair, trades: tr.length, pages, covered_hours: (tr.at(-1).t - tr[0].t) / 3600, truncated: pages >= MAX_PAGES,
    close: tr.at(-1).px, quote_volume: vol, median_trade_quote: q(tr.map((x) => x.qty * x.px), 0.5),
    buy_sell_gap_bps: { pairs: gaps.length, median: q(gaps, 0.5), p25: q(gaps, 0.25), p75: q(gaps, 0.75), p90: q(gaps, 0.9) },
  };
}
for (const date of DATES) for (const pair of PAIRS(date)) {
  if (have.has(`${date} ${pair}`)) continue;
  let row; try { row = await day(date, pair); } catch (e) { row = { date, pair, error: e.message }; }
  done.rows.push(row); writeFileSync(OUT, JSON.stringify(done, null, 1) + "\n");
  console.log(date, pair, row.error ?? `trades ${row.trades} hrs ${row.covered_hours?.toFixed(1)} gap med ${row.buy_sell_gap_bps?.median?.toFixed(2)} bps (n ${row.buy_sell_gap_bps?.pairs})`);
  await sleep(1100);
}
console.log("done");
