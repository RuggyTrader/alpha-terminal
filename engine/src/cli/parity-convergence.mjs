// RESEARCH: does the reference (TradingView-semantics) result for a window depend on how much history precedes it?
//   node src/cli/parity-convergence.mjs --symbol BTCUSD --tf 1 --profile btcusd-1m --chunks data/chunks/BTCUSD-1m --files data/BTCUSD-1m-11d.json \
//        --from 2026-11-01T00:00:00Z --to 2026-11-12T00:00:00Z --warmups 2026-11-01,2026-10-31,2026-10-29,2026-10-26 [--out runs/x.json]
// Real Kraken 1m candles only (verified chunk files and/or merged files); the timeframe is aggregated from 1m. For each
// warm-up start the strategy runs from that start with the ORIGINAL profile; trades entered before --from are excluded.
// Convergence = the in-window trade list stops changing as the warm-up grows. Profiles are never changed.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { referenceTrades } from "./economics.mjs";
import { aggregate, profileInputs } from "./fleet-backtest.mjs";

export function loadCandles({ chunks = null, files = [] }) {
  const byT = new Map();
  const add = (cs) => { for (const k of cs) byT.set(k.t, k); };
  if (chunks) for (const f of readdirSync(chunks).filter((x) => x.endsWith(".json")).sort()) add(JSON.parse(readFileSync(join(chunks, f), "utf8")).candles);
  for (const f of files) add(JSON.parse(readFileSync(f, "utf8")).candles);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function summarize(trades) {
  const g = trades.map((t) => t.gross);
  const w = g.filter((x) => x > 0).reduce((s, x) => s + x, 0), l = -g.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  let eq = 0, pk = 0, dd = 0; for (const x of g) { eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  return { trades: trades.length, long: trades.filter((t) => t.side === "LONG").length, short: trades.filter((t) => t.side === "SHORT").length,
    gross: +g.reduce((s, x) => s + x, 0).toFixed(2), profit_factor: l > 0 ? +(w / l).toFixed(3) : null, max_drawdown: +dd.toFixed(2) };
}

const key = (t) => `${t.side}@${t.entryTime}`;

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/parity-convergence.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const symbol = arg("symbol"), tf = Number(arg("tf", "1")), profile = arg("profile");
  const fromMs = Date.parse(arg("from")), toMs = Date.parse(arg("to"));
  const all = loadCandles({ chunks: arg("chunks", null), files: (arg("files", "") || "").split(",").filter(Boolean) }).filter((k) => k.t < toMs);
  const gaps = []; for (let i = 1; i < all.length; i++) if (all[i].t - all[i - 1].t !== 60_000) gaps.push({ after: new Date(all[i - 1].t).toISOString(), missing: (all[i].t - all[i - 1].t) / 60_000 - 1 });
  const inputs = profileInputs(process.cwd(), profile);
  const out = { symbol, timeframe: `${tf}m`, profile, window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    data: { first: new Date(all[0].t).toISOString(), last: new Date(all.at(-1).t).toISOString(), candles_1m: all.length, gaps_1m: gaps.length, gap_examples: gaps.slice(0, 5) }, runs: [] };
  let prev = null;
  for (const w of arg("warmups").split(",")) {
    const startMs = Date.parse(w.length === 10 ? `${w}T00:00:00Z` : w);
    if (startMs < all[0].t) { out.runs.push({ warmup_start: w, skipped: `no data before ${out.data.first}` }); continue; }
    const c1 = all.filter((k) => k.t >= startMs);
    const candles = tf === 1 ? c1 : aggregate(c1, tf);
    const trades = referenceTrades({ candles, symbol, intervalMin: tf, inputs, fromMs }).filter((t) => t.entryTime < toMs);
    const keys = trades.map(key);
    const diff = prev ? { added: keys.filter((k) => !prev.has(k)).length, removed: [...prev].filter((k) => !keys.includes(k)).length } : null;
    out.runs.push({ warmup_start: new Date(startMs).toISOString(), warmup_days: +((fromMs - startMs) / 86_400_000).toFixed(2), ...summarize(trades), vs_previous_warmup: diff,
      first_trades: trades.slice(0, 3).map((t) => ({ side: t.side, entry: new Date(t.entryTime).toISOString(), entry_price: t.entry, exit: new Date(t.exitTime).toISOString(), gross: +t.gross.toFixed(2) })) });
    prev = new Set(keys);
  }
  if (arg("out", null)) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
