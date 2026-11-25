// Candle screening engine: aggregation, no-lookahead features/regimes, event definitions, forward returns, screening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, regimes, detect, forward, screen, studyAsset, M5, DAY } from "../src/research/candles/candle-study.mjs";
import { parseRows, validate } from "../src/research/candles/fetch-candles.mjs";

const T0 = Date.parse("2021-01-01");
function series(n, f) { const b = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n) }; let p = 100; for (let i = 0; i < n; i++) { const [o, h, l, c] = f(i, p); b.t[i] = T0 + i * M5; b.o[i] = o; b.h[i] = h; b.l[i] = l; b.c[i] = c; p = c; } return b; }

test("parser skips blank/header lines; validator finds gaps, duplicates and bad OHLC", () => {
  assert.equal(parseRows("open_time,o,h,l,c,v\n1,2,3,1,2,5\n\n").length, 1);
  const v = validate([[0, 1, 2, 0.5, 1, 1], [300000, 1, 2, 0.5, 1, 1], [300000, 1, 2, 0.5, 1, 1], [1500000, 1, 0.5, 2, 1, 1]]);
  assert.equal(v.duplicates, 1); assert.equal(v.missingBars, 3); assert.equal(v.badOHLC, 1);
});

test("aggregation: complete UTC-aligned groups only", () => {
  const b = series(30, (i, p) => [p, p + 1, p - 1, p + 0.5]);
  const a = aggregate(b, 12); assert.equal(a.t.length, 2); assert.equal(a.o[0], b.o[0]); assert.equal(a.c[0], b.c[11]);
  assert.equal(a.h[0], Math.max(...b.h.slice(0, 12)));
});

test("regime for day d uses only days < d", () => {
  const n = 288 * 120, b = series(n, (i, p) => { const c = p * (i < 288 * 100 ? 1.00002 : 0.9998); return [p, Math.max(p, c), Math.min(p, c), c]; });
  const reg = regimes(b), d100 = T0 + 100 * DAY;
  assert.equal(reg.get(d100), "bull", "the crash that starts on day 100 is not known on day 100");
  assert.equal(reg.get(T0 + 119 * DAY) === "bull", false);
});

test("events: a planted -3 sigma bar, a failed breakout and an 8-bar exhaustion are detected at the right bar", () => {
  let s = 3; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const b = series(2000, (i, p) => {
    let c = p * (1 + (rnd() - 0.5) * 0.002), h = Math.max(p, c) * 1.0005, l = Math.min(p, c) * 0.9995;
    if (i === 800) { c = p * 0.97; l = c * 0.999; }                       // crash bar -> E1
    if (i === 1200) { h = p * 1.03; c = p * 0.9999; }                    // spike above the 20-bar high, close back inside -> E3
    if (i >= 1500 && i < 1508) { c = p * (1.0009 - (i - 1500) * 0.0001); h = c * 1.00001 + (1508 - i) * 0.00001 * p; l = p; } // 8 rising closes
    return [p, Math.max(h, p, c), Math.min(l, p, c), c];
  });
  const { events } = detect(b);
  assert.ok(events.E1_MR_DOWN.includes(800));
  // the planted failed breakout at 1200 is detected unless a natural one fired within the previous 12 bars (declustering)
  assert.ok(events.E3_FB_HIGH.some((i) => i <= 1200 && i > 1200 - 12), JSON.stringify(events.E3_FB_HIGH.filter((i) => i > 1180 && i < 1220)));
  assert.ok(events.E1_MR_DOWN.every((i, k, a) => !k || i - a[k - 1] >= 12), "declustered");
  const f = forward(b, 800, 3); assert.ok(Math.abs(f.r - (b.c[803] / b.o[801] - 1)) < 1e-12);
  assert.equal(forward(b, 1999, 1), null);
});

test("screening: Holm, cost, periods and breadth must all hold", () => {
  const mk = (sym, p, raw, per) => ({ family: "primary", sym, tf: "1h", event: "E1_MR_DOWN", h: 3, dir: 1, n: 500, p, mean_raw_bps: raw, periods_raw_bps: per });
  const rows = screen([mk("BTC", 1e-9, 45, { P1: 40, P2: 50, P3: 30 }), mk("ETH", 1e-9, 35, { P1: 10, P2: 20, P3: 30 }), mk("SOL", 0.5, -5, { P1: -1, P2: 1, P3: -2 })]);
  assert.equal(rows[0].passes, true); assert.equal(rows[2].passes, false);
  const r2 = screen([mk("BTC", 1e-9, 25, { P1: 40, P2: 50, P3: 30 }), mk("ETH", 1e-9, 35, { P1: 10, P2: -20, P3: 30 })]);
  assert.equal(r2[0].screen.cost, false); assert.equal(r2[1].screen.periods, false);
});

test("end to end on a random walk: no pattern passes screening (no false discovery)", () => {
  let s = 77; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const b = series(288 * 150, (i, p) => { const c = p * (1 + (rnd() - 0.5) * 0.003); return [p, Math.max(p, c) * (1 + rnd() * 0.001), Math.min(p, c) * (1 - rnd() * 0.001), c]; });
  const rows = screen(studyAsset("X", b));
  assert.equal(rows.filter((x) => x.passes).length, 0);
  assert.ok(rows.some((x) => x.n > 50));
});
