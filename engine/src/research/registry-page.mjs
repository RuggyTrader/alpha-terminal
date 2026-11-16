#!/usr/bin/env node
// Builds the research review page (static HTML, data embedded) from docs/research/registry/candidates.json.
// Research only: no candidate on this page is connected to execution.
//   node src/research/registry-page.mjs --in ../docs/research/registry/candidates.json --out research.html
import { readFileSync, writeFileSync } from "node:fs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const reg = JSON.parse(readFileSync(arg("in", "../docs/research/registry/candidates.json"), "utf8"));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (v) => (v === undefined || v === null || typeof v !== "number" ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`);
const ORDER = ["ELIGIBLE FOR FURTHER VALIDATION", "INCONCLUSIVE", "TESTING", "SPECIFIED", "IDEA", "FAILED"];
const list = [...reg.candidates].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
const count = (s) => list.filter((c) => c.status === s).length;
const families = [...new Set(list.map((c) => c.family))];
const tone = (s) => (s === "FAILED" ? "bad" : s === "INCONCLUSIVE" ? "warn" : s === "ELIGIBLE FOR FURTHER VALIDATION" ? "ok" : "muted");

const rows = list.map((c) => {
  const I = c.results.independent ?? {}, V = c.results.validation ?? {}, Dv = c.results.development ?? {};
  return `<tr data-status="${esc(c.status)}" data-family="${esc(c.family)}">
    <td><span class="pill ${tone(c.status)}">${esc(c.status === "ELIGIBLE FOR FURTHER VALIDATION" ? "ELIGIBLE" : c.status)}</span></td>
    <td><b>${esc(c.name)}</b><span class="sub">${esc(c.family)} · ${esc((c.timeframes || []).join(", "))}</span></td>
    <td class="num ${typeof I.net === "number" ? (I.net > 0 ? "pos" : "neg") : ""}">${money(I.net)}<span class="sub">${esc(I.trades ?? "")}${I.trades ? " trades" : ""}${I.positive_markets ? ` · ${esc(I.positive_markets)} mkts +` : ""}</span></td>
    <td class="num ${typeof V.net === "number" ? (V.net > 0 ? "pos" : "neg") : ""}">${money(V.net)}</td>
    <td class="num ${typeof Dv.net === "number" ? (Dv.net > 0 ? "pos" : "neg") : ""}">${money(Dv.net)}</td>
    <td>${esc(c.fee_drag ?? "—")}</td>
    <td class="why">${esc(c.failure ?? "meets the pre-registered criteria")}${c.results.validation?.note ? `<span class="sub">${esc(c.results.validation.note)}</span>` : ""}</td>
  </tr>`;
}).join("\n");

const html = `<title>ALPHA Research Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: one reading column, summary first, then a filterable evidence table. ALPHA identity: charcoal, orange α, green/red results. */
:root{--bg:#f3f0ea;--panel:#ffffff;--ink:#16130f;--muted:#857d71;--line:rgba(22,19,15,.09);--accent:#f2661b;--pos:#12965a;--neg:#d9443a;--warn:#c96a12;
--font:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f0d0b;--panel:#1a1714;--ink:#f4efe6;--muted:#a1988b;--line:rgba(255,240,220,.08);--pos:#40d98a;--neg:#ff7b6f;--warn:#f2a24c;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f0d0b;--panel:#1a1714;--ink:#f4efe6;--muted:#a1988b;--line:rgba(255,240,220,.08);--pos:#40d98a;--neg:#ff7b6f;--warn:#f2a24c;color-scheme:dark}
body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--font);font-variant-numeric:tabular-nums}
.wrap{max-width:1180px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 48px;display:flex;flex-direction:column;gap:22px}
header{display:flex;align-items:center;gap:14px}
.mark{width:38px;height:38px;border-radius:10px;background:#16130f;color:var(--accent);display:grid;place-items:center;font-weight:900;font-size:22px;flex:none}
h1{margin:0;font-size:26px;font-weight:850;letter-spacing:-.02em}
.tag{font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--accent)}
.lede{max-width:72ch;color:var(--muted);margin:0}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.stat span{font-size:11px;font-weight:750;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}
.stat b{font-size:26px;font-weight:850}
.findings{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.findings h2{margin:0 0 8px;font-size:16px}
.findings ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;max-width:90ch}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.filters label{font-size:12px;color:var(--muted);font-weight:700}
select{font:inherit;padding:6px 10px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
.tablebox{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;min-width:900px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:800;position:sticky;top:0;background:var(--panel)}
td.num{text-align:right;font-weight:800;white-space:nowrap}
td .sub{display:block;font-size:12px;color:var(--muted);font-weight:500}
td.why{font-size:13px;max-width:360px}
.pos{color:var(--pos)}.neg{color:var(--neg)}
.pill{display:inline-block;font-size:10.5px;font-weight:850;letter-spacing:.06em;padding:3px 8px;border-radius:999px;white-space:nowrap}
.pill.bad{background:color-mix(in srgb,var(--neg) 14%,transparent);color:var(--neg)}
.pill.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.pill.ok{background:color-mix(in srgb,var(--pos) 14%,transparent);color:var(--pos)}
.pill.muted{background:var(--line);color:var(--muted)}
footer{font-size:12px;color:var(--muted);max-width:90ch}
code{font-family:var(--mono);font-size:12px}
</style>
<div class="wrap">
  <header><div class="mark" aria-hidden="true">α</div><div><div class="tag">ALPHA TERMINAL · RESEARCH ONLY</div><h1>Strategy research review</h1></div></header>
  <p class="lede">Every strategy hypothesis tested so far, ordered by the strength of its evidence, never by backtest profit. Nothing here trades: research candidates are not connected to the PAPER engine. There is no "proven" status; the strongest possible is <b>Eligible</b>, meaning a candidate may be proposed for a separate, owner-approved forward PAPER trial.</p>
  <section class="summary" aria-label="Summary">
    <div class="stat"><span>Candidates tested</span><b>${list.length}</b></div>
    <div class="stat"><span>Eligible</span><b class="${count("ELIGIBLE FOR FURTHER VALIDATION") ? "pos" : ""}">${count("ELIGIBLE FOR FURTHER VALIDATION")}</b></div>
    <div class="stat"><span>Inconclusive</span><b>${count("INCONCLUSIVE")}</b></div>
    <div class="stat"><span>Failed</span><b class="neg">${count("FAILED")}</b></div>
  </section>
  <section class="findings" aria-label="Findings">
    <h2>What the evidence says</h2>
    <ul>
      <li><b>OTE / Fibonacci (the four live bots' strategy) is retired as a research direction.</b> Rounds 1–6: every variant lost after fees; on independent 5m markets it lost even before fees.</li>
      <li><b>Long-only trend and momentum showed the first positive out-of-sample results</b> (round 7, eight markets never used before), and stayed positive at 0.40% fees + 0.10% slippage. They are inconclusive: the gains came from a few large trends, too few markets were positive, and the 99.5% interval includes zero.</li>
      <li><b>Mean reversion, volatility-squeeze breakouts and all short-side rules failed.</b></li>
      <li><b>Next evidence must come from data not yet used:</b> a forward observation or a new pre-registered portfolio hypothesis. Re-tuning on these results is not allowed.</li>
    </ul>
  </section>
  <div class="filters">
    <label for="fs">Status</label><select id="fs"><option value="">All</option>${ORDER.filter(count).map((s) => `<option>${esc(s)}</option>`).join("")}</select>
    <label for="ff">Family</label><select id="ff"><option value="">All</option>${families.map((f) => `<option>${esc(f)}</option>`).join("")}</select>
  </div>
  <div class="tablebox"><table>
    <thead><tr><th>Status</th><th>Candidate</th><th>Independent net $</th><th>Validation net $</th><th>Development net $</th><th>Fee drag</th><th>Why</th></tr></thead>
    <tbody id="rows">${rows}</tbody>
  </table></div>
  <footer>Net figures are research backtests ($ per $100 per market, pooled), not PAPER or live results. Costs: 0.20% per fill + 0.05% slippage unless stated. Registry generated ${esc(reg.generated_at)} from <code>docs/research/registry/candidates.json</code>; reports in <code>docs/research/round1…round7</code>.</footer>
</div>
<script>
(() => {
  const fs = document.getElementById("fs"), ff = document.getElementById("ff");
  const apply = () => { for (const tr of document.querySelectorAll("#rows tr")) tr.hidden = (fs.value && tr.dataset.status !== fs.value) || (ff.value && tr.dataset.family !== ff.value); };
  fs.addEventListener("change", apply); ff.addEventListener("change", apply);
})();
</script>`;
writeFileSync(arg("out", "research.html"), html);
console.log("written", list.length, "candidates");
