// 7-day read-only trading-cost study: ONE sample per run (a Windows scheduled task runs it every 5 minutes).
// Public, unauthenticated market-data endpoints only (no keys, no accounts, no orders). About 9 requests per run.
//   node collect.mjs <data dir>          (writes samples-YYYY-MM-DD.jsonl, trades-*.jsonl, state.json, errors.log)
// Each sample records, per order book: best bid/ask (+ size), mid, and the EXECUTABLE average price of a market buy
// and a market sell of C$5, C$25, C$50 and C$100 walking the visible book, plus the top 10 levels. Public trades since
// the previous run are stored to judge whether a resting limit order would have filled.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: node collect.mjs <data dir>"); process.exit(2); }
mkdirSync(DIR, { recursive: true });
const STOP_AT = Date.parse(process.env.COST_STUDY_END ?? "2100-01-01"); // the scheduled task also ends; this is a backstop
const now = Date.now();
if (now > STOP_AT) process.exit(0);
const day = new Date(now).toISOString().slice(0, 10);
const statePath = join(DIR, "state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const errors = [];
const UA = { "User-Agent": "research-client (read-only market data)" };
const get = async (url, init = {}) => { const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const SIZES = [5, 25, 50, 100]; // CAD

/** Average price of a market order spending `notional` (quote currency) across levels; null if the book is too thin. */
function walk(levels, notional) { let left = notional, qty = 0; for (const [p, q] of levels) { const take = Math.min(left, p * q); qty += take / p; left -= take; if (left <= 1e-9) return notional / qty; } return null; }
function summarize(bids, asks, quoteToCad) {
  const bb = bids[0][0], ba = asks[0][0], mid = (bb + ba) / 2;
  const exec = {};
  for (const cad of SIZES) { const n = cad / quoteToCad; exec[cad] = { buy: walk(asks, n), sell: walk(bids, n) }; }
  return { bid: bb, bid_qty: bids[0][1], ask: ba, ask_qty: asks[0][1], mid, spread_bps: ((ba - bb) / mid) * 1e4, exec, top10: { bids: bids.slice(0, 10), asks: asks.slice(0, 10) } };
}
async function kraken(pair) { const r = await get(`https://api.kraken.com/0/public/Depth?pair=${pair}&count=100`); if (r.error?.length) throw new Error(r.error.join(";")); const b = Object.values(r.result)[0]; return { bids: b.bids.map((x) => [+x[0], +x[1]]), asks: b.asks.map((x) => [+x[0], +x[1]]) }; }
async function ndax(id) {
  const rows = await get("https://api.ndax.io:8443/AP/GetL2Snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Depth: 100 }) });
  return { bids: rows.filter((x) => x[9] === 0).map((x) => [x[6], x[8]]).sort((a, b) => b[0] - a[0]), asks: rows.filter((x) => x[9] === 1).map((x) => [x[6], x[8]]).sort((a, b) => a[0] - b[0]) };
}
const sample = { t: now, books: {}, ref: {} };
// USD/CAD first: needed to size the USD books in CAD
let usdcad = null;
try { const b = await kraken("USDCAD"); usdcad = (b.bids[0][0] + b.asks[0][0]) / 2; sample.books["Kraken USD/CAD"] = summarize(b.bids, b.asks, 1); /* quoted in CAD */ } catch (e) { errors.push(`Kraken USD/CAD: ${e.message}`); }
const jobs = {
  "Kraken BTC/CAD": [() => kraken("XBTCAD"), 1], "Kraken ETH/CAD": [() => kraken("ETHCAD"), 1],
  "Kraken BTC/USD": [() => kraken("XBTUSD"), usdcad], "Kraken ETH/USD": [() => kraken("ETHUSD"), usdcad],
  "Ndax BTC/CAD": [() => ndax(1), 1], "Ndax ETH/CAD": [() => ndax(3), 1],
};
await Promise.all(Object.entries(jobs).map(async ([k, [f, fx]]) => {
  if (fx === null) { errors.push(`${k}: no USD/CAD rate`); return; }
  try { const b = await f(); if (!b.bids.length || !b.asks.length) throw new Error("empty book"); sample.books[k] = summarize(b.bids, b.asks, fx); } catch (e) { errors.push(`${k}: ${e.message}`); }
}));
// independent global reference (USD): Coinbase public ticker
try { for (const p of ["BTC-USD", "ETH-USD"]) { const r = await get(`https://api.exchange.coinbase.com/products/${p}/ticker`); sample.ref[p] = { bid: +r.bid, ask: +r.ask }; } } catch (e) { errors.push(`Coinbase ref: ${e.message}`); }
sample.usdcad = usdcad;
appendFileSync(join(DIR, `samples-${day}.jsonl`), JSON.stringify(sample) + "\n");
// public trades since the previous run (to judge limit-order fills)
const trades = [];
try {
  for (const pair of ["XBTCAD", "ETHCAD"]) {
    const since = state[`kraken_${pair}`];
    const r = await get(`https://api.kraken.com/0/public/Trades?pair=${pair}${since ? `&since=${since}` : "&count=200"}`);
    if (r.error?.length) throw new Error(r.error.join(";"));
    const rows = Object.entries(r.result).find(([k]) => k !== "last")[1];
    for (const x of rows) trades.push({ v: "Kraken", pair, t: Math.round(x[2] * 1000), px: +x[0], qty: +x[1], side: x[3] === "b" ? "buy" : "sell" });
    state[`kraken_${pair}`] = r.result.last;
  }
} catch (e) { errors.push(`Kraken trades: ${e.message}`); }
try {
  for (const [pair, id] of [["BTCCAD", 1], ["ETHCAD", 3]]) {
    const rows = await get("https://api.ndax.io:8443/AP/GetLastTrades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Count: 200 }) });
    const lastId = state[`ndax_${pair}`] ?? 0;
    // row: [TradeId, InstrumentId, Quantity, Price, Order1, Order2, TradeTime(ms), Direction, TakerSide(0 buy / 1 sell), BlockTrade, ClientOrderId]
    for (const x of rows) if (x[0] > lastId) trades.push({ v: "Ndax", pair, t: x[6], px: +x[3], qty: +x[2], side: x[8] === 0 ? "buy" : "sell", id: x[0] });
    state[`ndax_${pair}`] = Math.max(lastId, ...rows.map((x) => x[0]));
  }
} catch (e) { errors.push(`Ndax trades: ${e.message}`); }
if (trades.length) appendFileSync(join(DIR, `trades-${day}.jsonl`), trades.map((x) => JSON.stringify(x)).join("\n") + "\n");
writeFileSync(statePath, JSON.stringify({ ...state, last_run: now, runs: (state.runs ?? 0) + 1 }));
if (errors.length) appendFileSync(join(DIR, "errors.log"), `${new Date(now).toISOString()} ${errors.join(" | ")}\n`);
console.log(`${new Date(now).toISOString()} books ${Object.keys(sample.books).length}/7, trades ${trades.length}, errors ${errors.length}`);
