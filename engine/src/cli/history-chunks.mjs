// Resumable download of real Kraken candles in fixed chunks, then a verified merge.
//   node src/cli/history-chunks.mjs --symbol SOLUSD --from 2026-06-12T00:00:00Z --to 2026-11-09T00:00:00Z \
//        --chunk-days 10 --dir data/chunks/SOLUSD-5m --out data/SOLUSD-5m-150d.json [--reference data/SOLUSD-5m-25d.json]
// Each chunk is built from Kraken's public trade list (same method as history.mjs) and saved as soon as it is
// complete, so an interrupted run resumes where it stopped. The merge checks: chunk coverage, ordering, duplicates,
// OHLC sanity, 5-minute periods without trades (reported, NOT filled: no price is invented), an exact comparison with
// Kraken's own OHLC candles where they overlap, and optionally with a previously verified file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candlesFromTrades, fetchCompletedCandles } from "../kraken.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const symbol = arg("symbol", "SOLUSD");
const intervalMin = Number(arg("interval", "5"));
const step = intervalMin * 60_000;
const fromMs = Date.parse(arg("from"));
const toMs = Date.parse(arg("to"));
const chunkMs = Number(arg("chunk-days", "10")) * 86_400_000;
const dir = arg("dir", join("data", "chunks", `${symbol}-${intervalMin}m`));
const out = arg("out", null);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || fromMs % step || toMs % step) {
  console.error("--from and --to must be valid, ordered and on candle boundaries"); process.exit(2);
}
mkdirSync(dir, { recursive: true });
const iso = (ms) => new Date(ms).toISOString();
const chunkFile = (a) => join(dir, `${symbol}-${intervalMin}m-${iso(a).replace(/[:.]/g, "")}.json`);

const chunks = [];
for (let a = fromMs; a < toMs; a += chunkMs) chunks.push([a, Math.min(a + chunkMs, toMs)]);
// --reverse: newest chunk first (lets a second process fill the period from the other end; chunks are skipped once saved).
for (const [a, b] of process.argv.includes("--reverse") ? [...chunks].reverse() : chunks) {
  const f = chunkFile(a);
  if (existsSync(f)) { console.log(`have ${iso(a)} .. ${iso(b)}`); continue; }
  const started = Date.now();
  const candles = await candlesFromTrades({ symbol, intervalMin, fromMs: a, toMs: b,
    onProgress: (ms, n) => process.stderr.write(`\r${iso(a)} chunk: ${iso(ms)} ${n} candles   `) });
  process.stderr.write("\n");
  writeFileSync(`${f}.tmp`, JSON.stringify({ symbol, intervalMin, from: iso(a), to: iso(b), fetchedAt: new Date().toISOString(), candles }));
  renameSync(`${f}.tmp`, f); // a chunk exists only when complete
  console.log(`saved ${iso(a)} .. ${iso(b)}: ${candles.length} candles in ${Math.round((Date.now() - started) / 1000)} s`);
}

if (out) {
  const all = [];
  for (const [a, b] of chunks) {
    const c = JSON.parse(readFileSync(chunkFile(a), "utf8"));
    if (c.from !== iso(a) || c.to !== iso(b)) throw new Error(`chunk ${iso(a)} has the wrong range`);
    all.push(...c.candles);
  }
  let unordered = 0, dup = 0, bad = 0, outside = 0;
  for (let i = 0; i < all.length; i++) {
    const k = all[i];
    if (k.t < fromMs || k.t >= toMs) outside += 1;
    if (!(k.l <= Math.min(k.o, k.c) && k.h >= Math.max(k.o, k.c) && k.l > 0)) bad += 1;
    if (i && k.t === all[i - 1].t) dup += 1;
    if (i && k.t < all[i - 1].t) unordered += 1;
  }
  const expected = (toMs - fromMs) / step;
  const present = new Set(all.map((k) => k.t));
  const missing = [];
  for (let t = fromMs; t < toMs; t += step) if (!present.has(t)) missing.push(t);
  let longestGap = 0, run = 0;
  for (let t = fromMs; t < toMs; t += step) { run = present.has(t) ? 0 : run + 1; longestGap = Math.max(longestGap, run); }

  // Kraken's own candles where they overlap (its OHLC endpoint keeps the last ~720).
  const ohlc = await fetchCompletedCandles({ symbol, intervalMin });
  const byT = new Map(all.map((k) => [k.t, k]));
  let compared = 0, mismatched = 0;
  const examples = [];
  for (const k of ohlc) {
    const m = byT.get(k.t);
    if (!m || k.t >= toMs) continue;
    compared += 1;
    if (m.o !== k.o || m.h !== k.h || m.l !== k.l || m.c !== k.c) { mismatched += 1; if (examples.length < 3) examples.push({ t: iso(k.t), trades: m, ohlc: k }); }
  }
  // A previously verified file (same source and method), where it overlaps.
  let reference = null;
  const refPath = arg("reference", null);
  if (refPath) {
    const ref = JSON.parse(readFileSync(refPath, "utf8"));
    let rc = 0, rm = 0;
    for (const k of ref.candles) {
      const m = byT.get(k.t);
      if (!m) continue;
      rc += 1;
      if (m.o !== k.o || m.h !== k.h || m.l !== k.l || m.c !== k.c) rm += 1;
    }
    reference = { file: refPath, compared: rc, mismatched: rm };
  }
  const doc = {
    source: `Kraken public Trades API (${symbol}), aggregated to ${intervalMin}m candles; completed candles only`,
    symbol, intervalMin, from: iso(fromMs), to: iso(toMs), fetchedAt: new Date().toISOString(),
    check: {
      expectedCandles: expected, candles: all.length, missingPeriodsWithoutTrades: missing.length, longestGapCandles: longestGap,
      missingExamples: missing.slice(0, 5).map(iso), unordered, duplicates: dup, invalidOHLC: bad, outsideRange: outside,
      againstKrakenOHLC: { compared, mismatched, examples }, againstReference: reference,
    },
    candles: all,
  };
  writeFileSync(out, JSON.stringify(doc));
  console.log(JSON.stringify({ out, ...doc.check }, null, 1));
}
