// Data-quality audit of every Kraken OHLCVT file used by research (validation report; research only).
//   node data-audit.mjs <kraken-ohlcvt dir> <out.json>
import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseKrakenCsv, validateBars, HOUR, DAY } from "./data.mjs";

const [DIR, OUT] = process.argv.slice(2);
const rows = [];
for (const f of readdirSync(DIR).filter((x) => /_(60|1440)\.csv$/.test(x)).sort()) {
  const text = readFileSync(join(DIR, f), "utf8"), step = f.endsWith("_60.csv") ? HOUR : DAY;
  const r = validateBars(parseKrakenCsv(text), step);
  const span = (r.last - r.first) / step + 1;
  rows.push({ file: f, ok: r.ok, bars: r.bars, first: new Date(r.first).toISOString().slice(0, 10), last: new Date(r.last).toISOString().slice(0, 10), coverage_pct: Math.round((1e4 * r.bars) / span) / 100,
    invalid: r.invalid.length, duplicates: r.duplicates.length, largest_gap_bars: r.largest_gaps[0]?.missing ?? 0, largest_gap_after: r.largest_gaps[0] ? new Date(r.largest_gaps[0].after).toISOString().slice(0, 16) : null,
    sha256: createHash("sha256").update(text).digest("hex") });
}
writeFileSync(OUT, JSON.stringify({ source: "Kraken official OHLCVT archive (extracted by range requests)", rows }, null, 1) + "\n");
for (const x of rows) console.log(`${x.file.padEnd(18)} ${x.ok ? "OK " : "BAD"} ${x.first}..${x.last} bars ${String(x.bars).padStart(6)} coverage ${String(x.coverage_pct).padStart(6)}% invalid ${x.invalid} dup ${x.duplicates} largest gap ${x.largest_gap_bars} after ${x.largest_gap_after}`);
