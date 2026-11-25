// Phase 2 event studies (docs/research/edge/PREREGISTRATION.md, d750dda): H-OI open-interest divergence and H-VOL extreme
// volatility expansions. Same inference as H-L: matched controls, day-clustered bootstrap, t-test on day means, Holm.
//   node phase2-study.mjs oi  <oidata dir> <out.json>
//   node phase2-study.mjs vol <jupiter/binance dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rng, mean, median, tTest, holm, clusterBootstrap, decileFn } from "./stats.mjs";

const M5 = 300_000, H = 3_600_000, DAY = 86_400_000;
const bps = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e5) / 10);

/** Generic matched comparison cell: evs [{ day, r, ctrl: [r...], half }] -> statistics. */
export function cell(evs) {
  const withC = evs.filter((e) => e.ctrl.length), eff = {}, raw = {};
  for (const e of withC) (eff[e.day] ??= []).push(e.r - mean(e.ctrl));
  for (const e of evs) (raw[e.day] ??= []).push(e.r);
  const tt = tTest(Object.values(eff).map((a) => mean(a)));
  const halves = Object.fromEntries(["H1", "H2"].map((hh) => { const m = withC.filter((e) => e.half === hh); return [hh, m.length ? bps(mean(m.map((e) => e.r - mean(e.ctrl)))) : null]; }));
  return { events: evs.length, matched: withC.length, days: Object.keys(raw).length, mean_raw_bps: evs.length ? bps(mean(evs.map((e) => e.r))) : null, median_raw_bps: evs.length ? bps(median(evs.map((e) => e.r))) : null,
    p_positive: evs.length ? Math.round((evs.filter((e) => e.r > 0).length / evs.length) * 1000) / 1000 : null,
    mean_ctrl_bps: withC.length ? bps(mean(withC.map((e) => mean(e.ctrl)))) : null, mean_effect_bps: withC.length ? bps(mean(withC.map((e) => e.r - mean(e.ctrl)))) : null,
    ci95_effect_bps: (() => { const c = clusterBootstrap(eff); return c ? c.map(bps) : null; })(), ci95_raw_bps: (() => { const c = clusterBootstrap(raw); return c ? c.map(bps) : null; })(),
    p_effect: tt.p, t_effect: tt.t, halves_effect_bps: halves };
}
const hourDist = (a, b) => { const d = (a - b + 24) % 24; return Math.min(d, 24 - d); };
const pickControls = (pool, k, r) => { const out = []; for (let i = 0; i < k && pool.length; i++) out.push(pool[Math.floor(r() * pool.length)]); return out; };

// ---------------- H-OI ----------------
export function parseMetrics(text) {
  const m = new Map();
  for (const line of text.split("\n")) { const x = line.split(","); if (x.length < 4) continue; const t = Date.parse(x[0].replace(" ", "T") + "Z"); const oi = Number(x[2]); if (Number.isFinite(t) && oi > 0) m.set(t, oi); }
  return m;
}
export function parseK(text) { const m = new Map(); for (const line of text.split("\n")) { const x = line.split(","); let t = Number(x[0]); if (!Number.isFinite(t)) continue; if (t > 1e14) t = Math.floor(t / 1000); m.set(t, { o: +x[1], h: +x[2], l: +x[3], c: +x[4] }); } return m; }

export function oiStudy(series, { seed = 13, halfSplit = Date.parse("2024-05-01"), from = Date.parse("2022-01-01"), to = Date.parse("2026-10-01"), oiCut = 0.005 } = {}) {
  const r = rng(seed), rows = [], log = [];
  const HZ = { "1h": H, "4h": 4 * H, "24h": DAY };
  for (const [sym, { k5, oi }] of Object.entries(series)) {
    const hourRet = new Map(); // hour boundary T -> 1h return ending at T
    const ts = [...k5.keys()].sort((a, b) => a - b), t0 = Math.ceil(ts[0] / H) * H, t1 = ts.at(-1);
    for (let T = t0 + H; T <= t1; T += H) { const a = k5.get(T - H), z = k5.get(T - M5); if (a && z) hourRet.set(T, z.c / a.o - 1); }
    const fwd = (entry, h) => { const a = k5.get(entry), z = k5.get(entry + h - M5); return a && z ? z.c / a.o - 1 : null; };
    const strong = [];
    const hrs = [...hourRet.keys()].sort((a, b) => a - b), rets = hrs.map((T) => hourRet.get(T));
    for (let i = 720; i < hrs.length; i++) {
      const T = hrs[i]; if (T < from || T >= to) continue;
      const w = rets.slice(i - 720, i), m = mean(w), s = Math.sqrt(w.reduce((q, x) => q + (x - m) ** 2, 0) / (w.length - 1)), ret = rets[i];
      if (!(Math.abs(ret) > 2 * s)) continue;
      const o1 = oi.get(T), o0 = oi.get(T - H); if (!o1 || !o0) continue;
      const dOI = o1 / o0 - 1, dir = Math.sign(ret), grp = dOI > oiCut ? (dir > 0 ? "up_OIup_newLongs" : "down_OIup_newShorts") : dOI < -oiCut ? (dir > 0 ? "up_OIdown_shortCovering" : "down_OIdown_longClosing") : (dir > 0 ? "up_neutral" : "down_neutral");
      const entry = T + M5, f = {}; for (const [h, ms] of Object.entries(HZ)) { const x = fwd(entry, ms); if (x !== null) f[h] = dir * x; }
      strong.push({ sym, T, day: Math.floor(T / DAY) * DAY, dir, grp, sigma: s, hour: new Date(T).getUTCHours(), dOI, f, half: T < halfSplit ? "H1" : "H2" });
    }
    const volDec = decileFn(strong.map((e) => e.sigma));
    for (const [h] of Object.entries(HZ)) for (const grp of ["up_OIup_newLongs", "up_OIdown_shortCovering", "down_OIup_newShorts", "down_OIdown_longClosing"]) {
      const neutral = strong.filter((e) => e.grp === (grp.startsWith("up") ? "up_neutral" : "down_neutral") && e.f[h] !== undefined);
      const evs = strong.filter((e) => e.grp === grp && e.f[h] !== undefined).map((e) => ({ day: e.day, r: e.f[h], half: e.half,
        ctrl: pickControls(neutral.filter((c) => volDec(c.sigma) === volDec(e.sigma) && hourDist(c.hour, e.hour) <= 1), 5, r).map((c) => c.f[h]) }));
      rows.push({ sym, group: grp, horizon: h, ...cell(evs) });
    }
    log.push({ sym, strongMoves: strong.length, groups: Object.fromEntries(["up_OIup_newLongs", "up_OIdown_shortCovering", "down_OIup_newShorts", "down_OIdown_longClosing", "up_neutral", "down_neutral"].map((g) => [g, strong.filter((e) => e.grp === g).length])) });
  }
  const ps = holm(rows.map((x) => x.p_effect)); rows.forEach((x, i) => (x.p_holm = ps[i]));
  return { rows, log };
}

// ---------------- H-VOL ----------------
export function volStudy(series, { seed = 17, halfSplit = Date.parse("2022-05-01"), from = Date.parse("2018-01-01"), to = Date.parse("2026-10-01") } = {}) {
  const r = rng(seed), rows = [], log = [];
  const HZ = { "1h": 1, "4h": 4, "24h": 24 };
  for (const [sym, bars] of Object.entries(series)) {
    const idx = new Map(bars.map((b, i) => [b.t, i])), range = bars.map((b) => (b.h - b.l) / b.o);
    const fwd = (i, n) => { const a = bars[i + 1], z = bars[i + n]; if (!a || !z || z.t - a.t !== (n - 1) * H) return null; return z.c / a.o - 1; };
    const evs = [], ctrls = []; let lastEv = -Infinity;
    for (let i = 168; i < bars.length - 25; i++) {
      const b = bars[i]; if (b.t < from || b.t >= to) continue;
      if (b.t - bars[i - 168].t !== 168 * H) continue; // a contiguous trailing week only
      const med = median(range.slice(i - 168, i)), ret = b.c / b.o - 1, dir = Math.sign(ret);
      const f = {}; for (const [h, n] of Object.entries(HZ)) { const x = fwd(i, n); if (x !== null) f[h] = x; }
      const rec = { t: b.t, day: Math.floor(b.t / DAY) * DAY, hour: new Date(b.t).getUTCHours(), ret, dir, f, half: b.t < halfSplit ? "H1" : "H2" };
      if (range[i] >= 4 * med && dir !== 0 && b.t - lastEv >= DAY) { evs.push(rec); lastEv = b.t; }
      else if (range[i] <= 1.5 * med && dir !== 0) ctrls.push(rec);
    }
    const retDec = decileFn(ctrls.map((c) => c.ret));
    const byKey = new Map(); for (const c of ctrls) { const k = `${retDec(c.ret)}|${c.hour}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(c); }
    for (const [h] of Object.entries(HZ)) {
      const list = evs.filter((e) => e.f[h] !== undefined).map((e) => {
        const pool = [e.hour - 1, e.hour, e.hour + 1].flatMap((hh) => byKey.get(`${retDec(e.ret)}|${(hh + 24) % 24}`) ?? []).filter((c) => c.f[h] !== undefined && Math.sign(c.ret) === e.dir);
        return { day: e.day, r: e.dir * e.f[h], half: e.half, ctrl: pickControls(pool, 5, r).map((c) => e.dir * c.f[h]) };
      });
      rows.push({ sym, horizon: h, ...cell(list) });
    }
    log.push({ sym, events: evs.length, up: evs.filter((e) => e.dir > 0).length, down: evs.filter((e) => e.dir < 0).length, controls: ctrls.length });
  }
  const ps = holm(rows.map((x) => x.p_effect)); rows.forEach((x, i) => (x.p_holm = ps[i]));
  return { rows, log };
}

if (process.argv[1]?.endsWith("phase2-study.mjs")) {
  const [kind, DIR, OUT] = process.argv.slice(2);
  let res;
  if (kind === "oi") {
    const series = Object.fromEntries(["BTC", "ETH", "SOL"].map((a) => [a, { k5: parseK(readFileSync(join(DIR, "k5m", `${a}USDT.csv`), "utf8")), oi: parseMetrics(readFileSync(join(DIR, "metrics", `${a}USDT.csv`), "utf8")) }]));
    res = oiStudy(series);
    res.coverage = Object.fromEntries(Object.entries(series).map(([a, s]) => [a, { k5mBars: s.k5.size, oiRows: s.oi.size, first: new Date([...s.oi.keys()].reduce((a, b) => Math.min(a, b))).toISOString(), last: new Date([...s.oi.keys()].reduce((a, b) => Math.max(a, b))).toISOString() }]));
  } else {
    const series = Object.fromEntries(["BTC", "ETH", "SOL"].map((a) => [a, JSON.parse(readFileSync(join(DIR, `${a}USDT-1h.json`), "utf8")).rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }))]));
    res = volStudy(series);
  }
  writeFileSync(OUT, JSON.stringify({ prereg: "docs/research/edge/PREREGISTRATION.md (d750dda)", kind, ...res }, null, 1) + "\n");
  console.log(JSON.stringify(res.log ?? res.coverage));
  for (const x of res.rows) console.log(`${x.sym} ${(x.group ?? "").padEnd(24)} ${x.horizon.padEnd(4)} n ${String(x.events).padStart(5)} m ${String(x.matched).padStart(5)} raw ${String(x.mean_raw_bps).padStart(7)} eff ${String(x.mean_effect_bps).padStart(7)} CI ${JSON.stringify(x.ci95_effect_bps)} p ${x.p_effect?.toFixed(4)} holm ${x.p_holm?.toFixed(3)} halves ${JSON.stringify(x.halves_effect_bps)}`);
}
