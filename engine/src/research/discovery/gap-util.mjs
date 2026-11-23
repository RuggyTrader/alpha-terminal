// Shared helper for the P1 order-book study.
/** Average price of a market order spending `notional` across levels [[price, qty]]; null if the book is too thin. */
export function walk(levels, notional) { let left = notional, qty = 0; for (const [p, q] of levels) { const take = Math.min(left, p * q); qty += take / p; left -= take; if (left <= 1e-9) return notional / qty; } return null; }
