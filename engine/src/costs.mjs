// Execution costs for research backtests: exchange fees by order type plus slippage on orders that take liquidity.
// Pure functions. Every assumption is named here and reported with the results.
//
// Order types in this strategy (Limit @ 0.705 entry mode):
//   entry  : resting limit order          -> maker fee, no slippage (fills at its price or better)
//   TP exit: resting limit order          -> maker fee, no slippage
//   SL exit: stop order (also break-even and trailing stops) -> taker fee + slippage against us
//   CLOSE_ALL (time exits)                -> taker fee + slippage
// A market-entry mode would be taker + slippage on entry too.

export const VENUES = Object.freeze({
  // https://ndax.io/en/fees (read 2026-11-09): "flat 0.20% trading fee on every buy and sell order ... no maker/taker
  // split". Minimum order "usually about $1 to $5" (help centre). Ndax trades SOL against CAD; its order book was NOT
  // measured (no connection was made), so slippage is a conservative ASSUMPTION.
  ndax: { name: "Ndax (0.20% flat, published)", makerPct: 0.2, takerPct: 0.2, takerSlipPct: 0.1, minOrderUsd: 5, minQty: 0 },
  // https://www.kraken.com/pro/fees (read 2026-11-09), Tier 1 ($0+ 30-day volume): spot maker 0.40%, taker 0.80%.
  // Slippage: live SOLUSD book 2026-11-09 04:24 UTC, spread $0.02 (0.023%), a $100 market buy filled at the best ask;
  // assumed half-spread + margin = 0.03%. Minimums: 0.05 SOL, $0.50 (AssetPairs).
  kraken: { name: "Kraken Pro Tier 1 (0.40% / 0.80%)", makerPct: 0.4, takerPct: 0.8, takerSlipPct: 0.03, minOrderUsd: 0.5, minQty: 0.05 },
  // Reference only: what the strategy does before any cost.
  none: { name: "No costs (reference)", makerPct: 0, takerPct: 0, takerSlipPct: 0, minOrderUsd: 0, minQty: 0 },
});

/** Cost in USD of one closed trade {side, qty, entryPrice, exitPrice, exitKind}. */
export function tradeCost(t, venue, { marketEntry = false } = {}) {
  const side = t.side === "SHORT" || t.side === -1 ? -1 : 1;
  const inVal = t.qty * t.entryPrice;
  const outVal = t.qty * t.exitPrice;
  const exitTaker = t.exitKind !== "TP";
  const fees = inVal * ((marketEntry ? venue.takerPct : venue.makerPct) / 100) + outVal * ((exitTaker ? venue.takerPct : venue.makerPct) / 100);
  const slip = (marketEntry ? inVal * (venue.takerSlipPct / 100) : 0) + (exitTaker ? outVal * (venue.takerSlipPct / 100) : 0);
  void side; // slippage is always against us, whatever the side
  return { fees, slip, total: fees + slip };
}

/** Round-trip cost as a % of the position, for a stop exit (worst case) and a take-profit exit. */
export function roundTripPct(venue) {
  return { tpExit: venue.makerPct * 2, stopExit: venue.makerPct + venue.takerPct + venue.takerSlipPct };
}
