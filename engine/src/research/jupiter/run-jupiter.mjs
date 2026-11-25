// Runner for the pre-registered Jupiter Perps PAPER research (docs/research/jupiter/PREREGISTRATION.md, Amendment 1).
//   node run-jupiter.mjs <binance dir> <out dir>             DEV windows only
//   node run-jupiter.mjs <binance dir> <out dir> --holdout   sealed HOLDOUT, allowed only once results-dev.json is committed
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, strategyA, strategyB, sigmaAt, H, DAY } from "./strategies.mjs";
import { strategyAIndependent, strategyBIndependent } from "./strategies-independent.mjs";
import { runBacktest, rollingStats } from "./backtest.mjs";

const EXPECTED_SHA = "091135894db8bb1e6583282446cb2ac1ad7bb3d1929aee5581e5349efb8d820a";
const here = dirname(fileURLToPath(import.meta.url));
const [BIN, OUT, flag] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(join(here, "config.frozen.json"), "utf8"));
const sha = createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
if (sha !== EXPECTED_SHA) { console.error(`REFUSED: config hash ${sha} != pre-registered ${EXPECTED_SHA}`); process.exit(3); }
const HOLDOUT = flag === "--holdout";
if (HOLDOUT) {
  const dev = join(OUT, "results-dev.json");
  const tracked = (() => { try { execFileSync("git", ["ls-files", "--error-unmatch", dev], { stdio: "ignore" }); execFileSync("git", ["diff", "--quiet", "HEAD", "--", dev]); return true; } catch { return false; } })();
  if (!existsSync(dev) || !tracked) { console.error("REFUSED: the HOLDOUT is sealed until results-dev.json is committed unchanged"); process.exit(4); }
}

// ---- data (SUBSTITUTE: Binance spot 1h) ----
const SYM = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" }, manifest = JSON.parse(readFileSync(join(BIN, "MANIFEST.json"), "utf8"));
const data = {};
for (const [a, s] of Object.entries(SYM)) {
  const text = readFileSync(join(BIN, `${s}-1h.json`), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== manifest[s].sha256) throw new Error(`${s} data hash mismatch`);
  const rows = JSON.parse(text).rows, b4 = aggregate(rows, 4 * H), daily = aggregate(rows, DAY);
  const sigmaByDay = new Map(daily.map((d) => [d.t, sigmaAt(daily, d.t + DAY, cfg.sizing.volLookbackDays)]));
  data[a] = { rows, b4, daily, sigmaByDay };
}
// ---- validation: strategies vs the independent implementation on the real data ----
const validation = {};
for (const a of cfg.assets) for (const v of cfg.variants) {
  const A = cfg.strategies.A, B = cfg.strategies.B;
  const a1 = strategyA(data[a].b4, A, v), a2 = strategyAIndependent(data[a].b4, A.channelsDays, A.barsPerDay, A.exitFraction, v === "long_short");
  const b1 = strategyB(data[a].daily, B, v), b2 = strategyBIndependent(data[a].daily, B.lookbackDays, B.holdDays, B.anchor, v === "long_short");
  const mA = a1.length === a2.length && a1.every((p, i) => p.t === a2[i][0] && p.signal === a2[i][1]);
  const mB = b1.length === b2.length && b1.every((p, i) => p.t === b2[i][0] && p.signal === b2[i][1]);
  validation[`${a} ${v}`] = { A_bars: a1.length, A_identical: mA, B_decisions: b1.length, B_identical: mB };
  if (!mA || !mB) throw new Error(`signal validation failed for ${a} ${v}`);
}
const sigCache = {};
const signalsFor = (s, v, a) => (sigCache[`${s}${v}${a}`] ??= s === "A" ? strategyA(data[a].b4, cfg.strategies.A, v) : strategyB(data[a].daily, cfg.strategies.B, v));
const markets = (s, v) => Object.fromEntries(cfg.assets.map((a) => [a, { ...data[a], signals: signalsFor(s, v, a) }]));

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const summary = (r, from, to) => ({
  final: r2(r.final), cagr_pct: r2(r.cagr_pct), max_dd_pct: r2(r.max_dd_pct), min_equity: r2(r.min_equity), shutdown: r.shutdown ? new Date(r.shutdown.t).toISOString().slice(0, 13) : null,
  liquidations: r.liquidations, trades: r.trades, win_rate: r.win_rate === null ? null : r2(r.win_rate * 100), profit_factor: r2(r.profit_factor),
  fees: Object.fromEntries(Object.entries(r.fees).map(([k, v]) => [k, r2(v)])), counts: r.counts, ledger_residual: r.ledger_residual, equity_identity_residual: r.equity_identity_residual,
  years: Object.fromEntries([...new Set(r.curve.map(([t]) => new Date(t).getUTCFullYear()))].map((y) => { const c = r.curve.filter(([t]) => new Date(t).getUTCFullYear() === y), before = r.curve.filter(([t]) => new Date(t).getUTCFullYear() < y).at(-1)?.[1] ?? cfg.account.capitalUsd; return [y, r2((c.at(-1)[1] / before - 1) * 100)]; })),
});
const windows = HOLDOUT ? { HOLDOUT: cfg.windows.HOLDOUT } : Object.fromEntries(Object.entries(cfg.windows).filter(([k]) => k !== "HOLDOUT"));
const rows = [], cands = [];
for (const s of ["A", "B"]) for (const v of cfg.variants) for (const L of cfg.leverageLevels) cands.push({ id: `${s} ${v} L${L}`, s, v, L });
for (const cd of cands) for (const [w, [a0, a1]] of Object.entries(windows)) for (const cn of ["base", "conservative"]) {
  const from = Date.parse(a0), to = Date.parse(a1);
  const r = runBacktest(markets(cd.s, cd.v), { from, to, L: cd.L, costs: cfg.costs[cn], config: cfg });
  if (Math.abs(r.ledger_residual) > 1e-6 || Math.abs(r.equity_identity_residual) > 1e-6) throw new Error(`ledger mismatch ${cd.id} ${w} ${cn}`);
  rows.push({ candidate: cd.id, window: w, costs: cn, ...summary(r, from, to) });
}
let out;
if (!HOLDOUT) {
  // DEV-2 conservative: research-mode run (no shutdown) for rolling windows / P(-25 % in 91 days); per-asset runs (breadth)
  const [d0, d1] = cfg.windows["DEV-2"].map(Date.parse), C = cfg.costs.conservative, extra = {};
  for (const cd of cands) {
    const rr = runBacktest(markets(cd.s, cd.v), { from: d0, to: d1, L: cd.L, costs: C, config: cfg, shutdownEnabled: false });
    const roll = Object.fromEntries([7, 14, 30, 91].map((h) => [`${h}d`, Object.fromEntries(Object.entries(rollingStats(rr.curve, h)).map(([k, x]) => [k, k === "p_loss25" || k === "positive_share" ? Math.round(x * 1000) / 1000 : r2(x)]))]));
    const per = Object.fromEntries(cfg.assets.map((a) => { const x = runBacktest(markets(cd.s, cd.v), { from: d0, to: d1, L: cd.L, costs: C, config: cfg, assets: [a] }); return [a, { final: r2(x.final), cagr_pct: r2(x.cagr_pct), max_dd_pct: r2(x.max_dd_pct), liquidations: x.liquidations }]; }));
    extra[cd.id] = { research_mode_no_shutdown: { final: r2(rr.final), cagr_pct: r2(rr.cagr_pct), max_dd_pct: r2(rr.max_dd_pct), liquidations: rr.liquidations }, rolling: roll, per_asset: per };
  }
  const get = (id, w, cn) => rows.find((x) => x.candidate === id && x.window === w && x.costs === cn);
  const decisions = {};
  for (const cd of cands) {
    const g = (w) => get(cd.id, w, "conservative"), e = extra[cd.id];
    const Q1 = ["DEV-2", "DEV-3"].every((w) => g(w).max_dd_pct < 15 && !g(w).shutdown);
    const Q2 = g("DEV-2").cagr_pct > 7.4 && g("DEV-3").cagr_pct > 0;
    const Q3 = ["DEV-1", "DEV-2", "DEV-3"].every((w) => g(w).liquidations === 0);
    const Q4 = e.rolling["91d"].p_loss25 < 0.05;
    const Q5 = Object.values(e.per_asset).filter((x) => x.final > cfg.account.capitalUsd).length >= 2;
    decisions[cd.id] = { Q1, Q2, Q3, Q4, Q5, passes_dev: Q1 && Q2 && Q3 && Q4 && Q5, dev2_conservative_cagr: g("DEV-2").cagr_pct, dev2_conservative_dd: g("DEV-2").max_dd_pct };
  }
  const passing = Object.entries(decisions).filter(([, d]) => d.passes_dev).sort((a, b) => b[1].dev2_conservative_cagr - a[1].dev2_conservative_cagr);
  out = { config_id: cfg.id, config_sha256: sha, data: { source: "Binance spot 1h (SUBSTITUTE price data, not Jupiter fills)", manifest }, validation, decisions, pick_before_holdout: passing[0]?.[0] ?? "NONE QUALIFIES", rows, extra };
  writeFileSync(join(OUT, "results-dev.json"), JSON.stringify(out, null, 1) + "\n");
} else {
  out = { config_id: cfg.id, config_sha256: sha, window: cfg.windows.HOLDOUT, rows };
  writeFileSync(join(OUT, "results-holdout.json"), JSON.stringify(out, null, 1) + "\n");
}
console.log(JSON.stringify(HOLDOUT ? rows.filter((x) => x.costs === "conservative").map((x) => [x.candidate, x.final, x.max_dd_pct, x.shutdown]) : { validation, decisions, pick: out.pick_before_holdout }, null, 1));
