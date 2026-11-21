// S3 (strategy selection, research/strategy-select): 200-day SMA trend filter with 40% volatility targeting, long only,
// BTC + ETH equal sleeves of ONE shared $100 PAPER account. FROZEN for a forward PAPER trial (NOT active; owner approval
// required). The decision rules are the research implementation (engine/src/research/select/alloc.mjs, S3 with the
// actual-weight rebalancing band and orders below the exchange minimum skipped) line for line; `replaySleeve`
// reproduces the research backtest exactly (parity test: worker/test/trial_s3_parity.test.mjs against a golden file).
export interface Candle { t: number; o: number; h: number; l: number; c: number } // t = candle open, ms UTC

export const PARAMS = Object.freeze({
  strategy: "S3-SMA200-VOL40", version: 1, timeframe: "1d",
  assets: Object.freeze({
    BTC: Object.freeze({ symbol: "BTCUSD", pair: "XBTUSD", minQty: 0.00006, minCost: 0.5 }),   // Kraken AssetPairs
    ETH: Object.freeze({ symbol: "ETHUSD", pair: "ETHUSD", minQty: 0.002, minCost: 0.5 }),
  }),
  sma: 200, volDays: 30, volTarget: 0.4, band: 0.1,            // weight = 1{close > SMA200} x min(1, 0.40 / annualised 30-day vol)
  feePct: 0.2, slipPct: 0.05, startEquityUsd: 100,              // production PAPER fee model; one shared $100, equal sleeves
  long: true, short: false, leverage: false,
});
export type Params = typeof PARAMS;
export const paramsKey = (p: Params = PARAMS) => JSON.stringify(p);

/** Target weight at the completed daily close i (bars 0..i only); null while the indicators warm up. */
export function targetWeight(K: Candle[], i: number, p: Params = PARAMS): number | null {
  if (i < p.sma - 1 || i < p.volDays + 1) return null;
  let s = 0; for (let j = i - p.sma + 1; j <= i; j++) s += K[j].c;
  const sma = s / p.sma;
  if (!(K[i].c > sma)) return 0;
  let m = 0; for (let j = i - p.volDays + 1; j <= i; j++) m += Math.log(K[j].c / K[j - 1].c); m /= p.volDays;
  let v = 0; for (let j = i - p.volDays + 1; j <= i; j++) v += (Math.log(K[j].c / K[j - 1].c) - m) ** 2;
  const vol = Math.sqrt(v / (p.volDays - 1)) * Math.sqrt(365);
  return vol > 0 ? Math.min(1, p.volTarget / vol) : 1;
}

/** Whether a new target produces an order: entering or leaving always; otherwise only when |target - actual| >= band. */
export function wantsOrder(target: number, actualWeight: number, lastTarget: number, p: Params = PARAMS): boolean {
  const crosses = (lastTarget === 0) !== (target === 0);
  return (crosses || Math.abs(target - actualWeight) >= p.band) && (target !== lastTarget || Math.abs(target - actualWeight) >= p.band);
}

/** Order feasibility: Kraken minimum quantity and cost, plus a USD minimum; a full exit is always allowed. */
export function feasible(qty: number, notional: number, fullExit: boolean, a: { minQty: number; minCost: number }, minUsd: number): boolean {
  return qty >= a.minQty && notional >= a.minCost && (notional >= minUsd || fullExit);
}

export interface Order { t: number; side: "BUY" | "SELL"; qty: number; notional: number; feasible: boolean; skipped: boolean }

/** Daily-bar replay of ONE sleeve (decide at close i, market order at open i+1): the research execution model. */
export function replaySleeve(K: Candle[], asset: "BTC" | "ETH", o: { fromMs: number; toMs: number; capital: number; minUsd: number; p?: Params }) {
  const p = o.p ?? PARAMS, a = p.assets[asset], fee = p.feePct / 100, slip = p.slipPct / 100;
  let cash = o.capital, qty = 0, w = 0, pending: number | null = null, fees = 0;
  const orders: Order[] = [], curve: [number, number][] = [];
  for (let i = 0; i < K.length; i++) {
    const b = K[i], inWin = b.t >= o.fromMs && b.t < o.toMs;
    if (b.t >= o.toMs) break;
    if (pending !== null && inWin) {
      const eqOpen = cash + qty * b.o, delta = pending * eqOpen - qty * b.o;
      if (Math.abs(delta) > 1e-9) {
        const buy = delta > 0, px = b.o * (buy ? 1 + slip : 1 - slip);
        let dq = Math.abs(delta) / px;
        dq = buy ? Math.min(dq, cash / (px * (1 + fee))) : Math.min(dq, qty);
        const notional = dq * px, f = notional * fee, fullExit = !buy && Math.abs(dq - qty) < 1e-12;
        const ok = feasible(dq, notional, fullExit, a, o.minUsd);
        orders.push({ t: b.t, side: buy ? "BUY" : "SELL", qty: dq, notional, feasible: ok, skipped: !ok });
        if (dq > 0 && ok) {
          if (buy) { cash -= notional + f; qty += dq; } else { cash += notional - f; qty -= dq; }
          fees += f;
          if (qty <= 1e-12) qty = 0;
          w = pending;
        }
      }
      pending = null;
    }
    if (inWin) curve.push([b.t, cash + qty * b.c]);
    const target = targetWeight(K, i, p);
    if (target !== null && inWin && i + 1 < K.length) {
      const eqC = cash + qty * b.c, actual = eqC > 0 ? (qty * b.c) / eqC : 0;
      if (wantsOrder(target, actual, w, p) && (target !== w || Math.abs(target - actual) >= p.band)) pending = target;
    }
  }
  return { orders, curve, fees, final: curve.length ? curve[curve.length - 1][1] : o.capital };
}
