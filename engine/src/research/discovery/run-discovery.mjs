// Discovery P1/P2 runner: docs/research/discovery/PREREGISTRATION.md (commit 0d86edb). Research only, PAPER.
//   node run-discovery.mjs <kraken-ohlcvt dir> <ndax dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY, HOUR } from "../lab/data.mjs";
import { backtestGap } from "./gap.mjs";
import { periodStats, longestRecoveryDays } from "../futures/perp.mjs";

const [KR, ND, OUT] = process.argv.slice(2);
const krMap = (f, step) => new Map(loadKraken(join(KR, f), step).bars.map((b) => [b.t, b]));
const SPEC = {
  BTC: { nd: "BTCCAD", kr: "XBTUSD", cSide: 0.0025, minQty: 0.00001 }, ETH: { nd: "ETHCAD", kr: "ETHUSD", cSide: 0.0019, minQty: 0.0001 },
  XRP: { nd: "XRPCAD", kr: "XRPUSD", cSide: 0.0024, minQty: 0.1 }, LTC: { nd: "LTCCAD", kr: "LTCUSD", cSide: 0.0035, minQty: 0.001 },
  DOGE: { nd: "DOGECAD", kr: "XDGUSD", cSide: 0.003, minQty: 1 }, SOL: { nd: "SOLCAD", kr: "SOLUSD", cSide: 0.0025, minQty: 0.01 },
  USDC: { nd: "USDCCAD", kr: "USDCUSD", cSide: 0.00213, minQty: 1 },
};
const ndBars = (sym, kind) => JSON.parse(readFileSync(join(ND, `${sym}-${kind}.json`), "utf8")).rows.map((x) => ({ t: x[9], o: x[3], h: x[1], l: x[2], c: x[4], v: x[5] })).filter((b) => b.o > 0 && b.c > 0 && b.h > 0 && b.l > 0);
function market(name, kind) {
  const s = SPEC[name], step = kind === "daily" ? DAY : HOUR, suf = kind === "daily" ? "1440" : "60";
  return { name, bars: ndBars(s.nd, kind), ref: krMap(`${s.kr}_${suf}.csv`, step), fx: krMap(`USDCAD_${suf}.csv`, step), cSide: s.cSide, cost: 2 * 0.002 + 2 * s.cSide, minQty: s.minQty };
}
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
function stats(r, from, to) {
  const rets = r.trades.map((t) => t.ret), n = rets.length, wins = r.trades.filter((t) => t.net > 0), losses = r.trades.filter((t) => t.net <= 0);
  let s = 5; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); const boots = [];
  for (let k = 0; k < 2000 && n; k++) { let m = 0; for (let i = 0; i < n; i++) m += rets[Math.floor(rnd() * n)]; boots.push(m / n); } boots.sort((a, b) => a - b);
  // daily equity for period stats (hourly curves are sampled at 00:00)
  const daily = r.curve.filter(([t]) => t % DAY === 0);
  const ps = (d) => { const x = periodStats(daily, d); return x && { n: x.n, median_pct: r2(x.median_pct), worst_pct: r2(x.worst_pct), best_pct: r2(x.best_pct), positive_pct: r2(x.positive_share * 100) }; };
  return { final: r2(r.final), cagr_pct: r2(r.cagr_pct), max_dd_pct: r2(r.dd_pct), trades: n, missed: r.missed, win_rate_pct: r2((100 * wins.length) / (n || 1)),
    profit_factor: r2(wins.reduce((a, t) => a + t.net, 0) / Math.abs(losses.reduce((a, t) => a + t.net, 0) || 1e-9)), mean_trade_pct: r2((rets.reduce((a, b) => a + b, 0) / (n || 1)) * 100),
    mean_trade_ci90_pct: n ? [r2(boots[100] * 100), r2(boots[1899] * 100)] : null, exits: { reverted: r.trades.filter((t) => t.reason === "REVERTED").length, time: r.trades.filter((t) => t.reason === "TIME").length },
    w1: ps(7), w2: ps(14), m1: ps(30), m3: ps(91), y1: ps(365), longest_recovery_days: r2(longestRecoveryDays(daily)) };
}
const CONF = { from: Date.parse("2023-01-01"), to: Date.parse("2026-10-01") };
const COINS = ["BTC", "ETH", "XRP", "LTC", "DOGE", "SOL"];
const daily = Object.fromEntries([...COINS, "USDC"].map((c) => [c, market(c, "daily")]));
const res = { prereg: "docs/research/discovery/PREREGISTRATION.md (0d86edb)", confirmation: "2023-01-01..2026-09-30", status: "PAPER research; reused prices, held-out for these signals", P1: {}, P2: {} };
// warm-up: the backtester needs `win` prior bars, so start 31 days earlier but count results from CONF.from via the curve
const warm = { from: CONF.from - 31 * DAY, to: CONF.to };
const trim = (r) => { const i = r.curve.findIndex(([t]) => t >= CONF.from); const base = r.curve[i - 1]?.[1] ?? 100; const sc = 100 / base; return { ...r, curve: r.curve.slice(i).map(([t, v]) => [t, v * sc]), trades: r.trades.filter((t) => t.entryT >= CONF.from), final: r.curve.at(-1)[1] * sc, cagr_pct: (((r.curve.at(-1)[1] * sc) / 100) ** (1 / ((CONF.to - CONF.from) / (365.25 * DAY))) - 1) * 100 }; };
// NOTE on trim: equity is re-based to $100 at the first confirmation day; positions open at that instant carry over (rare).
for (const f of [1, 0.5]) res.P1[`portfolio f=${f * 100}%`] = stats(trim(backtestGap(COINS.map((c) => daily[c]), { f, slots: 3, hold: 7, win: 30, minVol: 10_000, bar: DAY }, warm)));
res.P1.per_coin = Object.fromEntries(COINS.map((c) => [c, stats(trim(backtestGap([daily[c]], { f: 1, slots: 3, hold: 7, win: 30, minVol: 10_000, bar: DAY }, warm)))]));
res.P2["USDC f=100%"] = stats(trim(backtestGap([daily.USDC], { f: 1, slots: 1, hold: 7, win: 30, minVol: 10_000, bar: DAY }, warm)));
// hourly execution check (1-hour lag), 2025-11 .. 2026-09: win 720 h, hold 168 h, volume filter per hour = C$10k / 24
const hourly = Object.fromEntries([...COINS, "USDC"].map((c) => [c, market(c, "hourly")]));
const H = { from: Date.parse("2025-10-01"), to: Date.parse("2026-10-01") };
const hp = { slots: 3, hold: 168, win: 720, minVol: 10_000 / 24, bar: HOUR };
res.hourly_check = { window: "2025-11 (after 30-day warm-up) .. 2026-09", P1: stats(backtestGap(COINS.map((c) => hourly[c]), { ...hp, f: 1 }, H)), P2: stats(backtestGap([hourly.USDC], { ...hp, f: 1, slots: 1 }, H)) };
// criteria
const verdict = (s, perCoin) => {
  const fails = [];
  if (!(s.cagr_pct > 7.4)) fails.push(`net ${s.cagr_pct}%/yr <= 7.4 % (S3 benchmark)`);
  if (!(s.max_dd_pct < 15)) fails.push(`drawdown ${s.max_dd_pct}% >= 15 %`);
  if (!(s.profit_factor >= 1.2)) fails.push(`profit factor ${s.profit_factor} < 1.2`);
  if (!(s.trades >= 30)) fails.push(`${s.trades} trades < 30`);
  if (!(s.mean_trade_ci90_pct && s.mean_trade_ci90_pct[0] > 0)) fails.push(`mean trade CI ${JSON.stringify(s.mean_trade_ci90_pct)} includes 0`);
  if (perCoin) { const pos = Object.values(perCoin).filter((x) => x.final > 100).length; if (pos < 4) fails.push(`profitable in ${pos}/6 coins < 4`); }
  return fails;
};
res.P1.fails = verdict(res.P1["portfolio f=100%"], res.P1.per_coin); if (!(res.hourly_check.P1.mean_trade_pct > 0)) res.P1.fails.push(`hourly 1-h-lag mean trade ${res.hourly_check.P1.mean_trade_pct}% <= 0`);
res.P2.fails = verdict(res.P2["USDC f=100%"]); if (!(res.hourly_check.P2.mean_trade_pct > 0)) res.P2.fails.push(`hourly 1-h-lag mean trade ${res.hourly_check.P2.mean_trade_pct}% <= 0`);
res.P1.verdict = res.P1.fails.length ? "REJECT" : "PASS (eligible for prospective PAPER only)"; res.P2.verdict = res.P2.fails.length ? "REJECT" : "PASS (eligible for prospective PAPER only)";
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
const show = (k, s) => console.log(`${k.padEnd(22)} $${s.final} ${s.cagr_pct}%/yr DD ${s.max_dd_pct}% trades ${s.trades} missed ${s.missed} win ${s.win_rate_pct}% PF ${s.profit_factor} mean ${s.mean_trade_pct}% CI ${JSON.stringify(s.mean_trade_ci90_pct)} | 1w med ${s.w1?.median_pct}/worst ${s.w1?.worst_pct} | 2w ${s.w2?.median_pct}/${s.w2?.worst_pct} | 1m ${s.m1?.median_pct}/${s.m1?.worst_pct} | 3m ${s.m3?.median_pct}/${s.m3?.worst_pct} | 1y ${s.y1?.median_pct}/${s.y1?.worst_pct} | rec ${s.longest_recovery_days}d`);
for (const [k, s] of Object.entries(res.P1)) if (s.final !== undefined) show("P1 " + k, s);
for (const [c, s] of Object.entries(res.P1.per_coin)) show("P1 coin " + c, s);
show("P2 USDC", res.P2["USDC f=100%"]); show("HOURLY P1", res.hourly_check.P1); show("HOURLY P2", res.hourly_check.P2);
console.log("P1", res.P1.verdict, JSON.stringify(res.P1.fails)); console.log("P2", res.P2.verdict, JSON.stringify(res.P2.fails));
