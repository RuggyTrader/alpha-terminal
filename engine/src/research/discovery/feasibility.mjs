// Discovery phase, feasibility screen (DEVELOPMENT SLICE ONLY: data up to 2022-12-31; 2023-2026 is not read).
// Question: are Ndax-vs-global price gaps large and reversible enough to beat Ndax's round-trip cost?
//   premium p(d) = Ndax CAD close / (Kraken USD close x Kraken USD/CAD close) - 1   (stablecoins: x Kraken USDx/USD)
//   deviation x(d) = p(d) - median(p over the previous 30 days)
//   For days where Ndax is CHEAP by more than the round-trip cost (x < -cost) and traded >= C$10k that day:
//   the mean change in the premium over the next 1/3/7 days (a long position earns -dx... i.e. +reversion) vs the cost.
// Descriptive only; no strategy simulation.
//   node feasibility.mjs <kraken-ohlcvt dir> <ndax dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKraken, DAY } from "../lab/data.mjs";

const [KR, ND, OUT] = process.argv.slice(2);
const DEV_END = Date.parse("2023-01-01");
const kr = (f) => new Map(loadKraken(join(KR, `${f}_1440.csv`), DAY).bars.map((b) => [b.t, b.c]));
const usdcad = kr("USDCAD");
// round-trip cost = 2 x 0.20 % fee + 2 x MEASURED C$50 cost per side (Ndax books 2026-11-22; BTC uses the 7-day study's 0.25 %)
const MARKETS = {
  BTC: { nd: "BTCCAD", kr: "XBTUSD", cost: 2 * 0.002 + 2 * 0.0025 },
  ETH: { nd: "ETHCAD", kr: "ETHUSD", cost: 2 * 0.002 + 2 * 0.0019 },
  XRP: { nd: "XRPCAD", kr: "XRPUSD", cost: 2 * 0.002 + 2 * 0.0024 },
  LTC: { nd: "LTCCAD", kr: "LTCUSD", cost: 2 * 0.002 + 2 * 0.0035 },
  DOGE: { nd: "DOGECAD", kr: "XDGUSD", cost: 2 * 0.002 + 2 * 0.0030 },
  SOL: { nd: "SOLCAD", kr: "SOLUSD", cost: 2 * 0.002 + 2 * 0.0025 },
  USDC: { nd: "USDCCAD", kr: "USDCUSD", cost: 2 * 0.002 + 2 * 0.00213 },
};
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const res = { slice: "development, through 2022-12-31", markets: {} };
for (const [name, m] of Object.entries(MARKETS)) {
  const ref = kr(m.kr), rows = JSON.parse(readFileSync(join(ND, `${m.nd}-daily.json`), "utf8")).rows;
  const prem = new Map(), vol = new Map();
  for (const x of rows) { const t = x[9]; if (t >= DEV_END) continue; const u = usdcad.get(t), r = ref.get(t); if (!u || !r || !(x[4] > 0)) continue; prem.set(t, x[4] / (r * u) - 1); vol.set(t, x[5] * x[4]); }
  const days = [...prem.keys()].sort((a, b) => a - b);
  const p = days.map((t) => prem.get(t));
  const dev = days.map((t, i) => { if (i < 30) return null; const w = p.slice(i - 30, i); return p[i] - q(w, 0.5); });
  // AR(1) of the premium
  let c = 0, v = 0; const mp = p.reduce((a, b) => a + b, 0) / p.length; for (let i = 1; i < p.length; i++) { c += (p[i] - mp) * (p[i - 1] - mp); v += (p[i - 1] - mp) ** 2; }
  const ar = c / v, halfLife = ar > 0 && ar < 1 ? Math.log(0.5) / Math.log(ar) : null;
  const ev = {};
  for (const h of [1, 3, 7]) {
    const gains = [];
    days.forEach((t, i) => { if (dev[i] === null || dev[i] >= -m.cost || vol.get(t) < 10_000) return; const j = days.indexOf(t + h * DAY); if (j < 0) return; gains.push(p[j] - p[i]); });
    ev[`${h}d`] = { events: gains.length, mean_reversion_pct: gains.length ? (gains.reduce((a, b) => a + b, 0) / gains.length) * 100 : null, share_reverting_more_than_cost: gains.length ? gains.filter((g) => g > m.cost).length / gains.length : null };
  }
  res.markets[name] = { days: days.length, from: days.length ? new Date(days[0]).toISOString().slice(0, 10) : null, premium_median_pct: q(p, 0.5) * 100, premium_p05_pct: q(p, 0.05) * 100, premium_p95_pct: q(p, 0.95) * 100,
    premium_ar1: ar, half_life_days: halfLife, deviation_sd_pct: Math.sqrt(dev.filter((x) => x !== null).reduce((a, b) => a + b * b, 0) / dev.filter((x) => x !== null).length) * 100,
    round_trip_cost_pct: m.cost * 100, cheap_events_and_reversion: ev };
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const [k, v] of Object.entries(res.markets)) console.log(`${k.padEnd(5)} days ${v.days} from ${v.from} | premium median ${v.premium_median_pct.toFixed(2)}% [p5 ${v.premium_p05_pct.toFixed(2)}, p95 ${v.premium_p95_pct.toFixed(2)}] AR1 ${v.premium_ar1.toFixed(2)} half-life ${v.half_life_days?.toFixed(1)}d dev sd ${v.deviation_sd_pct.toFixed(2)}% | cost ${v.round_trip_cost_pct.toFixed(2)}% | ${Object.entries(v.cheap_events_and_reversion).map(([h, e]) => `${h}: n ${e.events} rev ${e.mean_reversion_pct?.toFixed(2)}% >cost ${e.share_reverting_more_than_cost === null ? "-" : (e.share_reverting_more_than_cost * 100).toFixed(0) + "%"}`).join(" | ")}`);
