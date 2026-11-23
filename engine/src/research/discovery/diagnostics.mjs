// POST-HOC diagnostics for P1 (run AFTER the verdict; cannot change it): yearly returns, concentration in the largest
// trades and coins, cost stress (spread x1.5 / x2), and staleness of the execution prints (how often the Ndax open bar
// had little volume). Research only.
//   node diagnostics.mjs <kraken-ohlcvt dir> <ndax dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY, HOUR } from "../lab/data.mjs";
import { backtestGap } from "./gap.mjs";

const [KR, ND, OUT] = process.argv.slice(2);
const krMap = (f, step) => new Map(loadKraken(join(KR, f), step).bars.map((b) => [b.t, b]));
const SPEC = { BTC: ["BTCCAD", "XBTUSD", 0.0025, 0.00001], ETH: ["ETHCAD", "ETHUSD", 0.0019, 0.0001], XRP: ["XRPCAD", "XRPUSD", 0.0024, 0.1], LTC: ["LTCCAD", "LTCUSD", 0.0035, 0.001], DOGE: ["DOGECAD", "XDGUSD", 0.003, 1], SOL: ["SOLCAD", "SOLUSD", 0.0025, 0.01] };
const ndBars = (sym, kind) => JSON.parse(readFileSync(join(ND, `${sym}-${kind}.json`), "utf8")).rows.map((x) => ({ t: x[9], o: x[3], h: x[1], l: x[2], c: x[4], v: x[5] })).filter((b) => b.o > 0 && b.c > 0 && b.h > 0 && b.l > 0);
const mk = (n, kind, mult = 1) => { const [nd, kr, c, mq] = SPEC[n], st = kind === "daily" ? DAY : HOUR, suf = kind === "daily" ? "1440" : "60"; return { name: n, bars: ndBars(nd, kind), ref: krMap(`${kr}_${suf}.csv`, st), fx: krMap(`USDCAD_${suf}.csv`, st), cSide: c * mult, cost: 2 * 0.002 + 2 * c, minQty: mq }; };
const COINS = Object.keys(SPEC), r2 = (x) => Math.round(x * 100) / 100;
const from = Date.parse("2023-01-01") - 31 * DAY, to = Date.parse("2026-10-01"), start = Date.parse("2023-01-01");
const out = {};
for (const f of [1, 0.5]) {
  const r = backtestGap(COINS.map((c) => mk(c, "daily")), { f, slots: 3, hold: 7, win: 30, minVol: 10_000 }, { from, to });
  const curve = r.curve.filter(([t]) => t >= start - DAY), byYear = {};
  for (const y of [2023, 2024, 2025, 2026]) { const a = curve.filter(([t]) => new Date(t).getUTCFullYear() < y).at(-1)?.[1], b = curve.filter(([t]) => new Date(t).getUTCFullYear() <= y).at(-1)?.[1]; if (a && b) byYear[y] = r2((b / a - 1) * 100); }
  const tr = r.trades.filter((t) => t.entryT >= start).sort((a, b) => b.net - a.net), total = tr.reduce((s, t) => s + t.net, 0);
  const byCoin = {}; for (const t of tr) byCoin[t.market] = r2((byCoin[t.market] ?? 0) + t.net);
  const stress = {};
  for (const m of [1.5, 2]) { const s = backtestGap(COINS.map((c) => mk(c, "daily", m)), { f, slots: 3, hold: 7, win: 30, minVol: 10_000 }, { from, to }); stress[`spread x${m}`] = { final: r2(s.final), dd_pct: r2(s.dd_pct) }; }
  out[`f=${f * 100}%`] = { returns_by_year_pct: byYear, net_total_usd: r2(total), top5_trades_share_pct: r2((100 * tr.slice(0, 5).reduce((s, t) => s + t.net, 0)) / total), top10_share_pct: r2((100 * tr.slice(0, 10).reduce((s, t) => s + t.net, 0)) / total), net_by_coin_usd: byCoin, cost_stress: stress };
}
// staleness: share of executed daily entries whose Ndax entry-day volume was below C$25k (thin days -> unreliable prints)
const thin = {}; const r = backtestGap(COINS.map((c) => mk(c, "daily")), { f: 1, slots: 3, hold: 7, win: 30, minVol: 10_000 }, { from, to });
for (const c of COINS) { const bars = new Map(mk(c, "daily").bars.map((b) => [b.t, b])); const e = r.trades.filter((t) => t.market === c && t.entryT >= start); thin[c] = { entries: e.length, entry_day_volume_below_25k: e.filter((t) => { const b = bars.get(t.entryT); return b && b.v * b.c < 25_000; }).length }; }
out.thin_entry_days = thin;
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
