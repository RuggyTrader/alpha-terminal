// EXPLORATORY (owner-requested): "$10 collateral at 10x, take +100 %, lose 100 % at liquidation" on real 5-minute history.
// Historical PAPER simulation only; signals are in-sample/post-hoc (disclosed). Jupiter cost model from jupiter/config.frozen.json.
//   node ten-x.mjs <candles dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCsv, aggregate, detect } from "./candle-study.mjs";
import { rng } from "../edge/stats.mjs";

const M5 = 300_000, H = 3_600_000, DAY = 86_400_000;
const CFG = JSON.parse(readFileSync(new URL("../jupiter/config.frozen.json", import.meta.url), "utf8"));

/** Trade one position from entry bar index k (5-minute bars). side +1 long / -1 short. Returns { win, net, exitK, reason }. */
export function tradeOnce(b, k, side, { collateral, lev, tpMove, c, maxHoldBars = 7 * 288, asset = "SOL" }) {
  const slip = c.delaySlipBps / 1e4, entry = b.o[k] * (1 + side * slip), size = collateral * lev;
  const swap = side > 0 ? collateral * (c.longCollateralSwapBps ?? 0) / 1e4 : 0, openFee = size * c.openBps / 1e4, closeFee = size * c.closeBps / 1e4, net0 = 3 * c.networkUsdPerTx;
  const margin = collateral - swap - openFee, borrowH = size * c.borrowHourly[side > 0 ? asset : "USDC"] * c.borrowMultiplier;
  for (let i = k; i < Math.min(b.t.length, k + maxHoldBars); i++) {
    const hrs = ((i - k + 1) * M5) / H, borrow = borrowH * hrs;
    // liquidation: margin + pnl - close fee - borrow <= size / 500 (adverse extreme checked FIRST)
    const liqMove = (size / 500 + closeFee + borrow - margin) / size, liqPx = entry * (1 + side * liqMove);
    const adverse = side > 0 ? b.l[i] : b.h[i], fav = side > 0 ? b.h[i] : b.l[i];
    if (side > 0 ? adverse <= liqPx : adverse >= liqPx) return { win: false, net: -collateral - net0, exitK: i, reason: "LIQUIDATED", hours: hrs };
    const tpPx = entry * (1 + side * tpMove);
    if (side > 0 ? fav >= tpPx : fav <= tpPx) { const px = tpPx * (1 - side * c.stopSlipBps / 1e4), pnl = size * side * (px / entry - 1); const back = margin + pnl - closeFee - borrow; return { win: true, net: back - (side > 0 ? back * (c.longCollateralSwapBps ?? 0) / 1e4 : 0) - collateral - net0, exitK: i, reason: "TAKE_PROFIT", hours: hrs }; }
  }
  const i = Math.min(b.t.length - 1, k + maxHoldBars - 1), px = b.c[i] * (1 - side * slip), hrs = ((i - k + 1) * M5) / H, pnl = size * side * (px / entry - 1);
  const back = Math.max(0, margin + pnl - closeFee - borrowH * hrs);
  return { win: back > collateral, net: back - collateral - net0, exitK: i, reason: "TIME_7D", hours: hrs };
}

/** Run signals sequentially (one position at a time) on one asset; sizing "fixed10" or "pct10" (10 % of equity, min $10). */
export function runAccount(b, signals, opts) {
  let eq = 100, hwm = 100, maxDD = 0, busyUntil = -1, hit75 = null, ruined = null; const trades = [];
  for (const s of signals) {
    if (s.k <= busyUntil || s.k >= b.t.length) continue;
    const coll = opts.sizing === "fixed10" ? 10 : Math.max(10, 0.1 * eq);
    if (eq < coll + 1) { ruined ??= b.t[s.k]; break; }
    const r = tradeOnce(b, s.k, s.side, { ...opts, collateral: coll });
    eq += r.net; trades.push({ t: b.t[s.k], ...r, coll }); busyUntil = r.exitK;
    hwm = Math.max(hwm, eq); maxDD = Math.max(maxDD, 1 - eq / hwm);
    if (eq <= 75 && !hit75) hit75 = b.t[r.exitK];
  }
  const wins = trades.filter((x) => x.win).length, days = trades.length ? (trades.at(-1).t - trades[0].t) / DAY : 0;
  return { trades: trades.length, winRate: trades.length ? wins / trades.length : null, avgNet: trades.length ? trades.reduce((s, x) => s + x.net, 0) / trades.length : null, final: eq, maxDDpct: maxDD * 100,
    hit75: hit75 && new Date(hit75).toISOString().slice(0, 10), ruined: ruined && new Date(ruined).toISOString().slice(0, 10), liquidations: trades.filter((x) => x.reason === "LIQUIDATED").length,
    timeouts: trades.filter((x) => x.reason === "TIME_7D").length, medianHours: trades.length ? trades.map((x) => x.hours).sort((a, z) => a - z)[trades.length >> 1] : null, tradesPerWeek: days ? (trades.length / days) * 7 : null, path: trades.map((x) => [x.t, +x.net.toFixed(2)]) };
}

/** Entry signals on 5-minute indices: from 1h events (entry at the next 1h open = a 5-minute bar), plus random baselines. */
export function signalSets(b5, seed = 5) {
  const b1 = aggregate(b5, 12), { events } = detect(b1), idx = new Map(Array.from(b5.t, (t, i) => [t, i])), r = rng(seed), out = {};
  const at = (t) => idx.get(t);
  out.continuation_long = events.E2_MR_UP.map((i) => ({ k: at(b1.t[i] + H), side: 1 })).filter((s) => s.k !== undefined);   // post-hoc: big up bar -> long
  out.reversion_long = events.E1_MR_DOWN.map((i) => ({ k: at(b1.t[i] + H), side: 1 })).filter((s) => s.k !== undefined);      // big down bar -> long
  out.random_long_daily = [], out.random_coinflip_daily = [];
  for (let d = Math.ceil(b5.t[0] / DAY) * DAY; d < b5.t.at(-1) - 8 * DAY; d += DAY) { const t = d + Math.floor(r() * 24) * H, k = at(t); if (k === undefined) continue; out.random_long_daily.push({ k, side: 1 }); out.random_coinflip_daily.push({ k, side: r() < 0.5 ? 1 : -1 }); }
  return out;
}

if (process.argv[1]?.endsWith("ten-x.mjs")) {
  const [DIR, OUT] = process.argv.slice(2), rows = [];
  for (const a of ["BTC", "ETH", "SOL"]) {
    const b = loadCsv(readFileSync(join(DIR, `${a}USDT-5m.csv`), "utf8")), sets = signalSets(b);
    for (const [name, sig] of Object.entries(sets)) for (const cost of ["base", "conservative"]) for (const sizing of ["fixed10", "pct10"]) {
      const r = runAccount(b, sig, { sizing, lev: 10, tpMove: 0.10, c: CFG.costs[cost], asset: a });
      rows.push({ asset: a, signal: name, cost, sizing, ...r, path: undefined });
      console.log(`${a} ${name.padEnd(22)} ${cost.padEnd(12)} ${sizing.padEnd(7)} trades ${String(r.trades).padStart(4)} win ${(r.winRate * 100).toFixed(1)}% avg $${r.avgNet.toFixed(2)} final $${r.final.toFixed(2)} maxDD ${r.maxDDpct.toFixed(0)}% liq ${r.liquidations} hit75 ${r.hit75 ?? "-"} ruined ${r.ruined ?? "-"} trades/wk ${r.tradesPerWeek?.toFixed(2)} medH ${r.medianHours?.toFixed(0)}`);
    }
  }
  writeFileSync(OUT, JSON.stringify({ note: "EXPLORATORY, owner-requested; in-sample/post-hoc signals; historical PAPER only", setup: "collateral $10 (or 10 % of equity), 10x, take profit +10 % price move (~+100 % on collateral), liquidation ~-9.6 %, max hold 7 days, one position at a time", rows }, null, 1) + "\n");
}
