// Compares an engine backtest with TradingView's own result for the same strategy, symbol, timeframe and period.
//   1. In TradingView: KRAKEN:SOLUSD, 5 m, the OTE Pro Strat script, Strategy Tester → "List of trades" → Export (CSV).
//   2. node src/cli/compare-tv.mjs --tv tv-trades.csv --engine runs/<run>/trades.json [--tz UTC]
// --tz is the chart time zone the CSV was exported in (TradingView writes local chart times). Trades are matched by
// side and entry bar time; prices, exit times and P&L are compared and every difference is listed.

import { readFileSync, writeFileSync } from "node:fs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};

function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

/** "2026-11-02 13:05" in a time zone → UTC ms. */
function zonedToUtc(s, tz) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(s.trim());
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (tz === "UTC") return asUtc;
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return asUtc - (shown - asUtc);
}

export function readTradingViewTrades(csvText, tz = "UTC") {
  const [header, ...rows] = parseCsv(csvText);
  const col = (re) => header.findIndex((h) => re.test(h.trim()));
  const iN = col(/^trade\s*#/i), iType = col(/^type$/i), iTime = col(/date/i), iPrice = col(/^price/i);
  const iQty = col(/contracts|position size \(qty\)|^quantity|^qty/i), iPnl = col(/^(net )?p&l|^profit/i);
  if ([iN, iType, iTime, iPrice].some((i) => i === -1)) throw new Error(`unrecognised TradingView CSV header: ${header.join(" | ")}`);
  const byTrade = new Map();
  for (const r of rows) {
    const n = Number(r[iN]);
    const t = byTrade.get(n) ?? { n };
    const type = r[iType].toLowerCase();
    const side = type.includes("long") ? "LONG" : type.includes("short") ? "SHORT" : null;
    const leg = { time: zonedToUtc(r[iTime], tz), price: Number(r[iPrice].replace(/[^0-9.\-]/g, "")) };
    if (type.startsWith("entry")) Object.assign(t, { side, entryTime: leg.time, entryPrice: leg.price, qty: iQty === -1 ? null : Number(r[iQty].replace(/[^0-9.\-]/g, "")) });
    else if (type.startsWith("exit")) Object.assign(t, { exitTime: leg.time, exitPrice: leg.price, pnl: iPnl === -1 ? null : Number(r[iPnl].replace(/[^0-9.\-]/g, "")) });
    byTrade.set(n, t);
  }
  return [...byTrade.values()].filter((t) => t.entryTime !== undefined).sort((a, b) => a.entryTime - b.entryTime);
}

export function compareTrades(tv, engine, priceTol = 1e-6) {
  const eng = engine.map((t) => ({ ...t, entryTime: Date.parse(t.entryTime), exitTime: Date.parse(t.exitTime) }));
  const used = new Set();
  const matched = [], onlyTv = [], diffs = [];
  for (const a of tv) {
    const j = eng.findIndex((b, k) => !used.has(k) && b.side === a.side && b.entryTime === a.entryTime);
    if (j === -1) { onlyTv.push(a); continue; }
    used.add(j);
    const b = eng[j];
    matched.push([a, b]);
    const d = [];
    if (Math.abs(a.entryPrice - b.entryPrice) > priceTol) d.push(`entry price TV ${a.entryPrice} vs engine ${b.entryPrice}`);
    if (a.exitTime !== b.exitTime) d.push(`exit time TV ${new Date(a.exitTime).toISOString()} vs engine ${new Date(b.exitTime).toISOString()}`);
    if (a.exitPrice !== undefined && Math.abs(a.exitPrice - b.exitPrice) > priceTol) d.push(`exit price TV ${a.exitPrice} vs engine ${b.exitPrice}`);
    if (a.qty !== null && a.qty !== undefined && Math.abs(a.qty - b.qty) > Math.max(1e-6, a.qty * 1e-6)) d.push(`qty TV ${a.qty} vs engine ${b.qty}`);
    if (d.length) diffs.push({ entryTime: new Date(a.entryTime).toISOString(), side: a.side, differences: d });
  }
  const onlyEngine = eng.filter((_, k) => !used.has(k));
  const sum = (xs) => Number(xs.reduce((s, x) => s + (x ?? 0), 0).toFixed(2));
  return {
    tradingview: { trades: tv.length, netPnl: sum(tv.map((t) => t.pnl)) },
    engine: { trades: eng.length, netPnl: sum(eng.map((t) => t.pnl)) },
    matchedByEntry: matched.length, identical: matched.length - diffs.length,
    differences: diffs,
    onlyInTradingView: onlyTv.map((t) => ({ side: t.side, entryTime: new Date(t.entryTime).toISOString(), entryPrice: t.entryPrice })),
    onlyInEngine: onlyEngine.map((t) => ({ side: t.side, entryTime: new Date(t.entryTime).toISOString(), entryPrice: t.entryPrice })),
  };
}

if (process.argv[1]?.endsWith("compare-tv.mjs")) {
  const tvFile = arg("tv", null), engFile = arg("engine", null);
  if (!tvFile || !engFile) { console.error("usage: --tv <TradingView trades.csv> --engine <runs/.../trades.json> [--tz UTC]"); process.exit(2); }
  const tv = readTradingViewTrades(readFileSync(tvFile, "utf8"), arg("tz", "UTC"));
  const engine = JSON.parse(readFileSync(engFile, "utf8"));
  // Compare only the overlapping period.
  const from = Math.max(tv[0]?.entryTime ?? 0, Date.parse(engine[0]?.entryTime ?? 0));
  const result = compareTrades(tv.filter((t) => t.entryTime >= from), engine.filter((t) => Date.parse(t.entryTime) >= from));
  const out = arg("out", engFile.replace(/trades\.json$/, "compare-tradingview.json"));
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ out, ...result }, null, 1));
}
