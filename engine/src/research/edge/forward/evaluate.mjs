// Evaluation of the forward SOL OI reversal study. Returns are computed ONLY when the pre-registered sample-size gate is met
// (>= 60 primary resolved events and >= 40 clusters); before that it reports counts and data quality only (no returns).
//   node evaluate.mjs <collector dir>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RULES, clusters, gateMet } from "./core.mjs";

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
// Student t quantile by bisection on the regularized incomplete beta (two-sided level)
function ibeta(a, b, x) { // continued fraction
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lg = (z) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = z, t = z + 5.5; t -= (z + 0.5) * Math.log(t); let s = 1.000000000190015; for (const q of c) s += q / ++y; return -t + Math.log((2.5066282746310005 * s) / z); };
  const cf = (a, b, x) => { let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); let h = d; for (let m = 1; m <= 300; m++) { const m2 = 2 * m; let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2)); d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); c = 1 + aa / c; h *= d * c; aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2)); d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d); c = 1 + aa / c; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-14) break; } return h; };
  const bt = Math.exp(lg(a + b) - lg(a) - lg(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * cf(a, b, x)) / a : 1 - (bt * cf(b, a, 1 - x)) / b;
}
export function tQuantile(p, df) { // upper quantile: P(T > q) = 1 - p
  let lo = 0, hi = 100; for (let i = 0; i < 200; i++) { const q = (lo + hi) / 2, tail = 0.5 * ibeta(df / 2, 0.5, df / (df + q * q)); if (tail > 1 - p) lo = q; else hi = q; } return (lo + hi) / 2;
}
/** Statistics of resolved primary events: mean, cluster-bootstrap and t-interval CIs (both at RULES.pass.ciLevel). */
export function stats(events, { B = 10_000, seed = 23 } = {}) {
  const cl = clusters(events), means = cl.map((c) => c.reduce((s, e) => s + e.gross, 0) / c.length), n = events.length;
  const mean = events.reduce((s, e) => s + e.gross, 0) / n, a = (1 - RULES.pass.ciLevel) / 2, r = rng(seed), boot = [];
  for (let b = 0; b < B; b++) { let s = 0, m = 0; for (let k = 0; k < cl.length; k++) { const c = cl[Math.floor(r() * cl.length)]; for (const e of c) { s += e.gross; m++; } } boot.push(s / m); }
  boot.sort((x, y) => x - y);
  const cm = means.reduce((s, x) => s + x, 0) / means.length, sd = Math.sqrt(means.reduce((s, x) => s + (x - cm) ** 2, 0) / (means.length - 1)), tq = tQuantile(1 - a, means.length - 1);
  const ciBoot = [boot[Math.floor(a * B)], boot[Math.ceil((1 - a) * B) - 1]], ciT = [cm - tq * sd / Math.sqrt(means.length), cm + tq * sd / Math.sqrt(means.length)];
  const lower = Math.min(ciBoot[0], ciT[0]), netCons = events.reduce((s, e) => s + e.net.conservative, 0) / n;
  return { events: n, clusters: cl.length, mean_bps: mean * 1e4, ci90_bootstrap_bps: ciBoot.map((x) => x * 1e4), ci90_t_bps: ciT.map((x) => x * 1e4), ci90_lower_used_bps: lower * 1e4,
    mean_net_conservative_bps: netCons * 1e4, win_rate: events.filter((e) => e.gross > 0).length / n,
    verdict: mean * 1e4 > RULES.pass.meanBps && lower * 1e4 > RULES.pass.ciLowerBps ? "PASS (evidence only; no promotion without owner approval)" : "FAIL" };
}

export function readJsonl(p) { return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; }
if (process.argv[1]?.endsWith("evaluate.mjs")) {
  const dir = process.argv[2];
  const evs = readJsonl(join(dir, "events.jsonl")), outs = new Map(readJsonl(join(dir, "outcomes.jsonl")).map((o) => [o.id, o]));
  const primary = evs.filter((e) => e.qualifying && e.primary).map((e) => ({ ...e, ...(outs.get(e.id) ?? {}) })).filter((e) => e.status === "RESOLVED");
  const counts = { qualifyingDetected: evs.filter((e) => e.qualifying).length, primaryResolved: primary.length, late: evs.filter((e) => e.qualifying && !e.primary).length,
    unresolved: [...outs.values()].filter((o) => o.status === "UNRESOLVED").length, clusters: clusters(primary).length, gate: RULES.gate };
  if (!gateMet(primary)) { console.log(JSON.stringify({ gateMet: false, counts, note: "returns are not computed before the pre-registered gate is met" }, null, 1)); process.exit(0); }
  console.log(JSON.stringify({ gateMet: true, counts, result: stats(primary) }, null, 1));
}
