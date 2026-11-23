// Forward PAPER report and the pre-registered day-7 / day-14 checks (docs/research/discovery/PAPER-FORWARD-PREREGISTRATION.md).
// Reads only local files. PAPER results: observed quotes do not guarantee real fills, and short windows do not predict returns.
//   node paper-report.mjs <gap-study dir> [gap-analysis.json] [> report.md]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000, START = Date.parse("2026-11-24T00:00:00Z"), SAMPLE_MS = 120_000;

/** Pure summary of one account from its state and its equity series [{ t, eq }]. */
export function accountStats(a, series, asOf) {
  const last = series.at(-1)?.eq ?? 100, at = (t) => { let v = 100; for (const p of series) { if (p.t > t) break; v = p.eq; } return v; };
  const ret = (days) => (asOf - START < days * DAY ? null : last / at(asOf - days * DAY) - 1);
  const closed = a.trades, wins = closed.filter((x) => x.net > 0), gw = wins.reduce((s, x) => s + x.net, 0), gl = -closed.filter((x) => x.net <= 0).reduce((s, x) => s + x.net, 0);
  return { equity: last, net_pct: (last / 100 - 1) * 100, r1d_pct: ret(1) === null ? null : ret(1) * 100, r1w_pct: ret(7) === null ? null : ret(7) * 100, r2w_pct: ret(14) === null ? null : ret(14) * 100,
    trades: closed.length, win_rate: closed.length ? wins.length / closed.length : null, profit_factor: gl > 0 ? gw / gl : closed.length ? Infinity : null,
    fees: a.fees, max_dd_pct: a.maxDD * 100, open: Object.keys(a.pos), missed: a.missed.length, gap_gone: a.missed.filter((m) => m.crossingGone).length, halted: a.halted };
}

/** The pre-registered checks. gap = the order-book study's C$33 summary (or null if not supplied). */
export function verdict(stats, day, gap) {
  const p = stats["P1-100"], s3 = stats["S3-25"], reasons = [];
  if (p.max_dd_pct >= 15) reasons.push(`P1-100 drawdown ${p.max_dd_pct.toFixed(2)} % >= 15 %`);
  if (day >= 14) {
    if (p.net_pct <= Math.max(0, s3.net_pct)) reasons.push(`(a) P1-100 net ${p.net_pct.toFixed(2)} % <= max(0, S3-25 net ${s3.net_pct.toFixed(2)} %)`);
    if (gap && gap.events >= 10 && gap.mean_net_pct <= 0) reasons.push(`(c) order-book study: ${gap.events} events, mean net ${gap.mean_net_pct.toFixed(3)} % <= 0`);
    if (gap && gap.crossings > 0 && gap.disappeared_share >= 0.5) reasons.push(`(d) ${(gap.disappeared_share * 100).toFixed(0)} % of crossings disappeared before execution`);
    return { stage: "day-14 initial assessment", decision: reasons.length ? "STOP P1" : "CONTINUE to day 30 (no pass is possible at day 14)", reasons };
  }
  if (day >= 7) {
    const pr = p.trades >= 5 && p.win_rate === 0;
    if (pr) reasons.push(`${p.trades} closed trades, all lost after costs`);
    return { stage: "day-7 review (descriptive)", decision: reasons.length ? "STOP P1 early" : "CONTINUE (descriptive review only)", reasons };
  }
  return { stage: `day ${day} (before the day-7 review)`, decision: reasons.length ? "HALTED" : "RUNNING", reasons };
}

if (process.argv[1]?.endsWith("paper-report.mjs")) {
  const [DIR, GAP] = process.argv.slice(2), P = join(DIR, "paper");
  const state = JSON.parse(readFileSync(join(P, "state.json"), "utf8"));
  const rows = readFileSync(join(P, "equity.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const asOf = rows.at(-1)?.t ?? Date.now(), day = Math.max(0, Math.floor((asOf - START) / DAY));
  const stats = Object.fromEntries(state.accounts.map((a) => [a.name, accountStats(a, rows.filter((r) => r.t >= START).map((r) => ({ t: r.t, eq: r[a.name] })), asOf)]));
  const gap = GAP && existsSync(GAP) ? JSON.parse(readFileSync(GAP, "utf8")).sizes?.["C$33"]?.summary ?? null : null;
  const v = verdict(stats, day, gap);
  const live = rows.filter((r) => r.t >= START), expected = Math.max(1, Math.floor((asOf - START) / SAMPLE_MS)), coverage = live.length / expected;
  const f = (x, d = 2) => (x === null || x === undefined ? "n/a" : x === Infinity ? "inf" : x.toFixed(d));
  const out = [
    `# Forward PAPER report: P1 vs S3-25, as of ${new Date(asOf).toISOString()} (day ${day})`, "",
    "PAPER results from public order books. Observed quotes do not guarantee real fills; a few weeks do not predict future returns.", "",
    `**${v.stage}: ${v.decision}**${v.reasons.length ? "\n" + v.reasons.map((r) => `* ${r}`).join("\n") : ""}`, "",
    "| Account | Equity C$ | Net % | 1 day % | 1 week % | 2 weeks % | Trades | Win rate | PF | Fees C$ | Max DD % | Missed (gap gone) | Open |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(stats).map(([n, s]) => `| ${n}${s.halted ? " (HALTED)" : ""} | ${f(s.equity)} | ${f(s.net_pct)} | ${f(s.r1d_pct)} | ${f(s.r1w_pct)} | ${f(s.r2w_pct)} | ${s.trades} | ${s.win_rate === null ? "n/a" : f(s.win_rate * 100, 0) + " %"} | ${f(s.profit_factor)} | ${f(s.fees, 3)} | ${f(s.max_dd_pct)} | ${s.missed} (${s.gap_gone}) | ${s.open.join(", ") || "-"} |`), "",
    `Collection coverage since the start: ${live.length} of ~${expected} expected 2-minute samples (${f(coverage * 100, 1)} %).`,
    gap ? `Order-book study (C$33): ${gap.events} executable events, mean net ${f(gap.mean_net_pct, 3)} %, ${gap.crossings} crossings, ${gap.disappeared} disappeared (${gap.disappeared_share === null ? "n/a" : f(gap.disappeared_share * 100, 0) + " %"}).` : "Order-book study summary not supplied.", "",
    "## Daily P1 signals (deviation % vs the 30-day median; signal needs < -cost and C$10k volume)", "",
    ...state.days.map((d) => `* ${d.day}: ${Object.entries(d.p1).map(([c, x]) => (x ? `${c} ${x.x_pct}${x.signal ? " SIGNAL" : ""}` : `${c} n/a`)).join(", ")}; S3 targets BTC ${f(d.s3w?.BTC, 3)} ETH ${f(d.s3w?.ETH, 3)}`),
    "", "## Closed trades", "",
    ...state.accounts.flatMap((a) => a.trades.map((t) => `* ${a.name} ${t.coin} ${new Date(t.entryT).toISOString().slice(0, 16)} -> ${new Date(t.exitT).toISOString().slice(0, 16)} net C$${t.net.toFixed(4)} (${(t.ret * 100).toFixed(2)} %) ${t.reason}`)),
  ];
  console.log(out.join("\n"));
}
