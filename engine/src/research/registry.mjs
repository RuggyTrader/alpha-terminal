#!/usr/bin/env node
// Strategy candidate registry (research only; never connected to execution or deployment). One entry per candidate
// with its specification, data, cost model, results and a status from a FIXED vocabulary. There is deliberately no
// "proven" status: the strongest is ELIGIBLE FOR FURTHER VALIDATION (a separate, owner-approved forward PAPER trial).
//   node src/research/registry.mjs --root ../docs/research   -> registry/candidates.json + registry/COMPARISON.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATUSES = Object.freeze(["IDEA", "SPECIFIED", "TESTING", "FAILED", "INCONCLUSIVE", "ELIGIBLE FOR FURTHER VALIDATION"]);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

/** Validates one entry: required fields and an allowed status. Throws on a bad entry. */
export function validate(c) {
  for (const k of ["id", "name", "family", "version", "markets", "timeframes", "data", "periods", "costs", "results", "status", "source"]) if (c[k] === undefined) throw new Error(`${c.id ?? "?"}: missing ${k}`);
  if (!STATUSES.includes(c.status)) throw new Error(`${c.id}: status ${c.status} is not allowed`);
  if (c.status === "ELIGIBLE FOR FURTHER VALIDATION" && !(c.results.independent?.net > 0)) throw new Error(`${c.id}: eligible without positive independent results`);
  return c;
}

// Rounds 1–5: summarised from their committed reports (figures as reported there; the reports are the source).
const HISTORY = [
  { id: "R1-OTE-ORIG-1M5M", name: "Original OTE (four live bots)", family: "OTE / Fibonacci", version: "production profiles", markets: ["SOL", "BTC"], timeframes: ["1m", "5m"],
    data: "Kraken 1m (Aug–Nov 2026)", periods: { development: "Aug–Oct 1 2026", validation: "Oct 2–Nov 12 2026" }, costs: "0.20% per fill",
    results: { validation: { net: -40.8, trades: 987, note: "all four bots negative; profit factor 0.04–0.20; ALPHA-01 negative before fees" } }, status: "FAILED",
    failure: "negative net expectancy after fees; edge before fees 0.01–0.06% of turnover", source: "docs/research/2026-11-15/PROFITABILITY-REPORT-1.md" },
  { id: "R1-OTE-FILTERS", name: "OTE + fee-aware / EMA / ATR / higher-timeframe filters", family: "OTE / Fibonacci", version: "round 1 grid", markets: ["SOL", "BTC"], timeframes: ["1m", "5m", "15m", "30m", "60m"],
    data: "Kraken 1m", periods: { validation: "Oct 2–Nov 12 2026" }, costs: "0.20%", results: { validation: { net: -1.77, note: "best: minNetRR 2.0, 22 trades" } }, status: "FAILED",
    failure: "losses cut only by removing trades", source: "docs/research/FAILED-CANDIDATES.md (round 1)" },
  { id: "R3-CANDIDATE-B", name: "BTC daily MA-50 trend (Candidate B)", family: "Trend following", version: "frozen trial rules", markets: ["BTC", "SOL", "ETH"], timeframes: ["1d"],
    data: "Coinbase daily 2021–2026", periods: { development: "2021-07–2024-07", validation: "2024-07–2026-11" }, costs: "0.20% + 0.05%",
    results: { validation: { note: "positive in every period on BTC, SOL, ETH (round 3)" } }, status: "INCONCLUSIVE",
    failure: "positive on examined markets only; forward PAPER trial deployed but NOT started (needs the owner)", source: "docs/research/round3/REPORT.md" },
  { id: "R4-OTE-HYBRID", name: "Hybrid OTE (regime / trend filters, 5m–4h)", family: "OTE / Fibonacci", version: "round 4", markets: ["BTC", "SOL", "ETH"], timeframes: ["5m", "15m", "1h", "4h"],
    data: "Coinbase 2021–2026", periods: { development: "2021-07–2024-07", validation: "2024-07–2026-11" }, costs: "0.20% + 0.05%",
    results: { validation: { note: "5m–1h loses heavily; only SOL 4h −1.618 positive (8/15 trades)" } }, status: "FAILED", failure: "no candidate met criteria", source: "docs/research/round4/REPORT.md" },
  { id: "R5-OTE-HTF", name: "OTE 4h / daily with trend filters, new markets", family: "OTE / Fibonacci", version: "round 5 (F0–F6)", markets: ["LTC", "LINK", "AVAX", "ADA", "BCH", "DOGE", "XRP"], timeframes: ["4h", "1d"],
    data: "Coinbase 1h/daily", periods: { development: "2021-07–2024-07", validation: "2024-07–2026-11" }, costs: "0.20% + 0.05%",
    results: { validation: { note: "best F4 LONG +28.1 (3/7 markets), CI includes 0" } }, status: "FAILED", failure: "breadth and significance; simple trend beat OTE", source: "docs/research/round5/REPORT.md" },
];

function fromR6(file) {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, "utf8"));
  return Object.entries(j.verdicts).map(([id, v]) => ({ id: `R6-${id}`, name: `OTE 5m fee-aware variant ${id}`, family: "OTE / Fibonacci", version: JSON.stringify(j.results[id].variant), markets: ["BTC", "SOL", "ETH", "LTC", "LINK", "ADA", "DOGE"], timeframes: ["5m"],
    data: "Coinbase 5m", periods: { development: "2021-07–2024-07 (BTC/SOL/ETH)", validation: "2024-07–2026-11", independent: "LTC/LINK/ADA/DOGE 2024-07–2026-11" }, costs: "0.20% + 0.05%; $20 wallet / $10 risk",
    results: { development: { net: v.development.net, trades: v.development.trades }, validation: { net: v.validation.net, trades: v.validation.trades },
      independent: { net: v.independent.net, gross: v.independent.gross, fees: v.independent.fees, trades: v.independent.trades, positive_markets: `${v.independent.positive}/4`, ci95: v.independent.ci } },
    fee_drag: v.independent.gross !== 0 ? `fees ${v.independent.fees} vs gross ${v.independent.gross}` : null,
    status: v.pass ? "ELIGIBLE FOR FURTHER VALIDATION" : "FAILED", failure: v.pass ? null : `failed: ${Object.entries(v.criteria).filter(([, x]) => !x).map(([k]) => k).join(", ")}; negative before fees`,
    source: "docs/research/round6/REPORT.md" }));
}

function fromR7(file) {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, "utf8"));
  return Object.entries(j.candidates).filter(([, c]) => c.selected).map(([key, c]) => {
    const [fam, side] = key.split(" ");
    const I = c.independent, positive = c.status !== "ELIGIBLE FOR FURTHER VALIDATION" && I.net > 0 && c.development.net > 0 && c.validation.net > 0 && c.independent_stress_040_010.net > 0;
    return { id: `R7-${c.selected}-${side}`, name: `${fam} ${side} (${c.selected})`, family: { T1: "Breakout / trend", T2: "Trend following", M1: "Momentum", B1: "Volatility breakout", R1: "Mean reversion" }[fam], version: `${c.selected} @ ${j.code_version ?? "?"}`,
      markets: Object.keys(I.per_market), timeframes: [c.selected.split("-")[1] === "1440" ? "1d" : c.selected.split("-")[1] === "240" ? "4h" : "1h"], data: "Coinbase public candles (sha256 in r7-results.json)",
      periods: { development: "BTC/ETH/SOL 2021-07–2024-07", validation: "10 markets 2024-07–2026-11", independent: "8 untouched markets 2021-07–2026-11" }, costs: "0.20% + 0.05% (stress 0.40% + 0.10%; 0.80%)",
      results: { development: { net: c.development.net, trades: c.development.trades }, validation: { net: c.validation.net, trades: c.validation.trades, positive_markets: `${c.validation.positive}/10` },
        independent: { net: I.net, gross: I.gross, fees: I.fees, trades: I.trades, positive_markets: `${I.positive}/8`, ci995: I.ci_995, max_dd_pct: I.dd, by_year: I.by_year },
        stress_040_010: c.independent_stress_040_010.net, cost_080: c.independent_080.net },
      fee_drag: I.gross > 0 ? `${((I.fees / I.gross) * 100).toFixed(0)}% of gross` : `fees ${I.fees} on gross ${I.gross}`,
      robustness: `all grid configurations of this family/side: ${Object.entries(j.development_all).filter(([k]) => k.startsWith(fam) && k.endsWith(side)).map(([k, v]) => `${k.split(" ")[0]} ${v.net}`).join(", ")}`,
      status: c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? c.status : positive ? "INCONCLUSIVE" : "FAILED", failure: c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? null : `failed: ${c.failed.join(", ")}`,
      source: "docs/research/round7/REPORT.md" };
  });
}

// Round 8 (docs/research/round8/PREREGISTRATION.md): SPECIFIED until r8-results.json exists, then its frozen verdicts.
const R8_SPEC = [
  { id: "R8-T1-240-55-20", name: "T1 LONG portfolio (Donchian 55/20, 4h)", family: "Breakout / trend", timeframes: ["4h"] },
  { id: "R8-M1-1440-30", name: "M1 LONG portfolio (30-day momentum)", family: "Momentum", timeframes: ["1d"] },
  { id: "R8-P3-1440-30-3", name: "P3 cross-sectional rotation (top 3 by 30-day return)", family: "Multi-asset selection", timeframes: ["1d"] },
];
export function fromR8(file) {
  const j = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  return R8_SPEC.map((sp) => {
    const base = { ...sp, version: j ? `frozen @ ${j.code_version ?? "?"}` : "frozen (pre-registered 2026-11-17)", markets: ["20 untouched markets (see pre-registration)"],
      data: "Coinbase public candles + Kraken minimums", periods: { independent: "20 untouched markets 2021-07–2026-11 (untouched markets, not untouched time)" },
      costs: "0.20% + 0.05% (stress 0.40% + 0.10%); shared $100, scenario B primary", source: "docs/research/round8/PREREGISTRATION.md" };
    const c = j?.candidates?.[sp.id];
    if (!c) return { ...base, results: {}, status: "SPECIFIED", failure: "pre-registered; not yet run (no exchange data access in the Mac session that wrote it)" };
    const B = c.untouched.scenarios.B.selected;
    return { ...base, results: { independent: { net: B.net, gross: B.gross, fees: B.fees, trades: B.trades, max_dd_pct: B.max_dd_pct, executable_pct: B.executable_pct, ci995_monthly: c.untouched.acceptance.ci_monthly_995 },
      stress_040_010: c.untouched.scenarios.B.stress.net, scenario_A_executable_pct: c.untouched.scenarios.A.selected.executable_pct },
      fee_drag: B.gross > 0 ? `${((B.fees / B.gross) * 100).toFixed(0)}% of gross` : `fees ${B.fees} on gross ${B.gross}`,
      status: c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? c.status : "FAILED", failure: c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? null : `failed: ${c.failed.join(", ")}`, source: "docs/research/round8/REPORT.md" };
  });
}

export function buildRegistry(root) {
  const list = [...HISTORY, ...fromR6(join(root, "round6", "r6-results.json")), ...fromR7(join(root, "round7", "r7-results.json")), ...fromR8(join(root, "round8", "r8-results.json"))].map(validate);
  return { generated_at: new Date().toISOString(), statuses: STATUSES, note: "Research registry. No candidate here is connected to execution; ranking is by evidence status, never by backtest profit.", candidates: list };
}

export function comparison(reg) {
  const order = ["ELIGIBLE FOR FURTHER VALIDATION", "INCONCLUSIVE", "TESTING", "SPECIFIED", "IDEA", "FAILED"];
  const rows = [...reg.candidates].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const n = (v) => (v === undefined || v === null ? "—" : typeof v === "number" ? (v > 0 ? `+${v}` : `${v}`) : v);
  let md = `# Strategy candidate comparison (generated ${reg.generated_at})\n\nResearch only. Sorted by **evidence status**, not by profit. There is no "proven" status. ELIGIBLE FOR FURTHER VALIDATION means only that a candidate may be proposed for a separate, owner-approved forward PAPER trial.\n\n`;
  md += `| Status | Candidate | Family | Independent net | Validation net | Development net | Fee drag | Why |\n|---|---|---|---|---|---|---|---|\n`;
  for (const c of rows) md += `| ${c.status} | ${c.name} | ${c.family} | ${n(c.results.independent?.net)} | ${n(c.results.validation?.net)} | ${n(c.results.development?.net)} | ${c.fee_drag ?? "—"} | ${c.failure ?? "meets the pre-registered criteria"} |\n`;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((c) => c.status === s).length]));
  md += `\n**Counts:** ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}\n\n`;
  md += `## Retire, and deserve more research\n\n`;
  md += `- **Retire:** every OTE / Fibonacci variant (rounds 1, 4, 5 and 6). It is negative before fees on independent markets. Also retire mean reversion (R1), volatility squeeze (B1) and all SHORT trend and momentum rules (round 7).\n`;
  md += `- **More research:**\n`;
  md += `  - long-only trend and momentum (round 7 T1 and M1, INCONCLUSIVE): positive out of sample, but concentrated;\n`;
  md += `  - the BTC daily MA-50 trend (Candidate B): its forward PAPER trial is deployed but not started.\n`;
  md += `  - **Next evidence must come from data not yet used** (forward data or a new pre-registered portfolio hypothesis).\n`;
  md += `  - Round 8 (pre-registered 2026-11-17): T1 / M1 / P3 as one shared $100 portfolio on 20 untouched markets, with Kraken minimums and sizing scenarios A–D; the same three are registered for the forward shadow (\`docs/research/forward/\`).\n`;
  return md;
}

if (process.argv[1] && process.argv[1].endsWith("registry.mjs")) {
  const root = arg("root", "../docs/research");
  const reg = buildRegistry(root);
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "candidates.json"), JSON.stringify(reg, null, 1));
  writeFileSync(join(root, "registry", "COMPARISON.md"), comparison(reg));
  console.log(`${reg.candidates.length} candidates:`, Object.fromEntries(STATUSES.map((s) => [s, reg.candidates.filter((c) => c.status === s).length])));
}
