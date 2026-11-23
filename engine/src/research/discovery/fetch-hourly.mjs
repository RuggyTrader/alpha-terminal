// Ndax public hourly history (GetTickerHistory, Interval 3600), monthly chunks, polite pacing. Research only.
//   node fetch-hourly.mjs <ndax dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const OUT = process.argv[2];
const IDS = { BTCCAD: 1, ETHCAD: 3, XRPCAD: 4, LTCCAD: 5, DOGECAD: 77, SOLCAD: 99, USDCCAD: 90 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [sym, id] of Object.entries(IDS)) {
  const rows = new Map();
  for (let y = 2025, m = 10; y < 2026 || m <= 11; m === 12 ? ((m = 1), y++) : m++) {
    const a = `${y}-${String(m).padStart(2, "0")}-01T00:00:00`, nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y, b = `${ny}-${String(nm).padStart(2, "0")}-01T00:00:00`;
    const r = await (await fetch("https://api.ndax.io:8443/AP/GetTickerHistory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Interval: 3600, FromDate: a, ToDate: b }) })).json();
    for (const x of r) rows.set(x[9], x);
    await sleep(700);
  }
  const all = [...rows.values()].sort((p, q) => p[9] - q[9]);
  writeFileSync(join(OUT, `${sym}-hourly.json`), JSON.stringify({ source: "Ndax public API GetTickerHistory, Interval 3600", fetched: new Date().toISOString(), rows: all }));
  console.log(sym, all.length, all.length ? new Date(all[0][9]).toISOString() + " .. " + new Date(all.at(-1)[9]).toISOString() : "");
}
