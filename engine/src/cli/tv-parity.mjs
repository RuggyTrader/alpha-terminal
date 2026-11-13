// PARITY: compares the engine's reference replay (original profile, TradingView semantics, zero fees, unlimited buying
// power) trade by trade with a screenshot-derived TradingView fixture (engine/parity/*.json). The fixture is an
// external verification reference only; it never feeds the engine.
//   node src/cli/tv-parity.mjs --fixture parity/tv-solusd-1m-2026-11-08_12.json --start 2026-11-08T00:00:00Z [--report-from 2026-11-08T00:00:00Z] [--to 2026-11-13T00:20:00Z] [--fill requested] [--out x.json]
// Matching is chronological: a TV trade matches an engine trade only with the SAME side and an entry within ±1 minute
// (or, when the TV entry time is missing, the same exit minute). Each pair is then classified field by field with the
// screenshot's precision (price: one tick; P&L: one cent + qty rounding; qty: 0.005).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { referenceTrades } from "./economics.mjs";
import { profileInputs } from "./fleet-backtest.mjs";
import { loadCandles } from "./parity-convergence.mjs";

const MIN = 60_000;
export function candlesFor(symbol) {
  const extra = ["nov12", "nov12b"].flatMap((d) => { try { return readdirSync(`data/chunks/${symbol}-1m-${d}`).map((f) => `data/chunks/${symbol}-1m-${d}/${f}`); } catch { return []; } });
  return loadCandles({ chunks: `data/chunks/${symbol}-1m`, files: [`data/${symbol}-1m-${symbol === "SOLUSD" ? "14" : "11"}d.json`, ...extra] });
}

export function engineTrades({ symbol, profile, candles, startMs, toMs, fill, pivotTies, inputsOverride, dir = process.cwd() }) {
  const c = candles.filter((k) => k.t >= startMs && k.t < toMs);
  const inputs = { ...profileInputs(dir, profile), ...(inputsOverride ?? {}) };
  return referenceTrades({ candles: c, symbol, intervalMin: 1, inputs, fromMs: null, fill, pivotTies });
}

/** Chronological matching and field classification. */
export function compare(tv, eng, { tick }) {
  const used = new Set();
  const rows = [];
  for (const r of tv) {
    const et = r.entry_time ? Date.parse(r.entry_time) : null, xt = r.exit_time ? Date.parse(r.exit_time) : null;
    let j = eng.findIndex((e, i) => !used.has(i) && e.side === r.side && et !== null && Math.abs(e.entryTime - et) <= MIN);
    if (j < 0 && et === null && xt !== null) j = eng.findIndex((e, i) => !used.has(i) && e.side === r.side && Math.abs(e.exitTime - xt) <= MIN);
    if (j < 0) { rows.push({ tv: r.id, side: r.side, status: "MISSING_ENGINE_TRADE", tv_entry: r.entry_time, tv_entry_price: r.entry_price, tv_pnl: r.pnl }); continue; }
    used.add(j);
    const e = eng[j];
    const issues = [];
    const near = (a, b, tol) => a === null || a === undefined || b === null || b === undefined ? null : Math.abs(a - b) <= tol + 1e-9;
    if (et !== null && e.entryTime !== et) issues.push("ENTRY_TIME");
    if (near(r.entry_price, e.entry, tick / 2) === false) issues.push("ENTRY_PRICE");
    // TradingView DISPLAYS quantities truncated to 2 dp (31.7059 shows as 31.70): compare against both readings.
    const qtyShown = (q) => [Math.floor(q * 100 + 1e-9) / 100, Math.round(q * 100) / 100];
    if (r.qty !== null && !qtyShown(e.qty).some((q) => Math.abs(q - r.qty) < 1e-9)) issues.push("QTY");
    if (r.open) { rows.push({ tv: r.id, side: r.side, status: issues.length ? "OPEN_" + issues.join("+") : "OPEN_MATCH", engine_entry: new Date(e.entryTime).toISOString(), engine_entry_price: e.entry, engine_qty: e.qty, tv_entry_price: r.entry_price, tv_qty: r.qty }); continue; }
    if (xt !== null && e.exitTime !== xt) issues.push("EXIT_TIME");
    if (near(r.exit_price, e.exit, tick / 2) === false) issues.push("EXIT_PRICE");
    const pnlTol = 0.006 + (r.qty === null ? 0.05 : 0.005 * Math.abs((e.exit ?? 0) - (e.entry ?? 0)));
    if (r.pnl !== null && near(r.pnl, e.gross, pnlTol) === false) issues.push("PNL");
    const insufficient = (r.missing ?? []).filter((m) => !m.startsWith("qty")).length > 0;
    const status = issues.length ? issues.join("+") : insufficient ? "MATCH_ON_AVAILABLE_FIELDS" : r.qty === null ? "MATCH_ON_AVAILABLE_FIELDS" : "EXACT_MATCH";
    rows.push({ tv: r.id, side: r.side, status, tv_entry: r.entry_time, engine_entry: new Date(e.entryTime).toISOString(), tv_entry_price: r.entry_price, engine_entry_price: e.entry,
      tv_exit: r.exit_time, engine_exit: new Date(e.exitTime).toISOString(), tv_exit_price: r.exit_price, engine_exit_price: e.exit, tv_qty: r.qty, engine_qty: +e.qty.toFixed(4), tv_pnl: r.pnl, engine_pnl: +e.gross.toFixed(2), engine_exit_kind: e.exitKind });
  }
  const extra = eng.map((e, i) => ({ e, i })).filter(({ i }) => !used.has(i)).map(({ e }) => ({ status: "EXTRA_ENGINE_TRADE", side: e.side, engine_entry: new Date(e.entryTime).toISOString(), engine_entry_price: e.entry, engine_exit: new Date(e.exitTime).toISOString(), engine_pnl: +e.gross.toFixed(2) }));
  const counts = {};
  for (const r of [...rows, ...extra]) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const firstDivergence = [...rows.filter((r) => !/MATCH/.test(r.status)), ...extra].sort((a, b) => Date.parse(a.tv_entry ?? a.engine_entry ?? "9999") - Date.parse(b.tv_entry ?? b.engine_entry ?? "9999"))[0] ?? null;
  return { rows, extra, counts, first_divergence: firstDivergence };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/tv-parity.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const fx = JSON.parse(readFileSync(arg("fixture"), "utf8"));
  const symbol = fx.market.split(":")[1];
  const tick = symbol === "SOLUSD" ? 0.01 : 0.1;
  const startMs = Date.parse(arg("start")), toMs = Date.parse(arg("to", "2026-11-13T00:20:00Z"));
  const reportFrom = Date.parse(arg("report-from", fx.reported_date_range.from + "T00:00:00Z"));
  const fill = arg("fill", null) === "requested" ? { limitPrice: "requested" } : undefined;
  const eng = engineTrades({ symbol, profile: fx.profile, candles: candlesFor(symbol), startMs, toMs, fill }).filter((e) => e.entryTime >= reportFrom);
  const res = compare(fx.trades, eng, { tick });
  const out = { fixture: arg("fixture"), start: new Date(startMs).toISOString(), report_from: new Date(reportFrom).toISOString(), to: new Date(toMs).toISOString(), fill: fill ? "requested" : "default", ...res };
  if (arg("out", null)) writeFileSync(arg("out"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.counts), "first divergence:", JSON.stringify(out.first_divergence));
}
