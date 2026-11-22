// Tests for the research lab (data validation, cost model, hourly limit-order backtester). Hand-computed expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKrakenCsv, validateBars, makeDailyVol, HOUR, DAY } from "../src/research/lab/data.mjs";
import { krakenFee, venue } from "../src/research/lab/costs.mjs";
import { backtestWick, tradeStats } from "../src/research/lab/wick.mjs";

const T0 = Date.parse("2024-01-10T00:00:00Z");
const V = { fee: () => ({ maker: 0.004, taker: 0.008 }), minUsd: 1, exitSlip: () => 0.001 };
const SIG = 0.01, z = 2;
const asset = (bars) => ({ name: "BTC", H: bars, vol: () => SIG });
const bar = (i, o, h, l, c) => ({ t: T0 + i * HOUR, o, h, l, c, v: 1, n: 1 });
const P = { z, m: 0.5, holdH: 48, r: 0.25, cap: 1 };
const run = (bars, p = P, v = V, to = T0 + bars.length * HOUR) => backtestWick([asset(bars)], p, v, { from: T0, to, audit: [] });
const L0 = 100 * Math.exp(-z * SIG);
const qty0 = Math.floor((0.0025 * 100) / (L0 - L0 * Math.exp(-z * SIG)) / 1e-8 + 1e-9) * 1e-8;
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("data: Kraken CSV parsing and validation", () => {
  const bars = parseKrakenCsv("3600,1,2,0.5,1.5,10,3\n7200,1.5,1.6,1.4,1.5,1,1\n14400,1.5,1.5,1.5,1.5,1,1\n14400,1,1,1,1,1,1\n");
  const r = validateBars(bars, HOUR);
  assert.equal(r.ok, false); assert.deepEqual(r.duplicates, [14400_000]);
  assert.equal(r.missing_bars, 1); assert.equal(r.gap_count, 1);
  const bad = validateBars([{ t: 0, o: 1, h: 0.9, l: 0.8, c: 1 }], HOUR); // high below open
  assert.deepEqual(bad.invalid, [0]);
  assert.throws(() => parseKrakenCsv("1,2,3\n"), /expected 7 fields/);
});

test("data: daily volatility uses only complete days before the current day", () => {
  const daily = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * DAY, c: 100 * Math.exp(0.01 * (i % 2 ? 1 : -1) * i) }));
  const vol = makeDailyVol(daily, 30);
  const t = T0 + 35 * DAY + 5 * HOUR; // day 35: uses days 5..34
  const r = []; for (let j = 5; j <= 34; j++) r.push(Math.log(daily[j].c / daily[j - 1].c));
  const mu = r.reduce((a, b) => a + b, 0) / 30, sd = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / 29);
  close(vol(t), sd, 1e-12);
  const changed = daily.map((b, i) => (i === 35 ? { ...b, c: 1 } : b)); // today's close must not matter
  close(makeDailyVol(changed, 30)(t), sd, 1e-12);
  assert.equal(vol(T0 + 10 * DAY), null);
});

test("costs: Kraken fee history and current schedule", () => {
  assert.deepEqual(krakenFee(Date.parse("2020-01-01"), "historical"), { maker: 0.0016, taker: 0.0026 });
  assert.deepEqual(krakenFee(Date.parse("2025-01-01"), "historical"), { maker: 0.0025, taker: 0.004 });
  assert.deepEqual(krakenFee(Date.parse("2026-06-01"), "historical"), { maker: 0.004, taker: 0.008 });
  assert.deepEqual(krakenFee(Date.parse("2018-01-01")), { maker: 0.004, taker: 0.008 });
  assert.equal(venue("ndax").fee(0).maker, 0.002);
});

test("wick: limit fill, then take-profit (maker both ways), exact cash", () => {
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98.5), bar(2, 98.6, 99.2, 98.4, 99)];
  const r = run(bars);
  assert.equal(r.n_trades, 1); const tr = r.trades[0];
  assert.equal(tr.reason, "TARGET"); close(tr.entry, L0); close(tr.qty, qty0, 1e-12);
  const tp = L0 * Math.exp(0.5 * z * SIG); close(tr.exit, tp);
  close(r.final, 100 - qty0 * L0 * 1.004 + qty0 * tp * 0.996, 1e-9);
});

test("wick: no fill when the low only touches the limit (trade-through required)", () => {
  const r = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, L0, 99)]);
  assert.equal(r.fills, 0); assert.equal(r.final, 100);
});

test("wick: fill and stop in the same hour is treated as stopped (conservative)", () => {
  const r = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 95, 99.5)]);
  const tr = r.trades[0], stop = L0 * Math.exp(-z * SIG);
  assert.equal(tr.reason, "STOP_SAME_HOUR"); close(tr.exit, stop * 0.999);
  close(r.final, 100 - qty0 * L0 * 1.004 + qty0 * stop * 0.999 * 0.992, 1e-9);
});

test("wick: stop is checked before the target in a later hour; gap below the stop fills at the open", () => {
  const stop = L0 * Math.exp(-z * SIG);
  const r = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98), bar(2, 95, 200, 94, 99)]);
  assert.equal(r.trades[0].reason, "STOP"); close(r.trades[0].exit, 95 * 0.999); assert.ok(95 < stop);
});

test("wick: time stop exits at the open after holdH hours (taker)", () => {
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98), bar(2, 98, 98.5, 97.5, 98), bar(3, 98.2, 98.5, 97.5, 98)];
  const r = run(bars, { ...P, holdH: 2 });
  assert.equal(r.trades[0].reason, "TIME"); close(r.trades[0].exit, 98.2 * 0.999); assert.equal(r.trades[0].exitT, T0 + 3 * HOUR);
});

test("wick: orders below the venue minimum are skipped", () => {
  const r = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98.5)], P, { ...V, minUsd: 50 });
  assert.equal(r.fills, 0); assert.equal(r.skipped_min, 1);
});

test("wick: strict drawdown marks open positions at the hour's low", () => {
  const r = run([bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98), bar(2, 98, 98, 96.5, 97.9)]);
  const cashAfter = 100 - qty0 * L0 * 1.004;
  const eqLow2 = cashAfter + qty0 * 96.5, peak = 100; // peak is the starting equity (later closes are lower)
  close(r.dd_pct, (1 - eqLow2 / peak) * 100, 1e-9);
});

test("wick: no look-ahead: results up to T do not depend on bars after T", () => {
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98.5), bar(2, 98.6, 99.2, 98.4, 99), bar(3, 99, 99, 99, 99)];
  const a = run(bars.slice(0, 3), P, V, T0 + 3 * HOUR), b = run([...bars, bar(4, 50, 50, 1, 2)], P, V, T0 + 3 * HOUR);
  assert.deepEqual(a.trades, b.trades); assert.equal(a.final, b.final); assert.equal(a.dd_pct, b.dd_pct);
});

test("wick: cash never negative and shared cash limits simultaneous fills", () => {
  const mk = (name) => ({ name, H: [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.9, 98)], vol: () => SIG });
  const r = backtestWick([mk("BTC"), mk("ETH"), mk("SOL")], { ...P, r: 50, cap: 1 }, V, { from: T0, to: T0 + 2 * HOUR });
  assert.ok(r.fills >= 1 && r.fills < 3); assert.ok(r.final > 0);
  const s = tradeStats([{ R: 1, net: 1, fees: 0.1, reason: "TARGET" }, { R: -1, net: -1, fees: 0.1, reason: "STOP" }]);
  assert.equal(s.n, 2); assert.equal(s.mean_R, 0); assert.equal(s.exits.TARGET, 1);
});
