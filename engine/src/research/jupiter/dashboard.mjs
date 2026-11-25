// Dashboard feed for the isolated Jupiter PAPER engine: a JSON document (for a future ALPHA TERMINAL Command Center card)
// and a self-contained local HTML view. Nothing here is deployed; the production Worker and D1 are untouched.
export const FEED_SCHEMA = "alpha-terminal.jupiter-paper.v1";

export function buildFeed({ state, views, marks, health, recon, config }) {
  const S = state.run, eq = S.eqClose ?? S.cash, cap = config.account.capitalUsd;
  const realizedPnl = S.realizedNet, unrealized = views.reduce((s, v) => s + v.valueUsd, 0) - Object.values(S.pos).reduce((s, p) => s + p.invested, 0);
  return {
    schema: FEED_SCHEMA, generatedAt: new Date().toISOString(), mode: "PAPER", liveExecution: false,
    venue: "Jupiter Perps (simulated: requests built in perps-api v2 shapes, never signed or sent)",
    priceData: "Binance spot 1h (SUBSTITUTE for Jupiter oracle prices); Jupiter mark from read-only market-stats for comparison",
    strategy: state.candidate ? { ...state.candidate, qualified: state.candidateQualified ?? false } : null,
    status: S.shutdown ? "SHUT_DOWN" : state.candidate ? "RUNNING" : "OBSERVATION_ONLY",
    equity: { now: eq, start: cap, high: S.hwm, maxDrawdownPct: S.ddMax * 100, shutdownAt: config.account.shutdownEquityUsd, distanceToShutdownUsd: eq - config.account.shutdownEquityUsd, cash: S.cash },
    pnl: { realizedUsd: realizedPnl, unrealizedUsd: unrealized, totalUsd: eq - cap, verified: recon.ok, reconciliation: recon },
    fees: S.F, counts: S.N,
    positions: views.map((v) => ({ ...v, approvedMaxLeverage: Math.max(state.candidate?.L ?? 0, config.riskManager.minLeverage) })),
    risk: { approvedLevel: state.candidate?.L ?? null, grossNotionalUsd: views.reduce((s, v) => s + v.sizeUsd, 0), grossLeverageOfEquity: eq > 0 ? views.reduce((s, v) => s + v.sizeUsd, 0) / eq : null,
      collateralInUseUsd: views.reduce((s, v) => s + v.collateralUsd, 0), pendingRequests: Object.keys(S.pending).length },
    trades: S.trades.slice(-50).reverse(), marks, health,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "–");
export function renderHtml(f) {
  const rows = (arr, cols) => arr.map((r) => `<tr>${cols.map(([, g]) => `<td>${esc(g(r))}</td>`).join("")}</tr>`).join("");
  const posCols = [["Asset", (v) => v.asset], ["Side", (v) => v.side], ["Size $", (v) => n2(v.sizeUsd)], ["Collateral $", (v) => n2(v.collateralUsd)], ["Leverage", (v) => n2(v.leverage) + "×"], ["Entry", (v) => n2(v.entryPriceUsd)], ["Mark", (v) => n2(v.markPriceUsd)], ["Liq.", (v) => n2(v.liquidationPriceUsd)], ["Stop", (v) => n2(v.tpslRequests[0]?.triggerPriceUsd)], ["Borrow $", (v) => n2(v.borrowFeesUsd)], ["Value $", (v) => n2(v.valueUsd)]];
  const trCols = [["Asset", (t) => t.asset], ["Side", (t) => t.side], ["Opened", (t) => new Date(t.openT).toISOString().slice(0, 16)], ["Closed", (t) => new Date(t.closeT).toISOString().slice(0, 16)], ["Net $", (t) => n2(t.net)], ["Reason", (t) => t.reason]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jupiter PAPER engine</title>
<style>:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e5e5e5;--warn:#b45309;--ok:#15803d}@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--mut:#9a9a9a;--line:#2a2a2a;--warn:#f59e0b;--ok:#4ade80}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1100px}h1{font-size:18px;margin:0 0 4px}.mut{color:var(--mut)}.banner{border:1px solid var(--warn);color:var(--warn);padding:8px 10px;border-radius:6px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.k{border:1px solid var(--line);border-radius:6px;padding:8px}.k b{display:block;font-size:18px}
table{border-collapse:collapse;width:100%;margin:6px 0 16px;font-variant-numeric:tabular-nums}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;white-space:nowrap}.wrap{overflow-x:auto}</style></head><body>
<h1>Jupiter Perps — PAPER engine</h1><div class="mut">${esc(f.generatedAt)} · ${esc(f.status)} · ${f.strategy ? esc(`${f.strategy.strategy} ${f.strategy.variant} L${f.strategy.L}`) + (f.strategy.qualified ? "" : " (NOT a qualified candidate)") : "no strategy (observation only)"}</div>
<div class="banner">PAPER only: no wallet, no signing, no live orders. Prices are Binance substitute data; fills are simulated.</div>
<div class="grid"><div class="k">Equity<b>$${n2(f.equity.now)}</b></div><div class="k">Total P&amp;L<b>$${n2(f.pnl.totalUsd)}</b><span class="mut">${f.pnl.verified ? "reconciled" : "NOT reconciled"}</span></div><div class="k">Max drawdown<b>${n2(f.equity.maxDrawdownPct)}%</b></div><div class="k">To $75 shutdown<b>$${n2(f.equity.distanceToShutdownUsd)}</b></div><div class="k">Gross leverage<b>${n2(f.risk.grossLeverageOfEquity)}×</b></div><div class="k">Data lag<b>${n2(f.health.dataLagMinutes)} min</b></div></div>
<h2>Positions</h2><div class="wrap"><table><tr>${posCols.map(([h]) => `<th>${h}</th>`).join("")}</tr>${rows(f.positions, posCols) || `<tr><td colspan="11" class="mut">none</td></tr>`}</table></div>
<h2>Recent trades</h2><div class="wrap"><table><tr>${trCols.map(([h]) => `<th>${h}</th>`).join("")}</tr>${rows(f.trades, trCols) || `<tr><td colspan="6" class="mut">none</td></tr>`}</table></div>
<h2>System health</h2><div class="wrap"><table>${Object.entries(f.health).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`).join("")}</table></div></body></html>`;
}
