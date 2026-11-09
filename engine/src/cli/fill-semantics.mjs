// Fill-semantics investigation (research only; the emulator in src/broker.mjs is NOT changed).
// Compares four readings of TradingView's emulator on the benchmark window and the 150-day history, and documents
// every trade on which they disagree, with its order timeline and the bar's assumed intrabar path.
//   node src/cli/fill-semantics.mjs --candles data/SOLUSD-5m-150d.json --out ../docs/research/fill-semantics
//
// Readings:
//   default        TradingView documented emulator (engine): orders created at a close are eligible from the next
//                  bar's open; an exit bracket can fill later on the entry's bar path; gaps fill at the open.
//   requested      limit orders that the bar's open gaps through fill at the limit price, not the open.
//   exitDelayTick  research variant: the exit cannot fill on the same path segment as the entry fill, only from the
//                  next path point (an EXTRA delay after the entry fill; not a documented setting).
//   noSameBarExit  research variant: the exit bracket is not active at all on the bar the entry filled.
// The last two are emulated without touching broker.mjs: exitDelayTick is the broker's own research option;
// noSameBarExit hides the bracket from the broker while the entry's fill bar is processed (Proxy below).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";
import { createState, onBar } from "../ote.mjs";

const iso = (ms) => new Date(ms).toISOString();

export function runReading(candles, inputs, reading) {
  const fill = reading === "requested" ? { limitPrice: "requested" } : reading === "exitDelayTick" ? { exitDelayTicks: 1 } : undefined;
  const S = createState({ symbol: "SOLUSD", timeframeMin: 5, inputs, fill });
  if (reading === "noSameBarExit") {
    S.broker = new Proxy(S.broker, {
      get(t, k) { return k === "exit" && t.pos && t.pos.entryBar === S.bar ? null : t[k]; },
    });
  }
  const orders = []; // ORDER_PLACED events (creation / re-placement of the limit entry and its bracket)
  for (const k of candles) for (const e of onBar(S, k)) if (e.type === "ORDER_PLACED") orders.push({ ...e, time: iso(k.t) });
  const trades = S.broker.closed.map((t) => ({
    side: t.side === 1 ? "LONG" : "SHORT", qty: t.qty, entryTime: iso(t.entryTime), entryPrice: t.entryPrice,
    exitTime: iso(t.exitTime), exitPrice: t.exitPrice, exitKind: t.exitKind, result: t.result ?? null, pnl: t.pnl,
  }));
  return { trades, orders };
}

export function summary(trades) {
  const p = trades.map((t) => t.pnl);
  const gp = p.filter((x) => x > 0).reduce((a, b) => a + b, 0), gl = -p.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const x of p) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { trades: trades.length, winners: p.filter((x) => x > 0).length, net: +eq.toFixed(2), profit_factor: gl ? +(gp / gl).toFixed(3) : null, max_drawdown: +dd.toFixed(2),
    same_bar: trades.filter((t) => t.result === "SAME_BAR").length };
}

const pathOf = (k) => (Math.abs(k.h - k.o) < Math.abs(k.o - k.l) ? ["O", "H", "L", "C"] : ["O", "L", "H", "C"]);

/** Every trade (keyed by side + entry time) on which `alt` differs from `base`, with its timeline and bar path. */
export function disputes(base, alt, candles) {
  const byT = new Map(candles.map((k) => [iso(k.t), k]));
  const key = (t) => `${t.side}|${t.entryTime}`;
  const am = new Map(alt.trades.map((t) => [key(t), t]));
  const out = [];
  for (const t of base.trades) {
    const a = am.get(key(t));
    if (a && a.exitTime === t.exitTime && a.exitPrice === t.exitPrice && a.entryPrice === t.entryPrice) continue;
    const k = byT.get(t.entryTime);
    const placed = base.orders.filter((o) => o.time < t.entryTime && (o.side === 1 ? "LONG" : "SHORT") === t.side).at(-1) ?? null;
    const prev = candles[candles.findIndex((c) => iso(c.t) === t.entryTime) - 1];
    const path = pathOf(k);
    out.push({
      side: t.side, entry_bar_open_utc: t.entryTime,
      order_created_at_close_of: prev ? iso(prev.t) : null,
      order_last_placed: placed ? { bar: placed.time, limit: placed.limit, stop: placed.stop, tp2: placed.tp2 } : null,
      bracket_created: "same script execution as the entry (strategy.exit right after strategy.entry)",
      eligible_from: `open of ${t.entryTime} (one-tick delay of a new order)`,
      fill_bar_ohlc: { o: k.o, h: k.h, l: k.l, c: k.c },
      assumed_path: `${path.join("→")} (${path.map((p) => k[p.toLowerCase()]).join(" → ")})`,
      entry_fill: t.entryPrice,
      default: { exit_time: t.exitTime, exit_price: t.exitPrice, result: t.result, pnl: +t.pnl.toFixed(4) },
      alternative: a ? { exit_time: a.exitTime, entry_price: a.entryPrice, exit_price: a.exitPrice, result: a.result, pnl: +a.pnl.toFixed(4) } : "trade absent (sequence changed)",
      pnl_difference: a ? +(a.pnl - t.pnl).toFixed(4) : null,
    });
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, base);
  const all = JSON.parse(readFileSync(arg("candles"), "utf8")).candles;
  const fx = JSON.parse(readFileSync(join(base, "test", "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8"));
  const bench = fx.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const ref = JSON.parse(readFileSync(join(base, "parity", "tv-solusd-5m-2026-11-07.json"), "utf8"));
  const READINGS = ["default", "requested", "exitDelayTick", "noSameBarExit"];
  const report = { generated_at: new Date().toISOString(), readings: {}, disputes: {} };
  const runs150 = {};
  for (const r of READINGS) {
    const b = runReading(bench, cfg.inputs, r);
    const listed = ref.trades.map((x) => {
      const t = b.trades[x.n - 1];
      return !!t && t.side === x.side && t.entryTime.replace(".000Z", "Z") === x.entry && t.exitTime.replace(".000Z", "Z") === x.exit
        && Math.abs(t.entryPrice - x.entry_price) < 0.005 && Math.abs(t.exitPrice - x.exit_price) < 0.005 && Math.abs(t.pnl - x.pnl) < 0.006;
    });
    const s = summary(b.trades);
    const passes = s.trades === 69 && s.winners === 32 && s.profit_factor === 3.298 && s.max_drawdown === 21.95 && Math.abs(s.net - 249.98) <= 0.011 && listed.every(Boolean);
    runs150[r] = runReading(all, cfg.inputs, r);
    report.readings[r] = { benchmark: { ...s, listed_trades_matched: listed.filter(Boolean).length, passes }, history_150d: summary(runs150[r].trades),
      benchmark_same_bar_trades: b.trades.filter((t) => t.result === "SAME_BAR").map((t) => `${t.side} ${t.entryTime} ${t.entryPrice}→${t.exitPrice} ${t.pnl.toFixed(2)}`) };
  }
  for (const r of READINGS.slice(1)) report.disputes[r] = disputes(runs150.default, runs150[r], all);
  const out = arg("out", join("runs", "fill-semantics"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "fill-semantics.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.readings).map(([k, v]) => [k, v])), null, 1));
  for (const [r, d] of Object.entries(report.disputes)) console.log(r, d.length, "disputed, total", d.reduce((s, x) => s + (x.pnl_difference ?? 0), 0).toFixed(2));
}
