// P1 order-book study analyzer (docs/research/discovery/GAP-STUDY-PREREGISTRATION.md, commit bb91f40). Applied ONCE at the end.
//   node analyze-gap.mjs <data dir> <out.json>            (fetches P1's daily reference premium from public endpoints)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000, MIN = 60_000;
export const COST = { BTC: 0.009, ETH: 0.0078, XRP: 0.0088, LTC: 0.011, DOGE: 0.01, SOL: 0.009 };
const FEE = 0.002;
const mid = (b) => (b.bid + b.ask) / 2;

/** Event study for one coin. samples: sorted [{t, ndax:{[c]}, kraken:{[c], USDCAD}}]; ref(t) -> m(d) */
export function eventsForCoin(samples, coin, ref, size = 33) {
  const out = { events: [], crossings: 0, disappeared: 0, collectionGaps: 0, stale: 0, thin: 0, open: null };
  let ev = null, pending = null;
  const rows = samples.filter((s) => s.ndax[coin] && s.kraken[coin] && s.kraken.USDCAD).map((s) => {
    const n = s.ndax[coin], g = mid(s.kraken[coin]) * mid(s.kraken.USDCAD), m = ref(s.t);
    const buy = n.buy?.[size], sell = n.sell?.[size];
    return { t: s.t, n, kmid: mid(s.kraken[coin]), g, m, buy, sell, entry: buy && m !== null ? buy / g - 1 - m : null, exit: sell && m !== null ? sell / g - 1 - m : null };
  });
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // stale: Ndax best bid & ask unchanged for >= 10 min while the Kraken mid moved >= 0.3 %
    let stale = false;
    for (let j = i - 1; j >= 0 && r.t - rows[j].t <= 30 * MIN; j--) { if (rows[j].n.bid !== r.n.bid || rows[j].n.ask !== r.n.ask) break; if (r.t - rows[j].t >= 10 * MIN && Math.abs(r.kmid / rows[j].kmid - 1) >= 0.003) { stale = true; break; } }
    const thin = !(r.n.askDepth2pct >= size) || !r.buy;
    if (ev) { // open event: close at the executable bid when the gap has closed, or time stop
      if (r.exit !== null && (r.exit >= 0 || r.t - ev.entryT >= 7 * DAY)) {
        const net = (r.sell / ev.entryPx) * (1 - FEE) ** 2 - 1;
        out.events.push({ ...ev, exitT: r.t, exitPx: r.sell, net, gap: r.exit - ev.entryPrem, hours: (r.t - ev.entryT) / 3_600_000, reason: r.exit >= 0 ? "CLOSED" : "TIME" });
        ev = null;
      }
      continue;
    }
    const crossing = r.entry !== null && r.entry < -COST[coin];
    if (pending) {
      const dt = r.t - pending.t;
      if (dt > 6 * MIN) { out.collectionGaps++; pending = null; }
      else if (dt >= MIN) {
        if (crossing && !stale && !thin) ev = { coin, entryT: r.t, entryPx: r.buy, entryPrem: r.entry, detectedT: pending.t };
        else out.disappeared++;
        pending = null; continue;
      } else continue; // < 60 s apart: wait for a later sample
    }
    if (crossing) { out.crossings++; if (stale) out.stale++; else if (thin) out.thin++; else pending = { t: r.t }; }
  }
  if (ev) { const last = rows.at(-1); out.open = { ...ev, markNet: last.sell ? (last.sell / ev.entryPx) * (1 - FEE) ** 2 - 1 : null }; }
  return out;
}

export function summarize(all) {
  const ev = all.flatMap((x) => x.events), n = ev.length, nets = ev.map((e) => e.net);
  let s = 3; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); const b = [];
  for (let k = 0; k < 2000 && n; k++) { let m = 0; for (let i = 0; i < n; i++) m += nets[Math.floor(rnd() * n)]; b.push(m / n); } b.sort((x, y) => x - y);
  const mean = (a) => a.reduce((p, q) => p + q, 0) / (a.length || 1), med = (a) => { const z = [...a].sort((x, y) => x - y); return z[z.length >> 1]; };
  const crossings = all.reduce((p, x) => p + x.crossings, 0), disappeared = all.reduce((p, x) => p + x.disappeared, 0);
  const closed = ev.filter((e) => e.reason === "CLOSED");
  return { events: n, mean_net_pct: mean(nets) * 100, ci90_pct: n ? [b[100] * 100, b[1899] * 100] : null, mean_gap_pct: mean(ev.map((e) => e.gap)) * 100, closed_share: n ? closed.length / n : null,
    median_hours_to_close: closed.length ? med(closed.map((e) => e.hours)) : null, crossings, disappeared, disappeared_share: crossings ? disappeared / crossings : null,
    stale: all.reduce((p, x) => p + x.stale, 0), thin: all.reduce((p, x) => p + x.thin, 0), collection_gaps: all.reduce((p, x) => p + x.collectionGaps, 0),
    win_rate: n ? nets.filter((x) => x > 0).length / n : null, total_net_on_33_per_event_usd: nets.reduce((p, q) => p + q * 33, 0) };
}

export function criteria(sum, perCoin) {
  const pos = Object.values(perCoin).filter((x) => x.events && x.mean_net_pct > 0).length;
  const reject = [], need = [];
  if (!(sum.mean_net_pct > 0)) reject.push("mean net <= 0");
  if (sum.events < 15) reject.push(`${sum.events} events < 15`);
  if (sum.disappeared_share !== null && sum.disappeared_share >= 0.5) reject.push(`${(sum.disappeared_share * 100).toFixed(0)} % of crossings disappeared`);
  if (!(sum.mean_gap_pct > 0.4)) reject.push(`mean gap component ${sum.mean_gap_pct?.toFixed(2)} % <= 0.40 %`);
  if (!(sum.ci90_pct && sum.ci90_pct[0] > 0)) need.push("CI lower bound not > 0");
  if (!(sum.closed_share >= 0.5 && sum.median_hours_to_close !== null && sum.median_hours_to_close <= 72)) need.push("closure share/time");
  if (pos < 3) need.push(`positive in ${pos} coins < 3`);
  return { verdict: reject.length ? "REJECT" : need.length ? "INCONCLUSIVE" : "DESERVES A SEPARATE PROSPECTIVE PAPER TEST", reject, unmet: need };
}

// ---- P1's daily reference premium from public endpoints (fetched at analysis time) ----
async function fetchReference(coins) {
  const kr = async (pair) => { const r = await (await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`)).json(); return new Map(Object.values(r.result).find(Array.isArray).map((x) => [x[0] * 1000, +x[4]])); };
  const fx = await kr("USDCAD"), ref = {};
  const IDS = { BTC: [1, "XBTUSD"], ETH: [3, "ETHUSD"], XRP: [4, "XRPUSD"], LTC: [5, "LTCUSD"], DOGE: [77, "XDGUSD"], SOL: [99, "SOLUSD"] };
  for (const c of coins) {
    const [id, pair] = IDS[c], k = await kr(pair);
    const rows = await (await fetch("https://api.ndax.io:8443/AP/GetTickerHistory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ OMSId: 1, InstrumentId: id, Interval: 86400, FromDate: new Date(Date.now() - 400 * DAY).toISOString().slice(0, 19), ToDate: new Date().toISOString().slice(0, 19) }) })).json();
    const prem = rows.map((x) => [x[9], x[4] / ((k.get(x[9]) ?? NaN) * (fx.get(x[9]) ?? NaN)) - 1]).filter(([, p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
    ref[c] = prem;
  }
  return ref;
}
const refFn = (prem) => (t) => { const d = Math.floor(t / DAY) * DAY; const w = prem.filter(([x]) => x < d).slice(-30).map(([, p]) => p); if (w.length < 30) return null; const s = [...w].sort((a, b) => a - b); return s[s.length >> 1]; };

if (process.argv[1]?.endsWith("analyze-gap.mjs")) {
  const [DIR, OUT] = process.argv.slice(2);
  const samples = []; for (const f of readdirSync(DIR).filter((x) => x.startsWith("samples-")).sort()) for (const l of readFileSync(join(DIR, f), "utf8").trim().split("\n")) if (l) samples.push(JSON.parse(l));
  samples.sort((a, b) => a.t - b.t);
  const coins = Object.keys(COST), refs = await fetchReference(coins);
  const res = { prereg: "docs/research/discovery/GAP-STUDY-PREREGISTRATION.md (bb91f40)", samples: samples.length, from: new Date(samples[0].t).toISOString(), to: new Date(samples.at(-1).t).toISOString(), note: "observed quotes do not guarantee execution", sizes: {} };
  const gaps = []; for (let i = 1; i < samples.length; i++) if (samples[i].t - samples[i - 1].t > 6 * MIN) gaps.push({ after: new Date(samples[i - 1].t).toISOString(), minutes: Math.round((samples[i].t - samples[i - 1].t) / MIN) });
  res.coverage = { expected_samples_at_2min: Math.round((samples.at(-1).t - samples[0].t) / (2 * MIN)), actual: samples.length, gaps_over_6min: gaps.length, largest_gaps: gaps.sort((a, b) => b.minutes - a.minutes).slice(0, 5) };
  for (const size of [33, 100]) {
    const per = Object.fromEntries(coins.map((c) => [c, eventsForCoin(samples, c, refFn(refs[c]), size)]));
    const perSum = Object.fromEntries(coins.map((c) => [c, summarize([per[c]])]));
    const sum = summarize(Object.values(per));
    res.sizes[`C$${size}`] = { summary: sum, per_coin: perSum, open_events: coins.map((c) => per[c].open).filter(Boolean), events: Object.values(per).flatMap((x) => x.events), ...(size === 33 ? { criteria: criteria(sum, perSum) } : {}) };
  }
  writeFileSync(OUT, JSON.stringify(res, null, 1) + "\n");
  console.log(JSON.stringify({ coverage: res.coverage, C33: res.sizes["C$33"].summary, criteria: res.sizes["C$33"].criteria, C100: res.sizes["C$100"].summary }, null, 1));
}
