// TradingView parity check for a strategy profile on real Kraken candles.
//   node src/cli/parity.mjs --candles data/SOLUSD-5m-25d.json --reference parity/tv-solusd-5m-2026-11-07.json [--profile solusd-5m] [--out runs/parity]
// Compares the engine's trades in the reference period with TradingView's summary and its listed trades, and
// measures how much the result depends on things the screenshots cannot settle: where the history starts, pivot
// tie rules and two fill-emulator assumptions. Reports facts only; it never adjusts the strategy to fit.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";
import { runBacktest } from "./backtest.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const doc = JSON.parse(readFileSync(arg("candles"), "utf8"));
const ref = JSON.parse(readFileSync(arg("reference"), "utf8"));
const profile = arg("profile", "solusd-5m");
const out = arg("out", join("runs", `parity-${profile}`));
const cfg = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: profile }, process.cwd());
const fromMs = Date.parse(`${ref.period.from}T00:00:00Z`);
const toMs = Date.parse(`${ref.period.to}T00:00:00Z`) + 86_400_000;
const candles = doc.candles;
const STEP = doc.intervalMin * 60_000;

const run = ({ start = candles[0].t, pivotTies, fill, inputs = {} } = {}) => {
  const r = runBacktest({ candles: candles.filter((k) => k.t >= start), symbol: doc.symbol, intervalMin: doc.intervalMin, inputs: { ...cfg.inputs, ...inputs }, pivotTies, fill });
  return r.trades.filter((t) => Date.parse(t.entryTime) >= fromMs && Date.parse(t.entryTime) < toMs);
};

function summary(trades) {
  const pnl = trades.map((t) => t.pnl);
  const wins = pnl.filter((p) => p > 0), losses = pnl.filter((p) => p < 0);
  let eq = 0, peak = 0, dd = 0;
  for (const p of pnl) { eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  // Drawdown including open-trade losses at each candle's worst price (approximation of TradingView's figure).
  const byT = new Map(candles.map((k) => [k.t, k]));
  let eq2 = 0, peak2 = 0, dd2 = 0;
  for (const t of trades) {
    const a = Date.parse(t.entryTime), b = Date.parse(t.exitTime), side = t.side === "LONG" ? 1 : -1;
    for (let ms = a; ms <= b; ms += STEP) {
      const k = byT.get(ms);
      if (!k) continue;
      const worst = side === 1 ? (ms === b ? Math.max(k.l, Math.min(t.exitPrice, k.h)) : k.l) : (ms === b ? Math.min(k.h, Math.max(t.exitPrice, k.l)) : k.h);
      const open = (worst - t.entryPrice) * t.qty * side;
      dd2 = Math.max(dd2, peak2 - (eq2 + open));
    }
    eq2 += t.pnl;
    peak2 = Math.max(peak2, eq2);
    dd2 = Math.max(dd2, peak2 - eq2);
  }
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  return {
    closed_trades: trades.length, net_pnl: +eq.toFixed(2), winning_trades: wins.length,
    win_rate_pct: trades.length ? +(100 * wins.length / trades.length).toFixed(2) : null,
    profit_factor: gl > 0 ? +(gw / gl).toFixed(3) : null,
    max_drawdown_closed: +dd.toFixed(2), max_drawdown_intrabar_approx: +dd2.toFixed(2),
    longs: trades.filter((t) => t.side === "LONG").length, shorts: trades.filter((t) => t.side === "SHORT").length,
  };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
function matchRef(trades) {
  return ref.trades.map((r) => {
    const t = trades.find((x) => x.side === r.side && x.entryTime.replace(".000Z", "Z") === r.entry);
    if (!t) {
      const close = trades.filter((x) => Math.abs(Date.parse(x.entryTime) - Date.parse(r.entry)) <= 6 * 3_600_000)
        .map((x) => `${x.side} ${x.entryTime} @ ${x.entryPrice}`);
      return { n: r.n, match: false, found: null, nearby: close };
    }
    const checks = {
      entry_price: near(t.entryPrice, r.entry_price, 0.005), exit_time: t.exitTime.replace(".000Z", "Z") === r.exit,
      exit_price: near(t.exitPrice, r.exit_price, 0.005), qty: near(t.qty, r.qty, 0.006), pnl: near(t.pnl, r.pnl, 0.011),
    };
    return {
      n: r.n, match: Object.values(checks).every(Boolean), checks,
      found: { side: t.side, entry: t.entryTime, entry_price: t.entryPrice, exit: t.exitTime, exit_price: t.exitPrice, qty: +t.qty.toFixed(4), pnl: +t.pnl.toFixed(2), exit_kind: t.exitKind, result: t.result },
    };
  });
}

const report = {
  generated_at: new Date().toISOString(), profile, inputs: cfg.inputs,
  data: { source: doc.source, from: doc.from, to: doc.to, candles: candles.length, check: doc.check },
  reference: { period: ref.period, summary: ref.summary, source: ref.source },
};
const base = run();
report.base = { assumptions: "history from the first candle in the file; pivots strict/strict; TradingView documented emulator (limit gap fills at the open, exits may fill on the entry's tick path)", summary: summary(base), reference_trades: matchRef(base) };

// Start-history dependence: the same rules, history starting later.
report.start_dependence = [];
const baseIds = new Set(base.map((t) => `${t.side}${t.entryTime}${t.exitTime}`));
for (let d = 0; d * 86_400_000 + candles[0].t < fromMs; d++) {
  const start = candles[0].t + d * 86_400_000;
  const tr = run({ start });
  report.start_dependence.push({ history_from: new Date(start).toISOString(), ...summary(tr), identical_to_base: tr.filter((t) => baseIds.has(`${t.side}${t.entryTime}${t.exitTime}`)).length });
}

// Pivot ties and fill-emulator variants.
report.variants = [];
for (const left of ["strict", "loose"]) for (const right of ["strict", "loose"]) for (const fill of [{}, { limitPrice: "requested" }, { exitDelayTicks: 1 }, { limitPrice: "requested", exitDelayTicks: 1 }]) {
  const tr = run({ pivotTies: { left, right }, fill });
  const m = matchRef(tr);
  report.variants.push({ pivots: `${left}/${right}`, fill: Object.keys(fill).length ? fill : "documented default", ...summary(tr), reference_trades_matched: m.filter((x) => x.match).length, reference_entries_found: m.filter((x) => x.found).length });
}

// Risk scaling: qty and P&L must scale exactly with risk per trade (used by the website simulator).
const r25 = run({ inputs: { riskUSD: 25 } });
const scaleOk = r25.length === base.length && r25.every((t, i) => t.entryTime === base[i].entryTime && t.exitTime === base[i].exitTime &&
  near(t.qty, base[i].qty * 2.5, 1e-9 * Math.max(1, t.qty)) && near(t.pnl, base[i].pnl * 2.5, 5e-4)); // P&L is reported to 4 decimals
report.risk_scaling = { compared_risk_usd: [cfg.inputs.riskUSD, 25], trades_compared: base.length, exact_linear: scaleOk };

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "parity.json"), JSON.stringify(report, null, 1));
writeFileSync(join(out, "trades.csv"), ["side,entry_time,entry_price,exit_time,exit_price,qty,pnl,exit_kind,result",
  ...base.map((t) => [t.side, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.qty, t.pnl, t.exitKind, t.result ?? ""].join(","))].join("\n") + "\n");
console.log(JSON.stringify({ out, base: report.base, start_dependence: report.start_dependence, variants: report.variants, risk_scaling: report.risk_scaling }, null, 1));
