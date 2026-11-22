// Live bid-ask spread and $50 market-order cost sampler (public, free APIs; no account, no orders).
//   node src/research/costs/spreads.mjs --samples 20 --every 15 --out <json>
// For each venue and pair: mid, quoted spread (bps of mid), and the cost of a $50 (CAD or USD) market BUY and SELL,
// walking the visible book, in bps of mid (= half the spread + any book impact). Fees are NOT included here.
import { writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg("--samples", 20)), EVERY = Number(arg("--every", 15)) * 1000, OUT = arg("--out", "spreads.json");
const NOTIONAL = 50;
const j = async (url, init) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) }); return r.json(); };
const VENUES = {
  "Kraken BTC/CAD": async () => krakenBook("XBTCAD"), "Kraken ETH/CAD": async () => krakenBook("ETHCAD"), "Kraken SOL/CAD": async () => krakenBook("SOLCAD"),
  "Kraken BTC/USD": async () => krakenBook("XBTUSD"), "Kraken ETH/USD": async () => krakenBook("ETHUSD"), "Kraken SOL/USD": async () => krakenBook("SOLUSD"),
  "Ndax BTC/CAD": async () => ndaxBook(1), "Ndax ETH/CAD": async () => ndaxBook(3), "Ndax SOL/CAD": async () => ndaxBook(99),
  "Coinbase BTC/USD": async () => cbBook("BTC-USD"), "Coinbase ETH/USD": async () => cbBook("ETH-USD"), "Coinbase SOL/USD": async () => cbBook("SOL-USD"),
  "Crypto.com BTC/USD": async () => cdcBook("BTC_USD"), "Crypto.com ETH/USD": async () => cdcBook("ETH_USD"), "Crypto.com SOL/USD": async () => cdcBook("SOL_USD"),
};
async function krakenBook(pair) { const r = await j(`https://api.kraken.com/0/public/Depth?pair=${pair}&count=50`); const b = Object.values(r.result)[0]; return { bids: b.bids.map((x) => [+x[0], +x[1]]), asks: b.asks.map((x) => [+x[0], +x[1]]) }; }
async function ndaxBook(id) {
  const rows = await j("https://api.ndax.io:8443/AP/GetL2Snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Depth: 50 }) });
  // row: [MDUpdateId, Accounts, ActionDateTime, ActionType, LastTradePrice, Orders, Price, ProductPairCode, Quantity, Side]
  const bids = rows.filter((x) => x[9] === 0).map((x) => [x[6], x[8]]).sort((a, b) => b[0] - a[0]);
  const asks = rows.filter((x) => x[9] === 1).map((x) => [x[6], x[8]]).sort((a, b) => a[0] - b[0]);
  return { bids, asks };
}
async function cbBook(p) { const r = await j(`https://api.exchange.coinbase.com/products/${p}/book?level=2`, { headers: { "User-Agent": "research-client" } }); return { bids: r.bids.slice(0, 50).map((x) => [+x[0], +x[1]]), asks: r.asks.slice(0, 50).map((x) => [+x[0], +x[1]]) }; }
async function cdcBook(p) { const r = await j(`https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${p}&depth=50`); const d = r.result.data[0]; return { bids: d.bids.map((x) => [+x[0], +x[1]]), asks: d.asks.map((x) => [+x[0], +x[1]]) }; }
/** Average fill price of a market order for `usd` notional walking `levels`; null if the visible book is too thin. */
function walk(levels, usd) { let left = usd, qty = 0; for (const [p, q] of levels) { const take = Math.min(left, p * q); qty += take / p; left -= take; if (left <= 1e-9) return usd / qty; } return null; }
const samples = Object.fromEntries(Object.keys(VENUES).map((k) => [k, []]));
for (let s = 0; s < N; s++) {
  const t0 = Date.now();
  await Promise.all(Object.entries(VENUES).map(async ([k, f]) => {
    try {
      const { bids, asks } = await f(); if (!bids.length || !asks.length) return;
      const bb = bids[0][0], ba = asks[0][0], mid = (bb + ba) / 2, buy = walk(asks, NOTIONAL), sell = walk(bids, NOTIONAL);
      samples[k].push({ t: t0, mid, spread_bps: ((ba - bb) / mid) * 1e4, buy50_bps: buy ? ((buy - mid) / mid) * 1e4 : null, sell50_bps: sell ? ((mid - sell) / mid) * 1e4 : null });
    } catch { /* a failed sample is simply missing */ }
  }));
  if (s < N - 1) await new Promise((r) => setTimeout(r, Math.max(0, EVERY - (Date.now() - t0))));
}
const med = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y); return v.length ? +v[Math.floor(v.length / 2)].toFixed(2) : null; };
const max = (a) => { const v = a.filter((x) => x !== null && Number.isFinite(x)); return v.length ? +Math.max(...v).toFixed(2) : null; };
const summary = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, { samples: v.length, mid: v.length ? +v.at(-1).mid.toFixed(2) : null, spread_bps_median: med(v.map((x) => x.spread_bps)), spread_bps_max: max(v.map((x) => x.spread_bps)), buy50_bps_median: med(v.map((x) => x.buy50_bps)), sell50_bps_median: med(v.map((x) => x.sell50_bps)) }]));
writeFileSync(OUT, JSON.stringify({ taken_at: new Date().toISOString(), samples: N, every_s: EVERY / 1000, notional: NOTIONAL, summary }, null, 1) + "\n");
for (const [k, v] of Object.entries(summary)) console.log(k.padEnd(20), JSON.stringify(v));
