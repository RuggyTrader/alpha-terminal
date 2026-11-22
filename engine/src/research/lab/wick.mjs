// Research lab: hourly limit-order backtester for the "liquidity provision to forced sellers" (wick capture) hypothesis.
// Research only. Long-only spot, no leverage, shared cash, at most one position per asset.
//
// Rules (docs/research/liquidity/PREREGISTRATION.md):
//   * Each hour, while flat, a post-only BUY limit rests at L = previous hourly close x exp(-z * sigma_d), where sigma_d is
//     the std of daily log returns over the 30 COMPLETE days before the current day (known in advance).
//   * Fill: only if the hour's low trades THROUGH the limit: low <= L x (1 - eps). Fill price min(open, L). Maker fee.
//   * On fill: stop = entry x exp(-z sigma_d) (another drop of the same size), take-profit LIMIT = entry x exp(m z sigma_d),
//     time stop after holdH hours.
//   * Conservative intrabar order: if the fill hour's low also reaches the stop, the trade is stopped in that hour. In later
//     hours the time stop is checked at the open, then the stop (before the take-profit). The take-profit fills only
//     when the high trades THROUGH it (high >= tp x (1 + eps)), at tp, maker fee. Stops and time exits are market
//     orders: price x (1 - slip), taker fee.
//   * Size: risk r % of equity between entry and stop, capped at cap x equity per asset and by cash; orders below the
//     venue's minimum value are skipped. Equity for sizing = cash + positions at the last close.
//   * Drawdown is STRICT: every hour, open positions are marked at that hour's LOW (all assets at once).
import { HOUR, DAY } from "./data.mjs";

const STEP = 1e-8;
const floorQ = (q) => Math.floor(q / STEP + 1e-9) * STEP;

export function backtestWick(assets, p, venue, opt) {
  const { from, to, capital = 100, eps = 0.0005, audit = null } = opt;
  const { z, m, holdH, r, cap = 1 / assets.length } = p;
  const H = assets.map((a) => new Map(a.H.map((b) => [b.t, b])));
  const pos = assets.map(() => null), ord = assets.map(() => null), lastC = assets.map(() => null);
  let cash = capital, peak = capital, ddStrict = 0, ddClose = 0, fees = 0, skippedMin = 0, fills = 0;
  const trades = [], curve = [];
  const close = (j, t, px, feeRate, reason) => {
    const P = pos[j], gross = P.qty * px, f = gross * feeRate;
    cash += gross - f; fees += f;
    const net = gross - f - P.cost;
    trades.push({ asset: assets[j].name, entryT: P.openT, exitT: t, entry: P.entry, exit: px, qty: P.qty, fees: P.fee + f, net, reason, R: net / P.risk });
    audit?.push({ t, asset: assets[j].name, side: "SELL", reason, px, qty: P.qty, fee: f });
    pos[j] = null;
  };
  for (let t = Math.ceil(from / HOUR) * HOUR; t < to; t += HOUR) {
    for (let j = 0; j < assets.length; j++) {
      const b = H[j].get(t); if (!b) continue;
      const a = assets[j], fee = venue.fee(t), slip = venue.exitSlip(a.name, t);
      // 1) open position from an earlier hour: time stop at the open, then stop, then take-profit
      if (pos[j] && pos[j].openT < t) {
        const P = pos[j];
        if (t >= P.openT + holdH * HOUR) close(j, t, b.o * (1 - slip), fee.taker, "TIME");
        else if (b.l <= P.stop) close(j, t, Math.min(b.o, P.stop) * (1 - slip), fee.taker, "STOP");
        else if (b.h >= P.tp * (1 + eps)) close(j, t, P.tp, fee.maker, "TARGET");
      }
      // 2) resting buy limit
      if (!pos[j] && ord[j] && b.l <= ord[j].L * (1 - eps)) {
        const o = ord[j]; ord[j] = null;
        const px = Math.min(b.o, o.L), qty = o.qty;
        if (qty * px < venue.minUsd || qty <= 0) skippedMin++;
        else if (qty * px * (1 + fee.maker) > cash + 1e-9) skippedMin++; // cash taken by other assets
        else {
          const f = qty * px * fee.maker;
          cash -= qty * px + f; fees += f; fills++;
          const stop = px * Math.exp(-z * o.sigma), tp = px * Math.exp(m * z * o.sigma);
          pos[j] = { qty, entry: px, openT: t, stop, tp, fee: f, cost: qty * px + f, risk: qty * (px - stop) + f };
          audit?.push({ t, asset: a.name, side: "BUY", reason: "LIMIT", px, qty, fee: f });
          if (b.l <= stop) close(j, t, stop * (1 - slip), fee.taker, "STOP_SAME_HOUR");
        }
      }
      lastC[j] = b.c;
    }
    // 3) strict and close marks (all assets together)
    const eqL = assets.reduce((s, _, j) => { if (!pos[j]) return s; const b = H[j].get(t); return s + pos[j].qty * (b ? b.l : lastC[j]); }, cash);
    const eqC = assets.reduce((s, _, j) => (pos[j] ? s + pos[j].qty * lastC[j] : s), cash);
    peak = Math.max(peak, eqC);
    ddStrict = Math.max(ddStrict, 1 - eqL / peak); ddClose = Math.max(ddClose, 1 - eqC / peak);
    if ((t + HOUR) % DAY === 0) curve.push([t + HOUR - DAY, eqC]);
    // 4) orders for the next hour (flat assets only; an asset with no trade this hour keeps its resting order)
    for (let j = 0; j < assets.length; j++) {
      if (pos[j] || !H[j].get(t)) continue;
      const sigma = assets[j].vol(t + HOUR);
      if (!(sigma > 0)) { ord[j] = null; continue; }
      const L = lastC[j] * Math.exp(-z * sigma), stop = L * Math.exp(-z * sigma);
      const fee = venue.fee(t + HOUR);
      const qty = floorQ(Math.max(0, Math.min((r / 100) * eqC / (L - stop), (cap * eqC) / L, cash / (L * (1 + fee.maker)))));
      ord[j] = { L, qty, sigma };
    }
  }
  const final = assets.reduce((s, _, j) => (pos[j] ? s + pos[j].qty * lastC[j] : s), cash);
  const years = (to - from) / (365.25 * DAY);
  return {
    final, ret_pct: (final / capital - 1) * 100, cagr_pct: ((final / capital) ** (1 / years) - 1) * 100,
    dd_pct: ddStrict * 100, dd_close_pct: ddClose * 100, trades, n_trades: trades.length, fees, skipped_min: skippedMin, fills,
    open_at_end: pos.some(Boolean), curve,
  };
}

/** Summary statistics of a trade list (net in $, R multiples) with a bootstrap 90 % CI of mean R. */
export function tradeStats(trades, seed = 1) {
  const n = trades.length; if (!n) return { n: 0 };
  const R = trades.map((x) => x.R), mean = R.reduce((a, b) => a + b, 0) / n;
  let s = seed >>> 0; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const boots = [];
  for (let k = 0; k < 2000; k++) { let t = 0; for (let i = 0; i < n; i++) t += R[Math.floor(rnd() * n)]; boots.push(t / n); }
  boots.sort((a, b) => a - b);
  const by = (k) => trades.filter((x) => x.reason === k).length;
  return { n, win_rate: trades.filter((x) => x.net > 0).length / n, mean_R: mean, ci90_R: [boots[100], boots[1899]], net_usd: trades.reduce((a, x) => a + x.net, 0), fees_usd: trades.reduce((a, x) => a + x.fees, 0),
    exits: { TARGET: by("TARGET"), STOP: by("STOP") + by("STOP_SAME_HOUR"), STOP_SAME_HOUR: by("STOP_SAME_HOUR"), TIME: by("TIME") } };
}
