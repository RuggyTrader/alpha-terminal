#!/usr/bin/env node
// RESEARCH ROUND 3 (docs/research/round3/PREREGISTRATION.md). Daily, long-only, low-turnover hypotheses H1-H6.
// Execution (same conservative model as round 2): decisions on completed daily closes; fills at the NEXT open as taker
// with slippage; stops fill at the stop or a worse gap open; Kraken minimums; no leverage, borrowing or shorts.
// Selection uses BTC + SOL development only; validation is a gate; ETH (never used to choose anything) is run ONCE.
import { readFileSync, writeFileSync } from "node:fs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = arg("data"), OUT = arg("out");
const DAY = 86_400_000, D = Date.parse;
const load = (p) => JSON.parse(readFileSync(`${DIR}/${p}-86400.json`, "utf8")).candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
const DATA = { BTC: load("BTC-USD"), SOL: load("SOL-USD"), ETH: load("ETH-USD") };
const MIN = { BTC: { qty: 0.00006, cost: 0.5 }, SOL: { qty: 0.05, cost: 0.5 }, ETH: { qty: 0.002, cost: 0.5 } };
const P = { dev: [D("2021-07-01"), D("2024-07-01")], val: [D("2024-07-01"), D("2026-11-15")], all: [D("2021-07-01"), D("2026-11-15")] };
const COSTS = [{ fee: 0, slip: 0 }, { fee: 0.2, slip: 0.05 }, { fee: 0.2, slip: 0.15 }, { fee: 0.4, slip: 0.05 }, { fee: 0.4, slip: 0.15 }];
const SEL = { fee: 0.2, slip: 0.05 };

// ---- indicators (completed closes only) ----
const sma = (xs, n) => xs.map((_, i) => (i + 1 < n ? null : xs.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n));
function atr(K, n = 14) { let a = null; return K.map((k, i) => { const tr = i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - K[i - 1].c), Math.abs(k.l - K[i - 1].c)); a = a === null ? tr : (a * (n - 1) + tr) / n; return i + 1 < n ? null : a; }); }
function rvol(K, n = 30) { return K.map((_, i) => { if (i < n) return null; const r = []; for (let j = i - n + 1; j <= i; j++) r.push(Math.log(K[j].c / K[j - 1].c)); const m = r.reduce((s, v) => s + v, 0) / n; return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) * Math.sqrt(365); }); }
const hh = (K, n) => K.map((_, i) => (i < n ? null : Math.max(...K.slice(i - n, i).map((k) => k.h))));
const ll = (K, n) => K.map((_, i) => (i < n ? null : Math.min(...K.slice(i - n, i).map((k) => k.l))));
const weekly = (t) => new Date(t).getUTCDay() === 0; // decisions on Sunday closes (weekly hypotheses)

/**
 * Generic daily simulator for ONE asset. `target(i)` (at close i) returns { w } (fraction of equity to hold, 0 = cash)
 * or { risk: true } meaning "enter by risk sizing with stop", plus optional { stop } levels. Positions are changed at
 * the next open; the protective / trailing stop is a stop order checked on each later candle.
 */
function simAsset(asset, K, rule, { fee, slip, risk = 2, capital = 100, from, to, rebalanceBand = 0 }) {
  const f = fee / 100, s = slip / 100, min = MIN[asset];
  let cash = capital, qty = 0, entry = 0, entryT = 0, entryFee = 0, stop = null, pending = null, peak = capital, dd = 0, ddPct = 0, cashDays = 0, days = 0;
  const trades = [], eq = [];
  const sell = (px, t, why) => {
    const x = px * (1 - s), gross = (x - entry) * qty, fx = x * qty * f;
    cash += x * qty - fx;
    trades.push({ entryT, exitT: t, gross, fees: entryFee + fx, net: gross - entryFee - fx, why });
    qty = 0; stop = null;
  };
  const buy = (px, t, q, st) => {
    const x = px * (1 + s); q = Math.floor(Math.min(q, cash / (x * (1 + f))) * 1e8) / 1e8;
    if (q < min.qty || q * x < min.cost) return false;
    const fx = q * x * f; cash -= q * x + fx;
    if (qty > 0) { // add to a position (rebalance): average in, fees accumulate
      entry = (entry * qty + x * q) / (qty + q); entryFee += fx; qty += q;
    } else { qty = q; entry = x; entryT = t; entryFee = fx; stop = st ?? null; }
    return true;
  };
  const trim = (px, q) => { const x = px * (1 - s), fx = x * q * f; const part = q / qty; const gross = (x - entry) * q, eFee = entryFee * part;
    cash += x * q - fx; trades.push({ entryT, exitT: 0, gross, fees: eFee + fx, net: gross - eFee - fx, why: "rebalance" }); entryFee -= eFee; qty -= q; };
  for (let i = 1; i < K.length; i++) {
    const k = K[i];
    if (k.t >= to) break;
    const live = k.t >= from;
    // 1) yesterday's decision at today's open
    if (pending && live) {
      const eqNow = cash + qty * k.o;
      if (pending.w !== undefined) {
        const want = pending.w * eqNow / k.o;
        if (pending.w === 0 && qty > 0) sell(k.o, k.t, pending.why ?? "signal");
        else if (qty === 0 && pending.w > 0) buy(k.o, k.t, want, pending.stop);
        else if (qty > 0 && pending.w > 0 && rebalanceBand > 0 && Math.abs(want - qty) / qty > rebalanceBand) { if (want > qty) buy(k.o, k.t, want - qty); else trim(k.o, qty - want); }
      } else if (pending.riskEntry && qty === 0) {
        const x = k.o * (1 + s), st = x - pending.stopDist;
        buy(k.o, k.t, (eqNow * risk / 100) / (x - st), st);
      }
    }
    pending = null;
    // 2) stop inside the candle
    if (qty > 0 && stop !== null && k.l <= stop) sell(Math.min(k.o, stop), k.t, "stop");
    // 3) close: rule
    if (live) {
      const d = rule(i, { qty, entry, stop });
      if (d) { if (d.newStop !== undefined && qty > 0) stop = Math.max(stop ?? -Infinity, d.newStop); if (d.order) pending = d.order; }
      const v = cash + qty * k.c; peak = Math.max(peak, v); dd = Math.max(dd, peak - v); ddPct = Math.max(ddPct, (peak - v) / peak);
      days++; if (qty === 0) cashDays++; eq.push([k.t, v]);
    }
  }
  const last = K.findLastIndex((k) => k.t < to);
  if (qty > 0) sell(K[last].c, K[last].t + DAY, "window_end");
  return { trades: trades.map((t) => ({ ...t, exitT: t.exitT || t.entryT })), end: cash, dd, ddPct, cashPct: days ? cashDays / days : 1, eq };
}

// ---- hypotheses: each returns rule(i, pos) for one asset ----
const H = {
  H1: { grid: { L: [60, 90, 120, 180] }, make: (K, p) => { const A = atr(K); return (i, pos) => {
    const mom = i >= p.L ? K[i].c / K[i - p.L].c - 1 : null;
    if (pos.qty > 0) return weekly(K[i].t) && mom !== null && mom <= 0 ? { order: { w: 0 } } : null;
    return weekly(K[i].t) && mom !== null && mom > 0 && A[i] ? { order: { riskEntry: true, stopDist: 3 * A[i] } } : null;
  }; } },
  H2: { grid: { N: [100, 200], TV: [0.3, 0.5] }, band: 0.2, make: (K, p) => { const S = sma(K.map((k) => k.c), p.N), V = rvol(K); return (i, pos) => {
    if (S[i] === null || V[i] === null) return null;
    const on = K[i].c > S[i], w = Math.min(1, p.TV / V[i]);
    if (!on) return pos.qty > 0 ? { order: { w: 0 } } : null;
    if (pos.qty === 0) return { order: { w } };
    return weekly(K[i].t) ? { order: { w } } : null; // weekly rebalance (20 % band)
  }; } },
  H3: { grid: { NM: ["55/20", "100/50"], K: [3, 4, 5] }, make: (K, p) => { const [n, m] = p.NM.split("/").map(Number), Hh = hh(K, n), Lm = ll(K, m), A = atr(K); let best = 0; return (i, pos) => {
    if (pos.qty > 0) {
      best = Math.max(best, K[i].c);
      const d = { newStop: A[i] ? best - p.K * A[i] : undefined };
      if (Lm[i] !== null && K[i].c < Lm[i]) d.order = { w: 0 };
      return d;
    }
    best = K[i].c;
    return Hh[i] !== null && K[i].c > Hh[i] && A[i] ? { order: { riskEntry: true, stopDist: p.K * A[i] } } : null;
  }; } },
  H5: { grid: {}, make: (K) => { const S = sma(K.map((k) => k.c), 200); return (i, pos) => {
    const on = S[i] !== null && S[i - 20] !== null && K[i].c > S[i] && S[i] > S[i - 20];
    return on && pos.qty === 0 ? { order: { w: 1 } } : !on && pos.qty > 0 ? { order: { w: 0 } } : null;
  }; } },
  H6: { grid: {}, make: (K, p0, BTC) => { const p = { ma: 50, k: 3, gs: 200, vw: 30, mw: 365, ...p0 };
    const S50 = sma(K.map((k) => k.c), p.ma), A = atr(K), bS = sma(BTC.map((k) => k.c), p.gs), bV = rvol(BTC, p.vw);
    const bIdx = new Map(BTC.map((k, j) => [k.t, j]));
    const medV = (j) => { const xs = bV.slice(Math.max(0, j - (p.mw - 1)), j + 1).filter((v) => v !== null).sort((a, b) => a - b); return xs.length ? xs[xs.length >> 1] : null; };
    let best = 0;
    return (i, pos) => {
      const j = bIdx.get(K[i].t); const gate = j !== undefined && bS[j] !== null && bV[j] !== null && BTC[j].c > bS[j] && bV[j] < medV(j);
      if (pos.qty > 0) {
        best = Math.max(best, K[i].c);
        const d = { newStop: A[i] ? best - p.k * A[i] : undefined };
        if ((S50[i] !== null && K[i].c < S50[i]) || !gate) d.order = { w: 0 };
        return d;
      }
      best = K[i].c;
      return gate && S50[i] !== null && K[i].c > S50[i] && A[i] ? { order: { riskEntry: true, stopDist: p.k * A[i] } } : null;
    };
  } },
};

// H4: relative strength across assets (weekly; hold the strongest with positive L-day return, fully invested).
function simRS(assets, p, { fee, slip, capital = 100, from, to }) {
  const f = fee / 100, s = slip / 100;
  const dates = DATA.BTC.map((k) => k.t).filter((t) => t >= from && t < to && assets.every((a) => DATA[a].some((k) => k.t === t)));
  const idx = Object.fromEntries(assets.map((a) => [a, new Map(DATA[a].map((k, j) => [k.t, j]))]));
  let cash = capital, held = null, qty = 0, entry = 0, entryT = 0, entryFee = 0, pending, peak = capital, dd = 0, ddPct = 0, cashDays = 0;
  const trades = [], eq = [];
  for (let n = 0; n < dates.length; n++) {
    const t = dates[n];
    if (pending !== undefined) {
      if (held && pending !== held) { const k = DATA[held][idx[held].get(t)], x = k.o * (1 - s), g = (x - entry) * qty, fx = x * qty * f; cash += x * qty - fx; trades.push({ entryT, exitT: t, gross: g, fees: entryFee + fx, net: g - entryFee - fx, asset: held }); held = null; qty = 0; }
      if (pending && !held) { const k = DATA[pending][idx[pending].get(t)], x = k.o * (1 + s), q = Math.floor(cash / (x * (1 + f)) * 1e8) / 1e8;
        if (q >= MIN[pending].qty && q * x >= MIN[pending].cost) { entryFee = q * x * f; cash -= q * x + entryFee; held = pending; qty = q; entry = x; entryT = t; } }
      pending = undefined;
    }
    if (weekly(t)) {
      let best = null, br = 0;
      for (const a of assets) { const j = idx[a].get(t); if (j === undefined || j < p.L) continue; const r = DATA[a][j].c / DATA[a][j - p.L].c - 1; if (r > br) { br = r; best = a; } }
      pending = best;
    }
    const v = cash + (held ? qty * DATA[held][idx[held].get(t)].c : 0); peak = Math.max(peak, v); dd = Math.max(dd, peak - v); ddPct = Math.max(ddPct, (peak - v) / peak); if (!held) cashDays++; eq.push([t, v]);
  }
  if (held) { const t = dates.at(-1), k = DATA[held][idx[held].get(t)], x = k.c * (1 - s), g = (x - entry) * qty, fx = x * qty * f; cash += x * qty - fx; trades.push({ entryT, exitT: t + DAY, gross: g, fees: entryFee + fx, net: g - entryFee - fx, asset: held }); }
  return { trades, end: cash, dd, ddPct, cashPct: dates.length ? cashDays / dates.length : 1, eq };
}

// ---- metrics ----
function metrics(r, capital = 100) {
  const nets = r.trades.map((t) => t.net), sum = (x) => x.reduce((a, b) => a + b, 0);
  const w = nets.filter((v) => v > 0), l = nets.filter((v) => v <= 0);
  let st = 0, worst = 0; for (const v of nets) { st = v <= 0 ? st + 1 : 0; worst = Math.max(worst, st); }
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let ci = null; if (nets.length >= 5) { const ms = []; for (let b = 0; b < 2000; b++) { let s = 0; for (let j = 0; j < nets.length; j++) s += nets[Math.floor(rnd() * nets.length)]; ms.push(s / nets.length); } ms.sort((a, b) => a - b); ci = [+ms[50].toFixed(2), +ms[1949].toFixed(2)]; }
  const net = r.end - capital;
  return { trades: nets.length, gross: +sum(r.trades.map((t) => t.gross)).toFixed(2), fees: +sum(r.trades.map((t) => t.fees)).toFixed(2), net: +net.toFixed(2),
    win: nets.length ? +(w.length / nets.length).toFixed(2) : null, pf: l.length && sum(l) < 0 ? +(sum(w) / -sum(l)).toFixed(2) : w.length ? 99 : null,
    avg: nets.length ? +(sum(nets) / nets.length).toFixed(2) : null, ci, max_dd_pct: +(r.ddPct * 100).toFixed(1), ret_dd: r.ddPct > 0 ? +((net / capital) / r.ddPct).toFixed(2) : null,
    streak: worst, hold_days: nets.length ? +(sum(r.trades.map((t) => (t.exitT - t.entryT) / DAY)) / nets.length).toFixed(1) : null, cash_pct: +(r.cashPct * 100).toFixed(0) };
}
const bh = (asset, [from, to], { fee, slip }) => { const ks = DATA[asset].filter((k) => k.t >= from && k.t < to); const q = 100 / (ks[0].o * (1 + slip / 100) * (1 + fee / 100)); let pk = 100, dd = 0; for (const k of ks) { const v = q * k.c; pk = Math.max(pk, v); dd = Math.max(dd, (pk - v) / pk); } const end = q * ks.at(-1).c * (1 - slip / 100) * (1 - fee / 100); return { net: +(end - 100).toFixed(2), max_dd_pct: +(dd * 100).toFixed(1), ret_dd: dd > 0 ? +(((end - 100) / 100) / dd).toFixed(2) : null }; };

// regimes: quarter of entry, by the asset's quarterly return
function regimes(asset, trades) {
  const K = DATA[asset], q = new Map();
  for (const k of K) { const d = new Date(k.t), id = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; (q.get(id) ?? q.set(id, []).get(id)).push(k); }
  const rows = [...q.values()].map((ks) => ({ from: ks[0].t, to: ks.at(-1).t + DAY, ret: ks.at(-1).c / ks[0].o - 1 }));
  const out = { bull: { n: 0, net: 0 }, bear: { n: 0, net: 0 }, sideways: { n: 0, net: 0 } };
  for (const t of trades) { const r = rows.find((x) => t.entryT >= x.from && t.entryT < x.to); if (!r) continue; const k = r.ret > 0.15 ? "bull" : r.ret < -0.15 ? "bear" : "sideways"; out[k].n++; out[k].net = +(out[k].net + t.net).toFixed(2); }
  return out;
}

const expand = (g) => Object.entries(g).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const neighbours = (g, c) => Object.entries(g).flatMap(([k, vs]) => { const i = vs.indexOf(c[k]); return [i - 1, i + 1].filter((j) => j >= 0 && j < vs.length).map((j) => ({ ...c, [k]: vs[j] })); });
const runOne = (h, asset, c, period, cost = SEL, risk = 2) => { const K = DATA[asset]; const r = simAsset(asset, K, H[h].make(K, c, DATA.BTC), { ...cost, risk, from: period[0], to: period[1], rebalanceBand: H[h].band ?? 0 }); return { r, m: metrics(r) }; };

const report = { label: "RESEARCH ROUND 3 (Coinbase daily candles; not PAPER results)", preregistration: "docs/research/round3/PREREGISTRATION.md", periods: P, costs: COSTS, hypotheses: {}, benchmarks: {} };
for (const h of ["H1", "H2", "H3", "H5", "H6"]) {
  const grid = H[h].grid, configs = expand(grid);
  const dev = (c) => ["BTC", "SOL"].map((a) => runOne(h, a, c, P.dev).m);
  const devAll = configs.map((c) => ({ c, d: dev(c) }));
  const ok = (c) => dev(c).every((m) => m.net > 0);
  const qualifying = configs.filter((c) => ok(c) && neighbours(grid, c).every(ok));
  const pick = qualifying.length ? [...qualifying].sort((a, b) => dev(a)[0].net + dev(a)[1].net - dev(b)[0].net - dev(b)[1].net)[Math.floor((qualifying.length - 1) / 2)] : null;
  const row = { grid, dev_grid: devAll.map(({ c, d }) => ({ c, BTC: d[0].net, SOL: d[1].net })), qualifying: qualifying.length, chosen: pick };
  if (pick) {
    row.dev = Object.fromEntries(["BTC", "SOL"].map((a) => [a, runOne(h, a, pick, P.dev).m]));
    row.val = Object.fromEntries(["BTC", "SOL"].map((a) => [a, runOne(h, a, pick, P.val).m]));
    row.val_costs = Object.fromEntries(["BTC", "SOL"].map((a) => [a, COSTS.map((k) => ({ ...k, net: runOne(h, a, pick, P.val, k).m.net }))]));
    row.passes_validation = ["BTC", "SOL"].every((a) => row.val[a].net > 0 && (row.val[a].pf ?? 0) > 1);
    // UNTOUCHED TEST 1: ETH, run once with the chosen settings (reported whatever validation said).
    const e = runOne(h, "ETH", pick, P.all);
    row.eth_test = { ...e.m, costs: COSTS.map((k) => ({ ...k, net: runOne(h, "ETH", pick, P.all, k).m.net })), risk1: runOne(h, "ETH", pick, P.all, SEL, 1).m.net,
      neighbours: neighbours(grid, pick).map((n) => ({ c: n, net: runOne(h, "ETH", n, P.all).m.net })), regimes: regimes("ETH", e.r.trades),
      equity: e.r.eq.filter((_, i) => i % 7 === 0).map(([t, v]) => [t, +v.toFixed(2)]) };
    row.regimes_btc_sol_all = { BTC: regimes("BTC", runOne(h, "BTC", pick, P.all).r.trades), SOL: regimes("SOL", runOne(h, "SOL", pick, P.all).r.trades) };
  }
  report.hypotheses[h] = row;
  console.error(h, "qualifying", qualifying.length, "/", configs.length, pick ? `chosen ${JSON.stringify(pick)} val BTC ${row.val.BTC.net} SOL ${row.val.SOL.net} ${row.passes_validation ? "PASS" : "fail"} | ETH test ${row.eth_test.net} n=${row.eth_test.trades} pf ${row.eth_test.pf} dd ${row.eth_test.max_dd_pct}%` : "no qualifying setting");
}
// H4 relative strength
{
  const grid = { L: [60, 90, 120] }, configs = expand(grid);
  const dev = (c) => metrics(simRS(["BTC", "SOL"], c, { ...SEL, from: P.dev[0], to: P.dev[1] }));
  const qualifying = configs.filter((c) => dev(c).net > 0 && neighbours(grid, c).every((n) => dev(n).net > 0));
  const pick = qualifying.length ? [...qualifying].sort((a, b) => dev(a).net - dev(b).net)[Math.floor((qualifying.length - 1) / 2)] : null;
  const row = { grid, dev_grid: configs.map((c) => ({ c, net: dev(c).net })), qualifying: qualifying.length, chosen: pick };
  if (pick) {
    row.dev = dev(pick); row.val = metrics(simRS(["BTC", "SOL"], pick, { ...SEL, from: P.val[0], to: P.val[1] }));
    row.passes_validation = row.val.net > 0 && (row.val.pf ?? 0) > 1;
    const e = simRS(["BTC", "SOL", "ETH"], pick, { ...SEL, from: P.all[0], to: P.all[1] });
    row.eth_test = { note: "BTC/SOL/ETH over the full period: ETH unseen, BTC/SOL periods already examined", ...metrics(e),
      costs: COSTS.map((k) => ({ ...k, net: metrics(simRS(["BTC", "SOL", "ETH"], pick, { ...k, from: P.all[0], to: P.all[1] })).net })),
      equity: e.eq.filter((_, i) => i % 7 === 0).map(([t, v]) => [t, +v.toFixed(2)]) };
  }
  report.hypotheses.H4 = row;
  console.error("H4 qualifying", qualifying.length, "/", configs.length, pick ? `chosen ${JSON.stringify(pick)} val ${row.val.net} ${row.passes_validation ? "PASS" : "fail"} | 3-asset test ${row.eth_test.net} n=${row.eth_test.trades} dd ${row.eth_test.max_dd_pct}%` : "no qualifying setting");
}
// H6 sensitivity (REPORTED, never used to select): one setting moved at a time, every period and market.
report.h6_sensitivity = [{}, { ma: 40 }, { ma: 60 }, { k: 2.5 }, { k: 3.5 }, { gs: 150 }, { gs: 250 }, { vw: 20 }, { vw: 45 }, { mw: 180 }, { mw: 730 }].map((v) => ({
  variant: Object.keys(v).length ? v : "as registered",
  dev: { BTC: runOne("H6", "BTC", v, P.dev).m.net, SOL: runOne("H6", "SOL", v, P.dev).m.net },
  val: { BTC: runOne("H6", "BTC", v, P.val).m.net, SOL: runOne("H6", "SOL", v, P.val).m.net },
  eth: (({ net, trades, pf, max_dd_pct }) => ({ net, trades, pf, max_dd_pct }))(runOne("H6", "ETH", v, P.all).m),
}));
for (const r of report.h6_sensitivity) console.error("H6 sens", JSON.stringify(r.variant), "dev", r.dev.BTC, r.dev.SOL, "val", r.val.BTC, r.val.SOL, "ETH", r.eth.net, "n", r.eth.trades, "pf", r.eth.pf);
for (const [name, per] of Object.entries(P)) report.benchmarks[name] = Object.fromEntries(["BTC", "SOL", "ETH"].map((a) => [a, { buy_hold: bh(a, per, SEL), h5_trend: runOne("H5", a, {}, per).m }]));
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.error("benchmarks ETH all:", JSON.stringify(report.benchmarks.all.ETH.buy_hold), "H5 on ETH:", report.benchmarks.all.ETH.h5_trend.net, report.benchmarks.all.ETH.h5_trend.max_dd_pct + "%");
console.error("benchmarks val BTC BH", JSON.stringify(report.benchmarks.val.BTC.buy_hold), "H5", report.benchmarks.val.BTC.h5_trend.net, "| SOL BH", JSON.stringify(report.benchmarks.val.SOL.buy_hold), "H5", report.benchmarks.val.SOL.h5_trend.net);
