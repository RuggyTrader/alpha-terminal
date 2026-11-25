// H-L event detection and measurement: no lookahead, burn-in, declustering, entry timing, direction normalization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { detectEvents, forward, parseLiq, parseKlines, minutesToHalfRetrace, study, MIN, DAY } from "../src/research/edge/liq-study.mjs";

const D0 = Date.parse("2024-01-01");
// baseline liquidations vary minute to minute (0..199 USD), so the 99.5th percentile sits near the top of the baseline
// (by construction ~0.5 % of ordinary windows exceed a 99.5th-percentile threshold; `scale` < 1 keeps a day's baseline
// below the earlier distribution so only the planted spikes trigger)
const mkDay = (k, spikes = {}, scale = 1) => { const long = new Float64Array(1440), short = new Float64Array(1440); for (let m = 0; m < 1440; m++) long[m] = short[m] = scale * ((m * 37 + k * 11) % 200); for (const [m, v] of Object.entries(spikes)) long[m] = v; return { day: D0 + k * 30 * DAY, liqPerMin: { long, short } }; };

test("parsers: Tardis side mapping (sell = long liquidated), notional, Binance klines with header and microseconds", () => {
  const csv = "exchange,symbol,timestamp,local_timestamp,id,side,price,amount\nbinance-futures,BTCUSDT,1709251203587000,1,,sell,60000,0.5\nbybit,BTCUSDT,1709251204000000,1,,buy,60000,0.1\n";
  const x = parseLiq(gzipSync(csv)); assert.equal(x[0].side, "long"); assert.equal(x[0].usd, 30000); assert.equal(x[1].side, "short"); assert.equal(x[0].t, 1709251203587);
  const k = parseKlines("open_time,open,high,low,close,volume\n1709251200000,1,2,0.5,1.5,10\n1709251260000000,1.5,2,1,1.8,5\n"); assert.equal(k.length, 2); assert.equal(k[1].t, 1709251260000);
});

test("thresholds use earlier days only (no lookahead); burn-in excluded; declustering 60 min", () => {
  // days 0..6 flat; day 7 has spikes at minutes 600 and 620 (same cluster) and 700
  const days = [0, 1, 2, 3, 4, 5, 6].map((k) => mkDay(k)).concat([mkDay(7, { 600: 1e6, 620: 1e6, 700: 1e6 }, 0.5)]);
  const { events } = detectEvents(days, { window: 5, pct: 0.995, burnIn: 6 });
  const ev7 = events.filter((e) => e.side === "long" && e.day === days[7].day);
  assert.deepEqual(ev7.map((e) => (e.tObs - days[7].day) / MIN), [601, 700 + 1]); // 620 suppressed (within 60 min of 601)
  // the threshold on day 7 came from days 0..6 only (baseline 5-minute sums < 1000): it never sees day 7's spike
  assert.ok(ev7[0].thr < 1000);
  // a spike on a burn-in day (day 2) is not an event
  const d2 = [0, 1].map((k) => mkDay(k)).concat([mkDay(2, { 300: 1e6 })], [3, 4, 5, 6].map((k) => mkDay(k)));
  assert.equal(detectEvents(d2, { burnIn: 6 }).events.filter((e) => e.side === "long" && e.day === d2[2].day).length, 0);
});

test("forward returns start at the entry minute's OPEN and end at the close of the last minute; MFE/MAE", () => {
  const bars = new Map(); for (let i = 0; i < 10; i++) bars.set(D0 + i * MIN, { t: D0 + i * MIN, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i });
  const f = forward(bars, D0 + 2 * MIN, 3 * MIN); // entry open 102, exit close of minute 4 = 104.5
  assert.ok(Math.abs(f.r - (104.5 / 102 - 1)) < 1e-12); assert.ok(Math.abs(f.up - (105 / 102 - 1)) < 1e-12); assert.ok(Math.abs(f.down - (101 / 102 - 1)) < 1e-12);
  assert.equal(forward(bars, D0 + 8 * MIN, 5 * MIN), null); // runs past the data -> null, never extrapolated
});

test("half-retrace timing: long liquidation after a drop from 100 to 90 -> first minute with high >= 95", () => {
  const bars = new Map(), t0 = D0 + 100 * MIN;
  bars.set(t0 - MIN, { o: 91, h: 91, l: 90, c: 90 });
  [92, 94, 96].forEach((h, i) => bars.set(t0 + i * MIN, { o: 90, h, l: 89, c: 90 }));
  assert.equal(minutesToHalfRetrace(bars, t0, 1, 90 / 100 - 1), 3);
  assert.equal(minutesToHalfRetrace(bars, t0, 1, 0.05), null); // price rose: not a liquidation-direction move
});

test("study end to end on a synthetic market: a planted +1 % rebound after long-liquidation spikes is detected vs controls", () => {
  const bars = new Map(), days = [];
  for (let k = 0; k < 30; k++) {
    const sm = 200 + ((k * 397) % 1100); // spike minute varies by day, so same-hour controls exist on other days
    const day = D0 + k * 2 * DAY, spikes = k >= 6 ? { [sm]: 5e6 } : {}; days.push(mkDay(0, spikes, k >= 6 ? 0.5 : 1)); days.at(-1).day = day;
    let p = 100; for (let m = 0; m < 2880; m++) { const t = day + m * MIN; let o = p; p *= 1 + (((m * 7919 + k * 104729) % 1000) / 1000 - 0.5) * 0.001; if (k >= 6 && m >= sm + 2 && m < sm + 12) p *= 1.001; bars.set(t, { t, o, h: Math.max(o, p), l: Math.min(o, p), c: p }); }
  }
  const res = study({ X: { days, bars } }, { seed: 3 });
  const r1h = res.rows.find((x) => x.side === "long" && x.horizon === "1h");
  assert.ok(r1h.events >= 20); assert.ok(r1h.mean_raw_bps > 80, String(r1h.mean_raw_bps)); assert.ok(r1h.mean_effect_bps > 80);
  assert.ok(r1h.p_effect < 0.001);
});
