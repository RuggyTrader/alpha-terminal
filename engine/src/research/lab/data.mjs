// Research lab: market data loading and validation (research only).
// Kraken's official OHLCVT archive CSV rows: unix_seconds,open,high,low,close,volume,trades. Hours/days without trades
// are ABSENT from the archive (not zero rows), so gaps are expected for thin markets and are reported, never filled.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Parse a Kraken OHLCVT CSV into bars { t (ms), o, h, l, c, v, n }. Throws on malformed rows. */
export function parseKrakenCsv(text) {
  const out = [];
  const lines = text.trim().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const x = lines[i].split(",");
    if (x.length < 7) throw new Error(`row ${i + 1}: expected 7 fields, got ${x.length}`);
    const v = x.map(Number);
    if (v.some((y) => !Number.isFinite(y))) throw new Error(`row ${i + 1}: non-numeric field`);
    out.push({ t: v[0] * 1000, o: v[1], h: v[2], l: v[3], c: v[4], v: v[5], n: v[6] });
  }
  return out;
}

/** Validate bars of a fixed step. Returns a report; `ok` is false only for genuinely invalid data (not for gaps). */
export function validateBars(bars, step) {
  const invalid = [], duplicates = [], unordered = [], offGrid = [];
  let missing = 0; const gaps = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!(b.l > 0 && b.l <= Math.min(b.o, b.c) + 1e-12 && b.h >= Math.max(b.o, b.c) - 1e-12 && b.h >= b.l)) invalid.push(b.t);
    if (b.t % step !== 0) offGrid.push(b.t);
    if (i) {
      const d = b.t - bars[i - 1].t;
      if (d === 0) duplicates.push(b.t); else if (d < 0) unordered.push(b.t);
      else if (d > step) { const m = d / step - 1; missing += m; gaps.push({ after: bars[i - 1].t, missing: m }); }
    }
  }
  gaps.sort((a, b) => b.missing - a.missing);
  return {
    ok: !invalid.length && !duplicates.length && !unordered.length && !offGrid.length,
    bars: bars.length, first: bars[0]?.t ?? null, last: bars.at(-1)?.t ?? null,
    invalid, duplicates, unordered, offGrid, missing_bars: missing, gap_count: gaps.length, largest_gaps: gaps.slice(0, 5),
  };
}

/** Load and validate a Kraken CSV file; returns { bars, report, sha256 }. Refuses invalid data. */
export function loadKraken(path, step) {
  const text = readFileSync(path, "utf8");
  const bars = parseKrakenCsv(text);
  const report = validateBars(bars, step);
  if (!report.ok) throw new Error(`${path}: invalid data ${JSON.stringify({ invalid: report.invalid.length, duplicates: report.duplicates.length, unordered: report.unordered.length, offGrid: report.offGrid.length })}`);
  return { bars, report, sha256: createHash("sha256").update(text).digest("hex") };
}

/** Daily volatility (std of log returns) of the `n` COMPLETE days strictly before the day containing t. */
export function makeDailyVol(daily, n = 30) {
  const idx = new Map(daily.map((b, i) => [b.t, i]));
  return (t) => {
    const day = Math.floor(t / DAY) * DAY;
    let i = idx.get(day - DAY);
    if (i === undefined) { // the previous day had no trades: use the latest earlier day
      let lo = 0, hi = daily.length - 1, k = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (daily[m].t < day) { k = m; lo = m + 1; } else hi = m - 1; }
      i = k;
    }
    if (i === undefined || i < n) return null;
    const r = [];
    for (let j = i - n + 1; j <= i; j++) r.push(Math.log(daily[j].c / daily[j - 1].c));
    const mu = r.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1));
  };
}
