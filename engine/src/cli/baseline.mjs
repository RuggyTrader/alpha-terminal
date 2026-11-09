// Corrected baseline study of the ORIGINAL strategy (research only; nothing here changes the engine, its settings or
// the ledger). Runs the exact solusd-5m profile (both directions, fixed $10 risk, Pine trade logic, TradingView's
// documented fill emulator) over the recorded Kraken SOLUSD 5m history and separates three performance models:
//
//   A  Exact TradingView equivalent: the strategy's own trades and quantities, no fees, no capital limit
//      (Properties: margin 0 = TradingView simulates no margin calls; positions are not limited by equity).
//   B  The SAME trade list as A with transaction costs applied to each fill (fees by order type, slippage on orders
//      that take liquidity, as a price penalty). No trade is added, removed or re-timed.
//   C  What the current ALPHA PAPER ledger could actually execute: long-only, balance-limited (no leverage), the
//      Worker's order limit, costs deducted from the balance. Refused entries are dropped as the live engine does,
//      so C is a different trade sequence, reported separately.
//
//   node src/cli/baseline.mjs --candles data/SOLUSD-5m-150d.json [--reference-candles data/SOLUSD-5m-25d.json] [--out runs/baseline]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";
import { VENUES } from "../costs.mjs";
import { abandonPosition, createState, onBar } from "../ote.mjs";
import { runBacktest } from "./backtest.mjs";

const STEP = 5 * 60_000;
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- data integrity

/** Independent re-check of a candle file: order, grid alignment, duplicates, OHLC validity, gaps, overlaps. */
export function verifyCandles(candles, { from, to, references = [] } = {}) {
  const issues = { unordered: 0, duplicates: 0, offGrid: 0, invalidOHLC: 0, nonPositive: 0 };
  const gaps = [];
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    if (k.t % STEP !== 0) issues.offGrid += 1;
    if (!(k.l <= Math.min(k.o, k.c) && k.h >= Math.max(k.o, k.c) && k.l <= k.h)) issues.invalidOHLC += 1;
    if (!(k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0)) issues.nonPositive += 1;
    if (i > 0) {
      const d = k.t - candles[i - 1].t;
      if (d === 0) issues.duplicates += 1;
      else if (d < 0) issues.unordered += 1;
      else if (d > STEP) gaps.push({ after: iso(candles[i - 1].t), missing: d / STEP - 1, first_missing: iso(candles[i - 1].t + STEP) });
    }
  }
  const expected = from !== undefined && to !== undefined ? (to - from) / STEP : null;
  const byT = new Map(candles.map((k) => [k.t, k]));
  const refs = references.map(({ name, candles: rc }) => {
    let compared = 0, mismatched = 0, missingHere = 0;
    const examples = [];
    for (const k of rc) {
      const m = byT.get(k.t);
      if (!m) { missingHere += 1; continue; }
      compared += 1;
      if (m.o !== k.o || m.h !== k.h || m.l !== k.l || m.c !== k.c) { mismatched += 1; if (examples.length < 3) examples.push(iso(k.t)); }
    }
    return { name, reference_candles: rc.length, compared, mismatched, missing_here: missingHere, examples };
  });
  return {
    candles: candles.length, first: iso(candles[0].t), last: iso(candles[candles.length - 1].t),
    expected_intervals: expected, missing_intervals: gaps.reduce((s, g) => s + g.missing, 0), gaps,
    longest_gap_candles: gaps.reduce((m, g) => Math.max(m, g.missing), 0), ...issues, references: refs,
  };
}

// ---------------------------------------------------------------- per-trade costs (Model B)

/**
 * Costs of one closed trade under a venue. Entry is a resting limit (Limit @ 0.705) → maker fee, no slippage.
 * A TP2 exit is a resting limit → maker fee, no slippage. Stops (initial, break-even, trailing) and close_all exits
 * take liquidity → taker fee, and the fill price is moved against the trade by the venue's slippage %.
 * Slippage is applied as a price penalty to the SAME fill; it never changes which trades happen or when.
 */
export function tradeCosts(t, venue) {
  const inVal = t.qty * t.entryPrice;
  const outVal = t.qty * t.exitPrice;
  const exitTaker = t.exitKind !== "TP";
  const entryFee = inVal * (venue.makerPct / 100);
  const slippage = exitTaker ? outVal * (venue.takerSlipPct / 100) : 0;
  // The exit fee is charged on the slipped exit value.
  const slippedOut = outVal + (t.side === "LONG" ? -slippage : slippage);
  const exitFee = slippedOut * ((exitTaker ? venue.takerPct : venue.makerPct) / 100);
  return { entryFee, exitFee, slippage, total: entryFee + exitFee + slippage };
}

// ---------------------------------------------------------------- metrics

/** Summary of a trade list. pnlOf(t) chooses gross (A) or net (B) P&L. Drawdown on closed-trade equity. */
export function metrics(trades, pnlOf = (t) => t.pnl) {
  const p = trades.map(pnlOf);
  const grossProfit = p.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossLoss = -p.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const x of p) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const by = (r) => trades.filter((t) => t.result === r).length;
  return {
    trades: trades.length,
    longs: trades.filter((t) => t.side === "LONG").length,
    shorts: trades.filter((t) => t.side === "SHORT").length,
    winners: p.filter((x) => x > 0).length,
    breakeven: p.filter((x) => x === 0).length,
    losers: p.filter((x) => x < 0).length,
    win_rate_pct: trades.length ? r2((100 * p.filter((x) => x > 0).length) / trades.length) : null,
    gross_profit: r2(grossProfit),
    gross_loss: r2(grossLoss),
    net: r2(eq),
    profit_factor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 1000) / 1000 : null,
    max_drawdown: r2(dd),
    avg_per_trade: trades.length ? r4(eq / trades.length) : null,
    exits: { tp2: by("TP2"), stop_loss: by("SL"), trailing_stop: by("TRAILING_SL"), break_even: by("BREAK_EVEN"), time_exit: by("TIME_EXIT"), same_bar: by("SAME_BAR") },
    traded_notional: r2(trades.reduce((s, t) => s + t.qty * t.entryPrice + t.qty * t.exitPrice, 0)),
  };
}

/** Equity from a starting capital at each close, plus the position size each entry implied against equity. */
export function equityPath(trades, start, pnlOf = (t) => t.pnl) {
  let eq = start, minEq = start, firstNegative = null, maxLev = 0, maxNotional = 0, maxNotionalAt = null;
  const points = [{ t: trades.length ? Date.parse(trades[0].entryTime) : null, eq: start }];
  for (const t of trades) {
    const notional = t.qty * t.entryPrice;
    if (notional > maxNotional) { maxNotional = notional; maxNotionalAt = t.entryTime; }
    if (eq > 0) maxLev = Math.max(maxLev, notional / eq);
    eq += pnlOf(t);
    minEq = Math.min(minEq, eq);
    if (eq < 0 && firstNegative === null) firstNegative = t.exitTime;
    points.push({ t: Date.parse(t.exitTime), eq: r4(eq) });
  }
  const over = trades.filter((t) => t.qty * t.entryPrice > start).length;
  return {
    start, end: r2(eq), min_equity: r2(minEq), equity_went_negative: firstNegative !== null, first_negative_at: firstNegative,
    max_position_notional: r2(maxNotional), max_position_notional_at: maxNotionalAt,
    max_notional_to_equity: r2(maxLev), entries_larger_than_start_capital: over, points,
  };
}

const side = (trades, s) => trades.filter((t) => t.side === s);

/**
 * Model C: the original strategy driven through the current ALPHA PAPER ledger rules. Fixed $10 risk is kept (no
 * percent sizing substituted); an entry the ledger would refuse is dropped as the live engine does.
 */
export function modelC(candles, inputs, startCapital, venue, { maxNotional = 5000, longOnly = true } = {}) {
  const S = createState({ symbol: "SOLUSD", timeframeMin: 5, inputs });
  let balance = startCapital;
  const refused = {};
  const refusedTrades = new Set();
  const executed = [];
  let seen = 0, minBalance = startCapital;
  for (const k of candles) {
    const events = onBar(S, k);
    for (const e of events) {
      if (e.type !== "ENTRY_FILL") continue;
      const value = e.qty * k.c; // the ledger fills at the reference price a moment after the candle closes
      const fee = value * (venue.makerPct / 100);
      const code = longOnly && e.side !== 1 ? "SHORT_SELLING_DISABLED"
        : value < (venue.minOrderUsd ?? 0) ? "BELOW_MIN_ORDER"
        : value + fee > balance + 1e-9 ? "INSUFFICIENT_PAPER_CAPITAL"
        : maxNotional && value > maxNotional ? "MAX_ORDER_NOTIONAL" : null;
      if (!code) continue;
      refused[code] = (refused[code] ?? 0) + 1;
      if (S.broker.pos) abandonPosition(S);
      else refusedTrades.add(S.broker.closed[S.broker.closed.length - 1]); // filled and exited inside this candle
    }
    while (seen < S.broker.closed.length) {
      const t = S.broker.closed[seen++];
      if (refusedTrades.has(t)) continue;
      const row = { side: t.side === 1 ? "LONG" : "SHORT", qty: t.qty, entryPrice: t.entryPrice, exitPrice: t.exitPrice, exitKind: t.exitKind,
        result: t.result ?? null, pnl: t.pnl, entryTime: iso(t.entryTime), exitTime: iso(t.exitTime) };
      const c = tradeCosts(row, venue);
      balance += t.pnl - c.total;
      minBalance = Math.min(minBalance, balance);
      executed.push({ ...row, costs: c.total });
    }
  }
  const m = metrics(executed, (t) => t.pnl - t.costs);
  return {
    start_capital: startCapital, executed_trades: executed.length, executed_longs: m.longs, executed_shorts: m.shorts,
    refused_entries: Object.values(refused).reduce((a, b) => a + b, 0), refused_by_reason: refused,
    gross: r2(executed.reduce((s, t) => s + t.pnl, 0)), costs: r2(executed.reduce((s, t) => s + t.costs, 0)),
    net: m.net, profit_factor_net: m.profit_factor, max_drawdown_net: m.max_drawdown,
    end_balance: r2(balance), min_balance: r2(minBalance), balance_went_negative: minBalance < 0,
  };
}

// ---------------------------------------------------------------- study

export function study({ candles, inputs, references = [], from, to, benchmark = null }) {
  const out = { data: verifyCandles(candles, { from, to, references }) };
  const run = (opts = {}) => runBacktest({ candles: opts.candles ?? candles, symbol: "SOLUSD", intervalMin: 5, inputs, fill: opts.fill, ledger: opts.ledger }).trades;

  // ---- Model A
  const A = run();
  out.model_a = {
    description: "Exact original strategy: both directions, fixed $10 risk, Pine quantities, TradingView documented fill emulator, no fees, no capital limit.",
    all: metrics(A), long: metrics(side(A, "LONG")), short: metrics(side(A, "SHORT")),
    equity_from_100: equityPath(A, 100),
    equity_from_10000: { ...equityPath(A, 10_000), points: undefined },
  };

  // Fill-property sensitivity: the two recorded Properties the 25-day benchmark could not distinguish.
  out.fill_property_sensitivity = [
    { name: "documented default (limit gap fills at open; exits may fill on the entry's tick path)", fill: undefined },
    { name: "limit orders at requested price", fill: { limitPrice: "requested" } },
    { name: "exit one tick after entry fill", fill: { exitDelayTicks: 1 } },
    { name: "requested price + one-tick exit delay", fill: { limitPrice: "requested", exitDelayTicks: 1 } },
  ].map(({ name, fill }) => {
    const tr = fill ? run({ fill }) : A;
    const ids = new Set(A.map((t) => `${t.side}${t.entryTime}${t.exitTime}${t.entryPrice}${t.exitPrice}`));
    const m = metrics(tr);
    return { name, trades: m.trades, net: m.net, profit_factor: m.profit_factor, max_drawdown: m.max_drawdown, identical_trades_to_default: tr.filter((t) => ids.has(`${t.side}${t.entryTime}${t.exitTime}${t.entryPrice}${t.exitPrice}`)).length };
  });

  // ---- benchmark window inside this dataset
  if (benchmark) {
    const inWin = (t) => Date.parse(t.entryTime) >= benchmark.from && Date.parse(t.entryTime) < benchmark.to;
    const fresh = run({ candles: candles.filter((k) => k.t >= benchmark.from && k.t <= benchmark.lastCandle) });
    const longHist = A.filter(inWin);
    const key = (t) => `${t.side}${t.entryTime}${t.exitTime}`;
    const freshIds = new Set(fresh.map(key));
    const m = metrics(fresh);
    out.benchmark = {
      window: `${iso(benchmark.from)} .. ${iso(benchmark.lastCandle)} (last candle)`,
      history_started_at_window: { trades: m.trades, winners: m.winners, net: m.net, profit_factor: m.profit_factor, max_drawdown: m.max_drawdown },
      reference: benchmark.reference,
      long_history_trades_in_window: { ...(({ trades, winners, net, profit_factor, max_drawdown }) => ({ trades, winners, net, profit_factor, max_drawdown }))(metrics(longHist)), identical_to_window_start_run: longHist.filter((t) => freshIds.has(key(t))).length },
      listed_trade_checks: (benchmark.listed ?? []).map((r) => {
        const t = fresh[r.n - 1];
        return { n: r.n, ok: !!t && t.side === r.side && t.entryTime.replace(".000Z", "Z") === r.entry && t.exitTime.replace(".000Z", "Z") === r.exit
          && Math.abs(t.entryPrice - r.entry_price) < 0.005 && Math.abs(t.exitPrice - r.exit_price) < 0.005 && Math.abs(t.qty - r.qty) < 0.006 && Math.abs(t.pnl - r.pnl) < 0.006 };
      }),
      max_position_notional_in_window: r2(Math.max(...fresh.map((t) => t.qty * t.entryPrice))),
      traded_notional_in_window: r2(fresh.reduce((s, t) => s + t.qty * (t.entryPrice + t.exitPrice), 0)),
    };
  }

  // ---- Model B: same trades + costs
  const venues = {
    none: VENUES.none,
    ndax: VENUES.ndax,
    ndax_slip_0_2: { ...VENUES.ndax, name: "Ndax, 2x slippage (0.20%)", takerSlipPct: 0.2 },
    kraken: VENUES.kraken,
    kraken_slip_0_1: { ...VENUES.kraken, name: "Kraken Pro Tier 1, slippage 0.10%", takerSlipPct: 0.1 },
  };
  out.model_b = {};
  for (const [id, v] of Object.entries(venues)) {
    const costs = A.map((t) => tradeCosts(t, v));
    const net = new Map(A.map((t, i) => [t, t.pnl - costs[i].total]));
    const pnlOf = (t) => net.get(t);
    const sum = (f, list = A) => r2(list.reduce((s, t) => s + f(costs[A.indexOf(t)]), 0));
    const part = (list) => ({ ...metrics(list, pnlOf), gross: r2(list.reduce((s, t) => s + t.pnl, 0)), costs: sum((c) => c.total, list) });
    out.model_b[id] = {
      venue: v.name, maker_pct: v.makerPct, taker_pct: v.takerPct, taker_slippage_pct: v.takerSlipPct,
      gross: r2(A.reduce((s, t) => s + t.pnl, 0)),
      entry_fees: sum((c) => c.entryFee), exit_fees: sum((c) => c.exitFee), slippage: sum((c) => c.slippage), total_costs: sum((c) => c.total),
      ...metrics(A, pnlOf),
      long: part(side(A, "LONG")), short: part(side(A, "SHORT")),
      equity_from_100: { ...equityPath(A, 100, pnlOf), points: id === "ndax" || id === "kraken" ? equityPath(A, 100, pnlOf).points : undefined },
      cost_per_trade_avg: r4(costs.reduce((s, c) => s + c.total, 0) / Math.max(1, A.length)),
      trades_flipped_win_to_loss: A.filter((t, i) => t.pnl > 0 && t.pnl - costs[i].total <= 0).length,
    };
  }

  // Different execution replay (not the same trade list): conservative limit fills, price must trade 1 tick through.
  const C1 = run({ fill: { limitThroughTicks: 1, tick: 0.01 } });
  const c1n = C1.map((t) => t.pnl - tradeCosts(t, VENUES.ndax).total);
  out.conservative_fill_replay = {
    description: "Separate replay: a resting limit (entry or TP2) fills only if price trades one tick through it. Changes which trades happen; not comparable trade-for-trade with A/B.",
    gross: (({ trades, longs, shorts, net, profit_factor, max_drawdown }) => ({ trades, longs, shorts, net, profit_factor, max_drawdown }))(metrics(C1)),
    ndax_net: r2(c1n.reduce((a, b) => a + b, 0)),
  };

  // ---- Model C: executable on the current ALPHA PAPER ledger
  out.model_c = [10, 100, 10_000].map((startCapital) => modelC(candles, inputs, startCapital, VENUES.ndax));
  out.model_c_note = "Long-only, balance-limited (entry value + entry fee ≤ available balance, no leverage or borrowing), $5,000 Worker order limit, Ndax $5 minimum, Ndax costs (fees and slippage) deducted from the balance at each close. A refused entry is dropped exactly as the live engine does, so the strategy's later trades can differ from A. A refused entry that filled and exited inside one candle is removed from the executed list (it never reached the ledger). Every short of Model A is unrepresentable on the current ledger.";
  // How many trades the shared backtest helper's long-only ledger option (used by the earlier research) let through
  // although refused: entries that fill and exit in the same candle are closed before the refusal is checked.
  {
    const r = runBacktest({ candles, symbol: "SOLUSD", intervalMin: 5, inputs, ledger: { startCapital: 10_000, feePct: 0, maxNotional: null, longOnly: true } });
    out.helper_same_bar_leak = { shorts_counted_by_long_only_helper: r.trades.filter((t) => t.side === "SHORT").length, same_bar_trades_in_a: A.filter((t) => t.result === "SAME_BAR").length };
  }

  // ---- chronological stability of the ORIGINAL (no selection involved): 60/40 split and calendar months
  const splitMs = from + Math.round((to - from) * 0.6);
  const ndaxNet = (t) => t.pnl - tradeCosts(t, VENUES.ndax).total;
  const seg = (list) => ({ trades: list.length, gross: r2(list.reduce((s, t) => s + t.pnl, 0)), ndax_net: r2(list.reduce((s, t) => s + ndaxNet(t), 0)), profit_factor_gross: metrics(list).profit_factor });
  out.periods = {
    split_at: iso(splitMs),
    first_60pct: seg(A.filter((t) => Date.parse(t.entryTime) < splitMs)),
    last_40pct: seg(A.filter((t) => Date.parse(t.entryTime) >= splitMs)),
    months: [...new Set(A.map((t) => t.entryTime.slice(0, 7)))].map((mo) => ({ month: mo, ...seg(A.filter((t) => t.entryTime.startsWith(mo))) })),
  };

  // ---- trades that touch a data gap (bars are a sequence; a gap is simply no bar, as on TradingView's Kraken feed)
  const gapStarts = out.data.gaps.map((g) => Date.parse(g.first_missing));
  out.gap_effects = {
    trades_open_across_a_gap: A.filter((t) => gapStarts.some((g) => g > Date.parse(t.entryTime) && g <= Date.parse(t.exitTime))).map((t) => `${t.side} ${t.entryTime} → ${t.exitTime}`),
  };

  out.trades = A.map((t) => {
    const c = tradeCosts(t, VENUES.ndax), k = tradeCosts(t, VENUES.kraken);
    return { ...t, notional: r2(t.qty * t.entryPrice), ndax_costs: r4(c.total), ndax_net: r4(t.pnl - c.total), kraken_costs: r4(k.total), kraken_net: r4(t.pnl - k.total) };
  });
  return out;
}

// ---------------------------------------------------------------- CLI

/** Static SVG of cumulative closed-trade P&L lines (step-free polylines at each close). */
export function svgCurves(title, series, note = "") {
  const W = 820, H = 360, L = 64, R = 16, T = 34, B = 44;
  const all = series.flatMap((s) => s.points);
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
  const lo = Math.min(0, ...all.map((p) => p.v)), hi = Math.max(0, ...all.map((p) => p.v));
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/><text x="${L}" y="18" font-size="13" font-weight="600">${title}</text>`;
  for (const v of [lo, 0, hi]) s += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? "#adb5bd" : "#e9ecef"}"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" fill="#5b6170">${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(0)}</text>`;
  s += `<text x="${L}" y="${H - 22}" fill="#5b6170">${day(t0)}</text><text x="${W - R}" y="${H - 22}" text-anchor="end" fill="#5b6170">${day(t1)}</text>`;
  if (note) s += `<text x="${L}" y="${H - 6}" fill="#868e96">${note}</text>`;
  series.forEach((c, i) => {
    s += `<polyline fill="none" stroke="${c.color}" stroke-width="1.6" points="${c.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>`;
    const last = c.points[c.points.length - 1];
    s += `<rect x="${L + 8 + i * 190}" y="${T - 2}" width="10" height="3" fill="${c.color}"/><text x="${L + 22 + i * 190}" y="${T + 2}" fill="#212529">${c.label}: ${last.v < 0 ? "-" : "+"}$${Math.abs(last.v).toFixed(2)}</text>`;
  });
  return s + "</svg>\n";
}

const cumulative = (trades, f) => { let v = 0; return trades.map((t) => ({ t: Date.parse(t.exitTime), v: (v += f(t)) })); };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, "..", "..");
  const doc = JSON.parse(readFileSync(arg("candles"), "utf8"));
  const candles = doc.candles;
  const refs = [];
  const fx = JSON.parse(readFileSync(join(base, "test", "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
  refs.push({ name: "benchmark fixture (test/fixtures)", candles: fx.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c })) });
  if (arg("reference-candles")) refs.push({ name: arg("reference-candles"), candles: JSON.parse(readFileSync(arg("reference-candles"), "utf8")).candles });
  const ref = JSON.parse(readFileSync(join(base, "parity", "tv-solusd-5m-2026-11-07.json"), "utf8"));
  const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, base);
  const from = Date.parse(doc.from), to = Date.parse(doc.to);
  const res = study({
    candles, inputs: cfg.inputs, references: refs, from, to,
    benchmark: { from: Date.parse("2026-10-19T00:00:00Z"), to: Date.parse("2026-11-08T00:00:00Z"), lastCandle: fx.rows[fx.rows.length - 1][0], reference: ref.summary, listed: ref.trades },
  });
  res.generated_at = new Date().toISOString();
  res.profile = "solusd-5m";
  res.inputs = cfg.inputs;
  res.dataset = { file: arg("candles"), source: doc.source, from: doc.from, to: doc.to };
  const out = arg("out", join("runs", "baseline"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "baseline.json"), JSON.stringify({ ...res, trades: undefined }, null, 1));
  const cols = ["n", "side", "entryTime", "entryPrice", "exitTime", "exitPrice", "qty", "notional", "exitKind", "result", "exitR", "pnl", "ndax_costs", "ndax_net", "kraken_costs", "kraken_net"];
  writeFileSync(join(out, "trades.csv"), [cols.join(","), ...res.trades.map((t) => cols.map((c) => t[c] ?? "").join(","))].join("\n") + "\n");
  const T = res.trades;
  writeFileSync(join(out, "model-a-gross.svg"), svgCurves("Model A: original strategy, cumulative P&L before costs (fixed $10 risk)", [
    { label: "All", color: "#212529", points: cumulative(T, (t) => t.pnl) },
    { label: "Longs", color: "#2b8a3e", points: cumulative(T.filter((t) => t.side === "LONG"), (t) => t.pnl) },
    { label: "Shorts", color: "#c92a2a", points: cumulative(T.filter((t) => t.side === "SHORT"), (t) => t.pnl) },
  ], "Theoretical TradingView-equivalent: no fees, no capital limit. Real Kraken SOLUSD 5m candles."));
  writeFileSync(join(out, "model-b-costs.svg"), svgCurves("Model B: the same trades after execution costs", [
    { label: "Before costs", color: "#212529", points: cumulative(T, (t) => t.pnl) },
    { label: "Ndax 0.20% + 0.10% slip", color: "#d9480f", points: cumulative(T, (t) => t.ndax_net) },
    { label: "Kraken Pro T1", color: "#1c7ed6", points: cumulative(T, (t) => t.kraken_net) },
  ], "Fees: published schedules. Slippage: estimates applied to stop exits. Ndax costs on Kraken prices (not Ndax SOL/CAD fills)."));
  const { model_a, model_b, model_c, benchmark, data, fill_property_sensitivity, conservative_fill_replay, periods } = res;
  console.log(JSON.stringify({ out, data: { ...data, gaps: data.gaps.length }, benchmark, a: { ...model_a, equity_from_100: { ...model_a.equity_from_100, points: model_a.equity_from_100.points.length } },
    b: Object.fromEntries(Object.entries(model_b).map(([k, v]) => [k, { ...v, equity_from_100: { ...v.equity_from_100, points: undefined } }])), c: model_c, fill_property_sensitivity, conservative_fill_replay, periods }, null, 1));
}
