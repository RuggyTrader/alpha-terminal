// Ndax public price history (research only): GetTickerHistory daily bars for BTC/CAD (1), ETH/CAD (3), SOL/CAD (99).
// Row: [EndTime, High, Low, Open, Close, Volume, InsideBidPx, InsideAskPx, InstrumentId, BeginTime].
// The InsideBid/Ask fields are checked for plausibility; they are NOT used as observed spreads if they fail.
//   node ndax-history.mjs <out dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [id, sym] of [[1, "BTCCAD"], [3, "ETHCAD"], [99, "SOLCAD"]]) {
  const r = await fetch("https://api.ndax.io:8443/AP/GetTickerHistory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Interval: 86400, FromDate: "2017-01-01T00:00:00", ToDate: "2026-11-22T00:00:00" }) });
  const rows = await r.json();
  writeFileSync(join(OUT, `${sym}-daily.json`), JSON.stringify({ source: "Ndax public API GetTickerHistory (AlphaPoint), Interval 86400", fetched: new Date().toISOString(), rows }));
  const by = {};
  for (const x of rows) { const y = new Date(x[9]).getUTCFullYear(); by[y] ??= { days: 0, noTrade: 0, cad: 0 }; by[y].days++; if (!(x[5] > 0)) by[y].noTrade++; by[y].cad += x[5] * x[4]; }
  console.log(sym, rows.length, new Date(rows[0][9]).toISOString().slice(0, 10), "..", new Date(rows.at(-1)[9]).toISOString().slice(0, 10));
  for (const [y, v] of Object.entries(by)) console.log(`  ${y}: ${v.days} days, ${v.noTrade} without trades, C$${(v.cad / 1e6).toFixed(1)}M traded`);
  await sleep(1000);
}
