// RESEARCH forward shadow evaluator. Replays each registered candidate over the FIRST-SEEN candles in the forward
// store, trading only from its frozen start_at, with the round-8 portfolio backtester (next-open fills, fees,
// slippage, Kraken minimums, recorded rejections). Deterministic: the same store and code give the same report.
// Output is HYPOTHETICAL research. It is never a funded PAPER result and is never added to the portfolio.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { aggregate } from "../../cli/fleet-backtest.mjs";
import { backtestPortfolio, blockBootstrap, monthlyReturns, summarizePortfolio } from "../r8/portfolio.mjs";
import { bootstrap } from "../r7/bt.mjs";
import { CANDIDATES } from "../r8/families.mjs";
import { COSTS, SCENARIOS } from "../r8/markets.mjs";
import { candleFile, readCandles } from "./store.mjs";

export const LABEL = "HYPOTHETICAL RESEARCH SHADOW: simulated on public candles; not funded PAPER results; not a profit claim";
const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? x ?? null : +x.toFixed(d));
const sum = (x) => x.reduce((a, b) => a + b, 0);

/** Loads the basket for a timeframe from the store: 4h is built from stored 1h candles. */
export function loadBasket(dir, basket, tf) {
  const series = {}, firstSeen = {}, provenance = {}, revisions = {};
  for (const m of basket) {
    const g = tf === 1440 ? 86400 : 3600, { candles, revisions: rv } = readCandles(dir, m, g);
    if (!candles.length) continue;
    firstSeen[m] = new Map(candles.map((c) => [c.t, c.first_seen_at]));
    series[m] = tf === 1440 ? candles.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })) : aggregate(candles, 240).filter((b, i, a) => i < a.length - 1 || completeFourHour(candles, b.t));
    const f = candleFile(dir, m, g);
    provenance[m] = { file: `${m}-${g}.jsonl`, sha256: existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) : null, candles: candles.length, last: new Date(candles.at(-1).t).toISOString() };
    revisions[m] = rv.length;
  }
  return { series, firstSeen, provenance, revisions };
}
/** A 4h bar is complete only when all four 1h candles that close it exist (the last one may still be missing). */
function completeFourHour(candles, t4) { const end = t4 + 4 * 3_600_000; return candles.some((c) => c.t === end - 3_600_000); }

/** Evaluates one registered forward candidate. `now` only labels the report; results depend on stored data only. */
export function evaluateForward(dir, reg, { now = Date.now() } = {}) {
  const cand = CANDIDATES.find((c) => c.id === reg.source_candidate);
  if (!cand) throw new Error(`${reg.id}: unknown source candidate ${reg.source_candidate}`);
  const sc = SCENARIOS[reg.scenario];
  if (!sc || sc.isolated) throw new Error(`${reg.id}: forward scenario must be a shared-account scenario (B, C or D)`);
  const start = Date.parse(reg.start_at);
  const mins = reg.minimums ?? {}, noMin = reg.basket.filter((m) => !mins[m]);
  // a market without a published Kraken minimum is EXCLUDED (never traded with an assumed-zero minimum)
  const { series, firstSeen, provenance, revisions } = loadBasket(dir, reg.basket.filter((m) => mins[m]), cand.tf);
  const make = cand.make(series), runs = {};
  for (const [ck, cost] of Object.entries(COSTS)) runs[ck] = backtestPortfolio(series, make, { capital: reg.capital ?? 100, ...cost, scenario: sc.scenario, sizing: sc.sizing, minimums: mins, from: start, to: Infinity });
  const r = runs.selected, s = summarizePortfolio(r), st = summarizePortfolio(runs.stress);
  const closed = r.trades.filter((t) => t.kind !== "end"), open = r.trades.filter((t) => t.kind === "end");
  const lastBar = Math.max(-Infinity, ...Object.values(series).map((b) => b.at(-1)?.t ?? -Infinity));
  const days = Math.max(0, (lastBar - start) / 86_400_000);
  const months = monthlyReturns(r.curve).map((x) => x.ret);
  const uncertainty = months.length >= 6 ? { method: "99.5% block bootstrap of monthly returns", ci: blockBootstrap(months)?.map((x) => round(x, 4)) }
    : closed.length >= 5 ? { method: "95% per-trade bootstrap (few trades: wide and unreliable)", ci: bootstrap(closed.map((t) => t.net), 0.95)?.map((x) => round(x, 4)) }
    : { method: "insufficient data", ci: null };
  // information audit: when could each decision have been known? lateness = first seen - bar close (collection delay)
  const g = cand.tf * 60_000;
  // first_seen_at of the candle that CLOSED the decision bar (for 4h: its last 1h candle)
  const audit = r.signals.map((x) => { const fs = firstSeen[x.market]?.get(cand.tf === 240 ? x.decidedT + 3 * 3_600_000 : x.decidedT); return { market: x.market, decided_at_close: new Date(x.decidedT + g).toISOString(), first_seen_at: fs ?? null, outcome: x.outcome }; });
  const evaluable = days >= (reg.min_days ?? 180) && closed.length >= (reg.min_trades ?? 30);
  const ewBH = (() => { const ms = Object.keys(series); if (!ms.length) return null; const c = (COSTS.selected.feePct + COSTS.selected.slipPct) / 100;
    return round(sum(ms.map((m) => { const b = series[m].filter((k) => k.t >= start); return b.length ? (100 / ms.length) * (b.at(-1).c / b[0].o) * (1 - c) ** 2 : 100 / ms.length; })) - 100); })();
  return {
    id: reg.id, label: LABEL, source_candidate: reg.source_candidate, family: cand.family, timeframe: cand.tf === 1440 ? "1d" : "4h", scenario: sc.label,
    status: evaluable ? "FORWARD SHADOW: EVALUABLE (apply the registered acceptance)" : "FORWARD SHADOW: COLLECTING (too little forward data for any conclusion)",
    registered_at: reg.registered_at, start_at: reg.start_at, report_at: new Date(now).toISOString(), data_through: Number.isFinite(lastBar) ? new Date(lastBar + g).toISOString() : null,
    forward_days: round(days, 1), markets_with_data: Object.keys(series).length, basket: reg.basket.length,
    excluded_markets: noMin.map((m) => ({ market: m, reason: "no Kraken USD minimum in the latest snapshot" })), minimums_fetched_at: reg.minimums_fetched_at ?? null,
    selected_costs: { gross: round(s.gross), fees: round(s.fees), net_marked: round(s.net), realized_net: round(sum(closed.map((t) => t.net))), trades_closed: closed.length, max_dd_pct: round(s.max_dd_pct, 1), exposure: round(s.exposure) },
    stress_costs: { net_marked: round(st.net), fees: round(st.fees) },
    open_positions: open.map((t) => ({ market: t.market, entry_at: new Date(t.entryT).toISOString(), entry: round(t.entry, 6), qty: t.qty, mark: round(t.exit / (1 - COSTS.selected.slipPct / 100), 6), unrealized_net_after_exit_costs: round(t.net) })),
    feasibility: { attempts: s.signals, setups: s.setups, executed_setups: s.executed_setups, executable_pct: round(s.executable_pct, 1), rejections: s.rejections },
    benchmarks: { cash: 0, equal_weight_buy_hold: ewBH },
    uncertainty, data: { provenance, revisions_seen: revisions }, information_audit: audit.slice(-50),
    acceptance: reg.acceptance,
  };
}
