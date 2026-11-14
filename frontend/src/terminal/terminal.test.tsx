import { fixtureLifetime } from "./test-fixtures";
// Dashboard UI and data-loop tests. Fixture data below exists only in this test file.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { actionLabel, alertLabel, alertTone, duplicateLabel, marketType, orderLabel, riskChecks } from "./classify";
import { AlertCard } from "./components/AlertCard";
import { heroSize } from "./components/AccountHero";
import { OrderIntentCard } from "./components/OrderIntentCard";
import { RiskDecisionCard } from "./components/RiskDecisionCard";
import { LoginScreen } from "./LoginScreen";
import { TradesPage, type TradesTab } from "./pages/Trades";
import { DashboardPoller, initialFeedState, type FeedState } from "./poller";
import { idleSignOut, performSignOut, type SignOutState } from "./signOut";
import { DashboardContext } from "./store";
import { TerminalRoutes } from "./Terminal";
import { AnimatedList, AnimatedNumber, prefersReducedMotion, Reveal } from "./motion";
import { Expandable } from "./components/ui";
import { AlphaPaperPositionCard } from "./components/AlphaPaperPositionCard";
import { TradeCard } from "./components/TradeCard";
import { primeVerified, verifiedKey } from "./useVerified";
import type { AlertRow, AlphaPaperPosition, AlphaPaperSection, DashboardData, OrderRow, PaperPosition, RiskRow, TradeRow } from "./types";

// ---------------------------------------------------------------- fixtures (tests only)

function alert(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: 1, alert_id: "test-alert-1", received_at: "2026-10-31T14:00:00Z", processed_at: "2026-10-31T14:00:01Z",
    symbol: "SPY", action: "buy", strategy: "TEST", order_type: "market", requested_qty: "1", accepted_qty: null,
    status: "rejected", validation_result: "passed", response_code: "RISK_REJECTED", http_status: 422,
    rejection_reason: "test rejection reason", duplicate_count: 0, last_duplicate_at: null, ...over,
  };
}

function risk(over: Partial<RiskRow> = {}): RiskRow {
  return {
    id: 1, alert_fk: 1, alert_id: "test-alert-1", symbol: "SPY", action: "buy", strategy: "TEST",
    decided_at: "2026-10-31T14:00:01Z", approved: false, code: "MAX_ORDER_NOTIONAL", reason: "test reason",
    side: "buy", final_qty: "1", reference_price: "100", reference_price_time: null, estimated_notional: "100",
    checks: [
      { check: "symbol_allowed", passed: true, detail: "SPY allowed" },
      { check: "max_order_notional", passed: false, detail: "over limit" },
    ],
    ...over,
  };
}

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 1, alert_id: "test-alert-2", strategy: "TEST", source: "webhook", client_order_id: "at-testclientid",
    alpaca_order_id: null, symbol: "SPY", side: "buy", qty: "1", order_type: "market", time_in_force: "day",
    status: "dry_run_accepted", submitted_at: "2026-10-31T14:01:00Z", updated_at: "2026-10-31T14:01:00Z",
    error_detail: null, broker_request_sent: false, ...over,
  };
}

const position: PaperPosition = {
  symbol: "TSTA", side: "long", qty: 3, qty_available: 3, avg_entry_price: 10, market_value: 37.5, cost_basis: 30,
  current_price: 12.5, lastday_price: 12, unrealized_pl: 7.5, unrealized_plpc: 0.25, change_today: 0.0417,
};

function paperPos(over: Partial<AlphaPaperPosition> = {}): AlphaPaperPosition {
  return {
    id: 7, label: "ALPHA PAPER", symbol: "SOLUSD", side: "long", qty: 0.5, avg_entry_price: 100, multiplier: 1, cost_basis: 50,
    mark_price: 110, mark_at: "2026-10-31T14:01:55Z", mark_source: "kraken:SOLUSD", mark_age_seconds: 5, mark_status: "FRESH",
    mark_error: null, market_value: 55, unrealized_pnl: 5, unrealized_pct: 10, realized_pnl: 0, strategy: "OTE Pro Strat",
    opened_at: "2026-10-31T14:00:00Z", open_alert_id: "test-open-1", open_order_id: "at-test-1", ...over,
  };
}

function paper(positions: AlphaPaperPosition[] = [], perf: Partial<AlphaPaperSection["performance"]> = {}): AlphaPaperSection {
  const unrealized = positions.reduce((t, p) => t + (p.unrealized_pnl ?? 0), 0);
  return {
    label: "ALPHA PAPER", simulated: true, broker_positions: false, positions,
    performance: { realized_pnl: 0, unrealized_pnl: unrealized, total_pnl: unrealized, marks_stale: false, open_positions: positions.length, closed_trades: 0, ...perf },
  };
}

function dashboard(over: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: "2026-10-31T14:02:00Z",
    mode: "PAPER",
    execution: "DRY_RUN_ONLY",
    broker_submission: false,
    enable_trading: false,
    engine: { state: "STOPPED", kill_switch: 0, killed_at: null, reason: "test", updated_at: "2026-10-31T13:00:00Z", updated_by: "test" },
    broker: {
      mode: "PAPER", read_only: true, errors: [],
      account: {
        id: "test", status: "ACTIVE", currency: "USD", cash: 1111.11, equity: 2222.22, last_equity: 2000,
        portfolio_value: 3333.33, buying_power: 4444.44, long_market_value: 5555.55, short_market_value: 0,
        trading_blocked: false, account_blocked: false, pattern_day_trader: false, daytrade_count: 0, todays_pnl: 222.22,
      },
      positions: [],
      clock: { timestamp: null, is_open: false, next_open: "2026-11-02T14:30:00Z", next_close: null },
    },
    counts: {
      alerts: { total: 0, dry_run: 0, rejected: 0, processing: 0, duplicates: 0 },
      risk: { total: 0, approved: 0, rejected: 0 },
      orders: { total: 0, dry_run_accepted: 0, unknown: 0, failed: 0 },
      trades: { total: 0, open: 0, closed: 0, realized_pnl: 0 },
    },
    recent: { alerts: [], risk: [], orders: [], trades: [], activity: [] },
    paper: paper(),
    ...over,
  };
}

const ok = (data: DashboardData): FeedState => ({
  ...initialFeedState, status: "ok", data, lastSuccessAt: Date.parse("2026-10-31T14:02:00Z"),
});

function withDash(state: FeedState, node: ReactElement, signOut: SignOutState = idleSignOut, path = "/") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <DashboardContext.Provider value={{ state, refresh: () => {}, signOut, doSignOut: () => {}, dismissSignOut: () => {}, reconnected: false }}>
        {node}
      </DashboardContext.Provider>
    </MemoryRouter>,
  );
}

const page = (path: string, state: FeedState, signOut?: SignOutState) => withDash(state, <TerminalRoutes />, signOut, path);
const trades = (tab: TradesTab, state: FeedState) => withDash(state, <TradesPage initialTab={tab} />);
const MONEY = /\$\d/;

// ---------------------------------------------------------------- Home

describe("Home", () => {
  it("renders the mobile home from Worker values only", () => {
    primeVerified(verifiedKey(0, 0), { verification: "test", lifetime: fixtureLifetime(), trades: [], truncated: false, excluded_closed_trades: 0 });
    const html = page("/", ok(dashboard()));
    expect(html).toContain("ALPHA TERMINAL");
    expect(html).toContain("PAPER DESK");
    expect(html).toContain("ONLINE");
    expect(html).toContain("VERIFIED P&amp;L");
    expect(html).toContain("TOTAL RETURN");
    expect(html).toContain("CLOSED TRADES");
    expect(html).toContain("WIN RATE");
    expect(html).toContain("no PAPER capital funded");
    // The optional Alpaca broker account is not the headline any more.
    expect(html).not.toContain("PAPER EQUITY");
    for (const v of ["$2,222.22", "$4,444.44", "$1,111.11", "$3,333.33"]) expect(html).not.toContain(v);
    // Market coverage moved to the Engine page (it repeated System health on Home; UI duplicate audit 2026-11-13).
    expect(html).not.toContain(">Markets<");
    const eng = page("/engine", ok(dashboard()));
    expect(eng).toContain("Markets");
    expect(eng).toContain("STOCKS");
    expect(eng).toContain("NOT CONFIGURED");
    expect(html).toContain("System health");
    for (const label of ["Home", "Trades", "Engine", "Activity", "Settings"]) expect(html).toContain(`>${label}<`);
    expect(html).not.toMatch(/withdraw/i);
  });

  it("shows an intentional empty state without positions", () => {
    const html = page("/", ok(dashboard()));
    expect(html).toContain("No open ALPHA PAPER positions");
    expect(html).toContain("No signals yet");
    expect(html).not.toContain("Alpaca PAPER account positions"); // no broker positions, no broker section
  });

  it("renders populated positions as cards", () => {
    const d = dashboard();
    d.broker.positions = [position];
    const html = page("/", ok(d));
    expect(html).toContain("TSTA");
    expect(html).toContain("STOCK");
    expect(html).toContain("LONG");
    expect(html).toContain("+$7.50");
    expect(html).toContain("+25.0%");
    expect(html).toContain("$37.50");
    // Broker positions are listed separately from the ALPHA PAPER ledger.
    expect(html).toContain("Alpaca PAPER account positions");
    expect(html).toContain("No open ALPHA PAPER positions");
  });

  it("shows ALPHA PAPER positions, labelled and kept apart from broker equity", () => {
    const d = dashboard({ paper: paper([paperPos()], { realized_pnl: 12.5, total_pnl: 17.5 }) });
    const html = page("/", ok(d));
    expect(html).toContain("Open positions");
    expect(html).toContain("ALPHA PAPER POSITION · simulated, not a broker position");
    expect(html).toContain("SOLUSD");
    expect(html).toContain("CRYPTO");
    expect(html).toContain("LONG");
    expect(html).toContain("+$5.00"); // (110 − 100) × 0.5
    expect(html).toMatch(/t-pos[^>]*>\+\$5\.00/);
    expect(html).toContain("+10.0%");
    expect(html).toContain("$100.00"); // avg entry
    expect(html).toContain("$110.00"); // current mark
    expect(html).toContain("Kraken · 5s ago");
    expect(html).toContain("Funded PAPER"); // Home keeps the summary (hero + selector); the full ALPHA PAPER performance section was a duplicate (UI duplicate audit)
    // Realized / unrealized / total moved to the Performance page (one place; Home keeps the summary).
    primeVerified(verifiedKey(d.counts.trades.closed, d.counts.trades.total), { verification: "TEST older backend without lifetime", trades: [], truncated: false, excluded_closed_trades: 0 });
    const perf = page("/performance", ok(d));
    expect(perf).toContain("Complete lifetime performance unavailable");
    expect(perf).not.toContain("+$17.50"); // legacy open + realized is not lifetime profit
    expect(html).not.toContain("$2,222.22"); // broker equity is not mixed in
    expect(html).not.toContain("Alpaca PAPER account positions");
  });

  it("colours a losing ALPHA PAPER position red", () => {
    const html = renderToStaticMarkup(<AlphaPaperPositionCard p={paperPos({ mark_price: 90, unrealized_pnl: -5, unrealized_pct: -10 })} />);
    expect(html).toMatch(/t-neg[^>]*>−\$5\.00/);
    expect(html).toContain("−10.0%");
  });

  it("flags a stale mark instead of showing it as current", () => {
    const html = renderToStaticMarkup(
      <AlphaPaperPositionCard p={paperPos({ mark_status: "STALE", mark_error: "Kraken market data returned HTTP 503 for SOLUSD", mark_age_seconds: 300 })} />,
    );
    expect(html).toContain("STALE");
    expect(html).toContain("is-stale");
    expect(html).toContain("Price refresh failed: Kraken market data returned HTTP 503 for SOLUSD.");
    expect(html).toContain("P&amp;L shows the last real mark, not a current price.");
    expect(html).toContain("Kraken · 5m ago");
  });

  it("shows N/A rather than a number when there is no mark", () => {
    const html = renderToStaticMarkup(
      <AlphaPaperPositionCard p={paperPos({ mark_price: null, mark_at: null, mark_source: null, mark_age_seconds: null, mark_status: "UNAVAILABLE", unrealized_pnl: null, unrealized_pct: null, market_value: null })} />,
    );
    expect(html).toContain("UNAVAILABLE");
    expect(html).toContain("N/A");
    expect(html).not.toContain("+$");
  });

  it("shows the compact system mode card", () => {
    const html = page("/", ok(dashboard()));
    expect(html).toContain("DRY RUN");
    expect(html).toContain("BROKER ROUTE STOPPED");
    expect(html).toContain("BROKER SUBMISSION OFF");
  });

  it("does not invent account values when Alpaca PAPER is not configured", () => {
    const d = dashboard({
      broker: {
        mode: "PAPER", read_only: true, account: null, positions: [], clock: null,
        errors: ["account", "positions", "clock"].map((source) => ({ source, code: "BROKER_NOT_CONFIGURED", message: "Alpaca PAPER keys are not configured" })),
      },
      paper: undefined, // broker values only; the ledger has its own section
    });
    const html = page("/settings", ok(d));
    expect(html).toContain("Alpaca PAPER broker (optional)");
    expect(html).toContain("NOT CONFIGURED");
    expect(html).not.toMatch(MONEY);
    expect(page("/", ok(d))).not.toContain("PAPER positions unavailable"); // broker errors live in Settings
  });

  it("keeps the last snapshot but marks it stale when the API fails", () => {
    const state: FeedState = { ...ok(dashboard()), status: "stale", error: { status: 0, code: "OFFLINE", message: "Backend unreachable" } };
    const html = page("/", state);
    expect(html).toContain("STALE");
    expect(html).toContain("Showing data from");
    expect(html).toContain("is-stale");
    expect(html).toContain("No open ALPHA PAPER positions"); // the last snapshot is still shown
  });

  it("shows OFFLINE and no numbers when the first load fails", () => {
    const html = page("/", { ...initialFeedState, status: "error", error: { status: 0, code: "OFFLINE", message: "Backend unreachable" } });
    expect(html).toContain("Backend unreachable");
    expect(html).toContain("OFFLINE");
    expect(html).not.toMatch(MONEY);
  });

  it("shows skeletons, not numbers, while loading", () => {
    const html = page("/", initialFeedState);
    expect(html).toContain("Loading");
    expect(html).not.toMatch(MONEY);
  });
});

// ---------------------------------------------------------------- Trades

describe("Trades", () => {
  it("shows a rejected alert compactly, with technical details collapsed", () => {
    const html = trades("alerts", ok(dashboard({ recent: { ...dashboard().recent, alerts: [alert()] } })));
    expect(html).toContain("xc-bad");
    expect(html).toContain("REJECTED");
    expect(html).toContain("test rejection reason");
    expect(html).not.toContain("test-alert-1"); // alert ID only in expanded details
  });

  it("shows an accepted dry-run alert and its order intent as dry run only", () => {
    const d = dashboard({
      recent: {
        ...dashboard().recent,
        alerts: [alert({ id: 2, alert_id: "test-alert-2", status: "dry_run", response_code: "DRY_RUN_ACCEPTED", http_status: 200, rejection_reason: null, accepted_qty: "1" })],
        orders: [order()],
      },
    });
    expect(trades("alerts", ok(d))).toContain("DRY-RUN ACCEPTED");
    const orders = trades("orders", ok(d));
    expect(orders).toContain("DRY RUN — NO BROKER ORDER SUBMITTED");
    expect(orders).toContain("ACCEPTED");
    expect(orders).not.toMatch(/FILLED/);
    const expanded = renderToStaticMarkup(<OrderIntentCard o={order()} defaultOpen />);
    expect(expanded).toContain("Not sent (dry run)");
    expect(expanded).toContain("at-testclientid");
  });

  it("shows alert details when expanded", () => {
    const html = renderToStaticMarkup(<AlertCard a={alert({ duplicate_count: 2 })} defaultOpen />);
    expect(html).toContain("test-alert-1");
    expect(html).toContain("RISK_REJECTED");
    expect(html).toContain("DUPLICATE ×2");
  });

  it("expands risk decisions into check chips", () => {
    const closed = renderToStaticMarkup(<RiskDecisionCard r={risk()} />);
    expect(closed).toContain("REJECTED");
    expect(closed).not.toContain("symbol allowed");
    const open = renderToStaticMarkup(<RiskDecisionCard r={risk()} defaultOpen />);
    expect(open).toContain("✓ symbol allowed");
    expect(open).toContain("✕ max order notional");
    expect(open).toContain("MAX_ORDER_NOTIONAL");
    expect(open).not.toContain("checks_json");
  });

  it("shows an empty trade history truthfully", () => {
    expect(trades("history", ok(dashboard()))).toContain("No completed ALPHA PAPER trades yet.");
  });

  it("labels ledger trades as ALPHA PAPER with their P&L", () => {
    const t: TradeRow = {
      id: 1, symbol: "SOLUSD", direction: "LONG", status: "CLOSED", strategy: "OTE Pro Strat", entry_qty: "2", entry_avg_price: "115",
      exit_qty: "2", exit_avg_price: "137.5", open_qty: "0", realized_pnl: "45", return_pct: "19.565217", opened_at: "2026-10-31T14:00:00Z",
      closed_at: "2026-10-31T15:00:00Z", source: "ALPHA_PAPER", open_alert_id: "a1", close_alert_id: "a4", open_order_id: "at-1",
      close_order_id: "at-4", price_sources: "kraken:SOLUSD",
    };
    const html = renderToStaticMarkup(<MemoryRouter><TradeCard t={t} defaultOpen /></MemoryRouter>);
    expect(html).toContain("✓ VERIFIED PAPER");
    expect(html).toContain("+$45.00");
    expect(html).toContain("+19.57%");
    expect(trades("history", ok(dashboard({ recent: { alerts: [], risk: [], orders: [], trades: [t], activity: [] } })))).toContain("SOLUSD");
  });
});

// ---------------------------------------------------------------- Engine, Activity, Settings

describe("Engine", () => {
  it("shows STOPPED read-only with no browser controls", () => {
    const html = page("/engine", ok(dashboard()));
    expect(html).toContain("ALPHA ENGINE");
    expect(html).toContain("PAPER EXECUTION");
    expect(html).toContain("NOT RUNNING"); // no engine report in this fixture
    expect(html).toContain("STOPPED"); // the separate broker route
    expect(html).toContain("This browser session is read-only, so it cannot start or stop the engine.");
    expect(html).toContain("FALSE"); // ENABLE_TRADING
    expect(html).not.toMatch(/<button[^>]*>[^<]*(Start|Pause|Resume|Stop|Kill)/);
  });

  it("flags non-dry-run settings reported by the backend", () => {
    expect(page("/engine", ok(dashboard({ enable_trading: true })))).toContain("Non-dry-run setting reported");
  });
});

describe("Activity", () => {
  it("shows a loading state, never generated log lines, before the Worker's events arrive", () => {
    const html = page("/activity", ok(dashboard()));
    expect(html).toContain("Recorded events");
    expect(html).not.toContain("ac-item"); // no event row exists until the Worker returns one
    expect(html).not.toContain("Legacy engine log"); // no legacy rows → no legacy section
  });

  it("renders persisted events with severity", () => {
    const d = dashboard({
      recent: {
        ...dashboard().recent,
        activity: [{ id: 1, ts: "2026-10-31T14:00:00Z", category: "risk", level: "info", message: "Rejected", alert_id: null, symbol: "SPY", action: "buy", error_detail: null }],
      },
    });
    const html = page("/activity", ok(d));
    expect(html).toContain("feed-warn");
    expect(html).toContain("RISK");
    expect(html).toContain("SPY BUY");
  });
});

describe("Settings", () => {
  it("reports markets and security truthfully", () => {
    const html = page("/settings", ok(dashboard()));
    expect(html).toContain("Crypto");
    expect(html).toContain("Stocks · no provider");
    expect(html).toContain("NOT CONFIGURED");
    expect(html).toContain("cannot be withdrawn");
    expect(html).toContain("Read-only");
    expect(html).toContain("Server-side only");
    expect(html).not.toMatch(/ADMIN_SECRET|DASHBOARD_PASSPHRASE/);
  });
});

// ---------------------------------------------------------------- sign-out

describe("sign-out", () => {
  it("reports success only when /auth/logout succeeds", async () => {
    expect(await performSignOut(async () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("does not claim the session ended when the backend is unreachable", async () => {
    const r = await performSignOut(async () => {
      throw new ApiError(0, "OFFLINE", "Backend unreachable");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("may still be active");
  });

  it("treats 401 as already signed out on the server", async () => {
    const r = await performSignOut(async () => {
      throw new ApiError(401, "UNAUTHORIZED", "Not signed in");
    });
    expect(r.ok).toBe(true);
  });

  it("keeps the signed-in app and offers a retry when sign-out failed", () => {
    const html = page("/settings", ok(dashboard()), { busy: false, error: "Sign-out failed because the backend could not be reached. Your server session may still be active, so you are still signed in here." });
    expect(html).toContain("Sign-out failed");
    expect(html).toContain("may still be active");
    expect(html).toContain("Retry sign out");
  });

  it("disables sign-out while it is in progress", () => {
    expect(page("/settings", ok(dashboard()), { busy: true, error: null })).toContain("Signing out…");
  });

  it("renders the sign-in screen for an expired session", () => {
    const html = renderToStaticMarkup(<LoginScreen expired onSignedIn={() => {}} />);
    expect(html).toContain("Session expired");
    expect(html).toContain('type="password"');
  });
});

// ---------------------------------------------------------------- classification

describe("classify", () => {
  it("colours alert states", () => {
    expect(alertLabel({ status: "dry_run" }).tone).toBe("ok");
    expect(alertLabel({ status: "rejected" }).tone).toBe("bad");
    expect(alertLabel({ status: "error" }).tone).toBe("bad");
    expect(alertTone({ status: "processing", duplicate_count: 1 })).toBe("warn");
    expect(duplicateLabel({ duplicate_count: 0 })).toBeNull();
    expect(actionLabel("close").text).toBe("CLOSE");
  });

  it("never labels an order intent as a fill", () => {
    for (const status of ["dry_run_accepted", "dry_run_failed", "unknown", "dry_run_reconciled", "submitting"]) {
      expect(orderLabel({ status }).text).not.toMatch(/FILL/);
    }
  });

  it("ignores malformed risk checks", () => {
    expect(riskChecks(risk({ checks: "bad" }))).toEqual([]);
    expect(riskChecks(risk()).length).toBe(2);
  });

  it("derives market type from the symbol", () => {
    expect(marketType("SPY")).toBe("STOCK");
    expect(marketType("BTCUSD")).toBe("CRYPTO");
    expect(marketType("BTC/USD")).toBe("CRYPTO");
  });

  it("sizes the hero value so it fits", () => {
    expect(heroSize("$2,222.22")).toBe("hv-l");
    expect(heroSize("$100,000.00")).toBe("hv-m");
    expect(heroSize("$10,000,000.00")).toBe("hv-s");
  });
});

// ---------------------------------------------------------------- API client

describe("api client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("turns a hung request into a TIMEOUT error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const { api, REQUEST_TIMEOUT_MS } = await import("../api/client");
    const p = api.get("/api/dashboard").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const err = (await p) as ApiError;
    expect(err.code).toBe("TIMEOUT");
  });

  it("reports 401 as an ApiError with status 401", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "authentication required" }), { status: 401 }));
    const { api } = await import("../api/client");
    const err = (await api.get("/api/dashboard").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
  });
});

// ---------------------------------------------------------------- refresh loop

describe("DashboardPoller", () => {
  afterEach(() => vi.useRealTimers());

  it("loads immediately and never overlaps requests", async () => {
    let resolve!: (d: DashboardData) => void;
    const fetcher = vi.fn(() => new Promise<DashboardData>((r) => (resolve = r)));
    const p = new DashboardPoller(fetcher, { intervalMs: 5000 });
    p.start();
    const again = p.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(dashboard());
    await again;
    expect(p.getState().status).toBe("ok");
    p.stop();
  });

  it("keeps the last good data and marks it stale after a failure", async () => {
    const fetcher = vi.fn<() => Promise<DashboardData>>()
      .mockResolvedValueOnce(dashboard())
      .mockRejectedValueOnce(new ApiError(0, "OFFLINE", "Backend unreachable"));
    const p = new DashboardPoller(fetcher);
    await p.refresh();
    await p.refresh();
    expect(p.getState().status).toBe("stale");
    expect(p.getState().data?.broker.account?.equity).toBe(2222.22);
  });

  it("stops polling and reports unauthorized on 401", async () => {
    vi.useFakeTimers();
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn<() => Promise<DashboardData>>().mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "authentication required"));
    const p = new DashboardPoller(fetcher, { intervalMs: 1000, onUnauthorized });
    p.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.getState().status).toBe("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("schedules the next refresh only after the previous one finishes", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<() => Promise<DashboardData>>().mockResolvedValue(dashboard());
    const p = new DashboardPoller(fetcher, { intervalMs: 1000 });
    p.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(fetcher).toHaveBeenCalledTimes(4);
    p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------- remember this device

describe("remember this device", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows an unchecked toggle with the 30-day note", () => {
    const html = renderToStaticMarkup(<LoginScreen onSignedIn={() => {}} />);
    expect(html).toContain("Remember this device");
    expect(html).toContain("Keep this device signed in for 30 days.");
    expect(html).toMatch(/type="checkbox"/);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  it("sends remember_device to the server and nothing else about the device", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { login } = await import("./api");
    await login("test-pass", true);
    await login("test-pass");
    expect(bodies).toEqual([
      { passphrase: "test-pass", remember_device: true },
      { passphrase: "test-pass", remember_device: false },
    ]);
  });

  it("never stores credentials or sessions in browser storage", () => {
    const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, text] of Object.entries(sources)) {
      // The one exception: the Light/Dark/System choice (theme.ts), a single non-sensitive key.
      if (file === "./theme.ts") continue;
      expect(text, file).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    }
    const theme = sources["./theme.ts"].replace(/\/\/.*$/gm, "");
    expect(theme).not.toMatch(/sessionStorage|document\.cookie|indexedDB/);
    expect(Array.from(theme.matchAll(/localStorage\.(\w+)\(([^,)]*)/g), (m) => `${m[1]}(${m[2]})`).sort()).toEqual(["getItem(KEY)", "setItem(KEY)"]);
    expect(theme).toContain('const KEY = "at-theme";');
  });
});

// ---------------------------------------------------------------- motion

// Read the stylesheet from disk (Vitest empties CSS imports). Typed loosely: no @types/node here.
const nodeFs = "node:fs";
const motionCss: string = ((await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (u: URL, e: string) => string }).readFileSync(
  new URL("./motion.css", import.meta.url),
  "utf8",
);

describe("motion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("detects reduced motion", () => {
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(prefersReducedMotion()).toBe(true);
  });

  it("disables non-essential motion in reduced-motion mode", () => {
    const block = motionCss.slice(motionCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain("animation-duration: 1ms");
    expect(block).toContain("transition-duration: 1ms");
    expect(block).toMatch(/\.globe-float \{ animation: none/);
    expect(block).toMatch(/\.m-reveal-pending \{ opacity: 1/);
  });

  it("never leaves an entrance animation ending invisible", () => {
    const frames = [...motionCss.matchAll(/@keyframes ([\w-]+) \{([^@]*?)\}\s*\}/g)];
    expect(frames.length).toBeGreaterThan(8);
    for (const [, name, body] of frames) {
      if (/leave|out|flash|glow|accent|close/.test(name)) continue; // exits and overlays are meant to fade away
      const end = body.slice(Math.max(body.lastIndexOf("to {"), body.lastIndexOf("100%")));
      expect(end, name).not.toMatch(/opacity:\s*0[;\s}]/);
    }
  });

  it("renders the real number immediately (no animation from zero)", () => {
    const html = renderToStaticMarkup(<AnimatedNumber id="test-num" value={1234.5} format={(n) => `$${n.toFixed(2)}`} />);
    expect(html).toContain("$1234.50");
  });

  it("does not hide revealed sections without JavaScript", () => {
    const html = renderToStaticMarkup(<Reveal><p>lower section</p></Reveal>);
    expect(html).toContain("lower section");
    expect(html).not.toContain("m-reveal-pending");
  });

  it("renders every list item visibly, staggering only the initial ones", () => {
    const html = renderToStaticMarkup(<AnimatedList items={["a", "b", "c"]} getKey={(x) => x} render={(x) => <span>item-{x}</span>} />);
    for (const x of ["a", "b", "c"]) expect(html).toContain(`item-${x}`);
    expect(html).not.toContain("is-leaving");
    expect(html).toContain("--i:2");
  });

  it("keeps expandable details accessible", () => {
    const closed = renderToStaticMarkup(<Expandable head={<b>head</b>}>details</Expandable>);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("details");
    const open = renderToStaticMarkup(<Expandable head={<b>head</b>} defaultOpen>details</Expandable>);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("details");
    expect(open).toMatch(/aria-controls="([^"]+)"[\s\S]*id="\1"/);
  });

  it("navigation renders every page with the shared nav indicator", () => {
    for (const path of ["/", "/trades", "/engine", "/activity", "/settings"]) {
      const html = page(path, ok(dashboard()));
      expect(html, path).toContain("bnav-ind");
      expect(html, path).toContain('class="page"');
    }
  });
});

// ---------------------------------------------------------------- OTE engine card

describe("OTE engine card", () => {
  const status = {
    symbol: "SOLUSD", timeframe: "5m", status_text: "Waiting for OTE tap", last_candle_time: "2026-10-31T14:00:00Z", last_candle_close: 93.14,
    position: null, trades: { closed: 3, wins: 1, losses: 1, net_pnl: 12.5 }, outbox: { pending: 0, rejected: 0, late: 0 }, last_error: null,
  };

  it("shows the engine's own state, ONLINE from the Worker's verdict", () => {
    const html = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 42, status } })));
    expect(html).toContain("OTE engine");
    expect(html).toContain("SOLUSD · 5m · PAPER simulation");
    expect(html).toContain("ONLINE");
    expect(html).toContain("Waiting for OTE tap");
    expect(html).toContain("42s ago");
    expect(html).toContain("+$12.50");
  });

  it("shows STALE / OFFLINE / NOT RUNNING truthfully, with the engine's last error", () => {
    const stale = page("/engine", ok(dashboard({ bot: { state: "STALE", age_seconds: 900, status: { ...status, last_error: { at: null, where: "market-data", message: "Kraken HTTP 503" } } } })));
    expect(stale).toContain("STALE");
    expect(stale).toContain("15m ago");
    expect(stale).toContain("market-data: Kraken HTTP 503");
    expect(page("/engine", ok(dashboard({ bot: { state: "OFFLINE", age_seconds: 7200, status } })))).toContain("OFFLINE");
    const never = page("/engine", ok(dashboard({ bot: { state: "NOT_RUNNING", age_seconds: null, status: null } })));
    expect(never).toContain("NOT RUNNING");
    expect(never).toContain("The engine has not reported yet.");
  });

  it("labels the engine's simulated position separately from the ALPHA PAPER ledger", () => {
    const html = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 5, status: { ...status, position: { side: "LONG", qty: 12.5, entry: 93.87, stop: 93.05, tp2: 96.5, unrealized_at_last_close: -3.25 } } } })));
    expect(html).toContain("LONG");
    expect(html).toContain("$93.87");
    expect(html).toContain("at last close");
    expect(html).toContain("Engine simulation · not verified");
  });
});

describe("OTE engine card: engine vs ALPHA PAPER ledger", () => {
  const base = {
    symbol: "SOLUSD", timeframe: "5m", status_text: "IN TRADE", last_candle_time: "2026-10-31T14:00:00Z", last_candle_close: 93.14,
    trades: { closed: 0, wins: 0, losses: 0, net_pnl: 0 }, outbox: { pending: 0, rejected: 1, late: 0 }, last_error: null,
    profile: "paper-test", risk_usd: 5,
  };
  const pos = { side: "LONG", qty: 6.1, entry: 93.87, stop: 93.05, tp2: 96.5, unrealized_at_last_close: 1.2 };

  it("names the test profile and says when the engine position is also in the ledger", () => {
    const html = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 5, status: { ...base, position: { ...pos, ledger: { status: "MIRRORED", reason: null } } } } })));
    expect(html).toContain("paper-test profile ($5 risk)");
    expect(html).toContain("Also open in the ALPHA PAPER ledger (checked against the ledger).");
  });

  it("flags an engine-only position and the last refused signal with its reason", () => {
    const html = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 5, status: {
      ...base, profile: "default", position: { ...pos, ledger: { status: "NOT_IN_LEDGER", reason: "BUY rejected: MAX_ORDER_NOTIONAL" } },
      last_rejection: { id: "x", action: "BUY", status: "rejected", code: "MAX_ORDER_NOTIONAL", reason: "Estimated notional $22760 is above the limit $5000" },
    } } })));
    expect(html).toContain("Engine-only position, not in the ALPHA PAPER ledger: BUY rejected: MAX_ORDER_NOTIONAL.");
    expect(html).toContain("Last refused signal: BUY rejected (MAX_ORDER_NOTIONAL)");
    expect(html).not.toContain("default profile");
  });
});

describe("OTE engine card: reconciliation", () => {
  const base = {
    symbol: "SOLUSD", timeframe: "5m", status_text: "IN TRADE", last_candle_time: "2026-10-31T14:00:00Z", last_candle_close: 93.14,
    trades: { closed: 0, wins: 0, losses: 0, net_pnl: 0 }, outbox: { pending: 0, rejected: 0, late: 0 }, last_error: null,
  };
  const pos = { side: "LONG", qty: 6.1, entry: 93.87, stop: 93.05, tp2: 96.5, unrealized_at_last_close: 1.2 };

  it("says when the engine position does not match the ledger, or could not be verified", () => {
    const diverged = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 5, status: { ...base,
      position: { ...pos, ledger: { status: "DIVERGED", reason: "ledger qty 7.1 vs engine 6.1" } },
      ledger_check: { status: "DIVERGED", at: null, issues: ["ledger qty 7.1 vs engine 6.1"] } } } })));
    expect(diverged).toContain("Does not match the ALPHA PAPER ledger: ledger qty 7.1 vs engine 6.1.");
    expect(diverged).not.toContain("Also open in the ALPHA PAPER ledger");
    const unverified = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 5, status: { ...base,
      position: { ...pos, ledger: { status: "UNVERIFIED", reason: "ledger query failed: fetch failed" } } } } })));
    expect(unverified).toContain("Accepted, but not verified against the ledger: ledger query failed: fetch failed.");
  });

  it("warns when the ledger holds an engine position the engine does not", () => {
    const html = page("/engine", ok(dashboard({ bot: { state: "ONLINE", age_seconds: 5, status: { ...base, position: null,
      ledger_check: { status: "DIVERGED", at: null, issues: ["the ledger holds an engine-opened SOLUSD position (ENG-x, qty 3) that the engine does not hold"] } } } })));
    expect(html).toContain("Reconciliation warning: the ledger holds an engine-opened SOLUSD position");
  });
});
