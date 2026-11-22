// Round S screen (docs/research/signals/PREREGISTRATION.md, commit cdbc8fa). DEVELOPMENT period only: every forward
// window ends on or before 2022-01-01. The evaluation period is never read here.
//   node screen.mjs <signals dir> <kraken-ohlcvt dir> <engine data dir> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, dailyMap, fundingSignal, mean7, netflowSignal, growth30, forwardReturn, spearman, blockBootstrap, quintiles } from "./build.mjs";
import { loadKraken } from "../lab/data.mjs";

const [SIG, KR, ENG, OUT] = process.argv.slice(2);
const DEV_END = Date.parse("2022-01-01");
const J = (f) => JSON.parse(readFileSync(join(SIG, f), "utf8")).data;
const kr = (f) => new Map(loadKraken(join(KR, f), DAY).bars.map((b) => [b.t, b]));
const BARS = { BTC: kr("XBTUSD_1440.csv"), ETH: kr("ETHUSD_1440.csv") };
const usdt = kr("USDTUSD_1440.csv");
const cm = (asset, m) => dailyMap(J(`coinmetrics-${asset}.json`).filter((r) => r[m] !== undefined).map((r) => [Date.parse(r.time), +r[m]]));
const coinbase = (a) => { const m = new Map(); for (const f of [`strategy-select/${a}-USD-86400-pre2021.json`, `research2/${a}-USD-86400.json`]) { try { for (const k of JSON.parse(readFileSync(join(ENG, f))).candles) m.set(k.t, k.c); } catch { /* absent */ } } return m; };
const binance = (s) => new Map(J(`binance-spot-1d-${s}.json`).map((r) => [r[0], r[4]]));
const premium = (a, s) => { const cb = coinbase(a), bn = binance(s), m = new Map(); for (const [t, c] of cb) { const b = bn.get(t), u = usdt.get(t)?.c; if (b && u) m.set(t, c / (b * u) - 1); } return m; };
const usdtS = cm("usdt", "SplyCur"), usdcS = cm("usdc", "SplyCur"), stable = new Map();
for (const [t, v] of usdtS) stable.set(t, v + (usdcS.get(t) ?? 0));

const SIGNALS = {
  S1_funding: { sign: -1, BTC: fundingSignal(J("binance-funding-BTCUSDT.json")), ETH: fundingSignal(J("binance-funding-ETHUSDT.json")) },
  S2_exchange_netflow: { sign: -1, notPointInTime: true, BTC: netflowSignal(cm("btc", "FlowInExNtv"), cm("btc", "FlowOutExNtv"), cm("btc", "SplyCur")), ETH: netflowSignal(cm("eth", "FlowInExNtv"), cm("eth", "FlowOutExNtv"), cm("eth", "SplyCur")) },
  S3_stablecoin_growth: { sign: +1, BTC: growth30(stable), ETH: growth30(stable) },
  S4_coinbase_premium: { sign: +1, BTC: mean7(premium("BTC", "BTCUSDT")), ETH: mean7(premium("ETH", "ETHUSDT")) },
  S5_fear_greed: { sign: -1, BTC: mean7(dailyMap(J("fear-greed.json"))), ETH: mean7(dailyMap(J("fear-greed.json"))) },
};
const res = { prereg: "docs/research/signals/PREREGISTRATION.md (cdbc8fa)", dev_end: "2021-12-31", signals: {} };
const r4 = (x) => Math.round(x * 1e4) / 1e4;
for (const [name, s] of Object.entries(SIGNALS)) {
  const out = { expected_sign: s.sign, not_point_in_time: !!s.notPointInTime };
  for (const a of ["BTC", "ETH"]) {
    const fwd = forwardReturn(BARS[a], 7), x = [], y = [], days = [];
    for (let d = Date.parse("2016-01-04"); d + 7 * DAY <= DEV_END; d += 7 * DAY) { const v = s[a](d), r = fwd(d); if (v === null || r === null || !Number.isFinite(v)) continue; x.push(v); y.push(r); days.push(d); }
    if (x.length < 40) { out[a] = { n: x.length, note: "too few samples" }; continue; }
    const ic = spearman(x, y), bs = blockBootstrap(x, y, spearman), q = quintiles(x, y);
    out[a] = { n: x.length, from: new Date(days[0]).toISOString().slice(0, 10), to: new Date(days.at(-1)).toISOString().slice(0, 10), ic: r4(ic), ci99: [r4(bs.lo99), r4(bs.hi99)], se: r4(bs.se), t: r4(ic / bs.se),
      quintile_mean_fwd7_pct: q.Q.map((v) => r4(v * 100)), signed_spread_pct: r4(s.sign * q.top_minus_bottom * 100) };
  }
  const B = out.BTC, E = out.ETH;
  out.pass = { ci_excludes_0_expected_sign: !!B.ci99 && (s.sign > 0 ? B.ci99[0] > 0 : B.ci99[1] < 0), eth_same_sign: !!E.ic && Math.sign(E.ic) === s.sign, spread_ge_2pct: !!B.signed_spread_pct && B.signed_spread_pct >= 2, point_in_time: !s.notPointInTime };
  out.passes_screen = Object.values(out.pass).every(Boolean);
  res.signals[name] = out;
}
writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
for (const [k, v] of Object.entries(res.signals)) console.log(k.padEnd(22), "BTC", JSON.stringify(v.BTC), "\n", " ".repeat(22), "ETH", JSON.stringify(v.ETH), "\n", " ".repeat(22), "PASS", v.passes_screen, JSON.stringify(v.pass));
