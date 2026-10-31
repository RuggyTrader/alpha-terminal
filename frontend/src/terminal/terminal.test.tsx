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
import type { AlertRow, DashboardData, OrderRow, PaperPosition, RiskRow } from "./types";

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
    ...over,
  };
}

const ok = (data: DashboardData): FeedState => ({
  ...initialFeedState, status: "ok", data, lastSuccessAt: Date.parse("2026-10-31T14:02:00Z"),
});

function withDash(state: FeedState, node: ReactElement, signOut: SignOutState = idleSignOut, path = "/") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <DashboardContext.Provider value={{ state, refresh: () => {}, signOut, doSignOut: () => {}, dismissSignOut: () => {} }}>
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
    const html = page("/", ok(dashboard()));
    expect(html).toContain("ALPHA TERMINAL");
    expect(html).toContain("PAPER DESK");
    expect(html).toContain("ONLINE");
    expect(html).toContain("PAPER EQUITY");
    expect(html).toContain("$2,222.22"); // equity
    expect(html).toContain("+$222.22"); // today's P&L
    expect(html).toContain("+11.1%"); // 222.22 / 2000
    for (const v of ["$4,444.44", "$1,111.11", "$3,333.33", "$5,555.55"]) expect(html).toContain(v);
    expect(html).toContain("MARKET CLOSED");
    for (const label of ["Home", "Trades", "Engine", "Activity", "Settings"]) expect(html).toContain(`>${label}<`);
    expect(html).not.toMatch(/withdraw/i);
  });

  it("shows an intentional empty state without positions", () => {
    const html = page("/", ok(dashboard()));
    expect(html).toContain("No open PAPER positions");
    expect(html).toContain("No TradingView alerts yet");
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
    expect(html).not.toContain("No open PAPER positions");
  });

  it("shows the compact system mode card", () => {
    const html = page("/", ok(dashboard()));
    expect(html).toContain("DRY RUN");
    expect(html).toContain("ENGINE STOPPED");
    expect(html).toContain("BROKER SUBMISSION OFF");
  });

  it("does not invent account values when Alpaca PAPER is not configured", () => {
    const d = dashboard({
      broker: {
        mode: "PAPER", read_only: true, account: null, positions: [], clock: null,
        errors: ["account", "positions", "clock"].map((source) => ({ source, code: "BROKER_NOT_CONFIGURED", message: "Alpaca PAPER keys are not configured" })),
      },
    });
    const html = page("/", ok(d));
    expect(html).toContain("Alpaca PAPER not configured");
    expect(html).toContain("PAPER positions unavailable");
    expect(html).not.toMatch(MONEY);
  });

  it("keeps the last snapshot but marks it stale when the API fails", () => {
    const state: FeedState = { ...ok(dashboard()), status: "stale", error: { status: 0, code: "OFFLINE", message: "Backend unreachable" } };
    const html = page("/", state);
    expect(html).toContain("STALE");
    expect(html).toContain("Showing data from");
    expect(html).toContain("is-stale");
    expect(html).toContain("$2,222.22");
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
    expect(trades("history", ok(dashboard()))).toContain("No completed PAPER trades yet.");
  });
});

// ---------------------------------------------------------------- Engine, Activity, Settings

describe("Engine", () => {
  it("shows STOPPED read-only with no browser controls", () => {
    const html = page("/engine", ok(dashboard()));
    expect(html).toContain("ALPHA ENGINE");
    expect(html).toContain("PAPER EXECUTION");
    expect(html).toContain("STOPPED");
    expect(html).toContain("Engine controls are intentionally unavailable from the browser.");
    expect(html).toContain("FALSE"); // ENABLE_TRADING
    expect(html).not.toMatch(/>(Start|Pause|Resume|Stop|Kill)</);
  });

  it("flags non-dry-run settings reported by the backend", () => {
    expect(page("/engine", ok(dashboard({ enable_trading: true })))).toContain("Non-dry-run setting reported");
  });
});

describe("Activity", () => {
  it("shows an empty state instead of generated log lines", () => {
    expect(page("/activity", ok(dashboard()))).toContain("No recorded activity yet.");
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
    expect(html).toContain("NOT CONFIGURED");
    expect(html).toContain("ACTIVE");
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
