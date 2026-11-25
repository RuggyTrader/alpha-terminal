// Corrected Jupiter-Perps-specific backtester (PAPER research). Replaces futures/perp.mjs for Jupiter work; perp.mjs is
// kept unchanged so earlier reports stay reproducible. Corrections relative to perp.mjs (each has a regression test):
//   1. ISOLATED margin per position (Jupiter): each position has its own collateral and liquidation; no cross-margining.
//   2. Capital allocation from REALIZED, available collateral: sizing equity = min(wallet cash + posted collateral, marked
//      equity); unrealized gains are never used as collateral; each asset sleeve is capped at one third.
//   3. Fee reservation BEFORE sizing: collateral + swap fee + network fees for open / stop / close must fit the wallet after
//      the gas reserve; open fees come out of the posted collateral (Jupiter's collateralUsd is after fees).
//   4. Liquidation at the Jupiter liquidation price (collateral + PnL - close fee - borrow <= size/500): ALL remaining
//      collateral is lost (not a percentage fee); gaps through it at the open are liquidated at the open.
//   5. Intrabar: the adverse extreme is checked first; stops can fail (retried next hour) and slip; keeper requests fill at
//      the next hour's open with delay slippage and can expire (retried).
//   6. Borrow fees accrue hourly on the FULL size at the collateral custody's rate (longs: asset; shorts: USDC).
//   7. A ledger identity is checked on every run (equity = capital + realized nets + open value - open invested).
import { openFee, closeFee, borrowPerHour, swapFee, pnl, positionValue, liquidationPrice, MAX_LEVERAGE_LIQ } from "./costs.mjs";
import { plan, stopPrice } from "./risk.mjs";
import { exposure, sigmaAt, H, DAY } from "./strategies.mjs";

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

/**
 * markets: { [asset]: { rows: [[t,o,h,l,c,v]] (1h), daily: [{t,o,h,l,c}], signals: [{ t, signal }] } }
 * opts: { from, to, L, costs, config, seed = 7, shutdownEnabled = true, assets (subset enabled), recordEvents }
 */
export function runBacktest(markets, opts) {
  const { from, to, L, costs: c, config, seed = 7, shutdownEnabled = true } = opts;
  const assets = opts.assets ?? config.assets, rm = config.riskManager, acct = config.account, volRef = config.sizing.volRefAnnual, volDays = config.sizing.volLookbackDays;
  const rand = rng(seed);
  const bar = Object.fromEntries(assets.map((a) => [a, new Map((markets[a]?.rows ?? []).map((r) => [r[0], r]))]));
  const sig = Object.fromEntries(assets.map((a) => [a, new Map((markets[a]?.signals ?? []).map((s) => [s.t, s.signal]))]));
  const last = {}, pos = {}, pending = {};
  let cash = acct.capitalUsd, hwm = cash, ddMax = 0, shutdown = false, shutdownAt = null, minEq = cash;
  const F = { open: 0, close: 0, borrow: 0, swap: 0, network: 0, slippage: 0, liquidationLoss: 0 };
  const N = { requests: 0, missed: 0, rejected: 0, stopFired: 0, stopFailed: 0, liquidations: 0, opens: 0, closes: 0, increases: 0, decreases: 0, skippedMin: 0 };
  const trades = [], curve = [], events = [];
  let realizedNet = 0;
  const net = (x) => { cash -= x; F.network += x; };
  const value = (p, px) => positionValue(p, px, c);
  const equityAt = (pick) => cash + Object.values(pos).reduce((s, p) => s + value(p, pick(p)), 0);
  const closePos = (a, px, t, reason) => {
    const p = pos[a]; const cf = closeFee(p.sizeUsd, a, c); let v = p.collateralUsd + pnl(p, px) - cf - p.borrowAccrued;
    if (v <= p.sizeUsd / MAX_LEVERAGE_LIQ) return liquidate(a, t, px, reason + "->LIQUIDATED");
    F.close += cf; F.borrow += p.borrowAccrued;
    const sw = swapFee(v, p.side, c); F.swap += sw; v -= sw; cash += v; net(c.networkUsdPerTx);
    const tradeNet = v - p.invested - c.networkUsdPerTx; realizedNet += tradeNet;
    trades.push({ asset: a, side: p.side, openT: p.openT, closeT: t, entry: p.entry, exit: px, sizeUsd: p.sizeUsd, maxLev: p.maxLev, net: tradeNet, reason });
    delete pos[a]; N.closes++;
  };
  const liquidate = (a, t, px, reason = "LIQUIDATION") => {
    const p = pos[a]; F.liquidationLoss += Math.max(0, p.collateralUsd);
    const tradeNet = -p.invested; realizedNet += tradeNet;
    trades.push({ asset: a, side: p.side, openT: p.openT, closeT: t, entry: p.entry, exit: px, sizeUsd: p.sizeUsd, maxLev: p.maxLev, net: tradeNet, reason });
    events.push({ t, kind: "LIQUIDATION", asset: a, px }); delete pos[a]; N.liquidations++;
  };
  const setStop = (a) => { const p = pos[a]; p.stop = stopPrice(p, c); net(c.networkUsdPerTx); p.invested += c.networkUsdPerTx; };
  const execute = (a, rq, b, t) => {
    const px0 = b[1], slipF = c.delaySlipBps / 1e4;
    const buy = (rq.type === "OPEN" || rq.type === "INCREASE") === (rq.side === "long");
    const px = px0 * (buy ? 1 + slipF : 1 - slipF);
    const p = pos[a];
    if (rq.type === "CLOSE") { if (!p) return; F.slippage += p.sizeUsd * slipF; closePos(a, px, t, rq.reason); return; }
    if (rq.type === "OPEN") {
      if (p) { N.rejected++; return; }
      const need = rq.collateralUsdDelta + swapFee(rq.collateralUsdDelta, rq.side, c) + c.networkUsdPerTx;
      if (need + 2 * c.networkUsdPerTx > cash - acct.gasReserveUsd) { N.rejected++; return; }
      const of = openFee(rq.sizeUsdDelta, a, c), sw = swapFee(rq.collateralUsdDelta, rq.side, c);
      cash -= rq.collateralUsdDelta + sw; F.open += of; F.swap += sw; net(c.networkUsdPerTx); F.slippage += rq.sizeUsdDelta * slipF;
      pos[a] = { asset: a, side: rq.side, sizeUsd: rq.sizeUsdDelta, collateralUsd: rq.collateralUsdDelta - of, entry: px, borrowAccrued: 0, openT: t, invested: rq.collateralUsdDelta + sw + c.networkUsdPerTx, maxLev: rq.sizeUsdDelta / (rq.collateralUsdDelta - of) };
      N.opens++; setStop(a); return;
    }
    if (!p || p.side !== rq.side) { N.rejected++; return; }
    if (rq.type === "INCREASE") {
      const sw = swapFee(rq.collateralUsdDelta, p.side, c);
      if (rq.collateralUsdDelta + sw + 2 * c.networkUsdPerTx > cash - acct.gasReserveUsd) { N.rejected++; return; }
      const of = openFee(rq.sizeUsdDelta, a, c);
      cash -= rq.collateralUsdDelta + sw; F.open += of; F.swap += sw; F.borrow += p.borrowAccrued; net(c.networkUsdPerTx); F.slippage += rq.sizeUsdDelta * slipF;
      // Jupiter averages the entry price (USD-sized position): new entry preserves token quantity
      const q = p.sizeUsd / p.entry + rq.sizeUsdDelta / px;
      p.collateralUsd += rq.collateralUsdDelta - of - p.borrowAccrued; p.borrowAccrued = 0; p.sizeUsd += rq.sizeUsdDelta; p.entry = p.sizeUsd / q;
      p.invested += rq.collateralUsdDelta + sw + c.networkUsdPerTx; p.maxLev = Math.max(p.maxLev, p.sizeUsd / p.collateralUsd);
      N.increases++; setStop(a); return;
    }
    if (rq.type === "DECREASE") {
      const f = rq.sizeUsdDelta / p.sizeUsd, cf = closeFee(rq.sizeUsdDelta, a, c);
      let payout = rq.collateralUsdDelta + f * pnl(p, px) - cf - p.borrowAccrued;
      F.close += cf; F.borrow += p.borrowAccrued; F.slippage += rq.sizeUsdDelta * slipF; p.borrowAccrued = 0;
      p.collateralUsd -= rq.collateralUsdDelta; p.sizeUsd -= rq.sizeUsdDelta;
      if (payout < 0) { p.collateralUsd += payout; payout = 0; }
      const sw = swapFee(payout, p.side, c); F.swap += sw; cash += payout - sw; net(c.networkUsdPerTx);
      p.invested -= payout - sw - c.networkUsdPerTx; // cash returned reduces the amount still invested
      N.decreases++;
      if (p.collateralUsd + pnl(p, px) - closeFee(p.sizeUsd, a, c) <= p.sizeUsd / MAX_LEVERAGE_LIQ) { liquidate(a, t, px); return; }
      setStop(a);
    }
  };
  for (let t = Math.ceil(from / H) * H; t < to; t += H) {
    // 1) keeper fills of pending requests at this hour's open (or expiry -> retried next hour)
    for (const a of assets) {
      const b = bar[a].get(t), rq = pending[a]; if (!b || !rq) continue;
      N.requests++;
      if (rand() < c.missProb) { N.missed++; continue; }
      delete pending[a]; execute(a, rq, b, t);
    }
    // 2) borrow accrual, gaps, stops and liquidation (adverse extreme first)
    for (const a of assets) {
      const b = bar[a].get(t), p = pos[a]; if (!b) continue;
      if (p) {
        p.borrowAccrued += borrowPerHour(p.sizeUsd, p.side, a, c);
        const [, o, h, l] = b, adverse = p.side === "long" ? l : h, worse = (x, y) => (p.side === "long" ? x <= y : x >= y);
        const lp = liquidationPrice(p, c);
        if (worse(o, lp)) { liquidate(a, t, o); }
        else if (p.stop !== null && p.stop !== undefined && worse(adverse, p.stop)) {
          if (rand() < c.stopFailProb) { N.stopFailed++; if (worse(adverse, lp)) liquidate(a, t, lp); }
          else { N.stopFired++; const fill = (worse(o, p.stop) ? o : p.stop) * (p.side === "long" ? 1 - c.stopSlipBps / 1e4 : 1 + c.stopSlipBps / 1e4); F.slippage += p.sizeUsd * (c.stopSlipBps / 1e4); closePos(a, fill, t, "STOP_LOSS"); }
        } else if (worse(adverse, lp)) liquidate(a, t, lp);
      }
      last[a] = b[4];
    }
    // 3) marks: drawdown from the high-water mark (high assumed before low), shutdown trigger at the worst mark
    const hb = (p) => (bar[p.asset].get(t) ? (p.side === "long" ? bar[p.asset].get(t)[2] : bar[p.asset].get(t)[3]) : last[p.asset]);
    const wb = (p) => (bar[p.asset].get(t) ? (p.side === "long" ? bar[p.asset].get(t)[3] : bar[p.asset].get(t)[2]) : last[p.asset]);
    const eqBest = equityAt(hb), eqWorst = equityAt(wb), eqClose = equityAt((p) => last[p.asset]);
    ddMax = Math.max(ddMax, 1 - eqWorst / Math.max(hwm, eqBest)); hwm = Math.max(hwm, eqBest, eqClose); minEq = Math.min(minEq, eqWorst);
    if (shutdownEnabled && !shutdown && eqWorst <= acct.shutdownEquityUsd) { shutdown = true; shutdownAt = { t, eqWorst }; events.push({ t, kind: "SHUTDOWN", eqWorst }); }
    if (shutdown) for (const a of Object.keys(pos)) if (!pending[a]) pending[a] = { type: "CLOSE", side: pos[a].side, sizeUsdDelta: pos[a].sizeUsd, reason: "SHUTDOWN", key: `shutdown|${a}` };
    // 4) strategy decisions at this hour's close
    const T = t + H;
    if (!shutdown) {
      const realized = cash + Object.values(pos).reduce((s, p) => s + p.collateralUsd, 0), sizingEq = Math.min(realized, eqClose), sleeve = sizingEq / config.assets.length;
      // cash already committed to requests decided this hour is not available to the next asset's plan
      let committed = 0;
      for (const a of assets) {
        if (!sig[a].has(T)) continue;
        // a request still pending here was missed by the keeper; the newer decision supersedes it (Jupiter requests expire)
        if (pending[a]) { delete pending[a]; N.superseded = (N.superseded ?? 0) + 1; }
        const sb = markets[a].sigmaByDay, sigma = sb ? sb.get(Math.floor(T / DAY) * DAY - DAY) ?? null : sigmaAt(markets[a].daily, T, volDays), target = exposure(sig[a].get(T), L, sigma, volRef);
        const pl = plan({ asset: a, target, sleeveEquity: sleeve, walletCash: cash - committed, pos: pos[a] ?? null, pending: pending[a] ?? null, shutdown, L, rm, account: acct, costs: c });
        if (pl.type === "NONE") { if (/below \$/.test(pl.reason)) N.skippedMin++; continue; }
        if (pl.type === "OPEN" || pl.type === "INCREASE") committed += pl.collateralUsdDelta + swapFee(pl.collateralUsdDelta, pl.side, c) + 3 * c.networkUsdPerTx;
        pending[a] = { ...pl, key: `${a}|${T}` };
      }
    }
    if (T % DAY === 0) curve.push([T, eqClose]);
  }
  const finalEq = cash + Object.entries(pos).reduce((s, [a, p]) => s + value(p, last[a]), 0);
  const openValue = Object.entries(pos).reduce((s, [a, p]) => s + value(p, last[a]) - p.invested, 0);
  const years = (to - from) / (365.25 * DAY), wins = trades.filter((x) => x.net > 0), gw = wins.reduce((s, x) => s + x.net, 0), gl = -trades.filter((x) => x.net <= 0).reduce((s, x) => s + x.net, 0);
  return {
    final: finalEq, cagr_pct: finalEq > 0 ? ((finalEq / acct.capitalUsd) ** (1 / years) - 1) * 100 : -100, max_dd_pct: ddMax * 100, min_equity: minEq,
    shutdown: shutdownAt, liquidations: N.liquidations, counts: N, fees: F, trades: trades.length, win_rate: trades.length ? wins.length / trades.length : null,
    profit_factor: gl > 0 ? gw / gl : trades.length ? Infinity : null,
    // ledger identity: every cash flow is attributed to a position, so cash = capital + realized nets - cash still invested
    ledger_residual: cash - (acct.capitalUsd + realizedNet - Object.values(pos).reduce((s, p) => s + p.invested, 0)),
    equity_identity_residual: finalEq - (acct.capitalUsd + realizedNet + openValue),
    cash, open: Object.keys(pos), positions: Object.fromEntries(Object.entries(pos).map(([a, p]) => [a, { ...p }])), curve, trade_list: trades, events,
  };
}

/** Rolling-window statistics of a daily equity curve: returns and the probability of a 25 % fall from the start within h days. */
export function rollingStats(curve, h, lossFrac = 0.25) {
  const r = []; let hits = 0, n = 0;
  for (let i = 0; i + h < curve.length; i++) {
    const s = curve[i][1]; if (!(s > 0)) continue; n++;
    r.push(curve[i + h][1] / s - 1);
    for (let j = i + 1; j <= i + h; j++) if (curve[j][1] <= s * (1 - lossFrac)) { hits++; break; }
  }
  if (!n) return { n: 0 };
  const z = [...r].sort((a, b) => a - b), q = (p) => z[Math.min(z.length - 1, Math.floor(p * z.length))] * 100;
  return { n, median_pct: q(0.5), p5_pct: q(0.05), worst_pct: z[0] * 100, best_pct: z.at(-1) * 100, positive_share: r.filter((x) => x > 0).length / n, p_loss25: hits / n };
}
