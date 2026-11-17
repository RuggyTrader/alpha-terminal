#!/usr/bin/env node
// RESEARCH results dashboard (static HTML, data embedded). A separate page: it is NOT part of the ALPHA TERMINAL app
// and its four-tab navigation, and it never shows funded PAPER figures. Sections: evidence registry, round 8
// (historical, by sizing scenario), account size & order minimums, forward shadow.
//   node src/research/dashboard.mjs --root ../docs/research --out ../docs/research/dashboard/index.html
//        [--forward data/forward/report.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildRegistry } from "./registry.mjs";
import { minEquityForTrade } from "./r8/portfolio.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (v) => (typeof v !== "number" || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`);
const pct = (v, d = 1) => (typeof v !== "number" || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const cls = (v) => (typeof v === "number" && v > 0 ? "pos" : typeof v === "number" && v < 0 ? "neg" : "");
const ORDER = ["ELIGIBLE FOR FURTHER VALIDATION", "INCONCLUSIVE", "TESTING", "SPECIFIED", "IDEA", "FAILED"];
const tone = (s) => (s === "FAILED" ? "bad" : s === "INCONCLUSIVE" ? "warn" : s === "ELIGIBLE FOR FURTHER VALIDATION" ? "ok" : "muted");

/** Analytic feasibility grid: the minimum wallet equity for one trade at 2% risk. Pure; used by the page and tests. */
export function minimumGrid({ notionals = [5, 10, 20], stops = [2, 5, 10, 15], riskPct = 2 } = {}) {
  return notionals.map((n) => ({ min_notional: n, by_stop: stops.map((s) => ({ stop_pct: s, equity: minEquityForTrade({ minNotional: n, stopPct: s / 100, riskPct: riskPct / 100 }) })) }));
}

function registrySection(reg) {
  const list = [...reg.candidates].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const rows = list.map((c) => { const I = c.results.independent ?? {}, V = c.results.validation ?? {};
    return `<tr data-status="${esc(c.status)}"><td><span class="pill ${tone(c.status)}">${esc(c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? "ELIGIBLE" : c.status)}</span></td>
<td><b>${esc(c.name)}</b><span class="sub">${esc(c.family)} · ${esc((c.timeframes || []).join(", "))}</span></td>
<td class="num ${cls(I.net)}">${money(I.net)}<span class="sub">${I.trades ? `${esc(I.trades)} trades` : ""}</span></td>
<td class="num ${cls(V.net)}">${money(V.net)}</td><td>${esc(c.fee_drag ?? "—")}</td><td class="why">${esc(c.failure ?? "meets the pre-registered criteria")}</td></tr>`; }).join("");
  const n = (s) => list.filter((c) => c.status === s).length;
  return { counts: { total: list.length, eligible: n("ELIGIBLE FOR FURTHER VALIDATION"), inconclusive: n("INCONCLUSIVE"), failed: n("FAILED"), specified: n("SPECIFIED") },
    html: `<div class="tablebox"><table><thead><tr><th>Status</th><th>Candidate</th><th>Independent net</th><th>Validation net</th><th>Fee drag</th><th>Research failure reason</th></tr></thead><tbody>${rows}</tbody></table></div>` };
}

function r8Section(r8) {
  if (!r8) return `<p class="note"><b>Pre-registered, not yet run.</b> The round-8 pre-registration and tested tooling are committed. The run needs public Coinbase and Kraken data, which the Mac session that built this page could not reach. Run <code>node src/research/r8/download-all.mjs</code>, <code>r8/kraken-minimums.mjs</code>, then <code>r8/run.mjs</code>.</p>`;
  const rows = Object.entries(r8.candidates).flatMap(([id, c]) => Object.entries(c.untouched.scenarios).map(([k, sc]) => { const s = sc.selected;
    return `<tr><td>${k === "B" ? `<span class="pill ${tone(c.status)}">${esc(c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? "ELIGIBLE" : c.status)}</span>` : ""}</td><td><b>${esc(id)}</b><span class="sub">${esc(r8.scenarios[k])}</span></td>
<td class="num ${cls(s.gross)}">${money(s.gross)}</td><td class="num">${money(s.fees)}</td><td class="num ${cls(s.net)}">${money(s.net)}</td><td class="num ${cls(sc.stress.net)}">${money(sc.stress.net)}</td>
<td class="num">${esc(s.trades)}</td><td class="num">${pct(s.max_dd_pct ?? s.median_sleeve_dd_pct)}</td><td class="num">${pct(s.executable_pct)}<span class="sub">${esc(Object.entries(s.rejections ?? {}).map(([r, v]) => `${r} ${v}`).join(", "))}</span></td>
<td class="why">${k === "B" ? esc(c.failed.length ? `failed: ${c.failed.join(", ")}` : "meets every pre-registered criterion") : ""}</td></tr>`; })).join("");
  return `<p class="note">Untouched basket: ${esc(r8.screen.untouched.eligible.join(", "))}. Excluded by the mechanical screen: ${esc(r8.screen.untouched.excluded.map((x) => x.market).join(", ") || "none")}. Equal-weight buy and hold of the same basket: ${money(r8.benchmarks.equal_weight_buy_hold_untouched)}; cash: $0.00.</p>
<div class="tablebox"><table><thead><tr><th>Verdict (B)</th><th>Candidate · scenario</th><th>Gross</th><th>Fees</th><th>Net</th><th>Net at stress costs</th><th>Trades</th><th>Max DD</th><th>Executable setups</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function minimumSection() {
  const g = minimumGrid();
  const head = g[0].by_stop.map((x) => `<th>${x.stop_pct}% stop</th>`).join("");
  const rows = g.map((r) => `<tr><td><b>$${r.min_notional}</b> minimum order</td>${r.by_stop.map((x) => `<td class="num ${x.equity > 20 ? "neg" : "pos"}">$${x.equity.toFixed(0)}</td>`).join("")}</tr>`).join("");
  return `<p class="note">With 2% risk per trade, a trade reaches the exchange minimum only when <b>wallet equity ≥ minimum order × stop distance ÷ 2%</b>. Red cells need more than a $20 bot wallet. Higher-timeframe strategies use wider stops, so under the per-bot $20 model they mostly cannot trade. Shared-account scenarios B–D are tested in round 8; the real allocation is unchanged.</p>
<div class="tablebox"><table class="narrow"><thead><tr><th>Minimum wallet equity for one trade</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function forwardSection(fwd, registry) {
  const regs = registry?.candidates ?? [];
  if (!fwd) return `<p class="note"><b>Registered, not yet collecting.</b> ${esc(regs.map((c) => c.id).join(", "))} start ${esc(regs[0]?.start_at ?? "")}. Nothing can be concluded before ${esc(regs[0]?.min_days ?? 180)} forward days and ${esc(regs[0]?.min_trades ?? 30)} closed trades.</p>`;
  const rows = fwd.reports.map((r) => `<tr><td><span class="pill muted">${esc(r.status.includes("EVALUABLE") ? "EVALUABLE" : "COLLECTING")}</span></td>
<td><b>${esc(r.id)}</b><span class="sub">${esc(r.family)} · ${esc(r.timeframe)} · ${esc(r.markets_with_data)} markets</span></td>
<td>${esc(r.start_at.slice(0, 10))} → ${esc((r.data_through ?? "").slice(0, 10))}<span class="sub">${esc(r.forward_days)} days</span></td>
<td class="num ${cls(r.selected_costs.net_marked)}">${money(r.selected_costs.net_marked)}<span class="sub">fees ${money(r.selected_costs.fees)}</span></td>
<td class="num">${pct(r.selected_costs.max_dd_pct)}</td><td class="num">${esc(r.selected_costs.trades_closed)}</td>
<td>${esc(r.open_positions.map((p) => p.market).join(", ") || "cash")}</td><td class="num">${pct(r.feasibility.executable_pct)}</td>
<td class="why">${esc(r.uncertainty.method)}${r.uncertainty.ci ? `: [${r.uncertainty.ci.join(", ")}]` : ""}</td></tr>`).join("");
  return `<p class="note">Hypothetical shadow accounts on candles that did not exist at registration. <b>An early positive number is not evidence</b>; status stays COLLECTING until the registered minimum is reached. Report generated ${esc(fwd.generated_at)}.</p>
<div class="tablebox"><table><thead><tr><th>Status</th><th>Candidate</th><th>Testing period</th><th>Forward net</th><th>Max DD</th><th>Closed trades</th><th>Hypothetical position</th><th>Executable</th><th>Uncertainty</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Pure renderer: everything the page shows comes from the arguments. */
export function renderDashboard({ registry, r8 = null, forward = null, forwardRegistry = null, generatedAt }) {
  const reg = registrySection(registry);
  return `<!doctype html><meta charset="utf-8">
<title>ALPHA Research Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f3f0ea;--panel:#fff;--ink:#16130f;--muted:#857d71;--line:rgba(22,19,15,.09);--accent:#f2661b;--pos:#12965a;--neg:#d9443a;--warn:#c96a12;--font:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,"Segoe UI",Roboto,Arial,sans-serif;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f0d0b;--panel:#1a1714;--ink:#f4efe6;--muted:#a1988b;--line:rgba(255,240,220,.08);--pos:#40d98a;--neg:#ff7b6f;--warn:#f2a24c;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f0d0b;--panel:#1a1714;--ink:#f4efe6;--muted:#a1988b;--line:rgba(255,240,220,.08);--pos:#40d98a;--neg:#ff7b6f;--warn:#f2a24c;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font);font-variant-numeric:tabular-nums}
.wrap{max-width:1180px;margin:0 auto;padding:28px 16px 48px;display:flex;flex-direction:column;gap:20px}
header{display:flex;align-items:center;gap:14px}.mark{width:38px;height:38px;border-radius:10px;background:#16130f;color:var(--accent);display:grid;place-items:center;font-weight:900;font-size:22px;flex:none}
h1{margin:0;font-size:26px;font-weight:850;letter-spacing:-.02em}h2{margin:8px 0 0;font-size:18px}.tag{font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--accent)}
.banner{border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);background:color-mix(in srgb,var(--warn) 9%,var(--panel));border-radius:14px;padding:12px 16px;max-width:95ch}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat span{display:block;font-size:11px;font-weight:750;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}.stat b{font-size:26px;font-weight:850}
.note{margin:0;color:var(--muted);max-width:95ch}.tablebox{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;min-width:860px}table.narrow{min-width:520px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:800}td.num{text-align:right;font-weight:800;white-space:nowrap}
td .sub{display:block;font-size:12px;color:var(--muted);font-weight:500;white-space:normal}td.why{font-size:13px;max-width:340px}.pos{color:var(--pos)}.neg{color:var(--neg)}
.pill{display:inline-block;font-size:10.5px;font-weight:850;letter-spacing:.06em;padding:3px 8px;border-radius:999px;white-space:nowrap}
.pill.bad{background:color-mix(in srgb,var(--neg) 14%,transparent);color:var(--neg)}.pill.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.pill.ok{background:color-mix(in srgb,var(--pos) 14%,transparent);color:var(--pos)}.pill.muted{background:var(--line);color:var(--muted)}
footer{font-size:12px;color:var(--muted)}code{font-family:var(--mono);font-size:12px}
</style>
<div class="wrap">
<header><div class="mark" aria-hidden="true">α</div><div><div class="tag">ALPHA TERMINAL · RESEARCH ONLY</div><h1>Strategy research dashboard</h1></div></header>
<div class="banner"><b>Not funded PAPER performance.</b> Every figure here is a research backtest or a hypothetical forward shadow. None is connected to the PAPER engine, the ledger or any bot, and none is a profit claim. There is no "proven" status: the strongest is <b>Eligible</b>, meaning that the owner may consider a separate trial.</div>
<section class="summary"><div class="stat"><span>Candidates</span><b>${reg.counts.total}</b></div><div class="stat"><span>Eligible</span><b class="${reg.counts.eligible ? "pos" : ""}">${reg.counts.eligible}</b></div>
<div class="stat"><span>Inconclusive</span><b>${reg.counts.inconclusive}</b></div><div class="stat"><span>Failed</span><b class="neg">${reg.counts.failed}</b></div><div class="stat"><span>Pre-registered, not run</span><b>${reg.counts.specified}</b></div></section>
<h2>Round 8: shared-account portfolio on untouched markets</h2>${r8Section(r8)}
<h2>Account size and Kraken order minimums</h2>${minimumSection()}
<h2>Forward shadow (hypothetical, new data only)</h2>${forwardSection(forward, forwardRegistry)}
<h2>All candidates, by evidence</h2>${reg.html}
<footer>Generated ${esc(generatedAt)} from <code>docs/research/registry</code>, <code>docs/research/round8</code> and <code>docs/research/forward</code>. Costs: 0.20% per fill + 0.05% slippage unless stated.</footer>
</div>`;
}

if (process.argv[1] && process.argv[1].endsWith("dashboard.mjs")) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const root = arg("root", "../docs/research"), out = arg("out", join(root, "dashboard", "index.html"));
  const read = (f) => (f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
  const html = renderDashboard({ registry: buildRegistry(root), r8: read(join(root, "round8", "r8-results.json")), forward: read(arg("forward", join(root, "forward", "report.json"))),
    forwardRegistry: read(join(root, "forward", "registry.json")), generatedAt: new Date().toISOString() });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`written ${out}`);
}
