// Deterministic backtest over a saved candle file, using exactly the engine's live code path (onBar).
//   node src/cli/backtest.mjs --candles data/SOLUSD-5m-14d.json [--from 2026-10-25] [--risk 200] [--out runs/x]
// Writes trades.csv, trades.json, events.json and summary.json. Every number comes from the candles.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createState, onBar, summarize } from "../ote.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

export function runBacktest({ candles, symbol, intervalMin, inputs = {}, pivotTies, fill, fromMs = null }) {
  const S = createState({ symbol, timeframeMin: intervalMin, inputs, pivotTies, fill });
  const events = [];
  for (const k of candles) {
    for (const e of onBar(S, k)) events.push({ ...e, time: new Date(k.t).toISOString() });
  }
  const trades = S.broker.closed
    .filter((t) => fromMs === null || t.entryTime >= fromMs)
    .map((t, i) => ({
      n: i + 1, side: t.side === 1 ? "LONG" : "SHORT", qty: t.qty,
      entryTime: new Date(t.entryTime).toISOString(), entryPrice: t.entryPrice,
      exitTime: new Date(t.exitTime).toISOString(), exitPrice: t.exitPrice,
      exitKind: t.exitKind, result: t.result ?? null, exitR: t.exitR ?? null, pnl: Number(t.pnl.toFixed(4)),
    }));
  return { S, events, trades, summary: summarize(S) };
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
