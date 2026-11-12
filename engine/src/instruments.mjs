// Instrument registry: the ONE place that describes a market's trading rules for funded PAPER sizing.
// docs/UNIVERSAL-POSITION-SIZING.md is the permanent rule set; the regression gate (engine/test/sizing-acceptance.test.mjs)
// fails when a market is enabled without a verified entry here or bypasses the shared sizing engine (src/sizing.mjs).
//
// Every value is taken from the provider's published specification, with its source and date. Nothing is copied from
// another market: BTCUSD and ETHUSD have their own minimums and ticks, and stocks or futures are not listed at all until
// their rules and a real data feed are verified (they are then unavailable for funded execution, with the reason).
//
// fundedEligible: the market may trade against the ALPHA PAPER ledger. It needs verified specs AND the owner's approval;
// a market can be fully specified and still not eligible (BTCUSD, ETHUSD: Strategy Mirror only, funded not approved).

const KRAKEN_SPOT = Object.freeze({
  provider: "Kraken", assetClass: "crypto", fractional: true, multiplier: 1,
  // Spot only for ALPHA PAPER: no margin and no leverage, although Kraken offers margin on these pairs (leverage_buy 2-10).
  margin: Object.freeze({ allowed: false, initialPct: 100, note: "spot, fully paid: no leverage or borrowing" }),
  shortable: false, // the ALPHA PAPER ledger is long-only (Worker SHORT_SELLING_ENABLED=false)
  hours: "24/7",
  // Kraken's public API publishes no fee schedule (AssetPairs returned no 'fees' arrays on 2026-11-12). The engine
  // reserves an ASSUMED fee for headroom (ENGINE_FEE_PCT, default 0.40%/side); the ledger charges what its Worker cost
  // profile says (production: none).
  feeModel: Object.freeze({ kind: "assumed", takerPct: 0.4, makerPct: 0.4, source: "assumption; Kraken publishes no fee schedule via its public API" }),
  orderTypes: Object.freeze(["limit", "market", "stop"]),
});

export const INSTRUMENTS = Object.freeze({
  SOLUSD: Object.freeze({
    ...KRAKEN_SPOT, symbol: "SOLUSD", providerSymbol: "SOLUSD", providerPair: "SOL/USD",
    tick: 0.01, qtyDecimals: 8, qtyStep: 1e-8, minQty: 0.05, minNotional: 0.5,
    verified: Object.freeze({ source: "Kraken public AssetPairs (pair SOLUSD): tick_size 0.01, lot_decimals 8, ordermin 0.05, costmin 0.5", at: "2026-11-12T01:00:29Z", previously: "2026-11-09" }),
    fundedEligible: true, priority: 1,
  }),
  BTCUSD: Object.freeze({
    ...KRAKEN_SPOT, symbol: "BTCUSD", providerSymbol: "XBTUSD", providerPair: "XXBTZUSD",
    tick: 0.1, qtyDecimals: 8, qtyStep: 1e-8, minQty: 0.00006, minNotional: 0.5,
    verified: Object.freeze({ source: "Kraken public AssetPairs (pair XXBTZUSD): tick_size 0.1, lot_decimals 8, ordermin 0.00006, costmin 0.5", at: "2026-11-12T01:00:29Z" }),
    fundedEligible: false, fundedNote: "Strategy Mirror only: funded execution needs separate approval", priority: 2,
  }),
  ETHUSD: Object.freeze({
    ...KRAKEN_SPOT, symbol: "ETHUSD", providerSymbol: "ETHUSD", providerPair: "XETHZUSD",
    tick: 0.01, qtyDecimals: 8, qtyStep: 1e-8, minQty: 0.002, minNotional: 0.5,
    verified: Object.freeze({ source: "Kraken public AssetPairs (pair XETHZUSD): tick_size 0.01, lot_decimals 8, ordermin 0.002, costmin 0.5", at: "2026-11-12T01:00:29Z" }),
    fundedEligible: false, fundedNote: "Strategy Mirror only: funded execution needs separate approval", priority: 3,
  }),
});

const REQUIRED = ["symbol", "provider", "providerSymbol", "assetClass", "tick", "qtyStep", "qtyDecimals", "minQty", "minNotional", "fractional", "multiplier", "margin", "hours", "feeModel", "orderTypes", "verified"];

/** The registry entry, or null: an unknown market has no rules and therefore cannot be sized. */
export function getInstrument(symbol) {
  return Object.hasOwn(INSTRUMENTS, symbol) ? INSTRUMENTS[symbol] : null;
}

/** Problems that keep a spec from being used for funded sizing (empty = complete and consistent). */
export function specProblems(spec) {
  const p = [];
  if (!spec || typeof spec !== "object") return ["no instrument specification"];
  for (const k of REQUIRED) if (spec[k] === undefined || spec[k] === null) p.push(`missing ${k}`);
  if (!(spec.tick > 0)) p.push("tick must be > 0");
  if (!(spec.qtyStep > 0)) p.push("qtyStep must be > 0");
  if (!(spec.minQty > 0)) p.push("minQty must be > 0");
  if (!(spec.minNotional >= 0)) p.push("minNotional must be ≥ 0");
  if (!(spec.multiplier > 0)) p.push("multiplier must be > 0");
  if (spec.fractional === false && spec.qtyStep < 1) p.push("a non-fractional instrument must trade in whole units (qtyStep ≥ 1)");
  if (!spec.verified?.source || !spec.verified?.at) p.push("specification has no verified source and date");
  return p;
}

/** Whether a market may trade against the ALPHA PAPER ledger, and if not, why. */
export function fundedStatus(symbol) {
  const spec = getInstrument(symbol);
  if (!spec) return { ok: false, reason: `${symbol} has no verified instrument specification; it stays unavailable for funded execution` };
  const p = specProblems(spec);
  if (p.length) return { ok: false, reason: `${symbol} specification incomplete: ${p.join("; ")}` };
  if (!spec.fundedEligible) return { ok: false, reason: `${symbol}: ${spec.fundedNote ?? "funded execution not approved"}` };
  return { ok: true, reason: null };
}

export const FUNDED_SYMBOLS = Object.freeze(Object.keys(INSTRUMENTS).filter((s) => fundedStatus(s).ok));
