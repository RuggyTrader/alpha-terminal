// Dashboard states. Fixture data below exists only in this test file.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { alertLabel, alertRowClass, duplicateLabel, orderLabel, riskChecks } from "./classify";
import { LoginScreen } from "./LoginScreen";
import { DashboardPoller, initialFeedState, type FeedState } from "./poller";
import { performSignOut } from "./signOut";
import { TerminalView } from "./TerminalView";
import type { AlertRow, DashboardData, OrderRow, RiskRow } from "./types";

// ---------------------------------------------------------------- fixtures

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
      clock: { timestamp: null, is_open: false, next_open: null, next_close: null },
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

const render = (state: FeedState) =>
  renderToStaticMarkup(<TerminalView state={state} onRefresh={() => {}} onSignOut={() => {}} />);

// ---------------------------------------------------------------- views

describe("TerminalView", () => {
  it("renders a successful snapshot from Worker values only", () => {
    const html = render(ok(dashboard()));
    expect(html).toContain("ALPHA TERMINAL");
    expect(html).toContain("PAPER");
    expect(html).toContain("DRY RUN");
    expect(html).toContain("CONNECTED");
    for (const v of ["$2,222.22", "$1,111.11", "$4,444.44", "$3,333.33", "+$222.22", "$5,555.55"]) expect(html).toContain(v);
    expect(html).toContain("CLOSED"); // market clock
    expect(html).toContain("STOPPED");
    expect(html).toContain("FALSE · DISABLED"); // ENABLE_TRADING
  });

  it("shows a truthful empty state for no positions, trades or activity", () => {
    const html = render(ok(dashboard()));
    expect(html).toContain("No open PAPER positions");
    expect(html).toContain("No trades recorded in D1");
    expect(html).toContain("No activity events recorded");
    expect(html).toContain("No alerts recorded in D1 yet");
  });

  it("marks rejected alerts distinctly", () => {
    const html = render(ok(dashboard({ recent: { ...dashboard().recent, alerts: [alert()] } })));
    expect(html).toContain('class="row-bad"');
    expect(html).toContain("REJECTED");
    expect(html).toContain("test rejection reason");
    expect(html).toContain("RISK_REJECTED");
  });

  it("shows an approved dry-run alert and its order as NOT a broker order", () => {
    const d = dashboard({
      recent: {
        ...dashboard().recent,
        alerts: [alert({ id: 2, alert_id: "test-alert-2", status: "dry_run", response_code: "DRY_RUN_ACCEPTED", http_status: 200, rejection_reason: null, accepted_qty: "1" })],
        orders: [order()],
      },
    });
    const html = render(ok(d));
    expect(html).toContain("DRY RUN OK");
    expect(html).toContain("NO BROKER ORDER SUBMITTED");
    expect(html).toContain("DRY RUN · ACCEPTED");
    expect(html).toContain("NOT SENT");
    expect(html).not.toMatch(/FILLED/);
  });

  it("keeps the last snapshot visible and marks it stale when the API is unavailable", () => {
    const state: FeedState = { ...ok(dashboard()), status: "stale", error: { status: 0, code: "OFFLINE", message: "Backend unreachable" } };
    const html = render(state);
    expect(html).toContain("STALE DATA");
    expect(html).toContain("$2,222.22");
    expect(html).toContain("term-stale");
  });

  it("shows an error with no numbers when the first load fails", () => {
    const html = render({ ...initialFeedState, status: "error", error: { status: 0, code: "OFFLINE", message: "Backend unreachable" } });
    expect(html).toContain("BACKEND UNREACHABLE");
    expect(html).toContain("OFFLINE");
    expect(html).not.toMatch(/\$\d/);
  });

  it("does not invent account values when Alpaca PAPER is not configured", () => {
    const d = dashboard({
      broker: {
        mode: "PAPER", read_only: true, account: null, positions: [], clock: null,
        errors: [
          { source: "account", code: "BROKER_NOT_CONFIGURED", message: "Alpaca PAPER keys are not configured" },
          { source: "positions", code: "BROKER_NOT_CONFIGURED", message: "Alpaca PAPER keys are not configured" },
        ],
      },
    });
    const html = render(ok(d));
    expect(html).toContain("No data");
    expect(html).toContain("BROKER_NOT_CONFIGURED");
    expect(html).toContain("PAPER positions unavailable");
    expect(html).not.toMatch(/\$\d/);
  });

  it("flags non-dry-run settings reported by the backend", () => {
    const html = render(ok(dashboard({ enable_trading: true })));
    expect(html).toContain("non-dry-run setting");
  });

  it("renders the sign-in screen for an expired session", () => {
    const html = renderToStaticMarkup(<LoginScreen expired onSignedIn={() => {}} />);
    expect(html).toContain("Session expired");
    expect(html).toContain('type="password"');
  });
});

// ---------------------------------------------------------------- classification

describe("classify", () => {
  it("distinguishes dry-run, rejected, error and duplicate alerts", () => {
    expect(alertLabel({ status: "dry_run" }).tone).toBe("ok");
    expect(alertLabel({ status: "rejected" }).tone).toBe("bad");
    expect(alertLabel({ status: "error" }).tone).toBe("err");
    expect(duplicateLabel({ duplicate_count: 3 })?.text).toBe("DUP ×3");
    expect(duplicateLabel({ duplicate_count: 0 })).toBeNull();
    expect(alertRowClass({ status: "dry_run", duplicate_count: 2 })).toBe("row-ok row-has-dup");
  });

  it("labels every order status as DRY RUN", () => {
    for (const status of ["dry_run_accepted", "dry_run_failed", "unknown", "dry_run_reconciled", "submitting"]) {
      expect(orderLabel({ status }).text.startsWith("DRY RUN")).toBe(true);
    }
  });

  it("ignores malformed risk checks", () => {
    expect(riskChecks(risk({ checks: "bad" }))).toEqual([]);
    expect(riskChecks(risk()).length).toBe(2);
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
    if (!r.ok) {
      expect(r.message).toContain("could not be reached");
      expect(r.message).toContain("may still be active");
    }
  });

  it("does not claim the session ended on a server error", async () => {
    const r = await performSignOut(async () => {
      throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Request origin not allowed");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("ORIGIN_NOT_ALLOWED");
  });

  it("treats 401 as already signed out on the server", async () => {
    const r = await performSignOut(async () => {
      throw new ApiError(401, "UNAUTHORIZED", "Not signed in");
    });
    expect(r.ok).toBe(true);
  });

  it("keeps the dashboard and shows a retry when sign-out failed", () => {
    const html = renderToStaticMarkup(
      <TerminalView
        state={ok(dashboard())}
        signOut={{ busy: false, error: "Sign-out failed because the backend could not be reached. Your server session may still be active, so you are still signed in here." }}
        onRefresh={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(html).toContain("SIGN-OUT FAILED");
    expect(html).toContain("may still be active");
    expect(html).toContain("Retry sign out");
    expect(html).toContain("$2,222.22"); // still showing the signed-in dashboard
  });

  it("disables the sign-out button while signing out", () => {
    const html = renderToStaticMarkup(
      <TerminalView state={ok(dashboard())} signOut={{ busy: true, error: null }} onRefresh={() => {}} onSignOut={() => {}} />,
    );
    expect(html).toContain("Signing out…");
  });
});

// ---------------------------------------------------------------- API client

describe("api client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("turns a hung request into a TIMEOUT error instead of waiting forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const { api, REQUEST_TIMEOUT_MS } = await import("../api/client");
    const p = api.get("/api/dashboard").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const err = (await p) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("TIMEOUT");
    expect(err.status).toBe(0);
  });

  it("reports 401 as an ApiError with status 401", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, code: "UNAUTHORIZED", message: "authentication required" }), { status: 401 }));
    const { api } = await import("../api/client");
    const err = (await api.get("/api/dashboard").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
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
    const s = p.getState();
    expect(s.status).toBe("stale");
    expect(s.data?.broker.account?.equity).toBe(2222.22);
    expect(s.error?.code).toBe("OFFLINE");
  });

  it("stops polling and reports unauthorized on 401", async () => {
    vi.useFakeTimers();
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn<() => Promise<DashboardData>>().mockRejectedValue(new ApiError(401, "UNAUTHORIZED", "authentication required"));
    const p = new DashboardPoller(fetcher, { intervalMs: 1000, onUnauthorized });
    p.start();
    await vi.runOnlyPendingTimersAsync();
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
    expect(fetcher).toHaveBeenCalledTimes(4); // t=0, 1000, 2000, 3000
    p.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
