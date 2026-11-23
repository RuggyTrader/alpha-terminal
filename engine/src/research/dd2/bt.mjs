// DD2 backtester (docs/research/dd2/PREREGISTRATION.md): long-only spot, shared cash across a universe of assets,
// daily bars. Signals at the close use bars 0..i only; market orders fill at the NEXT open (+ slippage); stops are checked
// on each bar's low from the entry bar on and fill at the stop, or at the open after a gap (worse). Kraken minimums at the
// historical price; quantities floored to 1e-8; entries below the minimum are skipped; full exits always trade.
export const DAY = 86_400_000;
const STEP = 1e-8;

// ---- indicators: value at i uses bars 0..i only (null while warming up) ----
export function sma(c, n) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
export function atr(K, n = 14) {
  const o = new Array(K.length).fill(null), tr = K.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - K[i - 1].c), Math.abs(k.l - K[i - 1].c)) : k.h - k.l));
  let s = 0; for (let i = 0; i < K.length; i++) { s += tr[i]; if (i >= n) s -= tr[i - n]; if (i >= n) o[i] = s / n; } return o;
}
export function roc(c, L) { return c.map((v, i) => (i >= L ? v / c[i - L] - 1 : null)); }
export function rsi(c, n = 2) {
  const o = new Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
export function priorHigh(K, N) { return K.map((_, i) => { if (i < N) return null; let m = -Infinity; for (let j = i - N; j < i; j++) m = Math.max(m, K[j].h); return m; }); }
export function priorLow(K, M) { return K.map((_, i) => { if (i < M) return null; let m = Infinity; for (let j = i - M; j < i; j++) m = Math.min(m, K[j].l); return m; }); }
export function vol30(c) { return c.map((_, i) => { if (i < 31) return null; const r = []; for (let j = i - 29; j <= i; j++) r.push(Math.log(c[j] / c[j - 1])); const m = r.reduce((a, b) => a + b, 0) / 30; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / 29) * Math.sqrt(365); }); }

/** Per-asset signal functions for a strategy spec: { entry(i), exit(i, heldBars) } for trade families, or target(i) for V. */
export function signals(K, spec) {
  const c = K.map((k) => k.c), A = atr(K, 14), p = spec.p;
  const base = { atr: A };
  switch (spec.family) {
    case "T": { const S = sma(c, p.n); return { ...base, entry: (i) => i > 0 && S[i] !== null && S[i - 1] !== null && c[i] > S[i] && c[i - 1] <= S[i - 1], exit: (i) => S[i] !== null && c[i] < S[i] }; }
    case "M": { const R = roc(c, p.L); return { ...base, entry: (i) => R[i] !== null && R[i] > p.th, exit: (i) => R[i] !== null && R[i] < 0 }; }
    case "R": { const R = rsi(c, 2), S5 = sma(c, 5), S200 = sma(c, 200); return { ...base, entry: (i) => R[i] !== null && R[i] < p.x && (!p.filter || (S200[i] !== null && c[i] > S200[i])), exit: (i, held) => (S5[i] !== null && c[i] > S5[i]) || held >= 5 }; }
    case "B": { const H = priorHigh(K, p.N), L = priorLow(K, p.M); return { ...base, entry: (i) => H[i] !== null && c[i] > H[i], exit: (i) => L[i] !== null && c[i] < L[i] }; }
    case "V": { const S = sma(c, p.n), V = vol30(c); return { ...base, target: (i) => (S[i] === null || V[i] === null ? null : c[i] > S[i] ? (V[i] > 0 ? Math.min(1, p.tv / V[i]) : 1) : 0) }; }
    default: throw new Error(`unknown family ${spec.family}`);
  }
}

/**
 * assets: [{ name, K: bars, minQty, minQtyAt?, minUsd? }] (minQtyAt(t): optional date-dependent minimum quantity) (minUsd: an optional USD minimum per order, e.g. today's Kraken minimum value). spec: { family, p, k, trail, r, cb } (V: p.n, p.tv, cb).
 * opt: { from, to, capital = 100, fee, slip, stopSlip, minCost = 0.5 }.
 */
export function backtest(assets, spec, opt) {
  const { from, to, capital = 100, fee, slip, stopSlip, minCost = 0.5, audit = null, exec = null, stopExec = null } = opt;
  // exec (optional, execution-cost research): (asset, t, side, order, bar) -> { px, fee } for a fill, or null when the
  // order is MISSED (not filled). Default: market order at the open +/- slip, paying `fee`. Stops always use stopSlip + fee.
  const n = assets.length, cap = 1 / n;
  const S = assets.map((a) => signals(a.K, spec));
  const idx = assets.map((a) => new Map(a.K.map((k, i) => [k.t, i])));
  const times = [...new Set(assets.flatMap((a) => a.K.filter((k) => k.t >= from && k.t < to).map((k) => k.t)))].sort((x, y) => x - y);
  const pos = assets.map(() => null), pend = assets.map(() => null), last = assets.map(() => null);
  let cash = capital, peak = capital, ddStrict = 0, ddClose = 0, hwm = capital, ddOfficial = 0, blockUntil = -Infinity, fees = 0, skipped = 0, orders = 0, exposed = 0, traded = 0, missed = 0;
  const trades = [], curve = [];
  // spec.scale (optional, V family): multiplies the target weights AND the rebalance band (a smaller S3); default 1
  const scaleV = spec.scale ?? 1;
  const band = spec.family === "V" ? 0.1 * Math.min(1, spec.p.tv / 0.4) * cap * scaleV : 0;
  const mark = (t, field) => assets.reduce((s, a, j) => { if (!pos[j]) return s; const i = idx[j].get(t); const px = i !== undefined ? a.K[i][field] : last[j]; return s + pos[j].qty * px; }, cash);
  const floorQ = (q) => Math.floor(q / STEP + 1e-9) * STEP;
  const sell = (j, px, t, reason, ref, feeRate = fee) => {
    const p = pos[j], notional = p.qty * px, f = notional * feeRate;
    audit?.push({ t, asset: assets[j].name, side: "SELL", kind: reason, px, ref, qty: p.qty, notional, fee: f, full: true });
    cash += notional - f; fees += f; orders++; traded += notional;
    if (p.open) { trades.push({ asset: assets[j].name, entryT: p.entryT, exitT: t, net: p.proceeds + notional - f - p.cost, reason }); }
    pos[j] = null;
  };
  for (const t of times) {
    // 1) pending market orders at this bar's open
    for (let j = 0; j < n; j++) {
      const i = idx[j].get(t); if (i === undefined || !pend[j]) continue;
      const k = assets[j].K[i], o = pend[j]; pend[j] = null;
      if (o.type === "EXIT") {
        if (!pos[j]) continue;
        if (exec) { const x = exec(assets[j].name, t, "SELL", o, k); if (!x) { missed++; continue; } sell(j, x.px, t, o.reason, { open: k.o, decidedT: o.t }, x.fee); continue; }
        sell(j, k.o * (1 - slip), t, o.reason, { open: k.o, decidedT: o.t }); continue;
      }
      const eqOpen = mark(t, "o");
      if (o.type === "ENTRY") {
        if (pos[j]) continue;
        const x = exec ? exec(assets[j].name, t, "BUY", o, k) : { px: k.o * (1 + slip), fee };
        if (!x) { missed++; continue; }
        const px = x.px, feeR = x.fee, dist = spec.k * o.atr;
        if (!(dist > 0)) continue;
        let q = Math.min((spec.r / 100) * eqOpen / dist, (cap * eqOpen) / px, cash / (px * (1 + feeR)));
        q = floorQ(q);
        if (!(q >= (assets[j].minQtyAt ? assets[j].minQtyAt(t) : assets[j].minQty) && q * px >= Math.max(minCost, assets[j].minUsd ?? 0))) { skipped++; continue; }
        const notional = q * px, f = notional * feeR;
        cash -= notional + f; fees += f; orders++; traded += notional;
        audit?.push({ t, asset: assets[j].name, side: "BUY", kind: "ENTRY", px, ref: { open: k.o, decidedT: o.t, atr: o.atr, eqOpen, cashAfter: cash }, qty: q, notional, fee: f, stop: px - dist });
        pos[j] = { qty: q, entryT: t, entryI: i, cost: notional + f, proceeds: 0, stop: px - dist, best: k.c, open: true };
      } else if (o.type === "TARGET") { // V: move to target weight of total equity
        const cur = pos[j] ? pos[j].qty * k.o : 0, delta = o.w * eqOpen - cur;
        if (Math.abs(delta) < 1e-9) continue;
        const x = exec ? exec(assets[j].name, t, delta > 0 ? "BUY" : "SELL", o, k) : { px: k.o * (delta > 0 ? 1 + slip : 1 - slip), fee };
        if (!x) { missed++; continue; }
        if (delta > 0) {
          const px = x.px; let q = floorQ(Math.min(delta / px, cash / (px * (1 + x.fee))));
          if (!(q >= (assets[j].minQtyAt ? assets[j].minQtyAt(t) : assets[j].minQty) && q * px >= Math.max(minCost, assets[j].minUsd ?? 0))) { skipped++; continue; }
          const notional = q * px, f = notional * x.fee; cash -= notional + f; fees += f; orders++; traded += notional; audit?.push({ t, asset: assets[j].name, side: "BUY", kind: "TARGET", px, qty: q, notional, fee: f });
          if (pos[j]) { pos[j].qty += q; pos[j].cost += notional + f; pos[j].w = o.w; }
          else pos[j] = { qty: q, entryT: t, entryI: i, cost: notional + f, proceeds: 0, stop: -Infinity, best: k.c, open: true, w: o.w };
        } else {
          const px = x.px, full = o.w === 0;
          let q = full ? pos[j].qty : floorQ(Math.min(-delta / px, pos[j].qty));
          if (!full && !(q >= (assets[j].minQtyAt ? assets[j].minQtyAt(t) : assets[j].minQty) && q * px >= Math.max(minCost, assets[j].minUsd ?? 0))) { skipped++; continue; }
          if (full || pos[j].qty - q < 1e-12) { sell(j, px, t, "TARGET_0", undefined, x.fee); continue; }
          const notional = q * px, f = notional * x.fee; cash += notional - f; fees += f; orders++; traded += notional; audit?.push({ t, asset: assets[j].name, side: "SELL", kind: "TARGET", px, qty: q, notional, fee: f });
          pos[j].qty -= q; pos[j].proceeds += notional - f; pos[j].w = o.w;
        }
      }
    }
    // OFFICIAL drawdown (owner's definition, docs/research/OFFICIAL-DRAWDOWN.md): high-water mark of TOTAL equity including
    // intraday highs; equity at this bar's high uses the holdings after the open's fills (before this bar's stops)
    const eqH = mark(t, "h");
    // 2) stops on this bar (stop first if both could happen)
    for (let j = 0; j < n; j++) {
      const i = idx[j].get(t); if (i === undefined || !pos[j] || !(pos[j].stop > -Infinity)) continue;
      const k = assets[j].K[i];
      // stopExec (optional): (asset, t) -> { slip, fee } for a date-dependent stop cost; default stopSlip and fee
      if (k.l <= pos[j].stop) { const sc = stopExec ? stopExec(assets[j].name, t) : { slip: stopSlip, fee }; sell(j, Math.min(k.o, pos[j].stop) * (1 - sc.slip), t, "STOP", { open: k.o, low: k.l, stop: pos[j].stop }, sc.fee); }
    }
    // 3) marks
    for (let j = 0; j < n; j++) { const i = idx[j].get(t); if (i !== undefined) last[j] = assets[j].K[i].c; }
    const eqC = mark(t, "c"), eqL = mark(t, "l");
    peak = Math.max(peak, eqC);
    ddStrict = Math.max(ddStrict, 1 - eqL / peak); ddClose = Math.max(ddClose, 1 - eqC / peak);
    // worst-case intrabar order for the official measure: this bar's high is assumed to come BEFORE its low
    ddOfficial = Math.max(ddOfficial, 1 - eqL / Math.max(hwm, eqH)); hwm = Math.max(hwm, eqH, eqC);
    curve.push([t, eqC]);
    if (pos.some(Boolean)) exposed++;
    // 4) circuit breaker: while holding, a close at or below peak x (1 - cb) exits everything at the next open and blocks
    //    entries for 30 days (the peak is never reset, so drawdown stays honest; in cash it cannot re-trigger)
    if (spec.cb && pos.some(Boolean) && eqC <= peak * (1 - spec.cb / 100)) {
      for (let j = 0; j < n; j++) if (pos[j]) pend[j] = { type: "EXIT", reason: "CIRCUIT_BREAKER", t }; else pend[j] = null;
      blockUntil = t + 30 * DAY;
      continue;
    }
    // 5) decisions at the close (bars 0..i only)
    for (let j = 0; j < n; j++) {
      const i = idx[j].get(t); if (i === undefined || i + 1 >= assets[j].K.length) continue;
      const s = S[j], k = assets[j].K[i];
      if (spec.family === "V") {
        if (t < blockUntil) continue;
        const tw0 = s.target(i); if (tw0 === null) continue;
        const tw = tw0 * cap * scaleV, act = pos[j] ? (pos[j].qty * k.c) / eqC : 0;
        if ((tw === 0) !== (act === 0) ? true : Math.abs(tw - act) >= band) { if (!(tw === 0 && !pos[j])) pend[j] = { type: "TARGET", w: tw }; }
        continue;
      }
      if (pos[j]) {
        if (spec.trail && s.atr[i] !== null) { pos[j].best = Math.max(pos[j].best, k.c); pos[j].stop = Math.max(pos[j].stop, pos[j].best - spec.k * s.atr[i]); }
        if (s.exit(i, i - pos[j].entryI)) pend[j] = { type: "EXIT", reason: "SIGNAL", t };
      } else if (t >= blockUntil && s.atr[i] !== null && s.entry(i)) pend[j] = { type: "ENTRY", atr: s.atr[i], t };
    }
  }
  // open positions are valued at the last close (not closed)
  const final = curve.length ? curve.at(-1)[1] : capital;
  const years = times.length / 365;
  const closed = trades.length, wins = trades.filter((x) => x.net > 0).length;
  return {
    final, net: final - capital, ret_pct: (final / capital - 1) * 100, cagr_pct: years > 0 ? ((final / capital) ** (1 / years) - 1) * 100 : 0,
    dd_pct: ddStrict * 100, dd_close_pct: ddClose * 100, dd_official_pct: ddOfficial * 100, trades: spec.family === "V" ? orders : closed, closed_trades: closed, wins,
    fees, traded, missed, open_at_end: pos.some(Boolean), trade_list: trades, skipped, exposure_pct: times.length ? (exposed / times.length) * 100 : 0, curve,
  };
}

export const PERIODS = Object.freeze({
  train: [Date.parse("2016-01-01"), Date.parse("2021-01-01")],
  validation: [Date.parse("2021-01-01"), Date.parse("2023-07-01")],
  test: [Date.parse("2023-07-01"), Date.parse("2026-11-15")],
});
export const STRESS = Object.freeze({
  "2018 bear": ["2018-01-01", "2019-01-01"], "Mar 2020 crash": ["2020-02-15", "2020-05-01"], "May 2021 crash": ["2021-05-01", "2021-08-01"],
  "2022 bear": ["2022-01-01", "2023-01-01"], "FTX collapse": ["2022-11-01", "2023-01-01"], "sideways 2019-20": ["2019-08-01", "2020-02-01"],
  "sideways 2023": ["2023-03-01", "2023-10-01"], "sideways 2024": ["2024-04-01", "2024-10-01"],
});
export const COSTS = Object.freeze({ base: { fee: 0.004, slip: 0.0005, stopSlip: 0.001 }, stress: { fee: 0.004, slip: 0.0015, stopSlip: 0.0025 }, paper: { fee: 0.002, slip: 0.0005, stopSlip: 0.0005 } });
export const MIN_QTY = Object.freeze({ BTC: 0.00006, ETH: 0.002, SOL: 0.05 });

/** The complete pre-registered grid. */
export function grid() {
  const out = [], common = [];
  for (const k of [1.5, 2, 3]) for (const trail of [false, true]) for (const r of [0.1, 0.25, 0.5, 1]) for (const cb of [0, 1.5]) common.push({ k, trail, r, cb });
  for (const n of [20, 50, 100, 200]) for (const c of common) out.push({ family: "T", p: { n }, ...c });
  for (const L of [14, 28, 56, 90]) for (const th of [0, 0.05, 0.1]) for (const c of common) out.push({ family: "M", p: { L, th }, ...c });
  for (const x of [5, 10, 15, 25]) for (const filter of [true, false]) for (const c of common) out.push({ family: "R", p: { x, filter }, ...c });
  for (const N of [20, 55, 100]) for (const M of [10, 20]) for (const c of common) out.push({ family: "B", p: { N, M }, ...c });
  for (const n of [100, 200]) for (const tv of [0.05, 0.1, 0.2, 0.4]) for (const cb of [0, 1.5]) out.push({ family: "V", p: { n, tv }, cb });
  return out;
}
export const specId = (s) => s.family === "V" ? `V n${s.p.n} tv${s.p.tv * 100}% cb${s.cb}` : `${s.family} ${Object.entries(s.p).map(([k, v]) => `${k}${v}`).join(" ")} k${s.k} ${s.trail ? "trail" : "fixed"} r${s.r}% cb${s.cb}`;
