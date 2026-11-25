// Download the H-L data (docs/research/edge/PREREGISTRATION.md): Tardis free first-of-month liquidation CSVs (binance-futures,
// bybit) and Binance USDT-M futures 1-minute klines for each liquidation day and the following day. Public data only.
//   node fetch-liq.mjs <out dir>       -> liq/<ex>/<SYM>/<YYYY-MM-DD>.csv.gz, k1m/<SYM>/<YYYY-MM-DD>.csv, MANIFEST.json
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unzip } from "./zip.mjs";

const OUT = process.argv[2]; const UA = { "User-Agent": "research-client (read-only market data)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), DAY = 86_400_000;
const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"], EXS = ["binance-futures", "bybit"];
const days = []; for (let y = 2020, m = 9; y < 2026 || (y === 2026 && m <= 11); m++) { if (m > 12) { m = 1; y++; } days.push(`${y}-${String(m).padStart(2, "0")}-01`); }
async function get(url) { for (let k = 0; k < 4; k++) { try { const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60_000) }); if (r.status === 404 || r.status === 400) return null; /* 400 = dataset not available for that symbol/date (Tardis) */ if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {} await sleep(2000 * (k + 1)); } throw new Error(`failed ${url}`); }
const manifest = existsSync(join(OUT, "MANIFEST.json")) ? JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) : { files: {}, missing: [] };
const save = (rel, buf) => { const p = join(OUT, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, buf); manifest.files[rel] = { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") }; };
for (const d of days) {
  const [y, m] = d.split("-"), next = new Date(Date.parse(d) + DAY).toISOString().slice(0, 10);
  for (const s of SYMS) {
    for (const ex of EXS) {
      const rel = `liq/${ex}/${s}/${d}.csv.gz`; if (manifest.files[rel] || manifest.missing.includes(rel)) continue;
      const b = await get(`https://datasets.tardis.dev/v1/${ex}/liquidations/${y}/${m}/01/${s}.csv.gz`); await sleep(400);
      if (b) save(rel, b); else manifest.missing.push(rel);
    }
    for (const dd of [d, next]) {
      const rel = `k1m/${s}/${dd}.csv`; if (manifest.files[rel] || manifest.missing.includes(rel)) continue;
      const z = await get(`https://data.binance.vision/data/futures/um/daily/klines/${s}/1m/${s}-1m-${dd}.zip`); await sleep(250);
      if (!z) { manifest.missing.push(rel); continue; }
      const files = unzip(z); save(rel, Object.values(files)[0]);
    }
  }
  writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
  console.log(d, Object.keys(manifest.files).length, "files", manifest.missing.length, "missing");
}
manifest.completed = new Date().toISOString(); manifest.source = { liquidations: "Tardis.dev free first-of-month CSV datasets (binance-futures forceOrder, bybit liquidation)", klines: "data.binance.vision USDT-M futures daily 1m klines" };
writeFileSync(join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 1));
