// Jupiter Perps cost and liquidation math (PAPER research). Formulas follow the program's reference implementation
// (julianfssen/jupiter-perps-anchor-idl-parsing examples linked from developers.jup.ag) and Jupiter's user docs:
//   * open / close base fee: increasePositionBps / decreasePositionBps of the size delta (6 bps on-chain, 2026-11-25)
//   * price-impact fee bps = sizeUsd(atomic, 6 dp) x 1e4 / tradeImpactFeeScalar   (linear in size)
//   * borrow fee accrues hourly on the FULL position size at the COLLATERAL custody's rate (long: the asset; short: USDC)
//   * liquidation when collateral + PnL - close fee - borrow <= sizeUsd / maxLeverage(500); all remaining collateral is lost
// USD-denominated positions: PnL = size x (price / entry - 1) for a long, size x (1 - price / entry) for a short.
export const MAX_LEVERAGE_LIQ = 500;

export const impactBps = (sizeUsd, asset, c) => (sizeUsd * 1e6 * 1e4) / c.tradeImpactFeeScalar[asset];
/** Fee (USD) to open or increase by sizeUsd. */
export const openFee = (sizeUsd, asset, c) => (sizeUsd * (c.openBps + impactBps(sizeUsd, asset, c) + c.imbalanceBpsPerSide)) / 1e4;
/** Fee (USD) to close or decrease by sizeUsd. */
export const closeFee = (sizeUsd, asset, c) => (sizeUsd * (c.closeBps + impactBps(sizeUsd, asset, c) + c.imbalanceBpsPerSide)) / 1e4;
/** Hourly borrow fee (USD) on a position. */
export const borrowPerHour = (sizeUsd, side, asset, c) => sizeUsd * c.borrowHourly[side === "long" ? asset : "USDC"] * c.borrowMultiplier;
/** Swap fee (USD) on collateral swapped USDC <-> asset token (longs only). */
export const swapFee = (usd, side, c) => (side === "long" ? (usd * (c.longCollateralSwapBps ?? 0)) / 1e4 : 0);

export const pnl = (pos, price) => (pos.side === "long" ? pos.sizeUsd * (price / pos.entry - 1) : pos.sizeUsd * (1 - price / pos.entry));
/** Position value if closed at `price` (never below 0: isolated margin). */
export function positionValue(pos, price, c) {
  return Math.max(0, pos.collateralUsd + pnl(pos, price) - closeFee(pos.sizeUsd, pos.asset, c) - pos.borrowAccrued);
}
/** Liquidation price: the price at which collateral + PnL - close fee - borrow = size / 500. */
export function liquidationPrice(pos, c) {
  const k = (pos.sizeUsd / MAX_LEVERAGE_LIQ + closeFee(pos.sizeUsd, pos.asset, c) + pos.borrowAccrued - pos.collateralUsd) / pos.sizeUsd;
  return pos.side === "long" ? pos.entry * (1 + k) : pos.entry * (1 - k);
}
export const isLiquidatable = (pos, price, c) => (pos.side === "long" ? price <= liquidationPrice(pos, c) : price >= liquidationPrice(pos, c));
