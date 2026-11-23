// Fractional-position long/short PERPETUAL-STYLE simulator (THEORETICAL PAPER research; nothing here is executable at $100).
// Hourly, 24/7. Variation margin is settled every hour (equity = cash). Positions are signed fractional units.
//   * Daily decision (00:00 UTC) -> target notional per asset = weight x base (base = equity if compounding, else capital).
//     Executed at that hour's open with half-spread + slippage; an order can be MISSED with probability missProb.
//   * Fees: "ideal" = percentage of notional (idealized: as if fractional contracts existed);
//           "conservative" = fixed $ per WHOLE contract per side, charged on ceil(|units| / contract) contracts.
//   * Funding: each hour, cash -= units x price x hourlyRate (positive rate: longs pay shorts).
//   * Initial margin caps gross notional when opening (sum |notional| x init <= equity); if equity marked at each hour's
//     WORST price falls below maintenance (sum |notional| x maint), everything is liquidated at that worst price (+ slippage)
//     and a liquidation fee is charged.
//   * Drawdown: from the equity high-water mark incl. intrabar extremes (best price assumed BEFORE worst in the hour).
export const HOUR = 3_600_000, DAY = 86_400_000;

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

/**
 * assets: [{ name, H: hourly bars, funding: (t) -> hourly rate }]
 * decide(dayT) -> { [name]: signed weight (fraction of base as notional) } or null (no change)
 * cfg: { capital, compound, fee: { mode: "ideal" | "conservative", pct: {a}, perContract: {a}, contract: {a} },
 *        spread: {a} (full spread, fraction), slip, liqSlip, missProb, seed, margin: { init: {a}, maint: {a} }, liqFee: { pct, perContract } }
 */
export function simulatePerp(assets, decide, cfg, { from, to }) {
  const { capital = 100, compound = true, fee, spread, slip = 0, liqSlip = 0, missProb = 0, seed = 7, margin, liqFee = { pct: 0, perContract: 0 }, band = 0 } = cfg;
  const H = assets.map((a) => new Map(a.H.map((b) => [b.t, b])));
  const rand = rng(seed);
  const n = assets.length, units = new Array(n).fill(0), last = new Array(n).fill(null);
  let cash = capital, hwm = capital, dd = 0, fees = 0, funding = 0, liqs = 0, missed = 0, trades = 0, slipCost = 0, ruined = false;
  const daily = [], events = [];
  const feeFor = (j, dUnits, px) => {
    const a = assets[j].name;
    if (fee.mode === "ideal") return Math.abs(dUnits) * px * fee.pct[a];
    // conservative: the percentage fee, but never less than one whole contract's fixed fee per order (a fixed fee is
    // never scaled down for a fractional size). Expressed per ORDER, not per historical unit, so old low prices do not
    // inflate it (v1 defect).
    return Math.max(Math.abs(dUnits) * px * fee.pct[a], fee.perContract[a]);
  };
  const liqFeeFor = (j, u, px) => (fee.mode === "ideal" ? Math.abs(u) * px * liqFee.pct : Math.max(Math.abs(u) * px * liqFee.pct, liqFee.perContract));
  for (let t = Math.ceil(from / HOUR) * HOUR; t < to; t += HOUR) {
    const bars = H.map((m) => m.get(t));
    // 1) variation margin from the previous close to this open, and the daily decision at the open
    for (let j = 0; j < n; j++) { const b = bars[j]; if (b && last[j] !== null && units[j]) cash += units[j] * (b.o - last[j]); if (b) last[j] = b.o; }
    if (!ruined && t % DAY === 0) {
      const w = decide(t);
      if (w) {
        const base = compound ? Math.max(cash, 0) : capital;
        const tgt = assets.map((a, j) => (bars[j] ? (w[a.name] ?? 0) * base / bars[j].o : units[j]));
        // initial-margin cap on gross notional
        const gross = tgt.reduce((s, u, j) => s + (bars[j] ? Math.abs(u) * bars[j].o * margin.init[assets[j].name] : 0), 0);
        const scale = gross > cash && gross > 0 ? Math.max(cash, 0) / gross : 1;
        for (let j = 0; j < n; j++) {
          if (!bars[j]) continue;
          const want = tgt[j] * scale, d = want - units[j]; if (Math.abs(d) < 1e-12) continue;
          // rebalance band: keep the position unless the sign changes, it goes to/from zero, or it drifts > band x target
          if (band > 0 && Math.sign(want) === Math.sign(units[j]) && want !== 0 && Math.abs(d) <= band * Math.abs(want)) continue;
          if (rand() < missProb) { missed++; continue; }
          const px = bars[j].o, sp = spread[assets[j].name] / 2 + slip, f = feeFor(j, d, px), sc = Math.abs(d) * px * sp;
          cash -= f + sc; fees += f; slipCost += sc; units[j] += d; trades++;
        }
      }
    }
    // 2) intrabar: best then worst price (worst-case order), liquidation check at the worst price
    let eqBest = cash, eqWorst = cash, maintReq = 0;
    for (let j = 0; j < n; j++) {
      const b = bars[j]; if (!b || !units[j]) continue;
      const best = units[j] > 0 ? b.h : b.l, worst = units[j] > 0 ? b.l : b.h;
      eqBest += units[j] * (best - b.o); eqWorst += units[j] * (worst - b.o);
      maintReq += Math.abs(units[j]) * worst * margin.maint[assets[j].name];
    }
    dd = Math.max(dd, 1 - eqWorst / Math.max(hwm, eqBest)); hwm = Math.max(hwm, eqBest);
    if (maintReq > 0 && eqWorst < maintReq) {
      for (let j = 0; j < n; j++) {
        const b = bars[j]; if (!b || !units[j]) continue;
        const worst = units[j] > 0 ? b.l : b.h, px = worst * (1 - Math.sign(units[j]) * liqSlip);
        cash += units[j] * (px - b.o); const lf = liqFeeFor(j, units[j], px); cash -= lf; fees += lf; units[j] = 0; last[j] = null;
      }
      liqs++; events.push({ t, kind: "LIQUIDATION", equity: cash });
      dd = Math.max(dd, 1 - cash / Math.max(hwm, eqBest));
    }
    // 3) close of the hour: variation margin open -> close, funding
    for (let j = 0; j < n; j++) {
      const b = bars[j]; if (!b) continue;
      if (units[j]) { cash += units[j] * (b.c - b.o); const fr = assets[j].funding(t) * units[j] * b.c; cash -= fr; funding += fr; }
      last[j] = b.c;
    }
    hwm = Math.max(hwm, cash);
    if (cash <= 0 && !ruined) { ruined = true; for (let j = 0; j < n; j++) units[j] = 0; events.push({ t, kind: "RUIN" }); }
    if ((t + HOUR) % DAY === 0) daily.push([t + HOUR - DAY, cash]);
  }
  const years = (to - from) / (365.25 * DAY);
  return { final: cash, cagr_pct: cash > 0 ? ((cash / capital) ** (1 / years) - 1) * 100 : -100, dd_pct: dd * 100, fees, funding, slipCost, liquidations: liqs, missed, trades, ruined, daily, events };
}

/** Non-overlapping period returns from a daily equity series. */
export function periodStats(daily, days) {
  const r = [];
  for (let i = days; i < daily.length; i += days) r.push(daily[i][1] / daily[i - days][1] - 1);
  if (!r.length) return null;
  const s = [...r].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: r.length, median_pct: q(0.5) * 100, worst_pct: s[0] * 100, best_pct: s.at(-1) * 100, positive_share: r.filter((x) => x > 0).length / r.length };
}
/** Longest time under water (days) of a daily equity series. */
export function longestRecoveryDays(daily) {
  let peak = -Infinity, peakT = null, longest = 0;
  for (const [t, v] of daily) { if (v >= peak) { if (peakT !== null) longest = Math.max(longest, (t - peakT) / DAY); peak = v; peakT = t; } }
  if (peakT !== null && daily.length) longest = Math.max(longest, (daily.at(-1)[0] - peakT) / DAY);
  return longest;
}
