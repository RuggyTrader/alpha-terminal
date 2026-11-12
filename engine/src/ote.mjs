// OTE + PD Array strategy: a port of tradingview/ote_pd_array_strategy.pine (the version with break-even and
// trailing stop). Same inputs, same order of operations, evaluated once per COMPLETED bar like Pine's default
// (no calc on every tick, no lookahead: a bar's script run only sees that bar and older ones).
// Every section is commented with the Pine section it mirrors. Display-only inputs are kept for parity but have
// no effect here. All state is plain data so it can be saved and resumed exactly.

import { atrStep, highest, lowest, newAtr, pivot, roundToTick, zonedParts } from "./indicators.mjs";
import { cancelAll, closeAll, newBroker, placeEntry, placeExit, processBar } from "./broker.mjs";
import { DEFAULT_SIZING, sizeOrder } from "./sizing.mjs";

export const DEFAULT_INPUTS = Object.freeze({
  // Structure
  swingLen: 8, minLegATR: 2.5, maxAge: 120,
  // Trade plan
  entryMode: "Limit @ 0.705", slMode: "Swing origin (1.0)", slBuf: 0.2, tp2Ext: -0.27,
  // PD array confluence
  minScore: 1, useFVG: true, useOB: true, useRB: true, fvgMinATR: 0.1, dispATR: 1.0, rbWick: 0.5, rbMinATR: 0.8, rbLook: 8,
  // Display (no effect on trading)
  showPD: true, maxZones: 30, showTable: true, showStop: true,
  // Auto trading
  allowLong: true, allowShort: true, riskUSD: 200.0, useBE: true, beFrac: 0.2,
  // Trailing stop
  useTrail: true, trailFrac: 0.5, trailLen: 3, trailBuf: 0.1,
  // Trading hours
  useHours: true, hoursTz: "America/New_York", flatHour: 16, flatMinute: 45, startHour: 18, startMinute: 0, weekendFlat: true,
  // Sleep window
  useSleep: true, sleepStartHour: 23, sleepStartMinute: 0, sleepEndHour: 8, sleepEndMinute: 0, sleepFlat: true,
  // Notifications (no effect on trading)
  notifyPlace: true, notifyBE: true, notifyTrail: true,
  // Research filter (NOT in the Pine script; 0 = off, the default): only take longs above (shorts below) an
  // exponential moving average of this many bars.
  trendEma: 0,
});

/** Symbol properties the Pine script reads from syminfo / request.currency_rate. */
export const SYMBOLS = Object.freeze({
  SOLUSD: { mintick: 0.01, pointValue: 1, usdRate: 1, type: "crypto" },
  BTCUSD: { mintick: 0.1, pointValue: 1, usdRate: 1, type: "crypto" },
  ETHUSD: { mintick: 0.01, pointValue: 1, usdRate: 1, type: "crypto" },
  HYPEUSD: { mintick: 0.001, pointValue: 1, usdRate: 1, type: "crypto" },
  KAITOUSD: { mintick: 0.0001, pointValue: 1, usdRate: 1, type: "crypto" },
});

const HIST = 64; // bars of OHLC kept (largest lookback: pivots 2 × 8 + 1)

export function createState({ symbol = "SOLUSD", timeframeMin = 5, inputs = {}, pivotTies, fill, sizing } = {}) {
  const sym = SYMBOLS[symbol];
  if (!sym) throw new Error(`no symbol properties for ${symbol}`);
  return {
    symbol, timeframeMin, inputs: { ...DEFAULT_INPUTS, ...inputs }, sym,
    // TradingView's ta.pivothigh/ta.pivotlow accept a tie with an OLDER bar but not with a newer one. Verified against
    // the user's TradingView report (KRAKEN:SOLUSD 5m, solusd-5m): with strict/strict only 3 of 5 listed trades matched;
    // with loose/strict all 5 match and the whole summary (trades, wins, profit factor, drawdown) does. engine/parity/.
    pivotTies: pivotTies ?? { left: "loose", right: "strict" },
    bar: -1, lastTime: null, o: [], h: [], l: [], c: [], atr: newAtr(),
    zones: [], dir: 0, legStart: null, legEnd: null, legStartBar: null, legEndBar: null,
    lastHigh: null, lastLow: null, lastHighBar: null, lastLowBar: null, armed: false, triggered: false, trigBar: null,
    entryP: null, slP: null, tp2P: null, beLevel: null, beDone: false, trailLevel: null, trailOn: false, trailMoved: false,
    curStop: null, orderLive: false, lastLimit: null, tradeScore: 0, tradeTags: "",
    nTrades: 0, nTP2: 0, nBE: 0, nTrail: 0, sumRR: 0, tradeRR: null, forced: false, lastClosed: 0,
    planSL: null, planTP2: null, planScore: 0, planTags: "", tSwingLow: null, tSwingHigh: null,
    broker: { ...newBroker(), pointValue: sym.pointValue, ...(fill ? { opts: fill } : {}) },
    status: "", plan: null,
    // Position sizing (sizing.mjs). capital: available PAPER balance of the strategy, set by the runner (live, from the
    // ledger) or the backtest; only percent mode reads it. lastSizing: the latest sizing decision, for the dashboard.
    // sizing.symbol: the market whose instrument rules size its orders (src/instruments.mjs)
    sizing: { ...DEFAULT_SIZING, symbol, ...(sizing ?? {}) }, capital: null, lastSizing: null, lastSkipKey: null,
  };
}

const lt = (a, b) => a !== null && b !== null && a < b;
const gt = (a, b) => a !== null && b !== null && a > b;
const ge = (a, b) => a !== null && b !== null && a >= b;
const le = (a, b) => a !== null && b !== null && a <= b;
const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };
const ago = (arr, n) => (arr.length > n ? arr[arr.length - 1 - n] : null);

/**
 * Runs one completed bar {t (open time, ms), o, h, l, c}. Returns the events of this bar:
 * broker fills first (they happen during the bar), then the strategy's decisions at its close.
 */
export function onBar(S, bar) {
  if (S.lastTime !== null && bar.t <= S.lastTime) throw new Error(`bar ${new Date(bar.t).toISOString()} is not after the last processed bar`);
  const I = S.inputs;
  const { mintick, pointValue, usdRate } = S.sym;
  S.bar += 1;
  S.lastTime = bar.t;
  const b = S.bar;
  const B = { ...bar, i: b };
  const { o, h, l, c } = bar;

  // ---- broker emulator: orders placed at the previous close are worked through this bar
  const events = processBar(S.broker, B).map((e) => ({ ...e, bar: b }));

  push(S.o, o); push(S.h, h); push(S.l, l); push(S.c, c);

  // ---- BASE CALCULATIONS
  const atr = atrStep(S.atr, h, l, 14);
  S.atr.prevClose = c;
  if (I.trendEma > 0) {
    const a = 2 / (I.trendEma + 1);
    S.trendEma = S.trendEma === undefined || S.trendEma === null ? c : S.trendEma + a * (c - S.trendEma);
    S.trendBars = (S.trendBars ?? 0) + 1;
  }
  const ph = pivot(S.h, I.swingLen, "high", S.pivotTies);
  const pl = pivot(S.l, I.swingLen, "low", S.pivotTies);
  const lowestL = lowest(S.l, I.rbLook);
  const highestH = highest(S.h, I.rbLook);
  const h1 = ago(S.h, 1), l1 = ago(S.l, 1), o1 = ago(S.o, 1), c1 = ago(S.c, 1), h2 = ago(S.h, 2), l2 = ago(S.l, 2);
  const tPL = pivot(S.l, I.trailLen, "low", S.pivotTies);
  const tPH = pivot(S.h, I.trailLen, "high", S.pivotTies);
  if (tPL !== null) S.tSwingLow = tPL;
  if (tPH !== null) S.tSwingHigh = tPH;

  // Trading hours (bar CLOSE time) and sleep window
  const tz = zonedParts(bar.t + S.timeframeMin * 60_000, I.hoursTz);
  const cm = tz.hour * 60 + tz.minute;
  const flatTotal = I.flatHour * 60 + I.flatMinute;
  const startTotal = I.startHour * 60 + I.startMinute;
  const dailyBreak = cm >= flatTotal && cm < startTotal;
  const weekendBlock = tz.dow === 7 || (tz.dow === 6 && cm >= flatTotal) || (tz.dow === 1 && cm < startTotal);
  const hoursBlocked = I.useHours && (dailyBreak || (I.weekendFlat && weekendBlock));
  const sleepStartTotal = I.sleepStartHour * 60 + I.sleepStartMinute;
  const sleepEndTotal = I.sleepEndHour * 60 + I.sleepEndMinute;
  const inSleep = sleepStartTotal > sleepEndTotal ? (cm >= sleepStartTotal || cm < sleepEndTotal) : (cm >= sleepStartTotal && cm < sleepEndTotal);
  const sleepBlocked = I.useSleep && inSleep;
  const blocked = hoursBlocked || sleepBlocked;
  const canTrade = !blocked;

  // ---- PD ARRAYS: mitigate old ones, detect new ones
  for (let i = S.zones.length - 1; i >= 0; i--) {
    const z = S.zones[i];
    if (z.side === 1 ? c < z.bot : c > z.top) S.zones.splice(i, 1);
  }
  const body = Math.abs(c - o), rng = h - l, loW = Math.min(o, c) - l, upW = h - Math.max(o, c);
  const A = (k) => (atr === null ? null : atr * k);
  const bullFVG = I.useFVG && gt(l, h2) && ge(h2 === null ? null : l - h2, A(I.fvgMinATR));
  const bearFVG = I.useFVG && lt(h, l2) && ge(l2 === null ? null : l2 - h, A(I.fvgMinATR));
  const bullOB = I.useOB && c > o && ge(body, A(I.dispATR)) && gt(c, h1) && lt(c1, o1);
  const bearOB = I.useOB && c < o && ge(body, A(I.dispATR)) && lt(c, l1) && gt(c1, o1);
  const bullRB = I.useRB && ge(rng, A(I.rbMinATR)) && loW >= rng * I.rbWick && le(l, lowestL);
  const bearRB = I.useRB && ge(rng, A(I.rbMinATR)) && upW >= rng * I.rbWick && ge(h, highestH);
  const addZone = (top, bot, kind, side) => {
    S.zones.push({ top, bot, idx: b, kind, side });
    if (S.zones.length > I.maxZones) S.zones.shift();
  };
  if (bullFVG) addZone(l, h2, 1, 1);
  if (bearFVG) addZone(l2, h, 1, -1);
  if (bullOB) addZone(h1, l1, 2, 1);
  if (bearOB) addZone(h1, l1, 2, -1);
  if (bullRB) addZone(Math.min(o, c), l, 3, 1);
  if (bearRB) addZone(h, Math.max(o, c), 3, -1);

  // ---- POSITION SYNC: detect fills and closed trades from the strategy
  const br = S.broker;
  const closedNow = br.closed.length;
  const justClosed = closedNow > S.lastClosed;
  S.lastClosed = closedNow;
  const inPos = br.pos !== null;

  if (inPos && !S.triggered && S.dir !== 0) {
    S.triggered = true;
    S.trigBar = b;
    S.entryP = br.pos.avg;
    S.slP = S.planSL;
    S.tp2P = S.planTP2;
    S.curStop = S.planSL;
    S.beDone = false;
    S.beLevel = S.entryP + (S.tp2P - S.entryP) * I.beFrac;
    S.trailLevel = S.entryP + (S.tp2P - S.entryP) * I.trailFrac;
    S.trailOn = false;
    S.trailMoved = false;
    S.tradeScore = S.planScore;
    S.tradeTags = S.planTags;
    S.tradeRR = Math.abs(S.tp2P - S.entryP) / Math.abs(S.entryP - S.slP);
    events.push({ type: "IN_TRADE", side: S.dir, entry: S.entryP, stop: S.slP, tp2: S.tp2P, score: S.tradeScore, tags: S.tradeTags.trim(), bar: b });
  }

  if (!inPos && S.triggered) {
    const last = br.closed[br.closed.length - 1];
    const exitPx = last.exitPrice;
    const tol = mintick * 2;
    const wonTP2 = !S.forced && (S.dir === 1 ? exitPx >= S.tp2P - tol : exitPx <= S.tp2P + tol);
    const trailExit = S.trailMoved && !S.forced && !wonTP2;
    const atBE = S.beDone && !S.forced && !wonTP2 && !trailExit && Math.abs(exitPx - S.entryP) <= tol;
    const exitR = (S.dir === 1 ? exitPx - S.entryP : S.entryP - exitPx) / Math.abs(S.entryP - S.slP);
    const result = S.forced ? "TIME_EXIT" : wonTP2 ? "TP2" : trailExit ? "TRAILING_SL" : atBE ? "BREAK_EVEN" : "SL";
    S.nTrades += 1;
    S.sumRR += S.tradeRR;
    if (wonTP2) S.nTP2 += 1;
    if (atBE) S.nBE += 1;
    if (trailExit) S.nTrail += 1;
    last.result = result;
    last.exitR = exitR;
    events.push({ type: "TRADE_FINISHED", result, exitR, pnl: last.pnl, bar: b });
    cancelAll(br);
    S.forced = false;
    S.triggered = false;
    S.trailOn = false;
    S.dir = 0;
  } else if (!inPos && justClosed && S.dir !== 0 && !S.triggered) {
    // entered and closed inside a single bar
    const last = br.closed[br.closed.length - 1];
    last.result = "SAME_BAR";
    cancelAll(br);
    S.forced = false;
    S.dir = 0;
    events.push({ type: "TRADE_FINISHED", result: "SAME_BAR", pnl: last.pnl, bar: b });
  }

  // ---- MARKET STRUCTURE: find the leg to draw the OTE on
  let legChanged = false;
  if (ph !== null) {
    S.lastHigh = ph;
    S.lastHighBar = b - I.swingLen;
    if (S.dir === 0 && S.lastLow !== null && lt(S.lastLowBar, S.lastHighBar) && ge(S.lastHigh - S.lastLow, A(I.minLegATR))) {
      Object.assign(S, { dir: 1, legStart: S.lastLow, legStartBar: S.lastLowBar, legEnd: S.lastHigh, legEndBar: S.lastHighBar, triggered: false });
      legChanged = true;
    } else if (S.dir === 1 && !S.triggered && ph > S.legEnd) {
      S.legEnd = ph;
      S.legEndBar = b - I.swingLen;
      legChanged = true;
    }
  }
  if (pl !== null) {
    S.lastLow = pl;
    S.lastLowBar = b - I.swingLen;
    if (S.dir === 0 && S.lastHigh !== null && lt(S.lastHighBar, S.lastLowBar) && ge(S.lastHigh - S.lastLow, A(I.minLegATR))) {
      Object.assign(S, { dir: -1, legStart: S.lastHigh, legStartBar: S.lastHighBar, legEnd: S.lastLow, legEndBar: S.lastLowBar, triggered: false });
      legChanged = true;
    } else if (S.dir === -1 && !S.triggered && pl < S.legEnd) {
      S.legEnd = pl;
      S.legEndBar = b - I.swingLen;
      legChanged = true;
    }
  }
  if (legChanged) {
    S.armed = false;
    events.push({ type: "SETUP", side: S.dir, legStart: S.legStart, legEnd: S.legEnd, bar: b });
  }

  // Cancel setups that broke the swing origin or got stale
  if (S.dir !== 0 && !S.triggered) {
    const broken = S.dir === 1 ? l < S.legStart : h > S.legStart;
    const expired = b - S.legEndBar > I.maxAge;
    if (broken || expired) {
      cancelAll(br);
      events.push({ type: "SETUP_CANCELLED", reason: broken ? "broken" : "expired", bar: b });
      S.dir = 0;
      legChanged = false;
    }
  }

  // ---- TRADE PLAN + ORDER PLACEMENT (while waiting for entry)
  const lvl = (r) => S.legEnd + (S.legStart - S.legEnd) * r;
  let plan = null;
  if (S.dir !== 0 && !S.triggered) {
    const l618 = lvl(0.618), l705 = lvl(0.705), l786 = lvl(0.786);
    const zHi = Math.max(l618, l786), zLo = Math.min(l618, l786);
    let f = false, ob = false, r = false;
    for (const z of S.zones) {
      if (z.side === S.dir && z.idx >= S.legStartBar && z.bot <= zHi && z.top >= zLo) {
        if (z.kind === 1) f = true; else if (z.kind === 2) ob = true; else r = true;
      }
    }
    const sc = (f ? 1 : 0) + (ob ? 1 : 0) + (r ? 1 : 0);
    const tags = (f ? "FVG " : "") + (ob ? "OB " : "") + (r ? "RB" : "");
    const slBase = I.slMode === "Swing origin (1.0)" ? S.legStart : l786;
    const slPlan = atr === null ? null : (S.dir === 1 ? slBase - atr * I.slBuf : slBase + atr * I.slBuf);
    const tp2v = lvl(I.tp2Ext);
    S.planSL = slPlan; S.planTP2 = tp2v; S.planScore = sc; S.planTags = tags;
    const limitMode = I.entryMode === "Limit @ 0.705";
    const armedNow = S.armed || (S.dir === 1 ? l > l618 : h < l618);
    const touched = S.dir === 1 ? l <= l618 : h >= l618;
    const holds = S.dir === 1 ? c >= l786 : c <= l786;
    const candleOk = S.dir === 1 ? c > o : c < o;
    const priceSide = S.dir === 1 ? c > l705 : c < l705;
    const ep = limitMode ? l705 : c;
    const timing = limitMode ? (armedNow && priceSide) : (S.armed && touched && holds && candleOk);
    const valid = slPlan !== null && (S.dir === 1 ? (tp2v > ep && ep > slPlan) : (tp2v < ep && ep < slPlan));
    const trendOk = !(I.trendEma > 0) || ((S.trendBars ?? 0) >= I.trendEma && (S.dir === 1 ? c > S.trendEma : c < S.trendEma));
    const dirOk = (S.dir === 1 ? I.allowLong : I.allowShort) && trendOk;
    const place = timing && valid && dirOk && sc >= I.minScore && canTrade;
    S.armed = armedNow;
    plan = { entry: l705, sl: slPlan, tp2: tp2v, score: sc, tags: tags.trim() };
    const eid = S.dir === 1 ? "OTE Long" : "OTE Short";
    // Sizing: fixed mode keeps the Pine formula exactly; percent and dollar modes size from the PAPER balance (sizing.mjs).
    const sz = place
      ? (S.sizing?.mode === "percent" || S.sizing?.mode === "dollar"
        ? sizeOrder({ sizing: S.sizing, capital: S.capital, entry: ep, stop: slPlan, side: S.dir, maxNotional: S.maxNotional ?? null })
        : { ok: true, mode: "fixed", qty: (I.riskUSD * usdRate) / (Math.abs(ep - slPlan) * pointValue), riskTarget: I.riskUSD, riskActual: I.riskUSD, entry: ep, stop: slPlan, side: S.dir, capped: false })
      : null;
    if (sz) S.lastSizing = { ...sz, bar: b };
    if (place && !sz.ok) {
      // Skipped safely: no order, the reason is kept (once per distinct reason and level, not every bar).
      cancelAll(br);
      const key = `${sz.code}|${roundToTick(l705, mintick)}`;
      if (key !== S.lastSkipKey) events.push({ type: "ORDER_SKIPPED", side: S.dir, code: sz.code, reason: sz.reason, limit: roundToTick(l705, mintick), stop: roundToTick(slPlan, mintick), qty: sz.qty ?? null, capital: S.capital, bar: b });
      S.lastSkipKey = key;
      S.orderLive = false;
    } else if (place) {
      S.lastSkipKey = null;
      const qty = sz.qty;
      if (qty > 0) {
        placeEntry(br, { id: eid, side: S.dir, qty, limit: limitMode ? roundToTick(l705, mintick) : null });
        placeExit(br, { from: eid, limit: roundToTick(tp2v, mintick), stop: roundToTick(slPlan, mintick) });
        const newOrder = !S.orderLive || (limitMode && Math.abs(l705 - S.lastLimit) >= mintick);
        if (newOrder) {
          events.push({ type: "ORDER_PLACED", side: S.dir, qty, limit: limitMode ? roundToTick(l705, mintick) : null, stop: roundToTick(slPlan, mintick), tp2: roundToTick(tp2v, mintick), score: sc, bar: b });
        }
        S.orderLive = true;
        S.lastLimit = l705;
      }
    } else {
      cancelAll(br);
      S.lastSkipKey = null;
    }
  }
  if (!(S.dir !== 0 && !S.triggered)) { S.orderLive = false; S.lastSkipKey = null; }

  // ---- TRADE MANAGEMENT (break-even, trailing stop)
  if (S.triggered && inPos && b > S.trigBar) {
    const eidT = S.dir === 1 ? "OTE Long" : "OTE Short";
    let newStop = S.curStop;
    let beNow = false, trailNow = false;
    if (I.useBE && !S.beDone && (S.dir === 1 ? h >= S.beLevel : l <= S.beLevel)) {
      S.beDone = true;
      if (S.dir === 1 ? S.entryP > newStop : S.entryP < newStop) {
        newStop = S.entryP;
        beNow = true;
      }
    }
    if (I.useTrail && !S.trailOn && (S.dir === 1 ? h >= S.trailLevel : l <= S.trailLevel)) {
      S.trailOn = true;
      events.push({ type: "TRAILING_ON", level: S.trailLevel, bar: b });
    }
    if (S.trailOn) {
      const swing = S.dir === 1 ? S.tSwingLow : S.tSwingHigh;
      const cand = swing === null || atr === null ? null : (S.dir === 1 ? swing - atr * I.trailBuf : swing + atr * I.trailBuf);
      const better = cand !== null && (S.dir === 1 ? (cand > newStop && cand < c) : (cand < newStop && cand > c));
      if (better) {
        newStop = cand;
        trailNow = true;
      }
    }
    newStop = roundToTick(newStop, mintick);
    if (newStop !== S.curStop) {
      S.curStop = newStop;
      if (trailNow) S.trailMoved = true;
      placeExit(br, { from: eidT, limit: roundToTick(S.tp2P, mintick), stop: S.curStop });
      if (beNow && !trailNow) events.push({ type: "STOP_TO_BREAK_EVEN", stop: S.curStop, bar: b });
      if (trailNow) events.push({ type: "TRAILING_STOP_MOVED", stop: S.curStop, bar: b });
    }
  }

  // ---- TIME EXIT: flatten + cancel orders outside trading hours / sleep window
  const flattenNow = hoursBlocked || (sleepBlocked && I.sleepFlat);
  if (blocked) {
    if (inPos && flattenNow) {
      S.forced = true;
      cancelAll(br);
      const fills = [];
      closeAll(br, B, fills);
      for (const e of fills) events.push({ ...e, bar: b });
    } else if (!inPos) {
      cancelAll(br);
    }
  }

  // Info-table status line, as in the Pine table
  const active = S.dir !== 0;
  S.status = blocked && !S.triggered ? (sleepBlocked && !hoursBlocked ? "Sleep window (no trading)" : "Outside trading hours")
    : !active ? "Waiting for a swing"
    : S.triggered ? (S.trailOn ? "IN TRADE (trailing SL)" : S.beDone ? "IN TRADE (SL at BE)" : "IN TRADE")
    : S.orderLive ? "ORDER PLACED - waiting fill"
    : S.lastSkipKey ? `ORDER SKIPPED - ${S.lastSkipKey.split("|")[0]}`
    : (plan && plan.score < I.minScore ? "Need more confluence" : "Waiting for OTE tap");
  S.plan = plan;
  return events;
}

/**
 * Drops the open position without an exit fill, because the ALPHA PAPER ledger refused (or never received) its
 * entry. The position never existed in the portfolio, so it gets no exit, no closed trade and no P&L; the strategy
 * goes back to waiting for a new swing, exactly as after a finished trade. Entry and exit rules are unchanged.
 * Returns the dropped position, or null when there was none.
 */
export function abandonPosition(S) {
  const br = S.broker;
  if (!br.pos) return null;
  const p = br.pos;
  br.pos = null;
  cancelAll(br);
  S.triggered = false;
  S.trailOn = false;
  S.trailMoved = false;
  S.beDone = false;
  S.forced = false;
  S.orderLive = false;
  S.dir = 0;
  S.status = "Waiting for a swing";
  return p;
}

/** Summary of closed trades from the broker emulator (measured, not estimated). */
export function summarize(S) {
  const t = S.broker.closed;
  const by = (r) => t.filter((x) => x.result === r).length;
  const wins = t.filter((x) => x.pnl > 0).length;
  return {
    trades: t.length, wins, losses: t.filter((x) => x.pnl < 0).length,
    netProfit: Number(S.broker.netProfit.toFixed(2)),
    tp2: by("TP2"), stopLoss: by("SL"), breakEven: by("BREAK_EVEN"), trailing: by("TRAILING_SL"), timeExit: by("TIME_EXIT"), sameBar: by("SAME_BAR"),
    open: S.broker.pos ? { side: S.broker.pos.side, qty: S.broker.pos.qty, entry: S.broker.pos.avg } : null,
  };
}
