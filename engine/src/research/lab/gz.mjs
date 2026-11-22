// Research lab: Grossman-Zhou drawdown-budget overlay on a target-weight signal (research only).
// Daily bars. At each close: k = clamp(m (V - (1 - alpha) P) / V, 0, 1); desired weight_i = k * w_i(t).
// Orders execute at the NEXT open, market, price x (1 +/- spread), fee on notional; only when the desired weight crosses
// to/from 0 or deviates from the actual weight by more than `band` x desired. Strict drawdown marks positions at lows.
const STEP = 1e-8;
const floorQ = (q) => Math.floor(q / STEP + 1e-9) * STEP;

/**
 * assets: [{ name, K: daily bars, target(i) -> weight in [0, 1] of the WHOLE account or null while warming up }]
 * p: { m, alpha = 0.02, band = 0.25 }; cost: { fee, spread, minUsd }; opt: { from, to, capital = 100 }
 */
export function backtestGZ(assets, p, cost, opt) {
  const { m, alpha = 0.02, band = 0.25 } = p;
  const { from, to, capital = 100 } = opt;
  const idx = assets.map((a) => new Map(a.K.map((k, i) => [k.t, i])));
  const times = [...new Set(assets.flatMap((a) => a.K.filter((k) => k.t >= from && k.t < to).map((k) => k.t)))].sort((x, y) => x - y);
  const qty = assets.map(() => 0), last = assets.map(() => null);
  let cash = capital, peak = capital, dd = 0, ddClose = 0, fees = 0, orders = 0, skipped = 0, pend = null, kSum = 0, kN = 0;
  const curve = [];
  for (const t of times) {
    // 1) execute pending rebalance at this open
    if (pend) {
      for (let j = 0; j < assets.length; j++) {
        const i = idx[j].get(t); if (i === undefined || pend[j] === null) continue;
        const o = assets[j].K[i].o, eqOpen = cash + assets.reduce((s, _, jj) => s + qty[jj] * (idx[jj].get(t) !== undefined ? assets[jj].K[idx[jj].get(t)].o : last[jj] ?? 0), 0);
        const want = pend[j] * eqOpen, have = qty[j] * o, delta = want - have;
        if (Math.abs(delta) < 1e-9) continue;
        if (delta > 0) {
          const px = o * (1 + cost.spread); let q = floorQ(Math.min(delta / px, cash / (px * (1 + cost.fee))));
          if (q * px < cost.minUsd) { skipped++; continue; }
          cash -= q * px * (1 + cost.fee); fees += q * px * cost.fee; qty[j] += q; orders++;
        } else {
          const px = o * (1 - cost.spread), full = pend[j] === 0; let q = full ? qty[j] : floorQ(Math.min(-delta / px, qty[j]));
          if (!full && q * px < cost.minUsd) { skipped++; continue; }
          cash += q * px * (1 - cost.fee); fees += q * px * cost.fee; qty[j] -= q; if (full || qty[j] < 1e-12) qty[j] = 0; orders++;
        }
      }
      pend = null;
    }
    // 2) marks (strict at lows, all assets together)
    let eqL = cash, eqC = cash;
    for (let j = 0; j < assets.length; j++) { const i = idx[j].get(t); if (i !== undefined) last[j] = assets[j].K[i].c; const b = i !== undefined ? assets[j].K[i] : null; eqL += qty[j] * (b ? b.l : last[j] ?? 0); eqC += qty[j] * (last[j] ?? 0); }
    peak = Math.max(peak, eqC); dd = Math.max(dd, 1 - eqL / peak); ddClose = Math.max(ddClose, 1 - eqC / peak);
    curve.push([t, eqC]);
    // 3) decision at the close
    // p.fixedK: reference runs only (the unscaled signal), not part of the overlay
    const k = p.fixedK ?? Math.min(1, Math.max(0, (m * (eqC - (1 - alpha) * peak)) / eqC)); kSum += k; kN++;
    const desired = assets.map((a, j) => { const i = idx[j].get(t); if (i === undefined || i + 1 >= a.K.length) return null; const w = a.target(i); return w === null ? null : k * w; });
    const next = desired.map((d, j) => {
      if (d === null) return null;
      const actual = eqC > 0 ? (qty[j] * (last[j] ?? 0)) / eqC : 0;
      if ((d === 0) !== (actual === 0)) return d;
      if (d > 0 && Math.abs(actual - d) > band * d) return d;
      return null;
    });
    if (next.some((x) => x !== null)) pend = next;
  }
  const final = cash + qty.reduce((s, q, j) => s + q * (last[j] ?? 0), 0), years = (to - from) / (365.25 * 86_400_000);
  return { final, cagr_pct: ((final / capital) ** (1 / years) - 1) * 100, dd_pct: dd * 100, dd_close_pct: ddClose * 100, fees, orders, skipped, mean_k: kSum / (kN || 1), curve };
}
