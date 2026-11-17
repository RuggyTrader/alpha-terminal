// Research dashboard: separate from funded PAPER, never labels a candidate profitable or proven, shows pending states
// truthfully, and renders round-8 and forward results from the data passed in.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { minimumGrid, renderDashboard } from "../src/research/dashboard.mjs";
import { buildRegistry } from "../src/research/registry.mjs";

const registry = buildRegistry("../docs/research");

describe("research dashboard", () => {
  it("is labelled research-only and never claims proof or profitability", () => {
    const html = renderDashboard({ registry, generatedAt: "t" });
    assert.match(html, /Not funded PAPER performance/);
    assert.doesNotMatch(html.replace(/no "proven" status/i, ""), /\bproven\b|guaranteed|profitable strategy/i);
  });
  it("shows round 8 as pre-registered and the forward shadow as not collecting when no results exist", () => {
    const html = renderDashboard({ registry, forwardRegistry: { candidates: [{ id: "RESEARCH-FWD-T1", start_at: "2026-11-18T00:00:00Z", min_days: 180, min_trades: 30 }] }, generatedAt: "t" });
    assert.match(html, /Pre-registered, not yet run/);
    assert.match(html, /Registered, not yet collecting/);
    assert.match(html, /RESEARCH-FWD-T1/);
    assert.ok(registry.candidates.filter((c) => c.id.startsWith("R8-")).every((c) => c.status === "SPECIFIED"));
  });
  it("an early positive forward result is shown as COLLECTING, not as a success", () => {
    const report = { id: "RESEARCH-FWD-M1", family: "Momentum", timeframe: "1d", markets_with_data: 3, status: "FORWARD SHADOW: COLLECTING (too little forward data for any conclusion)", start_at: "2026-11-18T00:00:00Z", data_through: "2026-12-01T00:00:00Z", forward_days: 13,
      selected_costs: { net_marked: 4.2, fees: 0.3, max_dd_pct: 1, trades_closed: 2 }, open_positions: [{ market: "GRT" }], feasibility: { executable_pct: 100 }, uncertainty: { method: "insufficient data", ci: null } };
    const html = renderDashboard({ registry, forward: { generated_at: "t", reports: [report] }, generatedAt: "t" });
    assert.match(html, /COLLECTING/);
    assert.match(html, /\+\$4\.20/);
    assert.match(html, /An early positive number is not evidence/);
    assert.doesNotMatch(html, /EVALUABLE<\/span>/);
  });
  it("the minimum-equity grid follows minimum x stop / risk", () => {
    const g = minimumGrid({ notionals: [10], stops: [10], riskPct: 2 });
    assert.equal(g[0].by_stop[0].equity, 50);
  });
});
