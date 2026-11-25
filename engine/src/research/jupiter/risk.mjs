// Independent risk manager: turns a strategy's target exposure into an approved, Jupiter-compatible position plan, or
// refuses. Shared by the backtester and the PAPER engine. It never sees strategy internals, only the target exposure.
import { liquidationPrice } from "./costs.mjs";

export const STOP_FRACTION = 0.5; // protective stop at half the distance entry -> liquidation (config riskManager.protectiveStop)

/** Collateral and wallet reserves needed to OPEN or INCREASE (fee reservation happens BEFORE sizing is accepted). */
export function requiredCash(collateral, side, c) {
  const swap = side === "long" ? (collateral * (c.longCollateralSwapBps ?? 0)) / 1e4 : 0;
  return collateral + swap + 3 * c.networkUsdPerTx; // the open, the stop-loss request and the eventual close
}

/** Protective stop price for a position (null for an unprotectable position). */
export function stopPrice(pos, c) {
  const lp = liquidationPrice(pos, c);
  if (!(lp > 0)) return pos.side === "long" ? null : pos.entry * (1 + STOP_FRACTION * 0.999); // a 1.1x short's liquidation is far above entry
  return pos.entry + STOP_FRACTION * (lp - pos.entry);
}

/**
 * plan({ asset, target, sleeveEquity, walletCash, pos, pending, shutdown, L, rm, account, costs })
 *   target: signed exposure (notional / sleeve equity) from the strategy; L: the leverage level (sleeve exposure cap)
 * Returns { type: "NONE" | "OPEN" | "CLOSE" | "INCREASE" | "DECREASE", side, sizeUsdDelta, collateralUsdDelta, leverage, reason }
 */
export function plan({ asset, target, sleeveEquity, walletCash, pos, pending, shutdown, L, rm, account, costs: c }) {
  const none = (reason) => ({ type: "NONE", reason });
  if (pending) return none("a request is already pending for this asset (duplicate guard)");
  if (shutdown) return pos ? { type: "CLOSE", side: pos.side, sizeUsdDelta: pos.sizeUsd, reason: "account shutdown" } : none("account shutdown");
  if (!Number.isFinite(target)) return none("no target");
  const capped = Math.max(-L, Math.min(L, target));             // no unlimited leverage: the sleeve cap L always applies
  const side = capped > 0 ? "long" : capped < 0 ? "short" : null;
  const notional = Math.abs(capped) * Math.max(0, sleeveEquity);
  const minNotional = rm.minCollateralUsd * rm.minLeverage;
  if (pos && (side !== pos.side || notional < minNotional)) return { type: "CLOSE", side: pos.side, sizeUsdDelta: pos.sizeUsd, reason: side !== pos.side ? "signal side changed" : "target below Jupiter minimum" };
  if (!side) return none("flat");
  const spendable = walletCash - account.gasReserveUsd;
  if (!pos) {
    if (notional < minNotional) return none(`target $${notional.toFixed(2)} below $${minNotional} (min collateral x min leverage)`);
    let coll = Math.min(notional / rm.minLeverage, sleeveEquity);
    while (coll >= rm.minCollateralUsd && requiredCash(coll, side, c) > spendable) coll = Math.min(coll * 0.99, spendable - 3 * c.networkUsdPerTx);
    if (!(coll >= rm.minCollateralUsd)) return none("not enough available collateral after reserves");
    const size = Math.min(notional, coll * Math.max(L, rm.minLeverage));
    const lev = size / coll;
    if (lev < rm.minLeverage - 1e-9) return none("leverage below Jupiter minimum");
    if (lev > Math.max(L, rm.minLeverage) + 1e-9) return none("leverage above the approved level");
    return { type: "OPEN", side, sizeUsdDelta: size, collateralUsdDelta: coll, leverage: lev, reason: "entry" };
  }
  const dev = Math.abs(notional - pos.sizeUsd) / pos.sizeUsd;
  if (dev <= rm.resizeBand) return none("inside the resize band");
  if (notional > pos.sizeUsd) {
    const wantColl = Math.min(notional / rm.minLeverage, sleeveEquity);
    let dColl = Math.max(0, wantColl - pos.collateralUsd);
    if (dColl > 0 && requiredCash(dColl, side, c) - 2 * c.networkUsdPerTx > spendable) dColl = Math.max(0, spendable - c.networkUsdPerTx - (side === "long" ? (spendable * (c.longCollateralSwapBps ?? 0)) / 1e4 : 0));
    const newColl = pos.collateralUsd + dColl, maxSize = newColl * Math.max(L, rm.minLeverage), dSize = Math.min(notional, maxSize) - pos.sizeUsd;
    if (!(dSize > 0)) return none("no room to increase within the approved leverage");
    return { type: "INCREASE", side, sizeUsdDelta: dSize, collateralUsdDelta: dColl, leverage: (pos.sizeUsd + dSize) / newColl, reason: "resize up" };
  }
  const dSize = pos.sizeUsd - notional, dColl = pos.collateralUsd * (dSize / pos.sizeUsd);
  if (pos.collateralUsd - dColl < rm.minCollateralUsd) return { type: "CLOSE", side, sizeUsdDelta: pos.sizeUsd, reason: "resize would leave collateral below $10" };
  return { type: "DECREASE", side, sizeUsdDelta: dSize, collateralUsdDelta: dColl, leverage: notional / (pos.collateralUsd - dColl), reason: "resize down" };
}
