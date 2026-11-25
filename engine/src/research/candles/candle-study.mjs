// Historical candle pattern screening (docs/research/candles/PREREGISTRATION.md, 28cfce0). One fixed grid; no parameter search.
//   node candle-study.mjs <candles dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rng, mean, median, tTest, holm, clusterBootstrap, decileFn } from "../edge/stats.mjs";

export const M5 = 300_000, DAY = 86_400_000;
export const TFS = { "5m": 1, "15m": 3, "1h": 12, "4h": 48 }, HZ = [1, 3, 12], EVENTS = ["E1_MR_DOWN", "E2_MR_UP", "E3_FB_HIGH", "E4_FB_LOW", "E5_VOL_HIGH", "E6_VOL_LOW", "E7_HAMMER", "E8_SHOOTING_STAR", "E9_EXHAUST_UP", "E10_EXHAUST_DOWN"];
export const DIR = { E1_MR_DOWN: 1, E2_MR_UP: -1, E3_FB_HIGH: -1, E4_FB_LOW: 1, E5_VOL_HIGH: 1, E6_VOL_LOW: 1, E7_HAMMER: 1, E8_SHOOTING_STAR: -1, E9_EXHAUST_UP: -1, E10_EXHAUST_DOWN: 1 };
export const PERIODS = [["P1", Date.parse("2020-01-01"), Date.parse("2022-01-01")], ["P2", Date.parse("2022-01-01"), Date.parse("2024-01-01")], ["P3", Date.parse("2024-01-01"), Infinity]];

export function loadCsv(text) { const rows = text.trim().split("\n").map((l) => l.split(",").map(Number)); const n = rows.length, b = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n) }; rows.forEach((r, i) => { b.t[i] = r[0]; b.o[i] = r[1]; b.h[i] = r[2]; b.l[i] = r[3]; b.c[i] = r[4]; }); return b; }
/** Aggregate 5-minute bars into bars of k x 5 minutes, UTC-aligned, complete groups only. */
export function aggregate(b, k) {
  if (k === 1) return b;
  const step = k * M5, out = { t: [], o: [], h: [], l: [], c: [] }; let i = 0;
  while (i < b.t.length) {
    const s = Math.floor(b.t[i] / step) * step; let j = i, hi = -Infinity, lo = Infinity;
    while (j < b.t.length && b.t[j] < s + step) { hi = Math.max(hi, b.h[j]); lo = Math.min(lo, b.l[j]); j++; }
    if (j - i === k && b.t[i] === s) { out.t.push(s); out.o.push(b.o[i]); out.h.push(hi); out.l.push(lo); out.c.push(b.c[j - 1]); }
    i = j;
  }
  return Object.fromEntries(Object.entries(out).map(([key, v]) => [key, Float64Array.from(v)]));
}
/** Daily regime known at the start of each day: from daily closes up to day d-1. Returns Map dayStart -> "bull"|"bear"|"side". */
export function regimes(b5) {
  const d = aggregate(b5, 288), out = new Map();
  for (let i = 60; i < d.t.length; i++) {
    const sma = (end) => { let s = 0; for (let k = end - 49; k <= end; k++) s += d.c[k]; return s / 50; };
    const prev = i - 1, s0 = sma(prev), s10 = sma(prev - 10), c = d.c[prev];
    out.set(d.t[i], c > s0 && s0 > s10 ? "bull" : c < s0 && s0 < s10 ? "bear" : "side");
  }
  return out;
}
/** Features and events for one timeframe. Every feature at bar i uses bars <= i only. */
export function detect(b) {
  const n = b.t.length, r = new Float64Array(n).fill(NaN), s20 = new Float64Array(n).fill(NaN), s100 = new Float64Array(n).fill(NaN), s200 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) r[i] = Math.log(b.c[i] / b.c[i - 1]);
  const roll = (w, out) => { let s = 0, q = 0; for (let i = 1; i < n; i++) { if (i - 1 >= 1) { s += r[i - 1]; q += r[i - 1] ** 2; } if (i - 1 - w >= 1) { s -= r[i - 1 - w]; q -= r[i - 1 - w] ** 2; } if (i - 1 >= w) { const m = s / w; out[i] = Math.sqrt(Math.max(0, (q - w * m * m) / (w - 1))); } } };
  roll(20, s20); roll(100, s100); roll(200, s200);
  const ev = Object.fromEntries(EVENTS.map((e) => [e, []])), last = Object.fromEntries(EVENTS.map((e) => [e, -Infinity]));
  let up = 0, dn = 0;
  const push = (e, i) => { if (i - last[e] >= 12) { ev[e].push(i); last[e] = i; } };
  for (let i = 201; i < n; i++) {
    up = b.c[i] > b.c[i - 1] ? up + 1 : 0; dn = b.c[i] < b.c[i - 1] ? dn + 1 : 0;
    const rg = (k) => b.h[k] - b.l[k];
    if (r[i] <= -3 * s100[i]) push("E1_MR_DOWN", i);
    if (r[i] >= 3 * s100[i]) push("E2_MR_UP", i);
    let H = -Infinity, L = Infinity; for (let k = i - 20; k < i; k++) { H = Math.max(H, b.h[k]); L = Math.min(L, b.l[k]); }
    if (b.h[i] > H && b.c[i] < H) push("E3_FB_HIGH", i);
    if (b.l[i] < L && b.c[i] > L) push("E4_FB_LOW", i);
    const ratio = s20[i] / s200[i], pratio = s20[i - 1] / s200[i - 1];
    if (ratio >= 2 && !(pratio >= 2)) push("E5_VOL_HIGH", i);
    if (ratio <= 0.5 && !(pratio <= 0.5)) push("E6_VOL_LOW", i);
    const ranges = []; for (let k = i - 20; k < i; k++) ranges.push(rg(k)); ranges.sort((a, z) => a - z);
    const R = rg(i), medR = (ranges[9] + ranges[10]) / 2, body = Math.abs(b.c[i] - b.o[i]);
    if (R >= 1.5 * medR && R > 0 && body <= 0.3 * R) {
      if (Math.min(b.o[i], b.c[i]) - b.l[i] >= 0.6 * R) push("E7_HAMMER", i);
      if (b.h[i] - Math.max(b.o[i], b.c[i]) >= 0.6 * R) push("E8_SHOOTING_STAR", i);
    }
    if (up === 8 && rg(i - 2) > rg(i - 1) && rg(i - 1) > rg(i)) push("E9_EXHAUST_UP", i);
    if (dn === 8 && rg(i - 2) > rg(i - 1) && rg(i - 1) > rg(i)) push("E10_EXHAUST_DOWN", i);
  }
  return { r, s100, events: ev };
}
/** Forward return from the open of bar i+1 to the close of bar i+h, with adverse / favourable excursion (raw, long sign). */
export function forward(b, i, h) { if (i + h >= b.t.length) return null; const e = b.o[i + 1]; let hi = -Infinity, lo = Infinity; for (let k = i + 1; k <= i + h; k++) { hi = Math.max(hi, b.h[k]); lo = Math.min(lo, b.l[k]); } return { r: b.c[i + h] / e - 1, up: hi / e - 1, down: lo / e - 1 }; }

function cellStats(recs, h) {
  const g = {}, gr = {}; for (const x of recs) { (g[x.cl] ??= []).push(x.eff); (gr[x.cl] ??= []).push(x.raw); }
  const tt = tTest(Object.values(g).map((a) => mean(a))), bp = (v) => (Number.isFinite(v) ? Math.round(v * 1e5) / 10 : null), ci = clusterBootstrap(g);
  const per = Object.fromEntries(PERIODS.map(([p]) => { const z = recs.filter((x) => x.period === p); return [p, z.length ? bp(mean(z.map((x) => x.raw))) : null]; }));
  const mae = recs.map((x) => x.mae).sort((a, b) => a - b);
  return { n: recs.length, clusters: Object.keys(g).length, mean_raw_bps: recs.length ? bp(mean(recs.map((x) => x.raw))) : null, median_raw_bps: recs.length ? bp(median(recs.map((x) => x.raw))) : null,
    p_positive: recs.length ? Math.round((recs.filter((x) => x.raw > 0).length / recs.length) * 1000) / 1000 : null, mean_effect_bps: recs.length ? bp(mean(recs.map((x) => x.eff))) : null,
    ci95_effect_bps: ci ? ci.map(bp) : null, p: tt.p, periods_raw_bps: per, mae_mean_bps: recs.length ? bp(mean(mae)) : null, mae_p90_bps: recs.length ? bp(mae[Math.floor(0.1 * (mae.length - 1))]) : null };
}

/** Full screening for one asset: returns rows for every (event, TF, horizon) and per regime. */
export function studyAsset(sym, b5, { seed = 31 } = {}) {
  const reg = regimes(b5), rnd = rng(seed), rows = [];
  for (const [tf, k] of Object.entries(TFS)) {
    const b = aggregate(b5, k), { s100, events } = detect(b), n = b.t.length;
    const regAt = (i) => reg.get(Math.floor(b.t[i] / DAY) * DAY) ?? null;
    const slot = (i) => (tf === "4h" ? Math.floor(new Date(b.t[i]).getUTCHours() / 4) : new Date(b.t[i]).getUTCHours());
    const cl = (i) => (tf === "4h" ? Math.floor((b.t[i] / DAY + 3) / 7) : Math.floor(b.t[i] / DAY));
    const volDec = decileFn(Array.from(s100).filter(Number.isFinite));
    const pools = new Map(); for (let i = 201; i < n - 13; i++) { const rg = regAt(i); if (!rg || !Number.isFinite(s100[i])) continue; const key = `${rg}|${volDec(s100[i])}|${slot(i)}`; (pools.get(key) ?? pools.set(key, []).get(key)).push(i); }
    for (const e of EVENTS) {
      const near = new Uint8Array(n); for (const i of events[e]) for (let d = -12; d <= 12; d++) if (i + d >= 0 && i + d < n) near[i + d] = 1;
      const D = DIR[e], recsByH = Object.fromEntries(HZ.map((h) => [h, []]));
      for (const i of events[e]) {
        const rg = regAt(i); if (!rg || !Number.isFinite(s100[i])) continue;
        const pool = pools.get(`${rg}|${volDec(s100[i])}|${slot(i)}`) ?? [], ctrl = [];
        for (let tries = 0; tries < 60 && ctrl.length < 5 && pool.length; tries++) { const j = pool[Math.floor(rnd() * pool.length)]; if (!near[j]) ctrl.push(j); }
        if (!ctrl.length) continue;
        const period = PERIODS.find(([, a, z]) => b.t[i] >= a && b.t[i] < z)[0];
        for (const h of HZ) {
          const f = forward(b, i, h); if (!f) continue;
          const cr = ctrl.map((j) => forward(b, j, h)).filter(Boolean).map((x) => D * x.r); if (!cr.length) continue;
          recsByH[h].push({ raw: D * f.r, eff: D * f.r - mean(cr), mae: D > 0 ? f.down : -f.up, cl: cl(i), period, regime: rg });
        }
      }
      for (const h of HZ) {
        rows.push({ family: "primary", sym, tf, event: e, h, dir: D, ...cellStats(recsByH[h], h) });
        for (const rg of ["bull", "bear", "side"]) rows.push({ family: "regime", regime: rg, sym, tf, event: e, h, dir: D, ...cellStats(recsByH[h].filter((x) => x.regime === rg), h) });
      }
    }
  }
  return rows;
}

/** Holm within each family, then the pre-registered screening (sign tests use mean_raw; E5/E6 are two-sided). */
export function screen(rows, { costBps = 30 } = {}) {
  for (const fam of ["primary", "regime"]) { const z = rows.filter((x) => x.family === fam), ps = holm(z.map((x) => (x.n >= 10 ? x.p : null))); z.forEach((x, i) => (x.p_holm = ps[i])); }
  const key = (x) => `${x.family}|${x.regime ?? ""}|${x.tf}|${x.event}|${x.h}`, groups = new Map(); for (const x of rows) (groups.get(key(x)) ?? groups.set(key(x), []).get(key(x))).push(x);
  for (const x of rows) {
    const twoSided = x.event === "E5_VOL_HIGH" || x.event === "E6_VOL_LOW", sgn = twoSided ? Math.sign(x.mean_raw_bps ?? 0) : 1, val = (x.mean_raw_bps ?? -Infinity) * sgn;
    const periodsOk = Object.values(x.periods_raw_bps).every((v) => v !== null && Math.sign(v) === Math.sign(sgn) && v !== 0);
    const breadth = groups.get(key(x)).filter((y) => y.mean_raw_bps !== null && Math.sign(y.mean_raw_bps) === Math.sign(sgn) && y.mean_raw_bps !== 0).length >= 2;
    x.screen = { holm: x.p_holm !== null && x.p_holm < 0.05, cost: val > costBps, periods: periodsOk, breadth, tradeDir: twoSided ? (sgn > 0 ? "long" : "short") : x.dir > 0 ? "long" : "short" };
    x.passes = x.screen.holm && x.screen.cost && x.screen.periods && x.screen.breadth;
  }
  return rows;
}

if (process.argv[1]?.endsWith("candle-study.mjs")) {
  const [DIR_, OUT] = process.argv.slice(2), rows = [];
  for (const s of ["BTC", "ETH", "SOL"]) { const t0 = Date.now(); rows.push(...studyAsset(s, loadCsv(readFileSync(join(DIR_, `${s}USDT-5m.csv`), "utf8")))); console.log(s, "done", ((Date.now() - t0) / 1000).toFixed(0), "s"); }
  screen(rows);
  const prim = rows.filter((x) => x.family === "primary"), reg = rows.filter((x) => x.family === "regime");
  const summary = { tests_primary: prim.filter((x) => x.p !== null).length, tests_regime: reg.filter((x) => x.p !== null).length, holm_sig_primary: prim.filter((x) => x.screen.holm).length, holm_sig_regime: reg.filter((x) => x.screen.holm).length,
    above_cost_primary: prim.filter((x) => x.screen.cost).length, passing: rows.filter((x) => x.passes).map((x) => `${x.family}${x.regime ? "/" + x.regime : ""} ${x.sym} ${x.tf} ${x.event} h${x.h}`) };
  writeFileSync(OUT, JSON.stringify({ prereg: "docs/research/candles/PREREGISTRATION.md (28cfce0)", summary, rows }, null, 1) + "\n");
  console.log(JSON.stringify(summary, null, 1));
}
