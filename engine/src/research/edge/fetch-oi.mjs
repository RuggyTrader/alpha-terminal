// Download the H-OI data: Binance USDT-M futures daily `metrics` (5-minute open interest) and monthly 5-minute klines.
//   node fetch-oi.mjs <out dir>   -> metrics/<SYM>.csv (concatenated), k5m/<SYM>.csv, MANIFEST.json
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unzip } from "./zip.mjs";

const OUT = process.argv[2]; const UA = { "User-Agent": "research-client (read-only market data)" }, DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) { for (let k = 0; k < 4; k++) { try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) }); if (r.status === 404) return null; if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {} await sleep(2000 * (k + 1)); } throw new Error(`failed ${url}`); }
mkdirSync(join(OUT, "metrics"), { recursive: true }); mkdirSync(join(OUT, "k5m"), { recursive: true });
const mp = join(OUT, "MANIFEST.json"), man = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : { done: {}, missing: [], sha: {} };
for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
  for (let t = Date.parse("2021-12-01"); t < Date.parse("2026-11-24"); t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10), key = `metrics/${s}/${d}`; if (man.done[key] || man.missing.includes(key)) continue;
    const z = await get(`https://data.binance.vision/data/futures/um/daily/metrics/${s}/${s}-metrics-${d}.zip`); await sleep(120);
    if (!z) { man.missing.push(key); continue; }
    const csv = Object.values(unzip(z))[0].toString("utf8").trim().split("\n").filter((l) => !/^create_time/.test(l)).join("\n") + "\n";
    appendFileSync(join(OUT, "metrics", `${s}.csv`), csv); man.done[key] = createHash("sha256").update(z).digest("hex").slice(0, 16);
    if (t % (30 * DAY) < DAY) { writeFileSync(mp, JSON.stringify(man)); console.log(s, d); }
  }
  for (let y = 2021, m = 12; y < 2026 || (y === 2026 && m <= 10); m++) {
    if (m > 12) { m = 1; y++; } const ym = `${y}-${String(m).padStart(2, "0")}`, key = `k5m/${s}/${ym}`; if (man.done[key] || man.missing.includes(key)) continue;
    const z = await get(`https://data.binance.vision/data/futures/um/monthly/klines/${s}/5m/${s}-5m-${ym}.zip`); await sleep(150);
    if (!z) { man.missing.push(key); continue; }
    const csv = Object.values(unzip(z))[0].toString("utf8").trim().split("\n").filter((l) => !/^open_time/.test(l)).join("\n") + "\n";
    appendFileSync(join(OUT, "k5m", `${s}.csv`), csv); man.done[key] = createHash("sha256").update(z).digest("hex").slice(0, 16);
  }
  writeFileSync(mp, JSON.stringify(man));
}
man.completed = new Date().toISOString(); writeFileSync(mp, JSON.stringify(man)); console.log("done", Object.keys(man.done).length, "missing", man.missing.length);
