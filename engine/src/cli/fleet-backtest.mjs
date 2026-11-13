// Backtests of the bot fleet (docs/MULTI-BOT-ARCHITECTURE.md §10), on real Kraken candles. Two separate models:
//
//   1. Strategy Mirror (TradingView reference): each bot's exact profile, the original strategy (onBar), LONG and SHORT,
//      fixed $10 reference risk, unlimited hypothetical buying power, zero commission and slippage, requested-price
//      limits. Reported per bot as gross P&L, and separately as a MODELLED net after Ndax-equivalent 0.20%/side fees.
//   2. Funded PAPER: each bot's OWN wallet funded by an equal-split group allocation, dollar-risk sizing (the bot's
//      riskUSD, never more than its wallet can fully pay), LONG and fully collateralised simulated SHORT, 0.20%/side
//      fees on every fill, fills at the candle close (the live Worker fills at the market price right after the close),
//      positive net profit swept to MAIN at every close (no compounding), losses reduce the bot's own wallet.
// All bots run in ONE chronological order of candle close (ties: priority, id): no lookahead, simultaneous positions.
//   node src/cli/fleet-backtest.mjs --sol1 data/SOLUSD-1m-14d.json --btc1 data/BTCUSD-1m-11d.json [--from 2026-11-01] [--out runs/x]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FleetLedgerSim, fromMicro } from "../capital.mjs";
import { getInstrument } from "../instruments.mjs";
import { INPUT_ENV, parseInputValue } from "../config.mjs";
import { abandonPosition, createState, onBar } from "../ote.mjs";

/** N-minute candles from real 1m candles: open first, high max, low min, close last; empty periods stay empty. */
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

export function stats(nets) {
  const wins = nets.filter((p) => p > 0), losses = nets.filter((p) => p < 0);
  let cum = 0, peak = 0, dd = 0;
  for (const p of nets) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const gl = -losses.reduce((s, p) => s + p, 0);
  return { trades: nets.length, net: cum, wins: wins.length, losses: losses.length, win_rate: nets.length ? wins.length / nets.length : null,
    profit_factor: gl > 0 ? wins.reduce((s, p) => s + p, 0) / gl : null, expectancy: nets.length ? cum / nets.length : null, max_drawdown: dd };
}

/**
 * bots: [{ id, group, symbol, intervalMin, priority, inputs, candles, riskUSD }]
 * allocations: [{ group, amountUsd }] made at the start (owner-approved allocations in the simulation)
 * fromMs: trades entering before this time are warm-up (excluded from the reports; the strategy still runs)
 */
export function runFleetBacktest({ bots, main = 0, allocations = [], feePct = 0.2, slippagePct = 0, limits = { maxOrderNotional: 5000, maxTotalExposure: 25000, maxOpenPositions: 5 }, fromMs = null, priceBufferPct = 0.5 }) {
  const ledger = new FleetLedgerSim({ bots: bots.map((b) => ({ id: b.id, group: b.group, priority: b.priority })), main, feePct, slippagePct, ...limits });
  for (const a of allocations) { const r = ledger.allocate(a.group, a.amountUsd); if (!r.ok) throw new Error(`allocation refused: ${r.code}`); }
  const run = bots.map((b) => {
    const instrument = getInstrument(b.symbol);
    const S = createState({ symbol: b.symbol, timeframeMin: b.intervalMin, inputs: b.inputs,
      sizing: { mode: "dollar", riskUSD: b.riskUSD, feePct, priceBufferPct, simulatedShort: true, symbol: b.symbol, instrument, limits } });
    const M = createState({ symbol: b.symbol, timeframeMin: b.intervalMin, inputs: b.inputs }); // reference: fixed $10, TradingView semantics
    return { b, S, M, step: b.intervalMin * 60_000, refused: {}, refusals: [], lastOrder: null, skipped: {}, mirrorClosed: 0, mirror: [] };
  });
  const timeline = [];
  for (const r of run) for (const k of r.b.candles) timeline.push({ close: k.t + r.step, r, k });
  timeline.sort((x, y) => (x.close - y.close) || (x.r.b.priority - y.r.b.priority) || x.r.b.id.localeCompare(y.r.b.id));
  let simultaneous = { sameSymbol: 0, opposing: 0, allFour: 0 };
  for (const { r, k } of timeline) {
    const { b, S } = r;
    const live = fromMs === null || k.t >= fromMs;
    S.capital = ledger.available(b.id);
    S.sizing.exposure = { position: 0, total: fromMicro(ledger.totalReservedMicro()), openPositions: ledger.positions.size };
    for (const e of onBar(S, k)) {
      if (e.type === "ORDER_SKIPPED" && live) r.skipped[e.code] = (r.skipped[e.code] ?? 0) + 1;
      if (e.type === "ORDER_PLACED") r.lastOrder = { ...e, capital: S.capital, sizing: S.lastSizing ?? null };
      if (e.type === "ENTRY_FILL") {
        const side = e.side === 1 ? "LONG" : "SHORT";
        const code = live ? ledger.open(b.id, side, e.qty, k.c, { openTime: k.t, symbol: b.symbol, riskUSD: b.riskUSD, instrument: getInstrument(b.symbol) }) : "WARMUP";
        if (code && live) {
          // Full evidence for every refusal: the planned order (sizing at placement) against the ledger's fill.
          const w = ledger.wallet[b.id], o = r.lastOrder, notional = e.qty * k.c * (1 + (side === "LONG" ? 1 : -1) * slippagePct / 100);
          r.refusals.push({ time: new Date(k.t).toISOString(), bot_id: b.id, signal_id: `ENG-${b.id}-${b.symbol}-${b.intervalMin}-${o?.bar ?? "?"}-${side === "LONG" ? "BUY" : "SELL"}`, direction: side,
            planned_limit: o?.limit ?? null, stop: o?.stop ?? null, qty: e.qty, fill_price: k.c, candle: { o: k.o, h: k.h, l: k.l, c: k.c },
            fill_vs_limit_pct: o?.limit ? ((k.c - o.limit) / o.limit) * 100 : null, capital_at_placement: o?.capital ?? null,
            available: fromMicro(w.available), reserved: fromMicro(w.reserved), required_collateral: notional, entry_fee: notional * feePct / 100, code });
        }
        if (code) { if (S.broker.pos) abandonPosition(S); if (live) r.refused[code] = (r.refused[code] ?? 0) + 1; }
      }
      if (e.type === "EXIT_FILL" && ledger.positions.has(b.id)) ledger.close(b.id, k.c, { closeTime: k.t, exitKind: e.kind });
    }
    onBar(r.M, k);
    while (r.mirrorClosed < r.M.broker.closed.length) {
      const t = r.M.broker.closed[r.mirrorClosed++];
      if (fromMs !== null && t.entryTime < fromMs) continue;
      const fees = (t.qty * t.entryPrice + t.qty * t.exitPrice) * feePct / 100;
      r.mirror.push({ gross: t.pnl, modelledNet: t.pnl - fees, side: t.side === 1 ? "LONG" : "SHORT" });
    }
    const open = [...ledger.positions.values()];
    const bySym = {};
    for (const p of open) (bySym[p.symbol] ??= []).push(p.side);
    for (const sides of Object.values(bySym)) {
      if (sides.length >= 2) simultaneous.sameSymbol += 1;
      if (sides.includes("LONG") && sides.includes("SHORT")) simultaneous.opposing += 1;
    }
    if (open.length >= 4) simultaneous.allFour += 1;
  }
  const perBot = Object.fromEntries(run.map((r) => {
    const T = ledger.trades.filter((t) => t.botId === r.b.id);
    const nets = T.map((t) => fromMicro(t.net));
    return [r.b.id, {
      symbol: r.b.symbol, timeframe: `${r.b.intervalMin}m`, risk_usd: r.b.riskUSD,
      funded: { ...stats(nets), gross: T.reduce((s, t) => s + fromMicro(t.gross), 0), fees: T.reduce((s, t) => s + fromMicro(t.entryFee + t.exitFee), 0),
        long_trades: T.filter((t) => t.side === "LONG").length, short_trades: T.filter((t) => t.side === "SHORT").length,
        swept_to_main: T.reduce((s, t) => s + fromMicro(t.sweep), 0), shortfall: T.reduce((s, t) => s + fromMicro(t.shortfall), 0),
        median_qty: T.length ? [...T.map((t) => t.qty)].sort((a, c) => a - c)[Math.floor(T.length / 2)] : null,
        median_notional: T.length ? [...T.map((t) => fromMicro(t.collateral))].sort((a, c) => a - c)[Math.floor(T.length / 2)] : null,
        refused: r.refused, refusals: r.refusals, reduced_to_fit: ledger.reductions.filter((x) => x.botId === r.b.id).length, skipped: r.skipped, wallet_end: ledger.available(r.b.id), open_at_end: ledger.positions.has(r.b.id) },
      mirror_reference: { ...stats(r.mirror.map((m) => m.gross)), long_trades: r.mirror.filter((m) => m.side === "LONG").length, short_trades: r.mirror.filter((m) => m.side === "SHORT").length,
        modelled_net_after_fees: r.mirror.reduce((s, m) => s + m.modelledNet, 0) },
    }];
  }));
  const allNets = ledger.trades.slice().sort((a, b) => (a.closeTime ?? 0) - (b.closeTime ?? 0)).map((t) => fromMicro(t.net));
  return {
    per_bot: perBot,
    combined: { funded: { ...stats(allNets), fees: ledger.trades.reduce((s, t) => s + fromMicro(t.entryFee + t.exitFee), 0),
      swept_to_main: ledger.sweeps.reduce((s, x) => s + fromMicro(x.amountMicro), 0), main_end: fromMicro(ledger.wallet.MAIN.available) },
      peak_concurrent_positions: ledger.peakConcurrent, candle_closes_with: simultaneous, reconciles: ledger.reconciles(),
      allocations: ledger.allocations.map((a) => ({ group: a.group, amount: fromMicro(a.amountMicro), split: a.split.map((s) => ({ bot: s.botId, amount: fromMicro(s.amountMicro) })) })) },
  };
}

/**
 * A profile's strategy inputs, read with the ENGINE's own key mapping and value parser (src/config.mjs), so research
 * and the live engine can never disagree. Every STRAT_* line must be a known input: an unknown or misspelled key is an
 * error, never silently skipped. (Defect fixed 2026-11-13: the old local regex STRAT_[A-Z_]+ could not match
 * STRAT_TP2_EXT, so every research run used the Pine default TP2 -0.27 instead of the profile's value.)
 */
export function profileInputs(dir, profile) {
  const out = {};
  for (const raw of readFileSync(join(dir, "profiles", `${profile}.env`), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(STRAT_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const input = INPUT_ENV[m[1]];
    if (!input) throw new Error(`${profile}: unknown strategy input ${m[1]}`);
    out[input] = parseInputValue(m[1], input, m[2]);
  }
  return out;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/fleet-backtest.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const sol1 = JSON.parse(readFileSync(arg("sol1"), "utf8")).candles, btc1 = JSON.parse(readFileSync(arg("btc1"), "utf8")).candles;
  const from = arg("from", "2026-11-01T00:00:00Z"), fromMs = Date.parse(from);
  const to = arg("to", null), toMs = to ? Date.parse(to) : Infinity;
  const clip = (c) => c.filter((k) => k.t < toMs);
  const cwd = process.cwd();
  const def = [
    { id: "ALPHA-01", group: "SOLANA", symbol: "SOLUSD", intervalMin: 1, priority: 2, profile: "solusd-1m", candles: clip(sol1) },
    { id: "ALPHA-02", group: "SOLANA", symbol: "SOLUSD", intervalMin: 5, priority: 1, profile: "solusd-5m", candles: clip(aggregate(sol1, 5)) },
    { id: "ALPHA-03", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 1, priority: 3, profile: "btcusd-1m", candles: clip(btc1) },
    { id: "ALPHA-04", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 5, priority: 4, profile: "btcusd-5m", candles: clip(aggregate(btc1, 5)) },
  ].map((b) => ({ ...b, inputs: profileInputs(cwd, b.profile), riskUSD: Number(arg("risk", "10")) }));
  const results = [];
  for (const perBot of arg("balances", "5,10,25,50,100,500,1000").split(",").map(Number)) {
    for (const slip of [0, 0.05]) {
      const r = runFleetBacktest({ bots: def, main: perBot * 4, allocations: [{ group: "SOLANA", amountUsd: perBot * 2 }, { group: "BITCOIN", amountUsd: perBot * 2 }], slippagePct: slip, fromMs });
      results.push({ allocation_per_bot: perBot, slippage_pct_per_side: slip, ...r });
    }
  }
  const out = arg("out", join("runs", `fleet-${Date.now()}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "fleet-backtest.json"), JSON.stringify({ from, to, candles: Object.fromEntries(def.map((b) => [b.id, b.candles.length])), fee_model: "Ndax-equivalent 0.20% per fill", results }, null, 1));
  console.log(JSON.stringify({ out, runs: results.length, candles: Object.fromEntries(def.map((b) => [b.id, b.candles.length])) }));
}
