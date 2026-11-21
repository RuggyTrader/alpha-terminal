// Strategy selection: a minimal ALLOCATION backtester for slow, long-only rules (docs/research/strategy-select/
// PREREGISTRATION.md). One sleeve = one asset with its own capital. Each day the rule sees completed bars 0..i only and
// returns a target weight in [0, 1] (or null = keep the current weight). The trade to reach it executes at bar i+1's
// OPEN, paying fee + slippage on the traded notional. Equity is marked at every close. No leverage, no shorting.
export const DAY = 86_400_000;

export function runSleeve(bars, rule, { capital, from = -Infinity, to = Infinity, feePct = 0.2, slipPct = 0.05, threshold = 0, minQty = 0, minNotional = 0 }) {
  const fee = feePct / 100, slip = slipPct / 100, decide = rule(bars);
  let cash = capital, qty = 0, w = 0, pending = null, open = null;
  const curve = [], trips = [], orders = [];
  let fees = 0, traded = 0, exposedDays = 0, days = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], inWin = b.t >= from && b.t < to;
    if (b.t >= to) break;
    // 1) execute yesterday's decision at today's open
    if (pending !== null && inWin) {
      const eqOpen = cash + qty * b.o, targetNotional = pending * eqOpen, cur = qty * b.o, delta = targetNotional - cur;
      if (Math.abs(delta) > 1e-9) {
        const buy = delta > 0, px = b.o * (buy ? 1 + slip : 1 - slip);
        let dq = Math.abs(delta) / px;
        if (buy) dq = Math.min(dq, cash / (px * (1 + fee)));           // never spend cash we do not have
        else dq = Math.min(dq, qty);
        const notional = dq * px, f = notional * fee;
        orders.push({ t: b.t, side: buy ? "BUY" : "SELL", qty: dq, notional, feasible: dq >= minQty && notional >= minNotional });
        if (dq > 0) {
          if (buy) { cash -= notional + f; qty += dq; } else { cash += notional - f; qty -= dq; }
          fees += f; traded += notional;
          if (buy && !open) open = { t: b.t, cost: notional + f, proceeds: 0 };
          else if (buy) open.cost += notional + f;
          else if (open) open.proceeds += notional - f;
          if (qty <= 1e-12 && open) { qty = 0; trips.push({ entryT: open.t, exitT: b.t, net: open.proceeds - open.cost }); open = null; }
          w = pending;
        }
      }
      pending = null;
    }
    // 2) mark at the close
    if (inWin) { const eq = cash + qty * b.c; curve.push({ t: b.t, eq }); days++; if (qty > 0) exposedDays++; }
    // 3) decide at the close (bars 0..i only)
    const target = decide(i);
    if (target !== null && target !== undefined && inWin && i + 1 < bars.length) {
      const tw = Math.max(0, Math.min(1, target));
      const crosses = (w === 0) !== (tw === 0);                           // entering or leaving always trades
      if (crosses || Math.abs(tw - w) >= threshold) { if (tw !== w) pending = tw; }
    }
  }
  if (open) trips.push({ entryT: open.t, exitT: null, net: open.proceeds - open.cost + qty * (curve.at(-1)?.eq !== undefined ? bars.find((x) => x.t === curve.at(-1).t).c : 0) });
  return { curve, trips, orders, fees, traded, final: curve.length ? curve.at(-1).eq : capital, exposure: days ? exposedDays / days : 0 };
}

// ---- indicators (value at i uses bars 0..i only) ----
export const sma = (xs, n) => { let s = 0; return xs.map((v, i) => { s += v; if (i >= n) s -= xs[i - n]; return i + 1 < n ? null : s / n; }); };
export function atr(b, n) { let a = null; return b.map((k, i) => { const tr = i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - b[i - 1].c), Math.abs(k.l - b[i - 1].c)); a = a === null ? tr : (a * (n - 1) + tr) / n; return i + 1 < n ? null : a; }); }

// ---- the pre-registered rules ----
/** S1: hold when close > SMA(n). */
export const S1 = ({ n = 200 } = {}) => (bars) => { const S = sma(bars.map((b) => b.c), n); return (i) => (S[i] === null ? null : bars[i].c > S[i] ? 1 : 0); };
/** S2: every 7th day (UTC day number % 7 == 0), hold if the L-day return is positive; otherwise keep. */
export const S2 = ({ L = 84 } = {}) => (bars) => (i) => (i < L || Math.floor(bars[i].t / DAY) % 7 !== 0 ? null : bars[i].c / bars[i - L].c - 1 > 0 ? 1 : 0);
/** S3: S1 x min(1, target / annualised 30-day realised volatility). */
export const S3 = ({ n = 200, target = 0.4 } = {}) => (bars) => {
  const C = bars.map((b) => b.c), S = sma(C, n), lr = C.map((c, i) => (i ? Math.log(c / C[i - 1]) : null));
  return (i) => {
    if (S[i] === null || i < 31) return null;
    if (!(C[i] > S[i])) return 0;
    let m = 0; for (let j = i - 29; j <= i; j++) m += lr[j]; m /= 30;
    let v = 0; for (let j = i - 29; j <= i; j++) v += (lr[j] - m) ** 2;
    const vol = Math.sqrt(v / 29) * Math.sqrt(365);
    return vol > 0 ? Math.min(1, target / vol) : 1;
  };
};
/** S4: enter on a close above the prior N-day high; exit on a close below the prior M-day low or below entry close - k*ATR(20). */
export const S4 = ({ N = 55, M = 20, k = 2 } = {}) => (bars) => {
  const A = atr(bars, 20); let inPos = false, ref = null;
  const hi = (i, n) => { let x = -Infinity; for (let j = i - n; j < i; j++) x = Math.max(x, bars[j].h); return x; };
  const lo = (i, n) => { let x = Infinity; for (let j = i - n; j < i; j++) x = Math.min(x, bars[j].l); return x; };
  return (i) => {
    if (i < Math.max(N, M) || A[i] === null) return null;
    const c = bars[i].c;
    if (!inPos) { if (c > hi(i, N)) { inPos = true; ref = c - k * A[i]; return 1; } return 0; }
    if (c < lo(i, M) || c < ref) { inPos = false; ref = null; return 0; }
    return 1;
  };
};
export const BUYHOLD = () => () => () => 1;
