// Corrected Jupiter-Perps-specific backtester (PAPER research). Replaces futures/perp.mjs for Jupiter work; perp.mjs is
// kept unchanged so earlier reports stay reproducible. Corrections relative to perp.mjs (each has a regression test):
//   1. ISOLATED margin per position (Jupiter): each position has its own collateral and liquidation; no cross-margining.
//   2. Capital allocation from REALIZED, available collateral: sizing equity = min(wallet cash + posted collateral, marked
//      equity); unrealized gains are never used as collateral; each asset sleeve is capped at one third; cash committed to
//      requests decided in the same hour is not offered to the next asset.
//   3. Fee reservation BEFORE sizing: collateral + swap fee + network fees for open / stop / close must fit the wallet after
//      the gas reserve; open fees come out of the posted collateral (Jupiter's collateralUsd is after fees).
//   4. Liquidation at the Jupiter liquidation price (collateral + PnL - close fee - borrow <= size/500): ALL remaining
//      collateral is lost (not a percentage fee); gaps through it at the open are liquidated at the open.
//   5. Intrabar: the adverse extreme is checked first; stops can fail (retried next hour) and slip; keeper requests fill at
//      the next hour's open with delay slippage and can expire (retried, or superseded by a newer decision).
//   6. Borrow fees accrue hourly on the FULL size at the collateral custody's rate (longs: asset; shorts: USDC).
//   7. Ledger identities are checked on every run.
// The hour-by-hour step (stepHour) is shared with the PAPER engine, so PAPER and backtest semantics are identical.
import { swapFee } from "./costs.mjs";
import { plan } from "./risk.mjs";
import { exposure, sigmaAt, H, DAY } from "./strategies.mjs";
import { newLedger, execute, intrabar, equityAt, identities } from "./ledger.mjs";

/** Persistable LCG (state in an object so the PAPER engine can save and resume it). */
export const rngNext = (r) => ((r.s = (Math.imul(r.s, 1664525) + 1013904223) >>> 0) / 2 ** 32);

export function newRunState(capital, seed = 7) {
  return { ...newLedger(capital), pending: {}, last: {}, hwm: capital, ddMax: 0, minEq: capital, shutdown: false, shutdownAt: null, curve: [], rng: { s: seed >>> 0 } };
}

/**
 * One closed hour t for all assets. ctx: { assets, bar(a, t) -> [t,o,h,l,c,v] | undefined, signalAt(a, T) -> number | undefined,
 * sigmaAt(a, T), L, costs, config, shutdownEnabled }. Mutates S. Returns the list of requests decided at this hour's close.
 */
export function stepHour(S, ctx, t) {
  const { assets, L, costs: c, config, shutdownEnabled = true } = ctx, acct = config.account, rm = config.riskManager, volRef = config.sizing.volRefAnnual;
  const rand = () => rngNext(S.rng), decided = [], outcomes = [];
  // 1) keeper fills of pending requests at this hour's open (or expiry -> retried next hour)
  for (const a of assets) {
    const b = ctx.bar(a, t), rq = S.pending[a]; if (!b || !rq) continue;
    S.N.requests++;
    if (rand() < c.missProb) { S.N.missed++; outcomes.push({ asset: a, key: rq.key, status: "EXPIRED_RETRYING", t }); continue; }
    delete S.pending[a]; const px = execute(S, a, rq, b, t, c, acct);
    outcomes.push({ asset: a, key: rq.key, status: px === null ? "REJECTED" : "EXECUTED", px, t });
  }
  // 2) borrow accrual, gaps, stops and liquidation (adverse extreme first)
  for (const a of assets) { const b = ctx.bar(a, t); if (!b) continue; intrabar(S, a, b, t, c, rand); S.last[a] = b[4]; }
  // 3) marks: drawdown from the high-water mark (high assumed before low), shutdown trigger at the worst mark
  const px = (p, iHi, iLo) => { const b = ctx.bar(p.asset, t); return b ? (p.side === "long" ? b[iHi] : b[iLo]) : S.last[p.asset]; };
  const eqBest = equityAt(S, (p) => px(p, 2, 3), c), eqWorst = equityAt(S, (p) => px(p, 3, 2), c), eqClose = equityAt(S, (p) => S.last[p.asset], c);
  S.ddMax = Math.max(S.ddMax, 1 - eqWorst / Math.max(S.hwm, eqBest)); S.hwm = Math.max(S.hwm, eqBest, eqClose); S.minEq = Math.min(S.minEq, eqWorst);
  S.eqClose = eqClose;
  if (shutdownEnabled && !S.shutdown && eqWorst <= acct.shutdownEquityUsd) { S.shutdown = true; S.shutdownAt = { t, eqWorst }; S.events.push({ t, kind: "SHUTDOWN", eqWorst }); }
  if (S.shutdown) for (const a of Object.keys(S.pos)) if (!S.pending[a]) S.pending[a] = { type: "CLOSE", side: S.pos[a].side, sizeUsdDelta: S.pos[a].sizeUsd, reason: "SHUTDOWN", key: `shutdown|${a}` };
  // 4) strategy decisions at this hour's close
  const T = t + H;
  if (!S.shutdown) {
    const realized = S.cash + Object.values(S.pos).reduce((s, p) => s + p.collateralUsd, 0), sizingEq = Math.min(realized, eqClose), sleeve = sizingEq / config.assets.length;
    let committed = 0; // cash committed to requests decided this hour is not offered to the next asset's plan
    for (const a of assets) {
      const sv = ctx.signalAt(a, T); if (sv === undefined) continue;
      if (S.pending[a]) { outcomes.push({ asset: a, key: S.pending[a].key, status: "SUPERSEDED", t: T }); delete S.pending[a]; S.N.superseded = (S.N.superseded ?? 0) + 1; } // missed by the keeper: superseded
      const target = exposure(sv, L, ctx.sigmaAt(a, T), volRef);
      const pl = plan({ asset: a, target, sleeveEquity: sleeve, walletCash: S.cash - committed, pos: S.pos[a] ?? null, pending: S.pending[a] ?? null, shutdown: S.shutdown, L, rm, account: acct, costs: c });
      if (pl.type === "NONE") { if (/below \$/.test(pl.reason)) S.N.skippedMin++; continue; }
      if (pl.type === "OPEN" || pl.type === "INCREASE") committed += pl.collateralUsdDelta + swapFee(pl.collateralUsdDelta, pl.side, c) + 3 * c.networkUsdPerTx;
      S.pending[a] = { ...pl, key: `${a}|${T}`, decidedT: T, target };
      decided.push({ asset: a, ...S.pending[a] });
    }
  }
  if (T % DAY === 0) S.curve.push([T, eqClose]);
  return { decided, outcomes };
}

/** Build a step context from in-memory markets. */
export function marketContext(markets, assets, opts) {
  const bar = Object.fromEntries(assets.map((a) => [a, new Map((markets[a]?.rows ?? []).map((r) => [r[0], r]))]));
  const sig = Object.fromEntries(assets.map((a) => [a, new Map((markets[a]?.signals ?? []).map((s) => [s.t, s.signal]))]));
  const volDays = opts.config.sizing.volLookbackDays;
  return { assets, L: opts.L, costs: opts.costs, config: opts.config, shutdownEnabled: opts.shutdownEnabled ?? true,
    bar: (a, t) => bar[a].get(t), signalAt: (a, T) => sig[a].get(T),
    sigmaAt: (a, T) => { const sb = markets[a].sigmaByDay; return sb ? sb.get(Math.floor(T / DAY) * DAY - DAY) ?? null : sigmaAt(markets[a].daily, T, volDays); } };
}

/**
 * markets: { [asset]: { rows: [[t,o,h,l,c,v]] (1h), daily: [{t,o,h,l,c}], signals: [{ t, signal }], sigmaByDay? } }
 * opts: { from, to, L, costs, config, seed = 7, shutdownEnabled = true, assets (subset enabled) }
 */
export function runBacktest(markets, opts) {
  const { from, to, config, seed = 7 } = opts, assets = opts.assets ?? config.assets, acct = config.account;
  const S = newRunState(acct.capitalUsd, seed), ctx = marketContext(markets, assets, opts);
  for (let t = Math.ceil(from / H) * H; t < to; t += H) stepHour(S, ctx, t);
  return summarize(S, acct.capitalUsd, from, to, opts.costs);
}

export function summarize(S, capital, from, to, c) {
  const id = identities(S, S.last, capital, c), trades = S.trades;
  const years = (to - from) / (365.25 * DAY), wins = trades.filter((x) => x.net > 0), gw = wins.reduce((s, x) => s + x.net, 0), gl = -trades.filter((x) => x.net <= 0).reduce((s, x) => s + x.net, 0);
  return {
    final: id.finalEq, cagr_pct: id.finalEq > 0 ? ((id.finalEq / capital) ** (1 / years) - 1) * 100 : -100, max_dd_pct: S.ddMax * 100, min_equity: S.minEq,
    shutdown: S.shutdownAt, liquidations: S.N.liquidations, counts: S.N, fees: S.F, trades: trades.length, win_rate: trades.length ? wins.length / trades.length : null,
    profit_factor: gl > 0 ? gw / gl : trades.length ? Infinity : null, ledger_residual: id.ledger_residual, equity_identity_residual: id.equity_identity_residual,
    cash: S.cash, open: Object.keys(S.pos), positions: Object.fromEntries(Object.entries(S.pos).map(([a, p]) => [a, { ...p }])), curve: S.curve, trade_list: trades, events: S.events,
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
