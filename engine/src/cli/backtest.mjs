// Deterministic backtest over a saved candle file, using exactly the engine's live code path (onBar).
//   node src/cli/backtest.mjs --candles data/SOLUSD-5m-14d.json [--from 2026-10-25] [--risk 200] [--out runs/x]
// Writes trades.csv, trades.json, events.json and summary.json. Every number comes from the candles.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abandonPosition, createState, onBar, summarize } from "../ote.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

/**
 * ledger (optional): models the ALPHA PAPER account instead of TradingView's unlimited capital.
 *   { startCapital, feePct, maxNotional, longOnly }: every closed trade changes the balance by its P&L minus the
 *   assumed fees on both sides; an entry is refused (and dropped, as the live engine does) when it is a short and
 *   longOnly is set, or when qty × the fill candle's close (the price the ledger fills at, a moment later) exceeds
 *   the available balance or maxNotional. In percent sizing the strategy sizes from that balance.
 */
export function runBacktest({ candles, symbol, intervalMin, inputs = {}, pivotTies, fill, fromMs = null, sizing, ledger = null }) {
  const S = createState({ symbol, timeframeMin: intervalMin, inputs, pivotTies, fill, sizing });
  const events = [];
  const acct = ledger ? { capital: ledger.startCapital, fees: 0, refused: [], closedSeen: 0, feeByTrade: new Map() } : null;
  for (const k of candles) {
    if (acct) { S.capital = acct.capital; S.maxNotional = ledger.maxNotional ?? null; }
    for (const e of onBar(S, k)) {
      events.push({ ...e, time: new Date(k.t).toISOString() });
      if (acct && e.type === "ENTRY_FILL") {
        const value = e.qty * k.c;
        const code = ledger.longOnly && e.side !== 1 ? "SHORT_SELLING_DISABLED"
          : value > acct.capital + 1e-9 ? "INSUFFICIENT_PAPER_CAPITAL"
          : ledger.maxNotional && value > ledger.maxNotional ? "MAX_ORDER_NOTIONAL" : null;
        if (code && S.broker.pos) {
          abandonPosition(S);
          acct.refused.push({ time: new Date(k.t).toISOString(), side: e.side === 1 ? "LONG" : "SHORT", qty: e.qty, value, capital: acct.capital, code });
        }
      }
    }
    if (acct) {
      while (acct.closedSeen < S.broker.closed.length) {
        const t = S.broker.closed[acct.closedSeen++];
        const fee = (t.qty * t.entryPrice + t.qty * t.exitPrice) * ((ledger.feePct ?? 0) / 100);
        acct.fees += fee;
        acct.capital += t.pnl - fee;
        acct.feeByTrade.set(t, fee);
      }
    }
  }
  const trades = S.broker.closed
    .filter((t) => fromMs === null || t.entryTime >= fromMs)
    .map((t, i) => ({
      n: i + 1, side: t.side === 1 ? "LONG" : "SHORT", qty: t.qty,
      entryTime: new Date(t.entryTime).toISOString(), entryPrice: t.entryPrice,
      exitTime: new Date(t.exitTime).toISOString(), exitPrice: t.exitPrice,
      exitKind: t.exitKind, result: t.result ?? null, exitR: t.exitR ?? null, pnl: Number(t.pnl.toFixed(4)),
      ...(acct ? { fee: Number((acct.feeByTrade.get(t) ?? 0).toFixed(4)) } : {}),
    }));
  return { S, events, trades, summary: summarize(S), ...(acct ? { account: { endCapital: acct.capital, fees: acct.fees, refused: acct.refused } } : {}) };
}

/** Invariants every fill must satisfy against the real candle it happened on. */
export function checkFills(candles, trades) {
  const byTime = new Map(candles.map((k) => [new Date(k.t).toISOString(), k]));
  const problems = [];
  for (const t of trades) {
    for (const [when, px, what] of [[t.entryTime, t.entryPrice, "entry"], [t.exitTime, t.exitPrice, "exit"]]) {
      const k = byTime.get(when);
      if (!k) { problems.push(`${what} of trade ${t.n} at ${when}: no such candle`); continue; }
      if (px < k.l - 1e-9 || px > k.h + 1e-9) problems.push(`${what} of trade ${t.n} at ${when}: price ${px} outside the candle range ${k.l}..${k.h}`);
    }
    if (t.exitTime < t.entryTime) problems.push(`trade ${t.n} exits before it enters`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("backtest.mjs")) {
  const file = arg("candles", null);
  if (!file) { console.error("--candles <file> is required"); process.exit(2); }
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const inputs = {};
  if (arg("risk", null) !== null) inputs.riskUSD = Number(arg("risk"));
  const fromMs = arg("from", null) ? Date.parse(arg("from")) : null;
  const { events, trades, summary } = runBacktest({ candles: doc.candles, symbol: doc.symbol, intervalMin: doc.intervalMin, inputs, fromMs });
  const problems = checkFills(doc.candles, trades);
  const out = arg("out", join("runs", `${doc.symbol}-${doc.intervalMin}m-${Date.now()}`));
  mkdirSync(out, { recursive: true });
  const csv = ["n,side,qty,entry_time,entry_price,exit_time,exit_price,exit_kind,result,exit_r,pnl",
    ...trades.map((t) => [t.n, t.side, t.qty, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.exitKind, t.result ?? "", t.exitR ?? "", t.pnl].join(","))].join("\n");
  writeFileSync(join(out, "trades.csv"), csv + "\n");
  writeFileSync(join(out, "trades.json"), JSON.stringify(trades, null, 1));
  writeFileSync(join(out, "events.json"), JSON.stringify(events, null, 1));
  const report = {
    data: { source: doc.source, symbol: doc.symbol, intervalMin: doc.intervalMin, candles: doc.candles.length, from: doc.from, to: doc.to, check: doc.check },
    inputs: { riskUSD: inputs.riskUSD ?? 200, other: "Pine defaults" },
    summary, fillInvariantProblems: problems,
  };
  writeFileSync(join(out, "summary.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ out, ...report }, null, 1));
}
