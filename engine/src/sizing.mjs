// Position sizing for the PAPER engine. Pure functions; no I/O.
//
// "fixed"   (default, unchanged): quantity = risk per trade in USD ÷ stop distance, exactly as the Pine strategy.
// "percent" (small-account mode): risk a percentage of the strategy's available ALPHA PAPER balance, and never buy more
//           than that balance can pay for, after a price buffer and the estimated entry fee:
//             risk target  = balance × riskPct
//             risk qty     = risk target ÷ |entry − stop|
//             cash qty     = balance ÷ (entry × (1 + priceBuffer) × (1 + fee))
//             quantity     = min(risk qty, cash qty), rounded DOWN to the instrument's quantity step
//           No leverage, no margin, no borrowing, no shorts. An order below the venue minimums, or one that cannot be
//           sized truthfully (unknown balance, no capital, no stop distance), is skipped with a precise reason.
//
// Venue rules used for SOLUSD (Kraken public AssetPairs, read 2026-11-09): ordermin 0.05 SOL, costmin $0.50,
// lot_decimals 8, tick $0.01. Kraken's API returned no fee schedule, so the fee is an ASSUMPTION (default 0.40% per
// side, configurable); the ALPHA PAPER ledger itself charges no fee.

export const SOLUSD_RULES = Object.freeze({ minQty: 0.05, minCost: 0.5, qtyDecimals: 8 });

export const DEFAULT_SIZING = Object.freeze({
  mode: "fixed",
  riskPct: 1, // % of the available strategy balance risked at the stop (percent mode)
  feePct: 0.4, // assumed fee per side, % of notional (reserved at entry; estimated in reports)
  priceBufferPct: 0.5, // headroom for the ledger filling at the live price a moment after the engine's fill
  ...SOLUSD_RULES,
});

const floorTo = (v, decimals) => {
  const f = 10 ** decimals;
  return Math.floor(v * f + 1e-9) / f;
};
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Sizes one entry. Returns { ok, qty, ... } or { ok: false, code, reason, ... }. All dollar figures are rounded to cents
 * for display; the quantity is exact (rounded down to the step).
 */
export function sizeOrder({ sizing = DEFAULT_SIZING, riskUSD, capital, entry, stop, side, maxNotional = null }) {
  const z = { ...DEFAULT_SIZING, ...sizing };
  const dist = Math.abs(entry - stop);
  const base = { mode: z.mode, entry, stop, side, riskPct: z.mode === "percent" ? z.riskPct : null, capital: capital ?? null };
  if (!(dist > 0) || !(entry > 0)) return { ...base, ok: false, code: "INVALID_STOP", reason: "entry and stop must differ" };

  if (z.mode !== "percent") {
    // Unchanged fixed-risk behaviour (the Pine strategy and the original engine).
    const qty = riskUSD / dist;
    return { ...base, ok: true, qty, riskTarget: riskUSD, riskActual: riskUSD, notional: entry * qty, requiredCapital: entry * qty, capped: false };
  }

  if (side !== 1) return { ...base, ok: false, code: "SHORT_NOT_ALLOWED", reason: "small-account mode is long-only: no short selling" };
  if (capital === null || capital === undefined || !Number.isFinite(capital)) {
    return { ...base, ok: false, code: "BALANCE_UNKNOWN", reason: "the strategy's PAPER balance could not be read; no order without it" };
  }
  if (!(capital > 0)) return { ...base, ok: false, code: "NO_CAPITAL", reason: `no available PAPER capital ($${r2(capital)})` };

  const riskTarget = capital * (z.riskPct / 100);
  const perUnit = entry * (1 + z.priceBufferPct / 100) * (1 + z.feePct / 100);
  const riskQty = riskTarget / dist;
  // Never more than the balance can pay for, and never above the Worker's order-value limit (same rule it enforces).
  const spend = maxNotional !== null && Number.isFinite(maxNotional) && maxNotional > 0 ? Math.min(capital, maxNotional) : capital;
  const cashQty = spend / perUnit;
  const qty = floorTo(Math.min(riskQty, cashQty), z.qtyDecimals);
  const out = {
    ...base,
    qty,
    riskTarget: r2(riskTarget),
    riskActual: r2(qty * dist),
    notional: r2(qty * entry),
    // Capital needed to take the full risk target without exceeding the balance.
    requiredCapital: r2(riskQty * perUnit),
    capped: cashQty < riskQty,
    cappedBy: cashQty < riskQty ? (spend < capital ? "ORDER_LIMIT" : "BALANCE") : null,
    feeEstimate: r2(qty * entry * (z.feePct / 100) * 2),
    minQty: z.minQty,
    minCost: z.minCost,
  };
  if (qty < z.minQty) {
    return { ...out, ok: false, code: "BELOW_MIN_QTY", reason: `${qty} SOL is below the minimum order of ${z.minQty} SOL (needs about $${r2(z.minQty * perUnit)} of PAPER capital)` };
  }
  if (qty * entry < z.minCost) {
    return { ...out, ok: false, code: "BELOW_MIN_COST", reason: `order value $${r2(qty * entry)} is below the minimum of $${z.minCost}` };
  }
  return { ...out, ok: true };
}
