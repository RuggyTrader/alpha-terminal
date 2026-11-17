// RESEARCH portfolio backtester (round 8). Several markets, ONE shared cash account, LONG only, bar by bar.
// Research only: never connected to execution, the ledger or any bot. Builds on the round-7 single-market rules.
//
// Execution rules (conservative, auditable; same conventions as r7/bt.mjs):
//   * A strategy sees ONLY completed bars 0..i of its own market (plus any cross-sectional data that the caller
//     precomputed from closes at or before bar i) and decides at bar i's close.
//   * Decisions fill at the market's NEXT bar open, with adverse slippage. One bar of latency is always applied.
//   * Within one timestamp: all pending EXITS execute first (cash is released), then all pending ENTRIES in a
//     deterministic order (strategy priority, then market name), then every resting stop is checked.
//   * Stops fill at the stop or at a worse gap open. Fees are charged on every fill's notional.
//   * Equity = cash + sum(qty x last close). Marked at every timestamp; drawdown is measured on that curve.
//   * Every entry that cannot be placed is RECORDED with a reason code (nothing is forced or silently dropped).
//
// Sizing scenarios (round 8 pre-registration, section "Account size"):
//   B  "risk"          : qty = equity x riskPct / (entry - stop), capped by cash; at most maxPositions open.
//   C  "fixed_fraction": qty = equity x fractionPct / entry (stop only used for exits), capped by cash.
//   D  "risk_budget"   : qty = equity x riskPct / (entry - stop), also capped at maxNotionalPct of equity and by a
//                        TOTAL open-risk budget (openRiskPct). Below the exchange minimum the quantity MAY be raised to
//                        the minimum only if that trade's risk stays <= maxRiskPct and the total budget still holds.
//   A  is scenario B run on one market with its own $20 wallet (the production per-bot model) - see isolatedSleeves().
// Exchange minimums: qty >= minQty and qty x price >= minCost (Kraken AssetPairs ordermin / costmin). Quantities are
// rounded DOWN to lotDecimals.

export const REJECT = Object.freeze({
  BELOW_MIN_QTY: "BELOW_MIN_QTY", BELOW_MIN_COST: "BELOW_MIN_COST", INSUFFICIENT_CASH: "INSUFFICIENT_CASH",
  MAX_POSITIONS: "MAX_POSITIONS", RISK_BUDGET_FULL: "RISK_BUDGET_FULL", STOP_INVALID: "STOP_INVALID",
});

const floorTo = (x, d) => { const f = 10 ** d; return Math.floor(x * f + 1e-9) / f; };
const ceilTo = (x, d) => { const f = 10 ** d; return Math.ceil(x * f - 1e-9) / f; };

/**
 * Sizes one entry. Pure function, exported for tests.
 * @returns {{ qty:number, raised?:boolean } | { reject:string, wanted?:number, needed?:number }}
 */
export function sizeEntry({ scenario, equity, cash, px, stop, openRisk, openCount, fee, min = {}, s = {} }) {
  const minQty = min.minQty ?? 0, minCost = min.minCost ?? 0, lot = min.lotDecimals ?? 8;
  const rpu = px - stop;
  if (!(rpu > 0)) return { reject: REJECT.STOP_INVALID };
  if (openCount >= (s.maxPositions ?? Infinity)) return { reject: REJECT.MAX_POSITIONS };
  const cashQty = (cash / (1 + fee)) / px;
  let want;
  if (scenario === "fixed_fraction") want = (equity * s.fractionPct / 100) / px;
  else want = (equity * s.riskPct / 100) / rpu;
  if (scenario === "risk_budget") {
    want = Math.min(want, (equity * s.maxNotionalPct / 100) / px);
    const room = equity * s.openRiskPct / 100 - openRisk;
    if (room <= 0) return { reject: REJECT.RISK_BUDGET_FULL };
    want = Math.min(want, room / rpu);
  }
  let qty = floorTo(Math.min(want, cashQty), lot);
  const meets = (q) => q >= minQty && q * px >= minCost && q > 0;
  if (meets(qty)) return { qty };
  const needed = ceilTo(Math.max(minQty, minCost / px), lot);
  if (scenario === "risk_budget" && s.allowRaiseToMin) {
    const risk = needed * rpu, okRisk = risk <= equity * s.maxRiskPct / 100 && openRisk + risk <= equity * s.openRiskPct / 100;
    const okCash = needed * px * (1 + fee) <= cash, okNotional = needed * px <= equity * s.maxNotionalPct / 100;
    if (okRisk && okCash && okNotional && meets(needed)) return { qty: needed, raised: true };
  }
  if (Math.min(want, cashQty) < needed && want >= needed) return { reject: REJECT.INSUFFICIENT_CASH, wanted: want, needed };
  return { reject: qty < minQty || qty === 0 ? REJECT.BELOW_MIN_QTY : REJECT.BELOW_MIN_COST, wanted: want, needed };
}

/**
 * @param series   { [market]: bars[] }  bars = [{ t, o, h, l, c }] ascending, same timeframe.
 * @param make     (bars, market) => (i, pos) => null | { enter: { stop } } | { exit: true } | { stop: newStop }
 * @param opts     { capital, feePct, slipPct, scenario, sizing, minimums: { [market]: { minQty, minCost, lotDecimals } },
 *                   from, to, priority?: (market, t) => number (higher first) }
 */
export function backtestPortfolio(series, make, opts = {}) {
  const { capital = 100, feePct = 0.2, slipPct = 0.05, scenario = "risk", sizing = { riskPct: 2 }, minimums = {}, from = -Infinity, to = Infinity, priority = null } = opts;
  const fee = feePct / 100, slip = slipPct / 100;
  const markets = Object.keys(series).sort();
  const decide = {}, idx = {}, byT = {};
  for (const m of markets) { decide[m] = make(series[m], m); idx[m] = new Map(series[m].map((b, i) => [b.t, i])); }
  const times = [...new Set(markets.flatMap((m) => series[m].map((b) => b.t)))].sort((a, b) => a - b);
  let cash = capital;
  const pos = {}, pending = {}, lastClose = {}, attempting = {}; // attempting[m]: the previous decision on m was also an entry

  const trades = [], rejections = [], signals = [], curve = [];
  let peak = capital, maxDD = 0, exposedBars = 0, counted = 0;
  const equityNow = () => cash + Object.entries(pos).reduce((a, [m, p]) => a + p.qty * (lastClose[m] ?? p.entryPrice), 0);
  const openRiskNow = () => Object.entries(pos).reduce((a, [m, p]) => a + Math.max(0, ((lastClose[m] ?? p.entryPrice) - p.stop) * p.qty), 0);
  const closePos = (m, t, i, px, kind) => {
    const p = pos[m], exitFee = px * p.qty * fee, gross = (px - p.entryPrice) * p.qty;
    cash += px * p.qty - exitFee;
    trades.push({ market: m, entryT: p.entryT, exitT: t, entry: p.entryPrice, exit: px, qty: p.qty, gross, fees: p.entryFee + exitFee, net: gross - p.entryFee - exitFee, kind, bars: i - p.entryIdx, raised: !!p.raised });
    delete pos[m];
  };
  for (const t of times) {
    const inWindow = t >= from && t < to;
    const here = markets.filter((m) => idx[m].has(t));
    // 1. pending exits at this bar's open
    for (const m of here) if (pending[m]?.kind === "EXIT" && pos[m]) { const b = series[m][idx[m].get(t)]; closePos(m, t, idx[m].get(t), b.o * (1 - slip), "signal"); delete pending[m]; }
    // 2. pending entries at this bar's open (deterministic order)
    const entering = here.filter((m) => pending[m]?.kind === "ENTER");
    entering.sort((a, b) => (priority ? priority(b, pending[b].t) - priority(a, pending[a].t) : 0) || (a < b ? -1 : 1));
    for (const m of entering) {
      const pd = pending[m]; delete pending[m];
      if (pos[m] || !inWindow) continue;
      const b = series[m][idx[m].get(t)], px = b.o * (1 + slip);
      const sig = { market: m, decidedT: pd.t, fillT: t, px, stop: pd.stop, newSetup: pd.newSetup };
      const r = sizeEntry({ scenario, equity: equityNow(), cash, px, stop: pd.stop, openRisk: openRiskNow(), openCount: Object.keys(pos).length, fee, min: minimums[m], s: sizing });
      signals.push({ ...sig, outcome: r.reject ?? (r.raised ? "FILLED_RAISED_TO_MIN" : "FILLED") });
      if (r.reject) { rejections.push({ ...sig, reason: r.reject, wanted_qty: r.wanted ?? null, needed_qty: r.needed ?? null }); continue; }
      const entryFee = px * r.qty * fee;
      cash -= px * r.qty + entryFee;
      pos[m] = { entryT: t, entryIdx: idx[m].get(t), entryPrice: px, qty: r.qty, stop: pd.stop, entryFee, raised: !!r.raised };
    }
    // 3. resting stops (the entry bar is exposed from its open)
    for (const m of here) {
      const p = pos[m]; if (!p) continue;
      const b = series[m][idx[m].get(t)];
      if (b.l <= p.stop) closePos(m, t, idx[m].get(t), Math.min(p.stop, b.o) * (1 - slip), "stop");
    }
    // 4. mark to market
    for (const m of here) lastClose[m] = series[m][idx[m].get(t)].c;
    const eq = equityNow();
    if (inWindow) { peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak : 0); curve.push({ t, eq }); counted++; if (Object.keys(pos).length) exposedBars++; }
    // 5. decisions at this close (bars 0..i of each market only)
    for (const m of here) {
      const i = idx[m].get(t), p = pos[m];
      const view = p ? { side: "LONG", entryIdx: p.entryIdx, entryPrice: p.entryPrice, qty: p.qty, stop: p.stop, bars: i - p.entryIdx } : null;
      const d = decide[m](i, view);
      if (d?.exit && p) pending[m] = { kind: "EXIT", t };
      else if (d?.stop !== undefined && p) { if (d.stop > p.stop) p.stop = d.stop; }
      else if (d?.enter && !p && inWindow && i + 1 < series[m].length) pending[m] = { kind: "ENTER", stop: d.enter.stop, t, newSetup: !attempting[m] };
      attempting[m] = !!(d?.enter && !p);
    }
  }
  // open positions at the end close at their last close (paying exit fee and slippage)
  for (const m of Object.keys(pos)) { const b = series[m].at(-1); closePos(m, b.t, series[m].length - 1, b.c * (1 - slip), "end"); }
  return { trades, rejections, signals, curve, final: cash, maxDD, exposure: counted ? exposedBars / counted : 0, capital };
}

/** Scenario A: each market in its own isolated wallet (production per-bot model), risk sizing, one position. */
export function isolatedSleeves(series, make, { sleeveCapital = 20, riskPct = 2, ...opts } = {}) {
  const out = {};
  for (const m of Object.keys(series).sort()) out[m] = backtestPortfolio({ [m]: series[m] }, make, { ...opts, capital: sleeveCapital, scenario: "risk", sizing: { riskPct, maxPositions: 1 } });
  return out;
}

const sum = (x) => x.reduce((a, b) => a + b, 0);

/** Calendar-month returns (UTC) from an equity curve: [{ month: "YYYY-MM", ret }]. */
export function monthlyReturns(curve) {
  const last = new Map();
  for (const { t, eq } of curve) { const d = new Date(t); last.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, eq); }
  const out = []; let prev = curve[0]?.eq;
  for (const [month, eq] of last) { out.push({ month, ret: prev > 0 ? eq / prev - 1 : 0 }); prev = eq; }
  return out;
}

/** Moving-block bootstrap CI of the mean of xs (deterministic seed). Keeps short-range serial dependence. */
export function blockBootstrap(xs, { level = 0.995, block = 3, B = 4000, seed = 23 } = {}) {
  const n = xs.length; if (n < 2 * block) return null;
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ms = [];
  for (let b = 0; b < B; b++) { let tot = 0, k = 0; while (k < n) { const st = Math.floor(rnd() * (n - block + 1)); for (let j = 0; j < block && k < n; j++, k++) tot += xs[st + j]; } ms.push(tot / n); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(((1 - level) / 2) * B)], ms[Math.ceil((1 - (1 - level) / 2) * B) - 1]];
}

/** Distinct setups: a new setup starts at an attempt flagged newSetup; it is executed if any of its attempts filled. */
export function setupStats(signals) {
  const cur = {}; let setups = 0, executedSetups = 0;
  for (const s of signals) {
    if (s.newSetup !== false || !cur[s.market]) { setups++; cur[s.market] = { filled: false }; }
    if (s.outcome.startsWith("FILLED") && !cur[s.market].filled) { cur[s.market].filled = true; executedSetups++; }
  }
  return { setups, executed_setups: executedSetups, executable_pct: setups ? (100 * executedSetups) / setups : null };
}

/** Summary of a portfolio run: gross / fees / net separately, drawdown, concentration, feasibility. */
export function summarizePortfolio(r) {
  const nets = r.trades.map((t) => t.net), byMarket = {};
  for (const t of r.trades) byMarket[t.market] = (byMarket[t.market] ?? 0) + t.net;
  const net = r.final - r.capital, pos = Object.values(byMarket).filter((v) => v > 0);
  const reasons = {}; for (const x of r.rejections) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  const years = {}; for (const t of r.trades) { const y = new Date(t.exitT).getUTCFullYear(); years[y] = (years[y] ?? 0) + t.net; }
  return {
    trades: r.trades.length, gross: sum(r.trades.map((t) => t.gross)), fees: sum(r.trades.map((t) => t.fees)), net, ret_pct: (net / r.capital) * 100,
    win: nets.length ? nets.filter((v) => v > 0).length / nets.length : null, avg_trade: nets.length ? sum(nets) / nets.length : null,
    max_dd_pct: r.maxDD * 100, exposure: r.exposure,
    // attempts: every entry decision (a rejected setup is re-attempted while its condition holds); setups: distinct
    // setups (consecutive attempts on one market count once). A setup is executed when any of its attempts filled.
    signals: r.signals.length, executed: r.signals.filter((s) => s.outcome.startsWith("FILLED")).length, raised_to_min: r.signals.filter((s) => s.outcome === "FILLED_RAISED_TO_MIN").length,
    ...setupStats(r.signals),
    rejections: reasons, by_market: byMarket, by_year: years,
    largest_market_share_of_net: net > 0 && pos.length ? Math.max(...pos) / sum(pos) : null,
  };
}

/** Minimum wallet equity at which ONE trade can meet the exchange minimum: minNotional x stopDistance / risk. */
export const minEquityForTrade = ({ minNotional, stopPct, riskPct }) => (minNotional * stopPct) / riskPct;
