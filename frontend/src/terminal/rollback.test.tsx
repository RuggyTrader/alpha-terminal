// Fee-compatible rollback release: the dashboard shows that execution costs are disabled for new fills, and shows fees
// recorded before the rollback with the net result. Fixture data exists only in this file.

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TradeCard } from "./components/TradeCard";
import { SettingsPage } from "./pages/Settings";
import { initialFeedState, type FeedState } from "./poller";
import { idleSignOut } from "./signOut";
import { DashboardContext } from "./store";
import type { DashboardData, PaperPortfolio, TradeRow } from "./types";

const portfolio: PaperPortfolio = {
  label: "ALPHA PAPER", simulated: true, active: true, wallets: [],
  totals: { book_balance_usd: 99.4, unallocated_usd: 0, available_usd: 99.4, reserved_usd: 0, realized_pnl_usd: 0.2, fees_usd: 0.6,
    net_realized_pnl_usd: -0.4, net_funding_usd: 99.8, unrealized_pnl_usd: 0 },
  consistency: { ok: true, issues: [] }, history: [], strategies: {}, validated_engines: ["SOLUSD"],
  limits: { max_order_notional_usd: 5000, max_position_exposure_usd: 10000, short_selling_enabled: false },
  costs: { profile: "none", name: "Execution costs disabled (fee-compatible rollback release)", disabled: true,
    release: "worker-rollback-fee-compat (cde07af + fee compatibility)", caveat: "Simulated execution costs are DISABLED for new fills on this rollback release.",
    fill_disclosure: "PAPER fills are simulated using the Kraken reference price when the signal is processed." },
};
const dash = { generated_at: "2026-11-09T12:00:00Z", mode: "PAPER", execution: "DRY_RUN_ONLY", broker_submission: false, enable_trading: false,
  engine: { state: "STOPPED", kill_switch: 0, killed_at: null, reason: null, updated_at: "2026-10-31T00:00:00Z", updated_by: "admin" },
  broker: { mode: "PAPER", read_only: true, errors: [], account: null, positions: [], clock: null }, portfolio,
  counts: { alerts: { total: 0, dry_run: 0, rejected: 0, processing: 0, duplicates: 0 }, risk: { total: 0, approved: 0, rejected: 0 }, orders: { total: 0, dry_run_accepted: 0, unknown: 0, failed: 0 }, trades: { total: 0, open: 0, closed: 0, realized_pnl: 0 } },
  recent: { alerts: [], risk: [], orders: [], trades: [], activity: [] } } as unknown as DashboardData;

describe("fee-compatible rollback release", () => {
  it("Settings: costs disabled for new fills, the release, fees paid and net realized", () => {
    const state: FeedState = { ...initialFeedState, status: "ok", data: dash, lastSuccessAt: Date.now() };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DashboardContext.Provider value={{ state, refresh: () => {}, signOut: idleSignOut, doSignOut: () => {}, dismissSignOut: () => {}, reconnected: false }}><SettingsPage /></DashboardContext.Provider>
      </MemoryRouter>,
    );
    expect(html).toContain("DISABLED FOR NEW FILLS");
    expect(html).toContain("worker-rollback-fee-compat");
    expect(html).toContain("Simulated fees paid");
    expect(html).toContain("Net realized ledger P&amp;L");
    expect(html).toContain("Kraken reference price");
  });

  it("Trade card: a trade with a cost record shows gross, fees and net; an older trade keeps one realized row", () => {
    const t = { id: 3, symbol: "SOLUSD", direction: "LONG", status: "CLOSED", strategy: "OTE", entry_qty: "0.5", entry_avg_price: "95.25",
      exit_qty: "0.5", exit_avg_price: "94.33", open_qty: "0", realized_pnl: "-0.65", return_pct: "-1.3", opened_at: "2026-11-09T10:00:00Z",
      closed_at: "2026-11-09T11:00:00Z", source: "ALPHA_PAPER", gross_pnl: "-0.46", fees_usd: "0.19", slippage_usd: "0", cost_profile: "none" } as TradeRow;
    const html = renderToStaticMarkup(<MemoryRouter><TradeCard t={t} defaultOpen /></MemoryRouter>);
    expect(html).toContain("Gross P&amp;L (before costs)");
    expect(html).toContain("Net PAPER P&amp;L");
    const old = renderToStaticMarkup(<MemoryRouter><TradeCard t={{ ...t, cost_profile: null, gross_pnl: null, fees_usd: null }} defaultOpen /></MemoryRouter>);
    expect(old).toContain("Realized PAPER P&amp;L");
    expect(old).not.toContain("Net PAPER P&amp;L");
  });
});
