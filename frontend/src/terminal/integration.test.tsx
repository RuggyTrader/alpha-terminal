// Contract regressions: all amounts below are labelled TEST inputs, never demo/live account figures.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { lifetimeMetrics, completeFundedHistory } from "./performance";
import { fixtureLifetime } from "./test-fixtures";
import { walletSummary, WalletOverview } from "./components/WalletOverview";
import { BotLifetimePanel } from "./components/BotTradesView";
import { BotTradeProofView } from "./pages/BotTradeProof";
import { humanReason } from "./tradeStory";
import { valuationState } from "./valuation";
import { verifiedKey } from "./useVerified";
import type { PaperPortfolio, PerformanceData } from "./types";
import type { Bot, Fleet } from "./bots";
import type { BotTradeProof } from "./botTrades";
const NOW = Date.parse("2026-11-13T18:00:00Z");
const totals = { ...fixtureLifetime(), closed_trades: 5003, wins: 2502, losses: 2501, net_usd: -123.45, gross_usd: 20, fees_usd: 143.45, win_rate: 0.5, profit_factor: 0.9, expectancy_usd: -0.024, max_drawdown_usd: 140 };
const data: PerformanceData = { lifetime: totals, verification: "TEST", truncated: true, excluded_closed_trades: 0,
  trades: [{ id: 1, symbol: "SOLUSD", direction: "long", strategy: null, realized_pnl: 999, return_pct: null, cost_basis: 80, opened_at: "2026-11-13T10:00:00Z", closed_at: "2026-11-13T11:00:00Z", price_sources: "TEST" }] };
const p = (): PaperPortfolio => ({ active: true, wallets: [
  { wallet: "MAIN", kind: "MAIN", available_usd: 100, reserved_usd: 0, realized_pnl_usd: 0, net_funding_usd: 100, book_balance_usd: 100, equity_usd: 100, unrealized_pnl_usd: 0, open_positions: 0, updated_at: "TEST" },
  { wallet: "ALPHA-01", kind: "STRATEGY", available_usd: 0, reserved_usd: 40, realized_pnl_usd: -5, net_funding_usd: 50, book_balance_usd: 40, equity_usd: null, unrealized_pnl_usd: null, open_positions: 1, updated_at: "TEST" },
], totals: { book_balance_usd: 140, equity_usd: null, unrealized_pnl_usd: null, economic_net_realized_pnl_usd: -12.38, shortfall_usd: 10.38, reserved_usd: 40, net_funding_usd: 150, available_usd: 100, unallocated_usd: 100, realized_pnl_usd: -2 },
 label: "TEST PAPER", simulated: true, consistency: { ok: true, issues: [] }, history: [], strategies: {}, validated_engines: [], limits: { max_order_notional_usd: null, max_position_exposure_usd: null, short_selling_enabled: false } });
const bot: Bot = { bot_id: "ALPHA-01", name: "ALPHA 01", symbol: "SOLUSD", timeframe: "1m", status: "ACTIVE", ledger_api: "bot", wallet: "ALPHA-01", group: "SOLANA", profile: "solusd-1m", inputs_hash: "TEST", risk_usd: 2, risk_setting: null, entries_paused: false,
  balances: { available_usd: 10, reserved_usd: 40, shortfall_usd: 0 }, funding: { allocated_usd: 50, transferred_in_usd: 0, withdrawn_usd: 0, profit_swept_to_main_usd: 20 },
  open_positions: [{ trade_id: "TEST-OPEN", symbol: "SOLUSD", side: "SHORT", qty: 0.5, entry_price: 80, stop: 82, tp: 70, collateral_usd: 40, opened_at: "TEST", mark_price: 81, mark_at: new Date(NOW - 1000).toISOString() }],
  paper: { trades: 900, long_trades: 400, short_trades: 500, wins: 450, losses: 450, break_even: 0, gross_usd: 10, fees_usd: 30, net_usd: -20, win_rate: 0.5, profit_factor: 0.9, expectancy_usd: -0.02, max_drawdown_usd: 25 }, mirror: [], engine: null };
const fleet: Fleet = { available: true, groups: [], bots: [bot] };
describe("integrated backend contract", () => {
  it("uses complete account totals even when the returned sample suggests the opposite profit", () => {
    const m = lifetimeMetrics(data, 1000)!;
    expect([m.trades, m.totalPnl, m.maxDrawdown, m.profitFactor]).toEqual([5003, -123.45, 140, 0.9]);
    expect(m.returnPct).toBeCloseTo(-12.345);
  });
  it("does not substitute an old or incomplete backend's trade sample for lifetime profit", () => {
    expect(lifetimeMetrics({ ...data, lifetime: undefined }, 1000)).toBeNull();
    expect(lifetimeMetrics({ ...data, lifetime: { ...totals, complete: false } }, 1000)).toBeNull();
  });
  it("refuses a complete account curve when trade rows are limited or missing", () => {
    expect(completeFundedHistory(data)).toBe(false);
    expect(completeFundedHistory({ ...data, truncated: false })).toBe(false);
    expect(completeFundedHistory({ ...data, trades: [], truncated: false, lifetime: fixtureLifetime() })).toBe(true);
  });
  it("renders per-bot lifetime values without a recent-trade calculation or sweep being added", () => {
    const html = renderToStaticMarkup(<BotLifetimePanel b={bot} />);
    expect(html).toContain("900"); expect(html).toContain("−$20.00"); expect(html).toContain("Lifetime · all closed trades");
    expect(html).not.toContain("+$40.00");
  });
  it("preserves unknown UPL and uses backend equity instead of recomputing book plus a partial sum", () => {
    expect(walletSummary(p()).unrealized).toBeNull(); expect(walletSummary(p()).equity).toBeNull();
    const input = p(); input.totals.equity_usd = 127.62; input.totals.unrealized_pnl_usd = -2;
    expect(walletSummary(input).equity).toBe(127.62);
  });
  it("shows economic loss, liability and unavailable equity separately", () => {
    const html = renderToStaticMarkup(<MemoryRouter><WalletOverview portfolio={p()} /></MemoryRouter>);
    expect(html).toContain("10.38"); expect(html).toContain("12.38"); expect(html).toContain("EQUITY UNAVAILABLE");
  });
  it("marks stale bot prices and incomplete mark evidence explicitly", () => {
    const input = p(); input.totals.equity_usd = 137.62;
    expect(valuationState(input, undefined, null, NOW)).toBe("UNAVAILABLE");
    expect(valuationState(input, undefined, fleet, NOW)).toBe("FRESH");
    expect(valuationState(input, undefined, fleet, NOW + 180_000)).toBe("STALE");
    expect(valuationState(input, undefined, fleet, NOW, true)).toBe("STALE");
  });
  it.each(["BOT_PROFILE_MISMATCH", "BOT_SHORTFALL", "CONCURRENT_ORDER"])("explains %s", code => {
    expect(humanReason(code)?.length).toBeGreaterThan(60);
  });
  it("invalidates performance when only the bot ledger changes", () => {
    expect(verifiedKey(0, 0, "ALPHA-01:1:2")).not.toBe(verifiedKey(0, 0, "ALPHA-01:2:3"));
  });
  it("shows the actual reduced fill separately from the requested quantity and planned limit", () => {
    const proof: BotTradeProof = { bot: null, position: { trade_id: "TEST-QTY", bot_id: "ALPHA-01", symbol: "SOLUSD", side: "LONG", status: "OPEN", qty: 0.1, entry_price: 80, exit_price: null, opened_at: "2026-11-13T10:00:00Z", closed_at: null, stop: 60, tp: 100, entry_fee_usd: 0.016, exit_fee_usd: null, collateral_usd: 8, gross_usd: null, net_usd: null, swept_usd: 0, shortfall_usd: 0, fee_model: "TEST" },
      orders: [{ order_id: "TEST-QTY", action: "OPEN_LONG", requested_qty: 0.5, status: "ACCEPTED", code: "DRY_RUN_ACCEPTED", message: "Reduced to approved stop risk", received_at: "2026-11-13T10:00:00Z", engine_payload: null }], fills: [], wallet_entries: [], events: [], checks: [], all_checks_ok: true, labels: { mode: "TEST PAPER", fee_model: "TEST", short_model: null } };
    const html = renderToStaticMarkup(<MemoryRouter><BotTradeProofView p={proof} /></MemoryRouter>);
    expect(html).toContain("filled 0.1 of 0.5 requested"); expect(html).toContain("not a guaranteed exchange fill");
  });
});

// Actual legacy row shape from the older read route; no synthetic replacement values in production.
describe("history compatibility", () => {
  it("maps the actual legacy quantities and keeps its numeric proof/chart reference", async () => {
    const { legacyHistoryRows } = await import("./botTrades");
    const { fromBotTrade } = await import("./tradeStory");
    const rows = legacyHistoryRows([{ id: 17, source: "ALPHA_PAPER", open_alert_id: "ENG-SOLUSD-5-TEST-BUY", close_alert_id: "TEST-CLOSE", symbol: "SOLUSD", direction: "long", status: "CLOSED", entry_qty: "0.1", entry_avg_price: "80", exit_avg_price: "81", opened_at: "2026-11-13T10:00:00Z", closed_at: "2026-11-13T11:00:00Z", realized_pnl: "0.1", gross_pnl: "0.1", fees_usd: "0" } as unknown as import("./types").TradeRow], { bot: "ALPHA-02" });
    expect(rows).toHaveLength(1); expect(rows[0].qty).toBe(0.1);
    expect(fromBotTrade(rows[0]).chartUrl).toBe("/bots/ALPHA-02/chart?ledger=legacy&trade=17");
    expect(legacyHistoryRows([], { bot: "ALPHA-01" })).toEqual([]);
  });
  it("keeps recent requests within the tested D1 variable budget while recovering legacy rows", async () => {
    const { vi } = await import("vitest"); const { api } = await import("../api/client"); const { fetchBotTrades } = await import("./botTrades");
    const get = vi.spyOn(api, "get").mockResolvedValueOnce({ ok: true, data: { available: true, trades: [], orders: [], signals: [] } }).mockResolvedValueOnce({ ok: true, data: [] });
    try {
      await fetchBotTrades({ bot: "ALPHA-02", limit: 5000 });
      expect(get.mock.calls.map(c => c[0])).toEqual(["/api/dashboard/bot-trades?bot=ALPHA-02&limit=50", "/api/dashboard/trades?limit=50"]);
    } finally { get.mockRestore(); }
  });
});
