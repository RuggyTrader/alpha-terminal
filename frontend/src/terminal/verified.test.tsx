import { fixtureLifetime } from "./test-fixtures";
// Verified performance, markets, system health and trade proof. Fixture data exists only in this file.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AccountHero } from "./components/AccountHero";
import { markets, systemHealth } from "./health";
import { computeMetrics } from "./performance";
import { PerformancePage } from "./pages/Performance";
import { pnlFromFills, ProofView } from "./pages/TradeProof";
import { initialFeedState, type FeedState } from "./poller";
import { idleSignOut } from "./signOut";
import { DashboardContext } from "./store";
import type { DashboardData, EngineBot, PaperPortfolio, PerformanceData, TradeProof, VerifiedTrade } from "./types";
import { primeVerified, verifiedKey, type VerifiedState } from "./useVerified";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function vt(id: number, pnl: number, closedAt: string, over: Partial<VerifiedTrade> = {}): VerifiedTrade {
  return { id, symbol: "SOLUSD", direction: "LONG", strategy: "OTE Pro Strat (engine)", realized_pnl: pnl, return_pct: null, cost_basis: 1000,
    opened_at: new Date(Date.parse(closedAt) - 3_600_000).toISOString(), closed_at: closedAt, price_sources: "kraken:SOLUSD", ...over };
}

function bot(over: Partial<EngineBot> = {}, status: Partial<NonNullable<EngineBot["status"]>> = {}): EngineBot {
  return {
    state: "ONLINE", age_seconds: 12,
    status: {
      symbol: "SOLUSD", timeframe: "5m", status_text: "Waiting for a swing", profile: "solusd-5m", risk_usd: 10,
      last_candle_time: "2026-11-09T11:50:00Z", last_candle_close: 87.1, position: null,
      trades: { closed: 18, wins: 9, losses: 9, net_pnl: 16.33 }, outbox: { pending: 0, rejected: 0, late: 0 },
      ledger_check: { status: "OK", at: "2026-11-09T11:55:20Z", issues: [] }, last_error: null, ...status,
    },
    ...over,
  };
}

function portfolio(funded: number): PaperPortfolio {
  return {
    label: "ALPHA PAPER", simulated: true, active: funded > 0, wallets: [],
    totals: { book_balance_usd: funded, unallocated_usd: 0, available_usd: funded, reserved_usd: 0, realized_pnl_usd: 0, net_funding_usd: funded, unrealized_pnl_usd: 0 },
    consistency: { ok: true, issues: [] }, history: [], strategies: {}, validated_engines: ["SOLUSD"],
    limits: { max_order_notional_usd: 5000, max_position_exposure_usd: 10000, short_selling_enabled: false, max_total_exposure_usd: 25000, max_open_positions: 5, daily_loss_limit_usd: 2000 },
  };
}

function dash(over: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: "2026-11-09T12:00:00Z", mode: "PAPER", execution: "DRY_RUN_ONLY", broker_submission: false, enable_trading: false,
    engine: { state: "STOPPED", kill_switch: 0, killed_at: null, reason: null, updated_at: "2026-10-31T00:00:00Z", updated_by: "admin" },
    broker: { mode: "PAPER", read_only: true, errors: [{ source: "account", code: "BROKER_AUTH_FAILED", message: "rejected" }], account: null, positions: [], clock: null },
    paper: { label: "ALPHA PAPER", simulated: true, broker_positions: false, positions: [], performance: { realized_pnl: 0, unrealized_pnl: 0, total_pnl: 0, marks_stale: false, open_positions: 0, closed_trades: 0 } },
    bot: bot(), portfolio: portfolio(0),
    counts: { alerts: { total: 0, dry_run: 0, rejected: 0, processing: 0, duplicates: 0 }, risk: { total: 0, approved: 0, rejected: 0 }, orders: { total: 0, dry_run_accepted: 0, unknown: 0, failed: 0 }, trades: { total: 0, open: 0, closed: 0, realized_pnl: 0 } },
    recent: { alerts: [], risk: [], orders: [], trades: [], activity: [] },
    ...over,
  };
}

const ok = (data: DashboardData): FeedState => ({ ...initialFeedState, status: "ok", data, lastSuccessAt: NOW });
const verified = (trades: VerifiedTrade[], excluded = 0): VerifiedState => ({ status: "ok", data: { verification: "Closed ALPHA PAPER ledger trades only.", trades, lifetime: fixtureLifetime(trades), truncated: false, excluded_closed_trades: excluded }, error: null });

function render(state: FeedState, node: ReactElement): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DashboardContext.Provider value={{ state, refresh: () => {}, signOut: idleSignOut, doSignOut: () => {}, dismissSignOut: () => {}, reconnected: false }}>
        {node}
      </DashboardContext.Provider>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------- metrics

describe("verified metrics", () => {
  const trades = [vt(1, 20, "2026-11-01T10:00:00Z"), vt(2, -10, "2026-11-05T10:00:00Z"), vt(3, 5, "2026-11-09T09:00:00Z")];

  it("computes P&L, return, win rate, profit factor, expectancy and drawdown from closed trades only", () => {
    const m = computeMetrics(trades, "ALL", NOW, 1000);
    expect(m.trades).toBe(3);
    expect(m.totalPnl).toBe(15);
    expect(m.returnPct).toBeCloseTo(1.5);
    expect(m.winRate).toBeCloseTo(66.667, 2);
    expect(m.profitFactor).toBeCloseTo(2.5);
    expect(m.expectancy).toBe(5);
    expect(m.maxDrawdown).toBe(10); // peak +20, trough +10
    expect(m.curve.map((p) => p.equity)).toEqual([0, 20, 10, 15]);
  });

  it("filters by range and never invents values", () => {
    expect(computeMetrics(trades, "1D", NOW, 1000).trades).toBe(1);
    expect(computeMetrics(trades, "1W", NOW, 1000).trades).toBe(2);
    const none = computeMetrics([], "ALL", NOW, 1000);
    expect([none.winRate, none.profitFactor, none.expectancy, none.maxDrawdown]).toEqual([null, null, null, null]);
    expect(computeMetrics(trades, "ALL", NOW, null).returnPct).toBeNull(); // nothing funded
    expect(computeMetrics([vt(1, 5, "2026-11-09T09:00:00Z")], "ALL", NOW, 1000).profitFactor).toBeNull(); // no losses
  });
});

// ---------------------------------------------------------------- markets and health

describe("markets and system health", () => {
  it("crypto is ACTIVE only with an online engine and a fresh Kraken candle; stocks are never configured", () => {
    expect(markets(dash(), NOW).map((m) => [m.cls, m.state])).toEqual([["CRYPTO", "ACTIVE"], ["STOCKS", "NOT CONFIGURED"]]);
    expect(markets(dash({ bot: bot({}, { last_candle_time: "2026-11-09T11:00:00Z" }) }), NOW)[0].state).toBe("DEGRADED");
    expect(markets(dash({ bot: bot({ state: "STALE" }) }), NOW)[0].state).toBe("STALE");
    expect(markets(dash({ bot: { state: "NOT_RUNNING", age_seconds: null, status: null } }), NOW)[0].state).toBe("STOPPED");
    expect(markets(dash({ bot: undefined }), NOW)[0].state).toBe("STOPPED");
  });

  it("reports real problems instead of HEALTHY", () => {
    const by = (d: DashboardData) => Object.fromEntries(systemHealth(ok(d), NOW).map((r) => [r.key, r.state]));
    expect(by(dash())).toEqual({ api: "HEALTHY", db: "HEALTHY", market: "HEALTHY", scanner: "HEALTHY", risk: "HEALTHY", paper: "HEALTHY", live: "DISABLED" });
    expect(by(dash({ bot: bot({}, { ledger_check: { status: "DIVERGED", at: null, issues: ["qty differs"] } }) })).paper).toBe("ERROR");
    expect(by(dash({ portfolio: { ...portfolio(0), consistency: { ok: false, issues: ["SOLUSD: reserved differs"] } } })).db).toBe("ERROR");
    expect(by(dash({ enable_trading: true }))).toMatchObject({ risk: "ERROR", live: "ERROR" });
    expect(by(dash({ bot: bot({}, { last_error: { at: null, where: "market-data", message: "HTTP 503" } }) })).market).toBe("ERROR");
    expect(by(dash({ bot: undefined }))).toMatchObject({ market: "STOPPED", scanner: "STOPPED", paper: "N/A" });
    expect(systemHealth({ status: "error", error: { status: 0, code: "OFFLINE", message: "x" }, data: null }, NOW)[0].state).toBe("OFFLINE");
  });
});

// ---------------------------------------------------------------- hero

describe("home hero", () => {
  it("does not count the engine's own simulation (+$16.33) as verified P&L", () => {
    const html = render(ok(dash()), <AccountHero state={ok(dash())} verified={verified([])} now={NOW} />);
    expect(html).toContain("VERIFIED P&amp;L");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("16.33");
    expect(html).toContain("ENGINE ONLINE");
    expect(html).toMatch(/WIN RATE<\/span><b[^>]*>N\/A/);
  });

  it("shows verified results and return on funded PAPER capital", () => {
    const d = dash({ portfolio: portfolio(5000) });
    const html = render(ok(d), <AccountHero state={ok(d)} verified={verified([vt(1, 60, "2026-11-08T10:00:00Z"), vt(2, -10, "2026-11-09T10:00:00Z")])} now={NOW} />);
    expect(html).toContain("+$50.00");
    expect(html).toContain("+1.00%"); // 50 / 5000
    expect(html).toContain("50.0%"); // 1 of 2
  });

  it("says so when the backend cannot provide verified history", () => {
    const html = render(ok(dash()), <AccountHero state={ok(dash())} verified={{ status: "unsupported", data: null, error: "x" }} now={NOW} />);
    expect(html).toContain("Verified history not provided by this backend yet");
    expect(html).not.toMatch(/\$\d/);
  });
});

// ---------------------------------------------------------------- performance page

describe("Verified Performance page", () => {
  const prime = (d: DashboardData, data: PerformanceData) => primeVerified(verifiedKey(d.counts.trades.closed, d.counts.trades.total), data);

  it("refuses to draw a curve without enough verified history", () => {
    const d = dash({ counts: { ...dash().counts, trades: { total: 1, open: 0, closed: 1, realized_pnl: 5 } } });
    prime(d, verified([vt(9, 5, "2026-11-09T10:00:00Z")], 1).data!);
    const html = render(ok(d), <PerformancePage now={NOW} />);
    expect(html).toContain("Verified performance");
    expect(html).toContain("NOT ENOUGH VERIFIED TRADING HISTORY");
    expect(html).toContain("1 closed trade(s) from other sources are excluded.");
    expect(html).toContain("engine simulations");
    expect(html).not.toContain("+$16.33");
    expect(html).toContain("no losing trades yet");
  });

  it("draws the equity curve from verified closes", () => {
    const d = dash({ portfolio: portfolio(1000), counts: { ...dash().counts, trades: { total: 3, open: 0, closed: 3, realized_pnl: 15 } } });
    prime(d, verified([vt(1, 20, "2026-11-01T10:00:00Z"), vt(2, -10, "2026-11-05T10:00:00Z"), vt(3, 5, "2026-11-09T09:00:00Z")]).data!);
    const html = render(ok(d), <PerformancePage now={NOW} />);
    expect(html).toContain("Verified equity curve");
    expect(html).toContain("2.50"); // profit factor
    expect(html).toContain("+$15.00");
    expect(html).toContain("/trades/3");
  });
});

// ---------------------------------------------------------------- trade proof

describe("Trade proof", () => {
  const proof = (over: Partial<TradeProof> = {}): TradeProof => ({
    verified: true, verification: "Closed by the ALPHA PAPER ledger.",
    trade: { id: 5, symbol: "SOLUSD", direction: "LONG", status: "CLOSED", strategy: "OTE Pro Strat (engine)", entry_qty: "10", entry_avg_price: "95.11",
      exit_qty: "10", exit_avg_price: "90.37", open_qty: "0", realized_pnl: "-47.4", return_pct: "-4.983703", opened_at: "2026-11-05T14:20:05Z", closed_at: "2026-11-05T15:20:04Z", source: "ALPHA_PAPER" },
    fills: [
      { id: 1, client_order_id: "at-1", alert_id: "ENG-BUY", risk_decision_fk: 1, kind: "OPEN", side: "buy", qty: 10, price: 95.11, price_source: "kraken:SOLUSD", price_at: "2026-11-05T14:20:05Z", realized_pnl: 0, position_qty_after: 10, avg_entry_after: 95.11, filled_at: "2026-11-05T14:20:05Z" },
      { id: 2, client_order_id: "at-2", alert_id: "ENG-CLOSE", risk_decision_fk: 2, kind: "CLOSE", side: "sell", qty: 10, price: 90.37, price_source: "kraken:SOLUSD", price_at: "2026-11-05T15:20:04Z", realized_pnl: -47.4, position_qty_after: 0, avg_entry_after: 95.11, filled_at: "2026-11-05T15:20:04Z" },
    ],
    alerts: [], risk_decisions: [{ id: 1, alert_id: "ENG-BUY", decided_at: "2026-11-05T14:20:05Z", approved: true, code: "APPROVED", reason: "ok", side: "buy", final_qty: "10", reference_price: "95.11", reference_price_time: "2026-11-05T14:20:05Z", estimated_notional: "951.1", checks: [{ check: "max_order_notional", passed: true, detail: "$951.10 ≤ $5,000" }] }],
    orders: [{ id: 1, alert_id: "ENG-BUY", client_order_id: "at-1", symbol: "SOLUSD", side: "buy", qty: "10", order_type: "market", status: "dry_run_accepted", submitted_at: "2026-11-05T14:20:05Z", error_detail: null, broker_request_sent: false }],
    ...over,
  });

  it("recomputes P&L from the recorded fills and confirms it matches", () => {
    expect(pnlFromFills(proof().fills)?.pnl).toBeCloseTo(-47.4);
    const html = renderToStaticMarkup(<ProofView proof={proof()} />);
    expect(html).toContain("✓ VERIFIED PAPER");
    expect(html).toContain("MATCHES");
    expect(html).toContain("kraken:SOLUSD");
    expect(html).toContain("max_order_notional");
    expect(html).toContain("NO BROKER ORDER SUBMITTED");
  });

  it("flags a recorded P&L that the fills do not support, and a trade without fills", () => {
    const bad = proof({ trade: { ...proof().trade, realized_pnl: "47.4" } });
    expect(renderToStaticMarkup(<ProofView proof={bad} />)).toContain("DOES NOT MATCH");
    const legacy = proof({ verified: false, verification: "Not an ALPHA PAPER ledger trade.", fills: [], risk_decisions: [], orders: [], trade: { ...proof().trade, source: null } });
    const html = renderToStaticMarkup(<ProofView proof={legacy} />);
    expect(html).toContain("NOT VERIFIED");
    expect(html).toContain("No recorded fills");
  });
});
