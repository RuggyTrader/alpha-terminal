// 7-day cost study analysis (read-only data from collect.mjs). Measures, for a $100 account (C$50 orders = one S3 sleeve):
//   * MARKET: executable buy/sell prices walking the book + the verified taker fee, per side and round trip
//     (buy and sell at the same instant: spread + impact + 2 fees; a venue's price premium cancels and is NOT added).
//   * POST-ONLY: limit at the best bid (buy) / best ask (sell) when the order is placed. Filled only if, within the
//     window, public trades at or through the limit exceed the displayed queue ahead of us plus our own size (or a trade
//     prints strictly through it). Cost = implementation shortfall vs the mid at placement (captures adverse moves).
//   * HYBRID: the same limit for 4 h, then a market order at the first sample after 4 h (shortfall vs the original mid).
//   * CAD->USD conversion for the Kraken USD route (one-time, round trip): USD/CAD book + verified 0.20 % FX fee.
//   * Premium of Ndax over Kraken CAD and over the global price (Coinbase USD x USD/CAD), and how much it CHANGES over
//     1 and 7 days (the only way a premium affects a round trip).
//   node analyze.mjs <data dir> <out.json> [--s3 <engine/data>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [DIR, OUT] = process.argv.slice(2);
const FEES = { // VERIFIED on the venues' fee pages, 2026-11-22 (Tier 1 / flat)
  Kraken: { maker: 0.004, taker: 0.008, fx: 0.002, src: "kraken.com/ca/pro/fees (Spot Tier 1; Stablecoins & FX Tier 1)" },
  Ndax: { maker: 0.002, taker: 0.002, src: "ndax.io/en/fees (flat 0.20 %)" },
};
const SIZE = "50", HOUR = 3_600_000;
const lines = (prefix) => readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort().flatMap((f) => readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const S = lines("samples-").sort((a, b) => a.t - b.t);
const T = lines("trades-");
const q = (a, p) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; };
const mean = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const pct = (x) => (x === null ? null : Math.round(x * 1e6) / 1e4); // fraction -> % with 2 decimals
const stats = (a) => ({ n: a.filter(Number.isFinite).length, mean_pct: pct(mean(a)), median_pct: pct(q(a, 0.5)), p90_pct: pct(q(a, 0.9)), max_pct: pct(q(a, 1)) });
const isWeekend = (t) => { const d = new Date(t).getUTCDay(); return d === 0 || d === 6; };
const out = { generated_at: new Date().toISOString(), samples: S.length, first: S[0] && new Date(S[0].t).toISOString(), last: S.at(-1) && new Date(S.at(-1).t).toISOString(), fees_verified: FEES, order_size_cad: Number(SIZE), market: {}, post_only: {}, conversion: {}, premium: {}, coverage: {} };
// coverage: gaps in sampling (PC off / asleep)
const gaps = []; for (let i = 1; i < S.length; i++) if (S[i].t - S[i - 1].t > 20 * 60_000) gaps.push({ from: new Date(S[i - 1].t).toISOString(), hours: Math.round((S[i].t - S[i - 1].t) / HOUR * 10) / 10 });
out.coverage = { gaps_over_20_min: gaps.length, gap_hours: Math.round(gaps.reduce((s, g) => s + g.hours, 0) * 10) / 10, gaps: gaps.slice(0, 30) };

// ---- MARKET orders (per side and same-instant round trip), per route ----
const ROUTES = { "Ndax BTC/CAD": "Ndax", "Ndax ETH/CAD": "Ndax", "Kraken BTC/CAD": "Kraken", "Kraken ETH/CAD": "Kraken", "Kraken BTC/USD": "Kraken", "Kraken ETH/USD": "Kraken" };
for (const [book, venue] of Object.entries(ROUTES)) {
  const f = FEES[venue].taker, rows = S.map((s) => ({ t: s.t, b: s.books[book] })).filter((x) => x.b && x.b.exec?.[SIZE]?.buy && x.b.exec?.[SIZE]?.sell);
  const buySide = rows.map((x) => x.b.exec[SIZE].buy / x.b.mid - 1 + f), sellSide = rows.map((x) => 1 - x.b.exec[SIZE].sell / x.b.mid + f);
  const rt = rows.map((x) => x.b.exec[SIZE].buy / x.b.exec[SIZE].sell - 1 + 2 * f);
  const spread = rows.map((x) => x.b.spread_bps / 1e4);
  out.market[book] = { venue, fee_per_side_pct: f * 100, spread: stats(spread), buy_side_total: stats(buySide), sell_side_total: stats(sellSide), round_trip_total: stats(rt),
    round_trip_weekday: stats(rows.filter((x) => !isWeekend(x.t)).map((x) => x.b.exec[SIZE].buy / x.b.exec[SIZE].sell - 1 + 2 * f)),
    round_trip_weekend: stats(rows.filter((x) => isWeekend(x.t)).map((x) => x.b.exec[SIZE].buy / x.b.exec[SIZE].sell - 1 + 2 * f)) };
}

// ---- POST-ONLY and HYBRID (CAD books, where public trades are collected) ----
const tradesBy = {};
for (const x of T) { const k = `${x.v} ${x.pair}`; (tradesBy[k] ??= []).push(x); }
for (const k of Object.keys(tradesBy)) { const seen = new Set(); tradesBy[k] = tradesBy[k].filter((x) => { const id = `${x.t}|${x.px}|${x.qty}|${x.side}|${x.id ?? ""}`; if (seen.has(id)) return false; seen.add(id); return true; }).sort((a, b) => a.t - b.t); }
const TRADE_KEY = { "Ndax BTC/CAD": "Ndax BTCCAD", "Ndax ETH/CAD": "Ndax ETHCAD", "Kraken BTC/CAD": "Kraken XBTCAD", "Kraken ETH/CAD": "Kraken ETHCAD" };
for (const [book, tk] of Object.entries(TRADE_KEY)) {
  const venue = ROUTES[book], F = FEES[venue], tr = tradesBy[tk] ?? [];
  if (!tr.length) continue;
  const tradeEnd = tr.at(-1).t;
  const res = { "1h": [], "4h": [], "24h": [] }, hyb = [], fillRate = { "1h": [0, 0], "4h": [0, 0], "24h": [0, 0] };
  // one placement per hour of samples (to keep the windows comparable and the computation light)
  const placements = S.filter((s, i) => s.books[book] && (i === 0 || Math.floor(s.t / HOUR) !== Math.floor(S[i - 1].t / HOUR)));
  for (const s of placements) {
    const b = s.books[book];
    for (const side of ["BUY", "SELL"]) {
      const lim = side === "BUY" ? b.bid : b.ask, queue = side === "BUY" ? b.bid_qty : b.ask_qty, ourQty = Number(SIZE) / lim;
      for (const [w, ms] of [["1h", HOUR], ["4h", 4 * HOUR], ["24h", 24 * HOUR]]) {
        if (s.t + ms > tradeEnd) continue;
        let vol = 0, fillT = null;
        for (const x of tr) {
          if (x.t <= s.t) continue; if (x.t > s.t + ms) break;
          const through = side === "BUY" ? (x.side === "sell" && x.px <= lim) : (x.side === "buy" && x.px >= lim);
          const strictly = side === "BUY" ? x.px < lim : x.px > lim;
          if (!through) continue;
          vol += x.qty; if (strictly || vol >= queue + ourQty) { fillT = x.t; break; }
        }
        fillRate[w][1]++;
        if (fillT !== null) { fillRate[w][0]++; res[w].push((side === "BUY" ? lim / b.mid - 1 : 1 - lim / b.mid) + F.maker); }
        if (w === "4h") {
          if (fillT !== null) hyb.push((side === "BUY" ? lim / b.mid - 1 : 1 - lim / b.mid) + F.maker);
          else { const later = S.find((y) => y.t >= s.t + 4 * HOUR && y.books[book]?.exec?.[SIZE]?.buy); if (later) { const e = later.books[book].exec[SIZE]; hyb.push((side === "BUY" ? e.buy / b.mid - 1 : 1 - e.sell / b.mid) + F.taker); } }
        }
      }
    }
  }
  out.post_only[book] = {
    venue, maker_fee_pct: F.maker * 100, placements: placements.length,
    fill_rate_pct: Object.fromEntries(Object.entries(fillRate).map(([w, [a, n]]) => [w, n ? Math.round((a / n) * 1000) / 10 : null])),
    cost_when_filled_per_side: Object.fromEntries(Object.entries(res).map(([w, a]) => [w, stats(a)])),
    hybrid_4h_then_market_per_side: stats(hyb),
    note: "unfilled post-only orders are MISSED (no cost, but the trade does not happen); HYBRID never misses",
  };
}

// ---- one-time CAD -> USD -> CAD conversion on Kraken (USD route) ----
const fx = S.map((s) => s.books["Kraken USD/CAD"]).filter((b) => b?.exec?.["100"]?.buy && b.exec["100"].sell);
out.conversion["Kraken CAD->USD->CAD (C$100, market, 0.20 % FX fee each way)"] = stats(fx.map((b) => b.exec["100"].buy / b.exec["100"].sell - 1 + 2 * FEES.Kraken.fx));

// ---- premiums (level, and change over 1 and 7 days) ----
for (const a of ["BTC", "ETH"]) {
  const rows = S.map((s) => {
    const n = s.books[`Ndax ${a}/CAD`], k = s.books[`Kraken ${a}/CAD`], r = s.ref?.[`${a}-USD`];
    const glob = r && s.usdcad ? ((r.bid + r.ask) / 2) * s.usdcad : null;
    return { t: s.t, ndax_vs_kraken: n && k ? n.mid / k.mid - 1 : null, ndax_vs_global: n && glob ? n.mid / glob - 1 : null, kraken_vs_global: k && glob ? k.mid / glob - 1 : null };
  });
  const change = (key, h) => rows.map((x) => { const y = rows.find((z) => z.t >= x.t + h * HOUR); return y && x[key] !== null && y[key] !== null ? y[key] - x[key] : null; });
  out.premium[a] = { ndax_vs_kraken: stats(rows.map((x) => x.ndax_vs_kraken)), ndax_vs_global: stats(rows.map((x) => x.ndax_vs_global)), kraken_vs_global: stats(rows.map((x) => x.kraken_vs_global)),
    ndax_vs_global_change_1d: stats(change("ndax_vs_global", 24)), kraken_vs_global_change_1d: stats(change("kraken_vs_global", 24)),
    note: "a constant premium cancels in a round trip; only its change between entry and exit affects returns (not added to the costs above)" };
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ samples: out.samples, first: out.first, last: out.last, gaps: out.coverage.gaps_over_20_min }, null, 0));
for (const [k, v] of Object.entries(out.market)) console.log(`MARKET ${k.padEnd(16)} round trip median ${v.round_trip_total.median_pct}% p90 ${v.round_trip_total.p90_pct}% | spread median ${v.spread.median_pct}%`);
for (const [k, v] of Object.entries(out.post_only)) console.log(`POST   ${k.padEnd(16)} fill 1h/4h/24h ${JSON.stringify(v.fill_rate_pct)} | filled cost/side (4h) ${v.cost_when_filled_per_side["4h"].mean_pct}% | hybrid/side ${v.hybrid_4h_then_market_per_side.mean_pct}%`);
console.log("FX", JSON.stringify(out.conversion), "\nPREMIUM", JSON.stringify(Object.fromEntries(Object.entries(out.premium).map(([a, v]) => [a, { ndax_vs_kraken: v.ndax_vs_kraken.median_pct, ndax_vs_global: v.ndax_vs_global.median_pct, kraken_vs_global: v.kraken_vs_global.median_pct }]))));
