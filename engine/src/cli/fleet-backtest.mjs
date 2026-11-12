// Combined backtest of a fleet of independent bots sharing PAPER capital (docs/MULTI-BOT-ARCHITECTURE.md §10).
//   node src/cli/fleet-backtest.mjs --one-minute data/SOLUSD-1m-14d.json [--balances 10,25,50,100,500,1000] [--out runs/fleet]
//
// * Every bot runs its own strategy instance (the engine's onBar) on its own timeframe's completed candles.
// * All candles of all bots are processed in ONE chronological order of candle CLOSE time (ties: bot priority, then
//   id), so no bot sees the future and the shared ledger sees orders in the order they would really arrive.
// * Funded track: percent sizing (1% of available allocated equity, max $10) through the capital book (earmarks of other
//   bots' resting entries) and a simulated ALPHA PAPER ledger with the Worker's rules (src/capital.mjs SimLedger):
//   long-only, full cost reserved from the shared wallet at fill, optional per-bot caps, account-wide limits, fees and
//   slippage on both sides. Fills happen at the candle close (the live Worker fills at the market price right after the
//   candle closes). A refused entry is dropped, exactly as the live engine drops it.
// * Strategy Mirror: one independent hypothetical strategy per bot at its fixed research risk (TradingView semantics,
//   no capital limit). Reported separately; never mixed with PAPER balances.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapitalBook, pendingEntryCost, SimLedger } from "../capital.mjs";
import { getInstrument } from "../instruments.mjs";
import { abandonPosition, createState, onBar } from "../ote.mjs";

/** 5m (or any N-minute) candles from real 1m candles: open first, high max, low min, close last; empty periods stay empty. */
export function aggregate(candles, intervalMin) {
  const step = intervalMin * 60_000;
  const out = [];
  for (const k of candles) {
    const t = k.t - (k.t % step);
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.n = (last.n ?? 0) + (k.n ?? 0); }
    else out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, n: k.n ?? 0 });
  }
  return out;
}

const stats = (pnls) => {
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p < 0);
  let cum = 0, peak = 0, dd = 0;
  for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const gl = -losses.reduce((s, p) => s + p, 0);
  return { trades: pnls.length, net: cum, win_rate: pnls.length ? wins.length / pnls.length : null, profit_factor: gl > 0 ? wins.reduce((s, p) => s + p, 0) / gl : null, max_drawdown: dd };
};

/**
 * bots: [{ id, symbol, intervalMin, wallet, priority, inputs, pivotTies, candles }]
 * ledger: SimLedger options ({ wallets, caps, feePct, slippagePct, maxOrderNotional, maxTotalExposure, maxOpenPositions })
 * policy: { riskPct, maxRiskUSD, feePct, priceBufferPct } (the funded sizing policy; feePct here is the sizing headroom)
 */
export function runFleetBacktest({ bots, ledger: ledgerOpts, policy = { riskPct: 1, maxRiskUSD: 10, feePct: 0.4, priceBufferPct: 0.5 } }) {
  const ledger = new SimLedger(ledgerOpts);
  const book = new CapitalBook();
  const run = bots.map((b) => {
    const instrument = getInstrument(b.symbol);
    const S = createState({ symbol: b.symbol, timeframeMin: b.intervalMin, inputs: b.inputs, pivotTies: b.pivotTies,
      sizing: { mode: "percent", ...policy, symbol: b.symbol, instrument,
        limits: { maxOrderNotional: ledgerOpts.maxOrderNotional ?? null, maxTotalExposure: ledgerOpts.maxTotalExposure ?? null, maxOpenPositions: ledgerOpts.maxOpenPositions ?? null } } });
    // The mirror: same inputs, fixed research risk, no capital limit (TradingView semantics).
    const M = createState({ symbol: b.symbol, timeframeMin: b.intervalMin, inputs: b.inputs, pivotTies: b.pivotTies });
    book.register(b.id, { wallet: b.wallet, priority: b.priority, pendingCost: () => pendingEntryCost(S) });
    return { b, S, M, step: b.intervalMin * 60_000, trades: [], refused: [], skipped: {}, entries: 0, mirrorClosed: 0, mirrorPnls: [] };
  });
  const timeline = [];
  for (const r of run) for (const k of r.b.candles) timeline.push({ close: k.t + r.step, r, k });
  timeline.sort((x, y) => (x.close - y.close) || (x.r.b.priority - y.r.b.priority) || x.r.b.id.localeCompare(y.r.b.id));
  let utilSum = 0, utilN = 0, maxConcurrentSameSymbol = 0, concurrentSince = null, concurrentMs = 0;
  for (const { close, r, k } of timeline) {
    const { b, S } = r;
    S.capital = book.capitalFor(b.id, ledger.availableFor(b.id, b.wallet));
    const reservedTotal = ledger.totalReserved();
    S.sizing.exposure = { position: ledger.positions.get(b.id)?.cost ?? 0, total: reservedTotal, openPositions: ledger.positions.size };
    for (const e of onBar(S, k)) {
      if (e.type === "ORDER_SKIPPED") r.skipped[e.code] = (r.skipped[e.code] ?? 0) + 1;
      if (e.type === "ENTRY_FILL") {
        const code = e.side !== 1 ? "SHORT_SELLING_DISABLED" : ledger.buy(b.id, b.wallet, e.qty, k.c);
        if (code) { if (S.broker.pos) abandonPosition(S); r.refused.push({ time: new Date(k.t).toISOString(), qty: e.qty, code }); }
        else r.entries += 1;
      }
      if (e.type === "EXIT_FILL" && ledger.positions.has(b.id)) {
        const p = ledger.positions.get(b.id);
        const before = ledger.realized[b.id] ?? 0;
        ledger.sell(b.id, k.c);
        // trade P&L = proceeds − cost − exit fee (the delta) − the entry fee booked when it filled
        r.trades.push({ t: close, pnl: (ledger.realized[b.id] - before) - p.cost * ledger.feePct / 100 });
      }
    }
    // Mirror (hypothetical): its own state, its own fills; P&L from its own closed trades.
    onBar(r.M, k);
    while (r.mirrorClosed < r.M.broker.closed.length) r.mirrorPnls.push(r.M.broker.closed[r.mirrorClosed++].pnl);
    // utilisation and simultaneous positions (time-weighted at candle closes)
    const book$ = ledger.totalReserved(), eq = Object.values(ledger.available).reduce((s, v) => s + v, 0) + book$;
    if (eq > 0) { utilSum += book$ / eq; utilN += 1; }
    const sameSymbolOpen = new Map();
    for (const [id] of ledger.positions) { const s = run.find((x) => x.b.id === id).b.symbol; sameSymbolOpen.set(s, (sameSymbolOpen.get(s) ?? 0) + 1); }
    const conc = Math.max(0, ...sameSymbolOpen.values());
    maxConcurrentSameSymbol = Math.max(maxConcurrentSameSymbol, conc);
    if (ledger.positions.size >= 2 && concurrentSince === null) concurrentSince = close;
    if (ledger.positions.size < 2 && concurrentSince !== null) { concurrentMs += close - concurrentSince; concurrentSince = null; }
  }
  // positions still open at the end are reported, not closed at an invented price
  const perBot = Object.fromEntries(run.map((r) => [r.b.id, {
    symbol: r.b.symbol, timeframe: `${r.b.intervalMin}m`, candles: r.b.candles.length,
    paper: { ...stats(r.trades.map((x) => x.pnl)), entries_accepted: r.entries, refused: r.refused.length, refused_by_code: r.refused.reduce((a, x) => ((a[x.code] = (a[x.code] ?? 0) + 1), a), {}),
      skipped_by_code: r.skipped, fees: ledger.fees[r.b.id] ?? 0, open_at_end: ledger.positions.has(r.b.id) },
    mirror_hypothetical: stats(r.mirrorPnls),
  }]));
  const allPnls = run.flatMap((r) => r.trades).sort((a, b) => a.t - b.t).map((x) => x.pnl);
  const startTotal = Object.values(ledger.start).reduce((s, v) => s + v, 0);
  const endTotal = Object.values(ledger.available).reduce((s, v) => s + v, 0) + ledger.totalReserved();
  return {
    per_bot: perBot,
    combined: {
      paper: { ...stats(allPnls), start_equity: startTotal, end_equity_at_cost: endTotal,
        refused: run.reduce((s, r) => s + r.refused.length, 0), fees: Object.values(ledger.fees).reduce((s, v) => s + v, 0) },
      capital_utilization_avg: utilN ? utilSum / utilN : 0, peak_reserved: ledger.peakReserved, min_available: ledger.minAvailable, peak_concurrent_positions: ledger.peakConcurrent,
      max_concurrent_same_symbol: maxConcurrentSameSymbol, time_with_two_or_more_positions_hours: concurrentMs / 3_600_000,
      reconciles: ledger.reconciles(), trades_total: allPnls.length,
    },
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/fleet-backtest.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const one = JSON.parse(readFileSync(arg("one-minute"), "utf8"));
  const c1 = one.candles, c5 = aggregate(c1, 5);
  const profile = Object.fromEntries(readFileSync(join(process.cwd(), "profiles", "solusd-5m.env"), "utf8").split(/\r?\n/).filter((l) => /^STRAT_/.test(l)).map((l) => l.split("=")));
  const toInput = { STRAT_SWING_LEN: "swingLen", STRAT_MIN_LEG_ATR: "minLegATR", STRAT_MAX_AGE: "maxAge", STRAT_ENTRY_MODE: "entryMode", STRAT_SL_MODE: "slMode", STRAT_SL_BUF: "slBuf", STRAT_TP2_EXT: "tp2Ext",
    STRAT_MIN_SCORE: "minScore", STRAT_USE_FVG: "useFVG", STRAT_FVG_MIN_ATR: "fvgMinATR", STRAT_USE_OB: "useOB", STRAT_DISP_ATR: "dispATR", STRAT_USE_RB: "useRB", STRAT_RB_WICK: "rbWick",
    STRAT_RB_MIN_ATR: "rbMinATR", STRAT_RB_LOOK: "rbLook", STRAT_MAX_ZONES: "maxZones", STRAT_ALLOW_LONG: "allowLong", STRAT_ALLOW_SHORT: "allowShort", STRAT_RISK_USD: "riskUSD",
    STRAT_USE_BE: "useBE", STRAT_BE_FRAC: "beFrac", STRAT_USE_TRAIL: "useTrail", STRAT_TRAIL_FRAC: "trailFrac", STRAT_TRAIL_LEN: "trailLen", STRAT_TRAIL_BUF: "trailBuf",
    STRAT_USE_HOURS: "useHours", STRAT_WEEKEND_FLAT: "weekendFlat", STRAT_USE_SLEEP: "useSleep", STRAT_HOURS_TZ: "hoursTz" };
  const inputs = {};
  for (const [k, v] of Object.entries(profile)) { const n = toInput[k]; if (!n) continue; inputs[n] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) ? Number(v) : v; }
  const balances = arg("balances", "10,25,50,100,500,1000").split(",").map(Number);
  const scenarios = [
    { name: "no costs (TradingView parity)", feePct: 0, slippagePct: 0 },
    { name: "0.25% fee + 0.05% slippage per side (ASSUMPTION)", feePct: 0.25, slippagePct: 0.05 },
    { name: "0.40% fee + 0.05% slippage per side (ASSUMPTION)", feePct: 0.4, slippagePct: 0.05 },
  ];
  const bots = (which) => [
    { id: "ALPHA-02", symbol: "SOLUSD", intervalMin: 5, wallet: "SOLUSD", priority: 1, inputs, candles: c5 },
    // PLACEHOLDER INPUTS: the owner's 5m inputs reused on 1m only to exercise the mechanics. NOT the owner's 1m settings.
    { id: "ALPHA-01", symbol: "SOLUSD", intervalMin: 1, wallet: "SOLUSD", priority: 2, inputs, candles: c1 },
  ].filter((b) => which.includes(b.id));
  const results = [];
  for (const sc of scenarios) for (const bal of balances) for (const set of [["ALPHA-02"], ["ALPHA-01"], ["ALPHA-01", "ALPHA-02"]]) {
    const r = runFleetBacktest({ bots: bots(set), ledger: { wallets: { SOLUSD: bal }, feePct: sc.feePct, slippagePct: sc.slippagePct, maxOrderNotional: 5000, maxTotalExposure: 25000, maxOpenPositions: 5 } });
    results.push({ scenario: sc.name, balance: bal, bots: set.join("+"), ...r });
  }
  const out = arg("out", join("runs", `fleet-${Date.now()}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "fleet-backtest.json"), JSON.stringify({ data: { source: one.source, from: one.from, to: one.to, candles_1m: c1.length, candles_5m: c5.length,
    note: "ALPHA-01 uses PLACEHOLDER inputs (the 5m profile) until the owner supplies the exact 1m settings" }, results }, null, 1));
  console.log(JSON.stringify({ out, candles_1m: c1.length, candles_5m: c5.length, runs: results.length }));
}
