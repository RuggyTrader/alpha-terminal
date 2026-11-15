#!/usr/bin/env node
// Round 2: the ORIGINAL OTE strategy (unchanged profiles solusd-5m / btcusd-5m) on 4h and daily candles, through the
// production fleet backtest (strategy limit fills, own wallet, reduce-to-fit, collateralised shorts, fee every fill).
import { readFileSync, writeFileSync } from "node:fs";
import { profileInputs, runFleetBacktest } from "../cli/fleet-backtest.mjs";
import { FleetLedgerSim } from "../capital.mjs";
import { to4h } from "./r2.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const DIR = arg("data"), OUT = arg("out");
const load = (f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")).candles;
const D = Date.parse;
const P = { dev: [D("2021-07-01"), D("2024-01-01")], val: [D("2024-01-01"), D("2025-07-01")], test: [D("2025-07-01"), D("2026-11-15")] };
const trades = [];
const orig = FleetLedgerSim.prototype.close;
FleetLedgerSim.prototype.close = function (...a) { const r = orig.apply(this, a); if (r?.trade) trades.push(r.trade); return r; };
const out = [];
for (const [asset, prod, profile, group] of [["SOL", "SOL-USD", "solusd-5m", "SOLANA"], ["BTC", "BTC-USD", "btcusd-5m", "BITCOIN"]]) {
  const sets = { "4h": [to4h(load(`${prod}-3600.json`)).candles, 240], "1d": [load(`${prod}-86400.json`), 1440] };
  for (const [tf, [K, im]] of Object.entries(sets)) for (const [per, [a, b]] of Object.entries(P)) for (const fee of [0.2, 0.4]) for (const short of [false, true]) {
    trades.length = 0;
    const inputs = { ...profileInputs(process.cwd(), profile), allowShort: short };
    runFleetBacktest({ bots: [{ id: "R", group, symbol: `${asset}USD`, intervalMin: im, priority: 1, profile, candles: K, inputs, riskUSD: 2 }], main: 100, allocations: [{ group, amountUsd: 100 }], feePct: fee, fillModel: "strategy", fromMs: a, toMs: b, slippagePct: 0.05 });
    const nets = trades.map((t) => t.net / 1e6), sum = (x) => x.reduce((s, v) => s + v, 0);
    const w = nets.filter((v) => v > 0), l = nets.filter((v) => v <= 0);
    out.push({ asset, tf, period: per, fee, mode: short ? "LONG+SHORT" : "LONG only", trades: nets.length, net: +sum(nets).toFixed(2), pf: l.length && sum(l) < 0 ? +(sum(w) / -sum(l)).toFixed(2) : null, win: nets.length ? +(w.length / nets.length).toFixed(2) : null });
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const r of out.filter((x) => x.fee === 0.2)) console.log(r.asset, r.tf, r.mode.padEnd(10), r.period.padEnd(4), "n", String(r.trades).padStart(4), "net", String(r.net).padStart(8), "pf", r.pf, "win", r.win);
