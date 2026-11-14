// PAPER fill rules for the bot ledger's strategy fills (pure; unit-tested in test/paper_fill.test.mjs).
//
// The engine's broker emulator (engine/src/broker.mjs, TradingView's documented model, bar magnifier off) decides
// WHEN and AT WHAT PRICE a strategy order fills, from the completed Kraken candle. The Worker does not trust that
// blindly. It accepts the fill only if:
//   * the candle is COMPLETE (its close is not after the moment the order arrives): no future data;
//   * for an entry from a pending limit, the candle OPENED AT OR AFTER the order was placed: no candle from before
//     the order existed;
//   * the price lies inside that candle's low..high range;
//   * a limit is respected: a BUY limit (LONG entry, SHORT take-profit) never fills ABOVE its limit, and a SELL limit
//     (SHORT entry, LONG take-profit) never fills BELOW it. A gap through the limit fills at the open, which is the
//     better price.
// Otherwise the order is refused with the reason; nothing is filled at an invented price.
//
// It is a SIMULATED limit fill. It models no queue position, partial fills or exchange liquidity, and it is not a
// guaranteed exchange fill. Orders without strategy fill evidence still fill at the Kraken reference price on
// arrival (REFERENCE_PRICE), labelled as such.

export interface Candle { t: string; o: number; h: number; l: number; c: number; tf_min: number }
export type FillCheck = { ok: true; price: number; candleClose: string } | { ok: false; code: string; message: string };

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function parseCandle(v: unknown, tfMin: number): Candle | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.t !== "string" || !Number.isFinite(Date.parse(c.t))) return null;
  if (![c.o, c.h, c.l, c.c].every(fin)) return null;
  const [o, h, l, cl] = [c.o, c.h, c.l, c.c] as number[];
  if (!(h >= Math.max(o, cl, l) && l <= Math.min(o, cl, h))) return null;
  return { t: new Date(Date.parse(c.t)).toISOString(), o, h, l, c: cl, tf_min: tfMin };
}

/**
 * side: the fill's direction in the market. "BUY" = LONG entry, SHORT exit. "SELL" = SHORT entry, LONG exit.
 * limit: the order's limit price when it is a limit order (entries from a pending order, take-profits), else null.
 */
export function checkStrategyFill(o: {
  side: "BUY" | "SELL"; price: unknown; candle: Candle | null; limit: number | null; nowMs: number; notBeforeMs: number | null;
}): FillCheck {
  const c = o.candle;
  if (!c) return { ok: false, code: "FILL_EVIDENCE_INVALID", message: "the strategy fill has no valid completed candle (t, o, h, l, c)" };
  if (!fin(o.price)) return { ok: false, code: "FILL_EVIDENCE_INVALID", message: "the strategy fill price is missing" };
  const openMs = Date.parse(c.t), closeMs = openMs + c.tf_min * 60_000;
  if (closeMs > o.nowMs + 5_000) return { ok: false, code: "FILL_FROM_INCOMPLETE_CANDLE", message: `the candle ${c.t} has not closed yet; only completed candles can fill` };
  if (o.notBeforeMs !== null && openMs < o.notBeforeMs) {
    return { ok: false, code: "FILL_BEFORE_ORDER", message: `the candle ${c.t} opened before the order was placed; it cannot fill it` };
  }
  const px = o.price;
  const tol = Math.max(1e-9, px * 1e-9);
  if (px < c.l - tol || px > c.h + tol) return { ok: false, code: "FILL_OUTSIDE_CANDLE", message: `fill ${px} is outside the candle's range ${c.l}–${c.h}` };
  if (o.limit !== null) {
    if (o.side === "BUY" && px > o.limit + tol) return { ok: false, code: "LIMIT_VIOLATION", message: `a buy limit at ${o.limit} cannot fill above it (${px})` };
    if (o.side === "SELL" && px < o.limit - tol) return { ok: false, code: "LIMIT_VIOLATION", message: `a sell limit at ${o.limit} cannot fill below it (${px})` };
    if (o.side === "BUY" && c.l > o.limit + tol) return { ok: false, code: "LIMIT_NOT_REACHED", message: `the candle's low ${c.l} never reached the buy limit ${o.limit}` };
    if (o.side === "SELL" && c.h < o.limit - tol) return { ok: false, code: "LIMIT_NOT_REACHED", message: `the candle's high ${c.h} never reached the sell limit ${o.limit}` };
  }
  return { ok: true, price: px, candleClose: new Date(closeMs).toISOString() };
}

/** Planned figures for a LIMIT order at its own limit price, after reduce-to-fit (risk, then the bot's wallet). */
export function sizeAtLimit(o: {
  side: "LONG" | "SHORT"; limit: number; stop: number; requestedQty: number; riskUsd: number; availableUsd: number;
  feeRatePct: number; minQty: number; minNotional: number; decimals: number;
}): { ok: true; qty: number; reduced: string | null; riskUsd: number; collateralUsd: number; feeUsd: number } | { ok: false; code: string; message: string } {
  const step = 10 ** o.decimals;
  const floor = (q: number) => Math.floor(q * step + 1e-9) / step;
  const dist = Math.abs(o.limit - o.stop);
  let qty = o.requestedQty, reduced: string | null = null;
  if (dist > 0 && o.riskUsd > 0) {
    const riskQty = floor(o.riskUsd / dist);
    if (riskQty < qty) { qty = riskQty; reduced = `reduced from ${o.requestedQty} to ${qty} to keep stop risk within $${o.riskUsd}`; }
  }
  const capQty = floor(o.availableUsd / (o.limit * (1 + o.feeRatePct / 100)));
  if (capQty < qty) { reduced = `reduced from ${o.requestedQty} to ${capQty} to fit the bot's available $${o.availableUsd.toFixed(2)}`; qty = capQty; }
  if (qty < o.minQty || qty * o.limit < o.minNotional) {
    const why = capQty < o.minQty || capQty * o.limit < o.minNotional
      ? `even the venue minimum (${o.minQty}, $${o.minNotional}) at ${o.limit} needs more than the bot's available $${o.availableUsd.toFixed(2)}`
      : `the quantity within the $${o.riskUsd} stop risk (${qty}) is below the venue minimum ${o.minQty}`;
    return { ok: false, code: capQty < o.minQty || capQty * o.limit < o.minNotional ? "INSUFFICIENT_BOT_CAPITAL" : "BELOW_MIN_QTY", message: why };
  }
  const collateral = qty * o.limit;
  return { ok: true, qty, reduced, riskUsd: Number((qty * dist).toFixed(6)), collateralUsd: Number(collateral.toFixed(6)), feeUsd: Number((collateral * o.feeRatePct / 100).toFixed(6)) };
}
