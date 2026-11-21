// S3 (strategy selection, research/strategy-select): 200-day SMA trend filter with 40% volatility targeting, long only,
// BTC + ETH equal sleeves of ONE shared $100 PAPER account. FROZEN for a forward PAPER trial (NOT active; owner approval
// required). The decision rules are the research implementation (engine/src/research/select/alloc.mjs, S3 with the
// actual-weight rebalancing band and orders below the exchange minimum skipped) line for line; `replaySleeve`
// reproduces the research backtest exactly (parity test: worker/test/trial_s3_parity.test.mjs against a golden file).
export interface Candle { t: number; o: number; h: number; l: number; c: number } // t = candle open, ms UTC

export const PARAMS = Object.freeze({
  strategy: "S3-SMA200-VOL40", version: 1, timeframe: "1d",
  assets: Object.freeze({
    BTC: Object.freeze({ symbol: "BTCUSD", pair: "XBTUSD", minQty: 0.00006, minCost: 0.5, qtyStep: 1e-8 }),   // Kraken AssetPairs (lot_decimals 8)
    ETH: Object.freeze({ symbol: "ETHUSD", pair: "ETHUSD", minQty: 0.002, minCost: 0.5, qtyStep: 1e-8 }),
  }),
  sma: 200, volDays: 30, volTarget: 0.4, band: 0.1,            // weight = 1{close > SMA200} x min(1, 0.40 / annualised 30-day vol)
  feePct: 0.2, slipPct: 0.05, startEquityUsd: 100,              // production PAPER fee model; one shared $100, equal sleeves
  long: true, short: false, leverage: false,
});
export type Params = typeof PARAMS;
export const paramsKey = (p: Params = PARAMS) => JSON.stringify(p);

/** The S3 signal at the completed daily close i (bars 0..i only): SMA, annualised 30-day vol and the target weight;
 *  null while the indicators warm up. */
export function signalAt(K: Candle[], i: number, p: Params = PARAMS): { sma: number; vol: number; target: number } | null {
  if (i < p.sma - 1 || i < p.volDays + 1) return null;
  let s = 0; for (let j = i - p.sma + 1; j <= i; j++) s += K[j].c;
  const sma = s / p.sma;
  let m = 0; for (let j = i - p.volDays + 1; j <= i; j++) m += Math.log(K[j].c / K[j - 1].c); m /= p.volDays;
  let v = 0; for (let j = i - p.volDays + 1; j <= i; j++) v += (Math.log(K[j].c / K[j - 1].c) - m) ** 2;
  const vol = Math.sqrt(v / (p.volDays - 1)) * Math.sqrt(365);
  const target = !(K[i].c > sma) ? 0 : vol > 0 ? Math.min(1, p.volTarget / vol) : 1;
  return { sma, vol, target };
}
/** Target weight at the completed daily close i (bars 0..i only); null while the indicators warm up. */
export function targetWeight(K: Candle[], i: number, p: Params = PARAMS): number | null {
  return signalAt(K, i, p)?.target ?? null;
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
export type Asset = "BTC" | "ETH";

/** Size the market order that moves a sleeve to `target` at a fill candle's `open` (+/- slippage, fee on the fill).
 *  `minUsd` null = the exchange rule only (minimum quantity and cost). `round` floors the quantity to the exchange's
 *  lot step (a full exit sells the whole holding, which is already on the step). null when nothing needs to change. */
export function planOrder(cash: number, qty: number, target: number, open: number, asset: Asset, o: { minUsd: number | null; round: boolean; p?: Params }) {
  const p = o.p ?? PARAMS, a = p.assets[asset], fee = p.feePct / 100, slip = p.slipPct / 100;
  const eqOpen = cash + qty * open, delta = target * eqOpen - qty * open;
  if (!(Math.abs(delta) > 1e-9)) return null;
  const buy = delta > 0, px = open * (buy ? 1 + slip : 1 - slip);
  let dq = Math.abs(delta) / px;
  dq = buy ? Math.min(dq, cash / (px * (1 + fee))) : Math.min(dq, qty);
  const qtyRaw = dq, fullExit = !buy && Math.abs(dq - qty) < 1e-12;
  if (o.round && !fullExit) dq = Math.floor(dq / a.qtyStep + 1e-9) * a.qtyStep;
  const notional = dq * px, f = notional * fee;
  const minUsd = o.minUsd ?? 0;
  return { side: (buy ? "BUY" : "SELL") as "BUY" | "SELL", px, qtyRaw, qty: dq, notional, fee: f, fullExit, minUsd, ok: feasible(dq, notional, fullExit, a, minUsd) };
}

/** Daily-bar replay of ONE sleeve (decide at close i, market order at open i+1): the research execution model.
 *  Defaults reproduce the research backtest exactly; `round` and `minUsd: null` give the live shadow configuration. */
export function replaySleeve(K: Candle[], asset: Asset, o: { fromMs: number; toMs: number; capital: number; minUsd: number | null; round?: boolean; p?: Params }) {
  const p = o.p ?? PARAMS;
  let cash = o.capital, qty = 0, w = 0, pending: number | null = null, fees = 0;
  const orders: Order[] = [], curve: [number, number][] = [];
  for (let i = 0; i < K.length; i++) {
    const b = K[i], inWin = b.t >= o.fromMs && b.t < o.toMs;
    if (b.t >= o.toMs) break;
    if (pending !== null && inWin) {
      const x = planOrder(cash, qty, pending, b.o, asset, { minUsd: o.minUsd, round: !!o.round, p });
      if (x) {
        orders.push({ t: b.t, side: x.side, qty: x.qty, notional: x.notional, feasible: x.ok, skipped: !x.ok });
        if (x.qty > 0 && x.ok) {
          if (x.side === "BUY") { cash -= x.notional + x.fee; qty += x.qty; } else { cash += x.notional - x.fee; qty -= x.qty; }
          fees += x.fee;
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
