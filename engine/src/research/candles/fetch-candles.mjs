// Assemble validated Binance USDT-M futures 5-minute candles for BTC / ETH / SOL, 2020-01 .. latest day.
// Reuses the 2021-12..2026-10 monthly files already downloaded for the OI study; downloads only the missing months/days.
//   node fetch-candles.mjs <oidata dir> <out dir>   -> <out>/<SYM>-5m.csv (t,o,h,l,c,v), VALIDATION.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unzip } from "../edge/zip.mjs";

const [OI, OUT] = process.argv.slice(2);
const UA = { "User-Agent": "research-client (read-only market data)" }, M5 = 300_000, DAY = 86_400_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) { for (let k = 0; k < 4; k++) { try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) }); if (r.status === 404) return null; if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {} await sleep(2000 * (k + 1)); } throw new Error(`failed ${url}`); }
export function parseRows(text) { const out = []; for (const line of text.split("\n")) { const x = line.split(","); if (x.length < 6 || !x[0].trim()) continue; let t = Number(x[0]); if (!Number.isFinite(t) || t <= 0) continue; if (t > 1e14) t = Math.floor(t / 1000); out.push([t, +x[1], +x[2], +x[3], +x[4], +x[5]]); } return out; }
export function validate(rows) {
  const v = { rows: rows.length, misaligned: 0, duplicates: 0, badOHLC: 0, nonPositive: 0, gaps: [], missingBars: 0 };
  for (let i = 0; i < rows.length; i++) {
    const [t, o, h, l, c] = rows[i];
    if (t % M5) v.misaligned++;
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) v.nonPositive++;
    if (!(l <= Math.min(o, c) + 1e-12 && h >= Math.max(o, c) - 1e-12)) v.badOHLC++;
    if (i) { const d = t - rows[i - 1][0]; if (d === 0) v.duplicates++; else if (d > M5) { const m = d / M5 - 1; v.missingBars += m; if (m >= 3) v.gaps.push({ after: new Date(rows[i - 1][0]).toISOString(), missing: m }); } }
  }
  v.gapsListed = v.gaps.length; v.largestGaps = v.gaps.sort((a, b) => b.missing - a.missing).slice(0, 10); delete v.gaps;
  v.first = rows.length ? new Date(rows[0][0]).toISOString() : null; v.last = rows.length ? new Date(rows.at(-1)[0]).toISOString() : null;
  return v;
}
if (process.argv[1]?.endsWith("fetch-candles.mjs")) {
  mkdirSync(join(OUT, "raw"), { recursive: true });
  const report = {};
  for (const [s, startYM] of [["BTCUSDT", "2020-01"], ["ETHUSDT", "2020-01"], ["SOLUSDT", "2020-09"]]) {
    const map = new Map(), sources = {};
    const add = (rows, src) => { for (const r of rows) { const old = map.get(r[0]); if (old && (old[1] !== r[1] || old[4] !== r[4])) sources.conflicts = (sources.conflicts ?? 0) + 1; map.set(r[0], r); } sources[src] = (sources[src] ?? 0) + rows.length; };
    // 1) months before the reused range
    let [y, m] = startYM.split("-").map(Number);
    while (y < 2021 || (y === 2021 && m <= 11)) {
      const ym = `${y}-${String(m).padStart(2, "0")}`, p = join(OUT, "raw", `${s}-5m-${ym}.zip`);
      let z = existsSync(p) ? readFileSync(p) : await get(`https://data.binance.vision/data/futures/um/monthly/klines/${s}/5m/${s}-5m-${ym}.zip`);
      if (z) { if (!existsSync(p)) { writeFileSync(p, z); await sleep(200); } add(parseRows(Object.values(unzip(z))[0].toString("utf8")), "downloaded-monthly"); }
      else sources.missingMonths = [...(sources.missingMonths ?? []), ym];
      if (++m > 12) { m = 1; y++; }
    }
    // 2) reused 2021-12..2026-10 (OI study)
    add(parseRows(readFileSync(join(OI, "k5m", `${s}.csv`), "utf8")), "reused-oi-study");
    // 3) daily files for 2026-11 (latest available)
    for (let t = Date.parse("2026-11-01"); t < Date.now() - DAY; t += DAY) {
      const d = new Date(t).toISOString().slice(0, 10), p = join(OUT, "raw", `${s}-5m-${d}.zip`);
      const z = existsSync(p) ? readFileSync(p) : await get(`https://data.binance.vision/data/futures/um/daily/klines/${s}/5m/${s}-5m-${d}.zip`);
      if (!z) { sources.missingDays = [...(sources.missingDays ?? []), d]; continue; }
      if (!existsSync(p)) { writeFileSync(p, z); await sleep(200); }
      add(parseRows(Object.values(unzip(z))[0].toString("utf8")), "downloaded-daily");
    }
    // 4) try Binance's daily files for any whole missing day (genuine data only; still-missing bars stay missing)
    let rows = [...map.values()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] > 288 * M5 / 2) {
      for (let t = Math.floor(rows[i - 1][0] / DAY) * DAY; t <= rows[i][0]; t += DAY) {
        const d = new Date(t).toISOString().slice(0, 10), p = join(OUT, "raw", `${s}-5m-${d}.zip`);
        const z = existsSync(p) ? readFileSync(p) : await get(`https://data.binance.vision/data/futures/um/daily/klines/${s}/5m/${s}-5m-${d}.zip`);
        if (!z) continue; if (!existsSync(p)) { writeFileSync(p, z); await sleep(200); }
        const before = map.size; for (const r of parseRows(Object.values(unzip(z))[0].toString("utf8"))) if (!map.has(r[0])) map.set(r[0], r);
        sources.gapFillDaily = (sources.gapFillDaily ?? 0) + (map.size - before);
      }
    }
    rows = [...map.values()].sort((a, b) => a[0] - b[0]);
    const text = rows.map((r) => r.join(",")).join("\n") + "\n";
    writeFileSync(join(OUT, `${s}-5m.csv`), text);
    report[s] = { ...validate(rows), sources, sha256: createHash("sha256").update(text).digest("hex") };
    console.log(s, JSON.stringify(report[s]));
  }
  writeFileSync(join(OUT, "VALIDATION.json"), JSON.stringify({ source: "data.binance.vision USDT-M futures 5m klines (monthly + daily); 2021-12..2026-10 reused from the OI study", generated: new Date().toISOString(), report }, null, 1) + "\n");
}
