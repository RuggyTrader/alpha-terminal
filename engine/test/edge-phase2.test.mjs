// Phase 2 studies: OI grouping and direction normalization; volatility event detection; planted effects are recovered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oiStudy, volStudy, parseMetrics, cell } from "../src/research/edge/phase2-study.mjs";

const H = 3_600_000, M5 = 300_000, T0 = Date.parse("2022-01-01");

test("metrics parser and matched cell", () => {
  const m = parseMetrics("2022-01-01 00:05:00,BTCUSDT,1000.5,4e7,1,1,1,1\n"); assert.equal(m.get(Date.parse("2022-01-01T00:05:00Z")), 1000.5);
  const c = cell([{ day: 1, r: 0.01, ctrl: [0], half: "H1" }, { day: 2, r: 0.02, ctrl: [0.01], half: "H2" }, { day: 3, r: 0.03, ctrl: [0.01], half: "H2" }]);
  assert.equal(c.mean_effect_bps, 133.3); // (100 + 100 + 200) / 3 bps, reported to 0.1 bps
});

test("volatility study: a planted continuation after 4x range expansions is measured as positive, controls near zero", () => {
  let s = 5; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const bars = []; let p = 100;
  for (let i = 0; i < 24 * 400; i++) {
    const t = T0 + i * H, big = i % 200 === 0 && i > 300, o = p; let c = p * (1 + (rnd() - 0.5) * 0.004);
    if (big) c = p * 1.04; // a +4 % hour with a large range
    p = c; const h = Math.max(o, c) * (1 + (big ? 0.01 : 0.001)), l = Math.min(o, c) * (1 - (big ? 0.01 : 0.001));
    bars.push({ t, o, h, l, c });
    if (i % 200 === 1 && i > 300) { bars.at(-1).c = bars.at(-1).o * 1.01; p = bars.at(-1).c; bars.at(-1).h = Math.max(bars.at(-1).h, p); } // +1 % next hour
  }
  const res = volStudy({ X: bars }, { from: T0, to: T0 + 400 * 24 * H });
  const r1 = res.rows.find((x) => x.horizon === "1h"); assert.ok(r1.events >= 30); assert.ok(r1.mean_raw_bps > 80, String(r1.mean_raw_bps)); assert.ok(r1.mean_effect_bps > 80);
});

test("OI study: groups by move direction x OI change; forward returns direction-normalized", () => {
  let s = 9; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const k5 = new Map(), oi = new Map(); let p = 100, o = 1e6;
  for (let i = 0; i < 12 * 24 * 120; i++) {
    const t = T0 + i * M5, hourStart = t % H === 0, hourIdx = Math.floor(i / 12), spikeHour = hourIdx % 50 === 0 && hourIdx > 800;
    const op = p; p *= 1 + (rnd() - 0.5) * 0.002 + (spikeHour ? 0.004 : 0); // strong up hour
    if (hourIdx % 50 === 1 && hourIdx > 800) p *= 1 - 0.0005;                  // then a reversal
    k5.set(t, { o: op, h: Math.max(op, p), l: Math.min(op, p), c: p });
    if (spikeHour) o *= 1.001; oi.set(t, o); if (hourStart) oi.set(t, o);
  }
  const res = oiStudy({ X: { k5, oi } }, { from: T0, to: T0 + 120 * 24 * H });
  const g = res.log[0].groups; assert.ok(g.up_OIup_newLongs > 10, JSON.stringify(g));
  const row = res.rows.find((x) => x.group === "up_OIup_newLongs" && x.horizon === "1h"); assert.ok(row.mean_raw_bps < 0, "planted reversal measured as negative continuation");
});
