// Read-only P1 order-book study collector (docs/research/discovery/GAP-STUDY-PREREGISTRATION.md). ONE sample per run.
// Public, unauthenticated endpoints only; no orders, no keys. ~19 requests per run.
//   node collect-gap.mjs <data dir>       (env GAP_STUDY_END = ISO end time; writes samples-YYYY-MM-DD.jsonl, errors.log)
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2]; if (!DIR) { console.error("usage: node collect-gap.mjs <data dir>"); process.exit(2); }
mkdirSync(DIR, { recursive: true });
if (Date.now() > Date.parse(process.env.GAP_STUDY_END ?? "2100-01-01")) process.exit(0);
const t0 = Date.now(), errors = [];
const UA = { "User-Agent": "research-client (read-only market data)" };
const get = async (url, init = {}) => { const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const post = (path, body) => get(`https://api.ndax.io:8443/AP/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const COINS = { BTC: [1, "XBTUSD"], ETH: [3, "ETHUSD"], XRP: [4, "XRPUSD"], LTC: [5, "LTCUSD"], DOGE: [77, "XDGUSD"], SOL: [99, "SOLUSD"] };
const SIZES = [33, 100]; // CAD
import { walk } from "./gap-util.mjs";
const depthWithin = (levels, best, pct) => levels.filter(([p]) => Math.abs(p / best - 1) <= pct).reduce((s, [p, q]) => s + p * q, 0);
const sample = { t: t0, ndax: {}, kraken: {} };
async function krakenBook(pair) { const r = await get(`https://api.kraken.com/0/public/Depth?pair=${pair}&count=25`); if (r.error?.length) throw new Error(r.error.join(";")); const b = Object.values(r.result)[0]; return { bid: +b.bids[0][0], ask: +b.asks[0][0], bidQty: +b.bids[0][1], askQty: +b.asks[0][1], t: Math.max(+b.bids[0][2], +b.asks[0][2]) * 1000 }; }
await Promise.all([
  ...Object.entries(COINS).map(async ([c, [id, pair]]) => {
    try {
      const rows = await post("GetL2Snapshot", { OMSId: 1, InstrumentId: id, Depth: 25 });
      const bids = rows.filter((x) => x[9] === 0).map((x) => [x[6], x[8]]).sort((a, b) => b[0] - a[0]), asks = rows.filter((x) => x[9] === 1).map((x) => [x[6], x[8]]).sort((a, b) => a[0] - b[0]);
      if (!bids.length || !asks.length) throw new Error("empty book");
      const l1 = await post("GetLevel1", { OMSId: 1, InstrumentId: id });
      sample.ndax[c] = { bid: bids[0][0], ask: asks[0][0], bidQty: bids[0][1], askQty: asks[0][1],
        buy: Object.fromEntries(SIZES.map((s) => [s, walk(asks, s)])), sell: Object.fromEntries(SIZES.map((s) => [s, walk(bids, s)])),
        askDepth2pct: depthWithin(asks, asks[0][0], 0.02), bidDepth2pct: depthWithin(bids, bids[0][0], 0.02),
        top10: { bids: bids.slice(0, 10), asks: asks.slice(0, 10) }, lastTradeTime: +l1.LastTradeTime, lastPx: +l1.LastTradedPx, notional24h: +l1.Rolling24HrNotional, notionalDay: +l1.CurrentDayNotional };
    } catch (e) { errors.push(`Ndax ${c}: ${e.message}`); }
    try { sample.kraken[c] = await krakenBook(pair); } catch (e) { errors.push(`Kraken ${c}: ${e.message}`); }
  }),
  (async () => { try { sample.kraken.USDCAD = await krakenBook("USDCAD"); } catch (e) { errors.push(`Kraken USDCAD: ${e.message}`); } })(),
]);
sample.t1 = Date.now();
appendFileSync(join(DIR, `samples-${new Date(t0).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(sample) + "\n");
if (errors.length) appendFileSync(join(DIR, "errors.log"), `${new Date(t0).toISOString()} ${errors.join(" | ")}\n`);
console.log(`${new Date(t0).toISOString()} ndax ${Object.keys(sample.ndax).length}/6 kraken ${Object.keys(sample.kraken).length}/7 errors ${errors.length} ${sample.t1 - t0}ms`);
