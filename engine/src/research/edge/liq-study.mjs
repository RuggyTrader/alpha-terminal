// H-L liquidation-cascade event study (docs/research/edge/PREREGISTRATION.md, d750dda). Pure functions + a runner.
//   node liq-study.mjs <liqdata dir> <out.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { rng, mean, median, tTest, holm, clusterBootstrap, decileFn, quantileSorted } from "./stats.mjs";

export const MIN = 60_000, DAY = 86_400_000;
export const HORIZONS = { "5m": 5 * MIN, "15m": 15 * MIN, "1h": 60 * MIN, "4h": 240 * MIN, "24h": 1440 * MIN };
export const COSTS_BPS = { optimistic: 15, baseline: 30, conservative: 60 };

/** Parse a Tardis liquidation CSV (gz) -> [{ t ms, side: "long" | "short" (which side was liquidated), usd }] */
export function parseLiq(buf) {
  const lines = gunzipSync(buf).toString("utf8").trim().split("\n"), out = [];
  for (let i = 1; i < lines.length; i++) {
    const x = lines[i].split(","); const t = Math.floor(Number(x[2]) / 1000), price = Number(x[6]), amt = Number(x[7]);
    if (!Number.isFinite(t) || !(price > 0) || !(amt > 0)) continue;
    out.push({ t, side: x[5] === "sell" ? "long" : "short", usd: price * amt }); // a forced SELL closes a liquidated LONG
  }
  return out;
}
/** Parse a Binance futures 1m kline CSV -> [{ t, o, h, l, c, v }] (header rows skipped; microsecond times normalized). */
export function parseKlines(text) {
  const out = [];
  for (const line of text.trim().split("\n")) { const x = line.split(","); let t = Number(x[0]); if (!Number.isFinite(t)) continue; if (t > 1e14) t = Math.floor(t / 1000); out.push({ t, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }); }
  return out;
}

/**
 * Detect events for one symbol. days: [{ day (ms), liqPerMin: { long: Float64Array(1440), short: ... } }] sorted by day.
 * opts: { window (minutes) = 5, pct = 0.995, burnIn = 6, declusterMin = 60 }.
 * The threshold for day k uses ONLY windows from days < k (expanding, real-time observable). Returns events and the pools.
 */
export function detectEvents(days, { window = 5, pct = 0.995, burnIn = 6, declusterMin = 60 } = {}) {
  const pools = { long: [], short: [] }, events = [], lqSeries = {};
  days.forEach((d, k) => {
    const lq = { long: new Float64Array(1440), short: new Float64Array(1440) };
    for (const side of ["long", "short"]) { const a = d.liqPerMin[side]; let s = 0; for (let m = 0; m < 1440; m++) { s += a[m]; if (m >= window) s -= a[m - window]; lq[side][m] = m >= window - 1 ? s : NaN; } }
    // lq[side][m] = sum of minutes (m-window, m] -> observable at the END of minute m, i.e. at time day + (m + 1) min
    lqSeries[d.day] = lq;
    if (k >= burnIn) for (const side of ["long", "short"]) {
      const z = pools[side].slice().sort((a, b) => a - b), thr = quantileSorted(z, pct); let lastT = -Infinity;
      for (let m = window - 1; m < 1440; m++) {
        const v = lq[side][m], tObs = d.day + (m + 1) * MIN;
        if (v > 0 && v >= thr && tObs - lastT >= declusterMin * MIN) { events.push({ day: d.day, side, tObs, lq: v, thr }); lastT = tObs; }
      }
    }
    for (const side of ["long", "short"]) for (let m = window - 1; m < 1440; m++) pools[side].push(lq[side][m]); // added AFTER the day is used
  });
  return { events, lqSeries };
}

/** Price path helpers over a Map t -> bar (1-minute bars). */
export function forward(bars, entryT, hMs) {
  const e = bars.get(entryT), x = bars.get(entryT + hMs - MIN); if (!e || !x) return null;
  let hi = -Infinity, lo = Infinity; for (let t = entryT; t < entryT + hMs; t += MIN) { const b = bars.get(t); if (!b) return null; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); }
  return { r: x.c / e.o - 1, up: hi / e.o - 1, down: lo / e.o - 1 };
}
export function preFeatures(bars, tObs) {
  const a = bars.get(tObs - 15 * MIN), z = bars.get(tObs - MIN); if (!a || !z) return null;
  const rets = []; for (let t = tObs - 60 * MIN; t < tObs; t += MIN) { const b = bars.get(t), p = bars.get(t - MIN); if (!b || !p) return null; rets.push(Math.log(b.c / p.c)); }
  const m = mean(rets), vol = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
  return { r15: z.c / a.o - 1, vol60: vol, hour: new Date(tObs).getUTCHours() };
}
/** Minutes until half of the preceding 15-minute move is retraced (direction-normalized), within 24 h; null if never. */
export function minutesToHalfRetrace(bars, tObs, D, r15) {
  const z = bars.get(tObs - MIN); if (!z || !Number.isFinite(r15) || !(-D * r15 > 0)) return null; // only when price moved in the liquidation direction
  const start = z.c / (1 + r15), target = z.c + 0.5 * (start - z.c); // half way back toward the start of the 15-minute move
  for (let t = tObs; t < tObs + DAY; t += MIN) { const b = bars.get(t); if (!b) return null; if (D > 0 ? b.h >= target : b.l <= target) return (t - tObs) / MIN + 1; }
  return null;
}

/** Full study for one configuration. data: { SYM: { days, bars } }. Returns per-(asset, side, horizon) statistics. */
export function study(data, opts = {}) {
  const { window = 5, pct = 0.995, delayMin = 1, seed = 11, halfSplit = Date.parse("2023-07-01") } = opts, r = rng(seed), rows = [], eventLog = [];
  for (const [sym, { days, bars }] of Object.entries(data)) {
    const { events, lqSeries } = detectEvents(days, { window, pct });
    const covered = days.map((d) => d.day), allEvT = events.map((e) => e.tObs);
    // candidate control minutes: the symbol's liquidation days (the burn-in applies to events only), total LQ <= median,
    // no event within +-2 h
    const tot = []; for (const d of covered) { const q = lqSeries[d]; for (let m = window - 1; m < 1440; m++) tot.push(q.long[m] + q.short[m]); }
    const medTot = median(tot.filter(Number.isFinite));
    const cands = [];
    for (const d of covered) { const q = lqSeries[d]; for (let m = window - 1; m < 1440; m += 3) { const tObs = d + (m + 1) * MIN; if (!(q.long[m] + q.short[m] <= medTot)) continue; if (allEvT.some((x) => Math.abs(x - tObs) < 2 * 3_600_000)) continue; const f = preFeatures(bars, tObs); if (f) cands.push({ tObs, day: d, ...f }); } }
    const volDec = decileFn(cands.map((c) => c.vol60));
    for (const side of ["long", "short"]) {
      const D = side === "long" ? 1 : -1; // rebound direction
      const moveDec = decileFn(cands.map((c) => -D * c.r15)); // move in the liquidation direction, positive
      const byKey = new Map(); for (const c of cands) { const k = `${moveDec(-D * c.r15)}|${volDec(c.vol60)}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push(c); }
      for (const ev of events.filter((e) => e.side === side)) {
        const f = preFeatures(bars, ev.tObs); if (!f) continue;
        const entryT = ev.tObs + delayMin * MIN, pool = (byKey.get(`${moveDec(-D * f.r15)}|${volDec(f.vol60)}`) ?? []).filter((c) => { const d = (c.hour - f.hour + 24) % 24; return Math.min(d, 24 - d) <= 1; }); // same UTC hour +-1
        const ctrl = []; for (let k = 0; k < 5 && pool.length; k++) ctrl.push(pool[Math.floor(r() * pool.length)]);
        const rec = { sym, side, day: ev.day, tObs: ev.tObs, lqUsd: ev.lq, thrUsd: ev.thr, r15: f.r15, half: ev.tObs < halfSplit ? "H1" : "H2", nCtrl: ctrl.length, fwd: {}, ctrlFwd: {} };
        for (const [h, ms] of Object.entries(HORIZONS)) {
          const fw = forward(bars, entryT, ms); if (!fw) continue;
          rec.fwd[h] = { r: D * fw.r, mfe: D > 0 ? fw.up : -fw.down, mae: D > 0 ? fw.down : -fw.up };
          const cr = ctrl.map((c) => forward(bars, c.tObs + delayMin * MIN, ms)).filter(Boolean).map((x) => D * x.r);
          if (cr.length) rec.ctrlFwd[h] = mean(cr);
        }
        rec.halfRetraceMin = minutesToHalfRetrace(bars, ev.tObs, D, f.r15);
        eventLog.push(rec);
      }
    }
  }
  for (const sym of Object.keys(data)) for (const side of ["long", "short"]) for (const h of Object.keys(HORIZONS)) rows.push(cell(eventLog.filter((e) => e.sym === sym && e.side === side), sym, side, h));
  const ps = holm(rows.map((x) => x.p_effect));
  rows.forEach((x, i) => (x.p_holm = ps[i]));
  const pooled = []; for (const side of ["long", "short"]) for (const h of Object.keys(HORIZONS)) pooled.push(cell(eventLog.filter((e) => e.side === side), "ALL", side, h));
  return { rows, pooled, events: eventLog };
}
function cell(evs, sym, side, h) {
  const withF = evs.filter((e) => e.fwd[h]), matched = withF.filter((e) => e.ctrlFwd[h] !== undefined);
  const byDay = (arr, f) => { const g = {}; for (const e of arr) (g[e.day] ??= []).push(f(e)); return g; };
  const eff = byDay(matched, (e) => e.fwd[h].r - e.ctrlFwd[h]), raw = byDay(withF, (e) => e.fwd[h].r);
  const dayMeans = Object.values(eff).map((a) => mean(a)), tt = tTest(dayMeans);
  const bps = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4 * 10) / 10);
  const clusters = new Set(); let lastT = -Infinity, nCl = 0; for (const e of [...withF].sort((a, b) => a.tObs - b.tObs)) { if (e.tObs - lastT > 4 * 3_600_000) nCl++; lastT = e.tObs; clusters.add(e.day); }
  const halves = Object.fromEntries(["H1", "H2"].map((hh) => { const m = matched.filter((e) => e.half === hh); return [hh, m.length ? bps(mean(m.map((e) => e.fwd[h].r - e.ctrlFwd[h]))) : null]; }));
  return { sym, side, horizon: h, events: withF.length, matched: matched.length, days: clusters.size, clusters4h: nCl,
    mean_raw_bps: withF.length ? bps(mean(withF.map((e) => e.fwd[h].r))) : null, median_raw_bps: withF.length ? bps(median(withF.map((e) => e.fwd[h].r))) : null,
    p_rebound: withF.length ? Math.round((withF.filter((e) => e.fwd[h].r > 0).length / withF.length) * 1000) / 1000 : null,
    mean_ctrl_bps: matched.length ? bps(mean(matched.map((e) => e.ctrlFwd[h]))) : null,
    mean_effect_bps: matched.length ? bps(mean(matched.map((e) => e.fwd[h].r - e.ctrlFwd[h]))) : null,
    ci95_effect_bps: (() => { const ci = clusterBootstrap(eff); return ci ? ci.map(bps) : null; })(),
    ci95_raw_bps: (() => { const ci = clusterBootstrap(raw); return ci ? ci.map(bps) : null; })(),
    mean_mfe_bps: withF.length ? bps(mean(withF.map((e) => e.fwd[h].mfe))) : null, mean_mae_bps: withF.length ? bps(mean(withF.map((e) => e.fwd[h].mae))) : null,
    p_effect: tt.p, t_effect: tt.t, halves_effect_bps: halves };
}

/** Load the downloaded data for the study. */
export function loadData(dir, { sources = ["binance-futures", "bybit"] } = {}) {
  const man = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")), data = {};
  for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    const bars = new Map(), days = [];
    for (const rel of Object.keys(man.files).filter((f) => f.startsWith(`k1m/${sym}/`))) for (const b of parseKlines(readFileSync(join(dir, rel), "utf8"))) bars.set(b.t, b);
    const dayList = [...new Set(Object.keys(man.files).filter((f) => f.startsWith("liq/") && f.includes(`/${sym}/`)).map((f) => f.slice(-17, -7)))].sort();
    for (const ds of dayList) {
      const day = Date.parse(ds), lp = { long: new Float64Array(1440), short: new Float64Array(1440) }; let any = false;
      for (const ex of sources) { const rel = `liq/${ex}/${sym}/${ds}.csv.gz`; if (!man.files[rel]) continue; any = true; for (const x of parseLiq(readFileSync(join(dir, rel)))) { const m = Math.floor((x.t - day) / MIN); if (m >= 0 && m < 1440) lp[x.side][m] += x.usd; } }
      if (any && bars.has(day)) days.push({ day, liqPerMin: lp });
    }
    data[sym.replace("USDT", "")] = { days, bars };
  }
  return data;
}

if (process.argv[1]?.endsWith("liq-study.mjs")) {
  const [DIR, OUT] = process.argv.slice(2);
  const all = loadData(DIR), primary = study(all);
  const coverage = Object.fromEntries(Object.entries(all).map(([s, d]) => [s, { liquidationDays: d.days.length, first: d.days[0] && new Date(d.days[0].day).toISOString().slice(0, 10), last: d.days.at(-1) && new Date(d.days.at(-1).day).toISOString().slice(0, 10), minuteBars: d.bars.size, totalLiqUsd: Math.round(d.days.reduce((s, x) => s + x.liqPerMin.long.reduce((a, b) => a + b, 0) + x.liqPerMin.short.reduce((a, b) => a + b, 0), 0)) }]));
  // sensitivity (reported, never used to select): 1h horizon only is not enough -> all horizons, summarized
  const sens = {};
  const pick = (res) => res.pooled.map((x) => ({ side: x.side, horizon: x.horizon, events: x.events, mean_raw_bps: x.mean_raw_bps, mean_effect_bps: x.mean_effect_bps, ci95_effect_bps: x.ci95_effect_bps }));
  for (const [name, o] of Object.entries({ pct99: { pct: 0.99 }, pct999: { pct: 0.999 }, window1m: { window: 1 }, window15m: { window: 15 }, delay3: { delayMin: 3 }, delay5: { delayMin: 5 } })) sens[name] = pick(study(all, o));
  sens.binanceOnly = pick(study(loadData(DIR, { sources: ["binance-futures"] })));
  sens.bybitOnly = pick(study(loadData(DIR, { sources: ["bybit"] })));
  const pre = Object.fromEntries(Object.entries(all).map(([s, d]) => [s, { ...d, days: d.days.filter((x) => x.day < Date.parse("2021-04-27")) }])), post = Object.fromEntries(Object.entries(all).map(([s, d]) => [s, { ...d, days: d.days.filter((x) => x.day >= Date.parse("2021-04-27")) }]));
  sens.preBinanceChange = pick(study(pre)); sens.postBinanceChange = pick(study(post));
  writeFileSync(OUT, JSON.stringify({ prereg: "docs/research/edge/PREREGISTRATION.md (d750dda)", coverage, costs_bps: COSTS_BPS, primary: { rows: primary.rows, pooled: primary.pooled }, sensitivity: sens, events: primary.events }, null, 1) + "\n");
  console.log(JSON.stringify(coverage));
  for (const x of [...primary.rows, ...primary.pooled]) console.log(`${x.sym.padEnd(4)} ${x.side.padEnd(5)} ${x.horizon.padEnd(4)} n ${String(x.events).padStart(4)} days ${String(x.days).padStart(3)} raw ${String(x.mean_raw_bps).padStart(7)} ctrl ${String(x.mean_ctrl_bps).padStart(7)} eff ${String(x.mean_effect_bps).padStart(7)} CI ${JSON.stringify(x.ci95_effect_bps)} p ${x.p_effect?.toFixed(4)} holm ${x.p_holm?.toFixed(3) ?? "-"} P(reb) ${x.p_rebound} halves ${JSON.stringify(x.halves_effect_bps)}`);
}
