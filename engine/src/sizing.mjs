// The shared position-sizing engine for every FUNDED PAPER strategy and market (docs/UNIVERSAL-POSITION-SIZING.md).
// Pure functions; no I/O. Every funded order quantity comes from sizePosition(); nothing else may compute one
// (enforced by engine/test/sizing-acceptance.test.mjs).
//
// Policy (funded default, "percent"):
//   risk target   = min(available equity × riskPct, maxRiskUSD)        1% of equity, at most $10 by default
//   risk qty      = risk target ÷ (|entry − stop| × multiplier)
//   spend limit   = min(available equity, order-value limit, position-exposure room, total-exposure room)   fully paid
//   cash qty      = spend limit ÷ (entry × multiplier × (1 + price buffer) × (1 + fee))
//   quantity      = min(risk qty, cash qty), rounded DOWN to the instrument's quantity step
// The quantity is never raised to reach the risk target or a venue minimum: a setup that cannot be taken within the
// rules is skipped with an exact, documented code and reason. No leverage, borrowing, shorts or fabricated capital.
//
// "dollar" (fleet bots, docs/MULTI-BOT-ARCHITECTURE.md §5): the owner's dollar risk per trade, NOT a % of equity:
//   risk target   = the bot's riskUSD
//   quantity      = min(riskUSD ÷ (|entry − stop| × multiplier), spend limit ÷ cash per unit), rounded DOWN
//   cash per unit = entry × multiplier × (1 + price buffer) × (1 + fee); a LONG pays it, a simulated SHORT posts it as
//                   collateral (fully collateralised, no leverage), so both directions use the same affordability rule.
// The quantity is never raised to reach the dollar risk or a minimum; the actual stop risk may be far below the target.
//
// "fixed" is the original Pine formula (risk in USD ÷ stop distance). It is what the Strategy Mirror and TradingView
// parity use; funded engines use it only with an explicit, recorded research reason (config.mjs).

import { getInstrument, specProblems } from "./instruments.mjs";

const SOL = getInstrument("SOLUSD");
/** SOLUSD venue rules, from the instrument registry (kept for older callers). */
export const SOLUSD_RULES = Object.freeze({ minQty: SOL.minQty, minCost: SOL.minNotional, qtyDecimals: SOL.qtyDecimals });

export const DEFAULT_SIZING = Object.freeze({
  // Strategy-level default: the strategy object itself is neutral (mirror, backtests, parity). Funded engines choose
  // "percent" through config.mjs, which is where the funded default lives.
  mode: "fixed",
  riskPct: 1, // % of the available strategy equity risked at the stop (percent mode, legacy ALPHA-02)
  riskUSD: null, // the bot's dollar risk per trade (dollar mode)
  simulatedShort: false, // dollar mode: SHORT setups are sized as fully collateralised simulated shorts
  maxRiskUSD: 10, // the most a funded trade may risk (the website's risk setting when synced); null = no cap
  feePct: 0.4, // assumed fee per side, % of notional (reserved at entry)
  priceBufferPct: 0.5, // headroom for the ledger filling at the live price a moment after the engine's fill
  minStopPct: 0, // optional fee-aware filter (0 = off)
  ...SOLUSD_RULES,
});

/** Plain-language meaning of every outcome; the dashboard and ALPHA Assistant quote these, never invent their own. */
export const OUTCOMES = Object.freeze({
  FULL_RISK: "Sized at the full target risk within your available equity.",
  REDUCED_TO_FIT: "This trade was reduced to fit your available equity and limits; its actual risk is below the target.",
  DOLLAR_RISK: "Sized from this bot's own dollar risk and its own wallet; never another bot's capital.",
  RISK_CAPPED: "The 1% target was above the maximum risk per trade, so the maximum was used.",
  BELOW_MIN_QTY: "This trade cannot be taken: the smallest permitted order is larger than what your equity and risk allow.",
  BELOW_MIN_COST: "This trade cannot be taken: the order value would be below the market's minimum order value.",
  SHORT_NOT_ALLOWED: "Shorts are not available in the ALPHA PAPER account (long only).",
  BALANCE_UNKNOWN: "The available equity could not be read, so no order was sized.",
  NO_CAPITAL: "There is no available PAPER capital for this market.",
  INVALID_STOP: "The setup has no valid stop distance.",
  STOP_TOO_TIGHT: "The stop is so close that trading costs would dominate the risk.",
  STALE_PRICE: "The price used for sizing is too old.",
  EXPOSURE_LIMIT: "An exposure limit leaves no room for another order.",
  MAX_OPEN_POSITIONS: "The maximum number of open positions is reached.",
  NO_INSTRUMENT_SPEC: "This market has no verified trading rules, so it cannot be traded in the funded account.",
  NO_CAPITAL_LEFT: "Another order already reserved the available capital (earlier signal first).",
});

const r2 = (v) => Math.round(v * 100) / 100;
function floorToStep(v, step, decimals) {
  const units = Math.floor(v / step + 1e-9);
  return Number((units * step).toFixed(Math.max(0, decimals ?? 8)));
}
const lim = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Sizes one funded order. Returns { ok: true, qty, outcome, explanation, ... } or { ok: false, code, reason, explanation, ... }.
 *   instrument  registry entry (instruments.mjs); required
 *   capital     available equity of this strategy's wallet (already net of reserved capital), USD
 *   entry, stop, side (1 long, -1 short)
 *   policy      { riskPct, maxRiskUSD, feePct, priceBufferPct, minStopPct, allowShort = false }
 *   limits      { maxOrderNotional, maxPositionExposure, maxTotalExposure, maxOpenPositions } (Worker risk limits)
 *   exposure    { position = 0, total = 0, openPositions = 0 } (this market's open cost, the account's open cost, count)
 *   price       { ageSec, maxAgeSec } (optional freshness of the entry price)
 */
export function sizePosition({ instrument, capital, entry, stop, side, policy = {}, limits = {}, exposure = {}, price = null }) {
  const p = { mode: "percent", riskPct: 1, riskUSD: null, maxRiskUSD: 10, feePct: 0.4, priceBufferPct: 0.5, minStopPct: 0, allowShort: false, simulatedShort: false, ...policy };
  const dollar = p.mode === "dollar";
  const spec = instrument ?? null;
  const unit = spec?.symbol ? spec.symbol.replace(/USD$/, "") : "units";
  const base = { mode: dollar ? "dollar" : "percent", symbol: spec?.symbol ?? null, entry, stop, side, riskPct: dollar ? null : p.riskPct, riskUSD: dollar ? lim(p.riskUSD) : null,
    maxRiskUSD: dollar ? null : lim(p.maxRiskUSD), capital: capital ?? null, direction: side === 1 ? "LONG" : "SHORT",
    collateralModel: side === 1 ? "CASH_PURCHASE" : "FULLY_COLLATERALISED_SHORT",
    minQty: spec?.minQty ?? null, minCost: spec?.minNotional ?? null };
  const no = (code, reason, extra = {}) => ({ ...base, ...extra, ok: false, code, reason, explanation: OUTCOMES[code] });

  const problems = specProblems(spec);
  if (problems.length) return no("NO_INSTRUMENT_SPEC", `no verified instrument specification: ${problems.join("; ")}`);
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || !(entry > 0)) return no("INVALID_STOP", "entry and stop must differ");
  if (side !== 1 && !(p.allowShort && spec.shortable) && !(dollar && p.simulatedShort && spec.paperShort)) return no("SHORT_NOT_ALLOWED", "funded PAPER is long-only: no short selling");
  if (dollar && !(lim(p.riskUSD) !== null)) return no("INVALID_STOP", "dollar mode needs a positive dollar risk per trade");
  if (price && Number.isFinite(price.ageSec) && Number.isFinite(price.maxAgeSec) && price.ageSec > price.maxAgeSec) {
    return no("STALE_PRICE", `entry price is ${Math.round(price.ageSec)} s old (limit ${price.maxAgeSec} s)`);
  }
  if (capital === null || capital === undefined || !Number.isFinite(capital)) return no("BALANCE_UNKNOWN", "the strategy's PAPER balance could not be read; no order without it");
  if (!(capital > 0)) return no("NO_CAPITAL", `no available PAPER capital ($${r2(capital)})`);
  if (p.minStopPct > 0 && (dist / entry) * 100 < p.minStopPct) {
    return no("STOP_TOO_TIGHT", `stop ${r2((dist / entry) * 100)}% from entry is below the ${p.minStopPct}% minimum (costs would dominate the risk)`);
  }
  const ex = { position: 0, total: 0, openPositions: 0, ...exposure };
  const L = { maxOrderNotional: lim(limits.maxOrderNotional), maxPositionExposure: lim(limits.maxPositionExposure), maxTotalExposure: lim(limits.maxTotalExposure), maxOpenPositions: lim(limits.maxOpenPositions) };
  if (L.maxOpenPositions !== null && !(ex.position > 0) && ex.openPositions >= L.maxOpenPositions) {
    return no("MAX_OPEN_POSITIONS", `${ex.openPositions} of ${L.maxOpenPositions} positions are open`);
  }

  // Risk: a percentage of equity, never above the maximum per trade. Never raised to reach anything.
  // dollar: the bot's own dollar risk (no % of equity, no hidden cap); percent (legacy): % of equity, capped.
  const riskUncapped = dollar ? lim(p.riskUSD) : capital * (p.riskPct / 100);
  const maxRisk = dollar ? null : lim(p.maxRiskUSD);
  const riskTarget = maxRisk !== null ? Math.min(riskUncapped, maxRisk) : riskUncapped;
  const riskCapped = maxRisk !== null && riskUncapped > maxRisk;
  // Buying power: fully paid (no leverage), within every Worker limit that applies.
  const caps = [
    ["BALANCE", capital],
    ["ORDER_LIMIT", L.maxOrderNotional],
    ["POSITION_LIMIT", L.maxPositionExposure === null ? null : L.maxPositionExposure - ex.position],
    ["TOTAL_EXPOSURE", L.maxTotalExposure === null ? null : L.maxTotalExposure - ex.total],
  ].filter(([, v]) => v !== null);
  const [bindName, spend] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
  if (!(spend > 0)) return no("EXPOSURE_LIMIT", `no room under the ${bindName === "POSITION_LIMIT" ? "position" : "total"} exposure limit`);
  const perUnit = entry * spec.multiplier * (1 + p.priceBufferPct / 100) * (1 + p.feePct / 100);
  const riskQty = riskTarget / (dist * spec.multiplier);
  const cashQty = spend / perUnit;
  const qty = floorToStep(Math.min(riskQty, cashQty), spec.qtyStep, spec.qtyDecimals);
  const capped = cashQty < riskQty;
  const notional = qty * entry * spec.multiplier;
  const out = {
    ...base, qty,
    riskTarget: r2(riskTarget), riskTargetUncapped: r2(riskUncapped), riskCappedByMax: riskCapped,
    riskActual: r2(qty * dist * spec.multiplier), notional: r2(notional),
    requiredCapital: r2(riskQty * perUnit), // capital the full risk target would need
    spendLimit: r2(spend), capped, cappedBy: capped ? bindName : null,
    feeEstimate: r2(notional * (p.feePct / 100) * 2),
    collateral: r2(qty * perUnit), // cash reserved: the purchase (LONG) or the short's collateral (SHORT), incl. headroom
    minOrderCost: r2(spec.minQty * perUnit),
    checks: { minQty: qty >= spec.minQty, minCost: notional >= spec.minNotional, buyingPower: qty * perUnit <= spend + 1e-9 },
  };
  if (qty < spec.minQty) {
    const why = cashQty < spec.minQty
      ? `${qty} ${unit} is below the minimum order of ${spec.minQty} ${unit} (needs about $${r2(spec.minQty * perUnit)} of PAPER capital; $${r2(spend)} available)`
      : `${qty} ${unit} is below the minimum order of ${spec.minQty} ${unit}: the $${r2(riskTarget)} risk target with a ${r2(dist)} stop allows only ${floorToStep(riskQty, spec.qtyStep, spec.qtyDecimals)} ${unit}, and the size is never raised above the target risk`;
    return { ...out, ok: false, code: "BELOW_MIN_QTY", reason: why, explanation: OUTCOMES.BELOW_MIN_QTY };
  }
  if (notional < spec.minNotional) {
    return { ...out, ok: false, code: "BELOW_MIN_COST", reason: `order value $${r2(notional)} is below the minimum of $${spec.minNotional}`, explanation: OUTCOMES.BELOW_MIN_COST };
  }
  const outcome = capped ? "REDUCED_TO_FIT" : "FULL_RISK";
  return { ...out, ok: true, outcome, explanation: `${OUTCOMES[outcome]}${riskCapped ? ` ${OUTCOMES.RISK_CAPPED}` : ""}${dollar ? ` ${OUTCOMES.DOLLAR_RISK}` : ""}` };
}

/**
 * Deterministic capital allocation when several funded candidates compete for ONE wallet in the same poll.
 * Order: earliest signal candle, then the registry priority, then symbol, then id (information known at signal time
 * only; never outcomes). Each accepted candidate's cost (incl. buffer and fee reserve) is deducted before the next is
 * sized, so the same capital is never promised twice and available capital never goes negative.
 *   candidates: [{ id, symbol, barClose, entry, stop, side, instrument? }]
 */
export function allocateCapital(candidates, { capital, policy = {}, limits = {}, exposure = {} }) {
  const spec = (c) => c.instrument ?? getInstrument(c.symbol);
  const order = [...candidates].sort((a, b) => (Date.parse(a.barClose) - Date.parse(b.barClose))
    || (spec(a)?.priority ?? 99) - (spec(b)?.priority ?? 99)
    || String(a.symbol).localeCompare(String(b.symbol)) || String(a.id).localeCompare(String(b.id)));
  let left = capital;
  const ex = { position: 0, total: 0, openPositions: 0, ...exposure };
  const p = { feePct: 0.4, priceBufferPct: 0.5, ...policy };
  return order.map((c) => {
    const instrument = spec(c);
    if (!(left > 0)) return { id: c.id, symbol: c.symbol, ok: false, code: "NO_CAPITAL_LEFT", reason: "earlier candidates reserved the available capital", explanation: OUTCOMES.NO_CAPITAL_LEFT, capitalAfter: 0 };
    const s = sizePosition({ instrument, capital: left, entry: c.entry, stop: c.stop, side: c.side, policy: p, limits, exposure: { ...ex, position: 0 } });
    if (s.ok) {
      const cost = s.qty * c.entry * instrument.multiplier * (1 + p.priceBufferPct / 100) * (1 + p.feePct / 100);
      left = Math.max(0, left - cost);
      ex.total += s.qty * c.entry * instrument.multiplier;
      ex.openPositions += 1;
    }
    return { id: c.id, ...s, capitalAfter: r2(left) };
  });
}

/**
 * The strategy's sizing call (ote.mjs). fixed: the original Pine formula. percent: the shared engine above, with the
 * instrument, policy, limits and exposure the runner put into `sizing` (SOLUSD rules when none was given).
 */
export function sizeOrder({ sizing = DEFAULT_SIZING, riskUSD, capital, entry, stop, side, maxNotional = null }) {
  const z = { ...DEFAULT_SIZING, ...sizing };
  if (z.mode !== "percent" && z.mode !== "dollar") {
    const dist = Math.abs(entry - stop);
    const base = { mode: z.mode, entry, stop, side, riskPct: null, capital: capital ?? null };
    if (!(dist > 0) || !(entry > 0)) return { ...base, ok: false, code: "INVALID_STOP", reason: "entry and stop must differ" };
    const qty = riskUSD / dist;
    return { ...base, ok: true, qty, riskTarget: riskUSD, riskActual: riskUSD, notional: entry * qty, requiredCapital: entry * qty, capped: false };
  }
  // Never another market's rules: no instrument and no known symbol means NO_INSTRUMENT_SPEC, not SOLUSD's minimums.
  const instrument = z.instrument ?? (z.symbol ? getInstrument(z.symbol) : null);
  return sizePosition({
    instrument, capital, entry, stop, side,
    policy: z.mode === "dollar"
      ? { mode: "dollar", riskUSD: z.riskUSD, feePct: z.feePct, priceBufferPct: z.priceBufferPct, minStopPct: z.minStopPct, simulatedShort: z.simulatedShort === true }
      : { riskPct: z.riskPct, maxRiskUSD: z.maxRiskUSD, feePct: z.feePct, priceBufferPct: z.priceBufferPct, minStopPct: z.minStopPct },
    limits: { ...(z.limits ?? {}), maxOrderNotional: maxNotional ?? z.limits?.maxOrderNotional ?? null },
    exposure: z.exposure ?? {},
  });
}
