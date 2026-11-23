// Simulator audit: perp.mjs vs the independent re-implementation, on every pre-registered configuration and window,
// plus the ledger identity (final = capital + price P&L - fees - slippage - funding). Research only.
//   node audit-perp.mjs <kraken-ohlcvt dir> <signals dir> <out.json>
import { writeFileSync } from "node:fs";
import { simulatePerp } from "./perp.mjs";
import { simulateIndependent } from "./perp-independent.mjs";
import { setup } from "./perp-setup.mjs";

const [KR, SIG, OUT] = process.argv.slice(2);
const { data, SIGNALS, SIZING, COSTS, MARGIN, WINDOWS } = setup(KR, SIG);
const rows = [];
let worstFinal = 0, worstDD = 0, worstLedger = 0, liqMismatch = 0;
for (const [hn, sig] of Object.entries(SIGNALS)) for (const [sn, size] of Object.entries(SIZING)) for (const [cn, cost] of Object.entries(COSTS)) for (const compound of [true, false]) {
  if (!compound && (sn.startsWith("EXPL") || cn === "ideal")) continue;
  const decide = (d) => { const s = sig(d); if (s === null) return null; const w = {}; for (const a of ["BTC", "ETH"]) { const x = s[a]; w[a] = x === null || x === undefined ? 0 : x * size(a, d); } return w; };
  for (const [w0, w1] of WINDOWS) {
    const win = { from: Date.parse(w0), to: Date.parse(w1) }, cfg = { capital: 100, compound, margin: MARGIN, band: 0.25, ...cost };
    const a = simulatePerp([data.BTC, data.ETH], decide, cfg, win), b = simulateIndependent([data.BTC, data.ETH], decide, cfg, win);
    const dF = Math.abs(a.final - b.final) / Math.max(1, Math.abs(a.final)), dD = Math.abs(a.dd_pct - b.dd_pct);
    worstFinal = Math.max(worstFinal, dF); worstDD = Math.max(worstDD, dD); worstLedger = Math.max(worstLedger, Math.abs(a.ledger_residual));
    if (a.liquidations !== b.liquidations) liqMismatch++;
    rows.push({ hypothesis: hn, sizing: sn, cost: cn, compound, window: w0, final: a.final, final_independent: b.final, dd: a.dd_pct, dd_independent: b.dd_pct, liq: a.liquidations, liq_independent: b.liquidations, ledger_residual: a.ledger_residual });
  }
}
const summary = { configurations: rows.length, max_relative_final_difference: worstFinal, max_drawdown_difference_pp: worstDD, liquidation_count_mismatches: liqMismatch, max_ledger_residual_usd: worstLedger };
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));
for (const r of rows.filter((x) => Math.abs(x.final - x.final_independent) / Math.max(1, Math.abs(x.final)) > 1e-9 || x.liq !== x.liq_independent).slice(0, 10)) console.log("MISMATCH", JSON.stringify(r));
