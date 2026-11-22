// Fetch free, public, unauthenticated history for the "independent information" signal screen (research only).
//   node fetch.mjs <out dir>
// Sources: Binance USD-M perpetual funding (fapi /fundingRate), Binance spot daily klines (api /klines),
// CoinMetrics community API (exchange flows, supply), alternative.me Fear & Greed. Polite pacing; raw JSON is stored.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => { for (let k = 0; k < 5; k++) { const r = await fetch(u, { headers: { "User-Agent": "research-client (read-only)" } }); if (r.ok) return r.json(); await sleep(3000 * (k + 1)); } throw new Error(`failed ${u}`); };
const save = (f, data, source) => { writeFileSync(join(OUT, f), JSON.stringify({ source, fetched: new Date().toISOString(), data })); console.log(f, Array.isArray(data) ? data.length : Object.keys(data).length); };

// Binance funding (8-hourly), full history
for (const sym of ["BTCUSDT", "ETHUSDT"]) {
  const rows = []; let start = Date.parse("2019-01-01");
  for (;;) {
    const page = await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&limit=1000`);
    if (!page.length) break;
    for (const x of page) rows.push([x.fundingTime, +x.fundingRate]);
    start = page.at(-1).fundingTime + 1; if (page.length < 1000) break; await sleep(500);
  }
  save(`binance-funding-${sym}.json`, rows, "Binance USD-M futures public API /fapi/v1/fundingRate");
}
// Binance spot daily klines (for the Coinbase-vs-Binance price gap)
for (const sym of ["BTCUSDT", "ETHUSDT"]) {
  const rows = []; let start = Date.parse("2017-08-01");
  for (;;) {
    const page = await get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&startTime=${start}&limit=1000`);
    if (!page.length) break;
    for (const x of page) rows.push([x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]);
    start = page.at(-1)[0] + 1; if (page.length < 1000) break; await sleep(500);
  }
  save(`binance-spot-1d-${sym}.json`, rows, "Binance spot public API /api/v3/klines 1d");
}
// CoinMetrics community: exchange flows (btc, eth) and stablecoin supply (usdt, usdc)
for (const [asset, metrics] of [["btc", "FlowInExNtv,FlowOutExNtv,SplyCur"], ["eth", "FlowInExNtv,FlowOutExNtv,SplyCur"], ["usdt", "SplyCur"], ["usdc", "SplyCur"]]) {
  const rows = []; let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}&metrics=${metrics}&frequency=1d&page_size=10000&start_time=2015-01-01&paging_from=start`;
  while (url) { const j = await get(url); rows.push(...j.data); url = j.next_page_url ?? null; await sleep(1000); }
  save(`coinmetrics-${asset}.json`, rows, `CoinMetrics community API asset-metrics ${metrics}`);
}
const fng = await get("https://api.alternative.me/fng/?limit=0&format=json");
save("fear-greed.json", fng.data.map((x) => [x.timestamp * 1000, +x.value]).reverse(), "alternative.me Fear & Greed index API");
