// Shared Jupiter-Perps execution and accounting (isolated margin), used by BOTH the backtester and the PAPER engine so
// the two cannot drift apart. State is a plain JSON object (persistable). PAPER only: nothing here talks to a network.
import { openFee, closeFee, borrowPerHour, swapFee, pnl, positionValue, liquidationPrice, MAX_LEVERAGE_LIQ } from "./costs.mjs";
import { stopPrice } from "./risk.mjs";

export function newLedger(capital) {
  return { cash: capital, pos: {}, realizedNet: 0, trades: [], events: [],
    F: { open: 0, close: 0, borrow: 0, swap: 0, network: 0, slippage: 0, liquidationLoss: 0 },
    N: { requests: 0, missed: 0, rejected: 0, stopFired: 0, stopFailed: 0, liquidations: 0, opens: 0, closes: 0, increases: 0, decreases: 0, skippedMin: 0 } };
}
const net = (S, x) => { S.cash -= x; S.F.network += x; };
export const value = (p, px, c) => positionValue(p, px, c);

export function liquidate(S, a, t, px, reason = "LIQUIDATION") {
  const p = S.pos[a]; S.F.liquidationLoss += Math.max(0, p.collateralUsd);
  const tradeNet = -p.invested; S.realizedNet += tradeNet;
  S.trades.push({ asset: a, side: p.side, openT: p.openT, closeT: t, entry: p.entry, exit: px, sizeUsd: p.sizeUsd, maxLev: p.maxLev, net: tradeNet, reason });
  S.events.push({ t, kind: "LIQUIDATION", asset: a, px }); delete S.pos[a]; S.N.liquidations++;
}
export function closePos(S, a, px, t, reason, c) {
  const p = S.pos[a]; const cf = closeFee(p.sizeUsd, a, c); let v = p.collateralUsd + pnl(p, px) - cf - p.borrowAccrued;
  if (v <= p.sizeUsd / MAX_LEVERAGE_LIQ) return liquidate(S, a, t, px, reason + "->LIQUIDATED");
  S.F.close += cf; S.F.borrow += p.borrowAccrued;
  const sw = swapFee(v, p.side, c); S.F.swap += sw; v -= sw; S.cash += v; net(S, c.networkUsdPerTx);
  const tradeNet = v - p.invested - c.networkUsdPerTx; S.realizedNet += tradeNet;
  S.trades.push({ asset: a, side: p.side, openT: p.openT, closeT: t, entry: p.entry, exit: px, sizeUsd: p.sizeUsd, maxLev: p.maxLev, net: tradeNet, reason });
  delete S.pos[a]; S.N.closes++;
}
function setStop(S, a, c) { const p = S.pos[a]; p.stop = stopPrice(p, c); net(S, c.networkUsdPerTx); p.invested += c.networkUsdPerTx; }

/** Execute an approved request at this hour's open (keeper fill with delay slippage). Returns the fill price or null. */
export function execute(S, a, rq, b, t, c, acct) {
  const px0 = b[1], slipF = c.delaySlipBps / 1e4;
  const buy = (rq.type === "OPEN" || rq.type === "INCREASE") === (rq.side === "long");
  const px = px0 * (buy ? 1 + slipF : 1 - slipF);
  const p = S.pos[a];
  if (rq.type === "CLOSE") { if (!p) return null; S.F.slippage += p.sizeUsd * slipF; closePos(S, a, px, t, rq.reason, c); return px; }
  if (rq.type === "OPEN") {
    if (p) { S.N.rejected++; return null; }
    const need = rq.collateralUsdDelta + swapFee(rq.collateralUsdDelta, rq.side, c) + c.networkUsdPerTx;
    if (need + 2 * c.networkUsdPerTx > S.cash - acct.gasReserveUsd) { S.N.rejected++; return null; }
    const of = openFee(rq.sizeUsdDelta, a, c), sw = swapFee(rq.collateralUsdDelta, rq.side, c);
    S.cash -= rq.collateralUsdDelta + sw; S.F.open += of; S.F.swap += sw; net(S, c.networkUsdPerTx); S.F.slippage += rq.sizeUsdDelta * slipF;
    S.pos[a] = { asset: a, side: rq.side, sizeUsd: rq.sizeUsdDelta, collateralUsd: rq.collateralUsdDelta - of, entry: px, borrowAccrued: 0, openT: t, invested: rq.collateralUsdDelta + sw + c.networkUsdPerTx, maxLev: rq.sizeUsdDelta / (rq.collateralUsdDelta - of) };
    S.N.opens++; setStop(S, a, c); return px;
  }
  if (!p || p.side !== rq.side) { S.N.rejected++; return null; }
  if (rq.type === "INCREASE") {
    const sw = swapFee(rq.collateralUsdDelta, p.side, c);
    if (rq.collateralUsdDelta + sw + 2 * c.networkUsdPerTx > S.cash - acct.gasReserveUsd) { S.N.rejected++; return null; }
    const of = openFee(rq.sizeUsdDelta, a, c);
    S.cash -= rq.collateralUsdDelta + sw; S.F.open += of; S.F.swap += sw; S.F.borrow += p.borrowAccrued; net(S, c.networkUsdPerTx); S.F.slippage += rq.sizeUsdDelta * slipF;
    const q = p.sizeUsd / p.entry + rq.sizeUsdDelta / px; // Jupiter averages the entry (USD-sized position): token quantity preserved
    p.collateralUsd += rq.collateralUsdDelta - of - p.borrowAccrued; p.borrowAccrued = 0; p.sizeUsd += rq.sizeUsdDelta; p.entry = p.sizeUsd / q;
    p.invested += rq.collateralUsdDelta + sw + c.networkUsdPerTx; p.maxLev = Math.max(p.maxLev, p.sizeUsd / p.collateralUsd);
    S.N.increases++; setStop(S, a, c); return px;
  }
  if (rq.type === "DECREASE") {
    const f = rq.sizeUsdDelta / p.sizeUsd, cf = closeFee(rq.sizeUsdDelta, a, c);
    let payout = rq.collateralUsdDelta + f * pnl(p, px) - cf - p.borrowAccrued;
    S.F.close += cf; S.F.borrow += p.borrowAccrued; S.F.slippage += rq.sizeUsdDelta * slipF; p.borrowAccrued = 0;
    p.collateralUsd -= rq.collateralUsdDelta; p.sizeUsd -= rq.sizeUsdDelta;
    if (payout < 0) { p.collateralUsd += payout; payout = 0; }
    const sw = swapFee(payout, p.side, c); S.F.swap += sw; S.cash += payout - sw; net(S, c.networkUsdPerTx);
    p.invested -= payout - sw - c.networkUsdPerTx;
    S.N.decreases++;
    if (p.collateralUsd + pnl(p, px) - closeFee(p.sizeUsd, a, c) <= p.sizeUsd / MAX_LEVERAGE_LIQ) { liquidate(S, a, t, px); return px; }
    setStop(S, a, c); return px;
  }
  return null;
}

/** One hour of risk for one position: borrow accrual, a gap through liquidation, the stop (may fail), liquidation. */
export function intrabar(S, a, b, t, c, rand) {
  const p = S.pos[a]; if (!p) return;
  p.borrowAccrued += borrowPerHour(p.sizeUsd, p.side, a, c);
  const [, o, h, l] = b, adverse = p.side === "long" ? l : h, worse = (x, y) => (p.side === "long" ? x <= y : x >= y);
  const lp = liquidationPrice(p, c);
  if (worse(o, lp)) liquidate(S, a, t, o);
  else if (p.stop !== null && p.stop !== undefined && worse(adverse, p.stop)) {
    if (rand() < c.stopFailProb) { S.N.stopFailed++; if (worse(adverse, lp)) liquidate(S, a, t, lp); }
    else { S.N.stopFired++; const fill = (worse(o, p.stop) ? o : p.stop) * (p.side === "long" ? 1 - c.stopSlipBps / 1e4 : 1 + c.stopSlipBps / 1e4); S.F.slippage += p.sizeUsd * (c.stopSlipBps / 1e4); closePos(S, a, fill, t, "STOP_LOSS", c); }
  } else if (worse(adverse, lp)) liquidate(S, a, t, lp);
}

/** Equity = cash + each position's close-out value at a price chosen per position. */
export const equityAt = (S, pick, c) => S.cash + Object.values(S.pos).reduce((s, p) => s + value(p, pick(p), c), 0);
/** Ledger identities (every cash flow belongs to a position). */
export function identities(S, lastPx, capital, c) {
  const invested = Object.values(S.pos).reduce((s, p) => s + p.invested, 0);
  const finalEq = S.cash + Object.entries(S.pos).reduce((s, [a, p]) => s + value(p, lastPx[a], c), 0);
  const openValue = Object.entries(S.pos).reduce((s, [a, p]) => s + value(p, lastPx[a], c) - p.invested, 0);
  return { finalEq, ledger_residual: S.cash - (capital + S.realizedNet - invested), equity_identity_residual: finalEq - (capital + S.realizedNet + openValue) };
}
