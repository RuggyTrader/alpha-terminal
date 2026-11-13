// PAPER portfolio UI and the risk simulator. Fixture values exist only in this test file.

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { initialFeedState, type FeedState } from "./poller";
import { constrainedBacktest, rawBacktest, type BacktestResult, type BacktestTrade } from "./simulator";
import { idleSignOut } from "./signOut";
import { DashboardContext } from "./store";
import { TerminalRoutes } from "./Terminal";
import type { DashboardData, PaperPortfolio, PaperWallet } from "./types";

// ---------------------------------------------------------------- simulator

const T = (n: number, side: "LONG" | "SHORT", pnl: number, qty = 10, entryPrice = 100): BacktestTrade => ({
  n, side, qty, entryTime: `2026-10-2${n}T00:00:00Z`, entryPrice, exitTime: `2026-10-2${n}T01:00:00Z`, exitPrice: entryPrice, exitKind: "TP", result: null, pnl,
});
const bt = (trades: BacktestTrade[]): BacktestResult => ({
  strategy: "SOLUSD", profile: "test", config_hash: "0000000000000000", risk_basis_usd: 10, inputs: {},
  data: { source: "test", from: "2026-10-20T00:00:00Z", to: "2026-10-30T00:00:00Z", candles: 1, trades_from: "2026-10-20T00:00:00Z" },
  execution: [], trades,
});
const LIMITS = { maxOrderNotional: 5000, maxPositionExposure: 10000, longOnly: true };

describe("risk simulator", () => {
  // +20, −10, −10, +30 at $10 risk; a short in position 2.
  const base = bt([T(1, "LONG", 20), T(2, "SHORT", -10), T(3, "LONG", -10), T(4, "LONG", 30)]);

  it("A (raw) rescales qty and P&L exactly by risk and computes the stated metrics", () => {
    const s = rawBacktest(base, 20, 100); // ×2
    expect(s.trades).toBe(4);
    expect(s.netPnl).toBe(60);
    expect(s.avgPnl).toBe(15);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBeCloseTo(100 / 40, 10);
    expect(s.avgWin).toBe(50);
    expect(s.avgLoss).toBe(-20);
    expect(s.maxConsecutiveLosses).toBe(2);
    // equity 100 → 140 → 120 → 100 → 160: peak 140, trough 100
    expect(s.maxDrawdownUsd).toBe(40);
    expect(s.maxDrawdownPct).toBeCloseTo(40 / 140, 10);
    expect(s.list[0].qty).toBe(20);
    expect(s.maxNotional).toBe(2000);
    expect(s.curve.map((c) => c.equity)).toEqual([100, 140, 120, 100, 160]);
  });

  it("B (PAPER-constrained) rejects shorts and positions larger than the balance, and compounds nothing else", () => {
    // $10 risk: qty 10 at $100 = $1,000 position. With $1,500 the first long fits; the short is refused.
    const s = constrainedBacktest(base, 10, 1500, LIMITS);
    expect(s.rejectedBy).toEqual({ SHORT_NOT_SUPPORTED: 1 });
    expect(s.trades).toBe(3);
    expect(s.netPnl).toBe(40);
    // With $20 every long is too big for the balance (no leverage).
    const small = constrainedBacktest(base, 10, 20, LIMITS);
    expect(small.trades).toBe(0);
    expect(small.rejectedBy).toEqual({ SHORT_NOT_SUPPORTED: 1, INSUFFICIENT_PAPER_CAPITAL: 3 });
    expect(small.endEquity).toBe(20);
    expect(small.netPnl).toBe(0);
  });

  it("B reports average P&L and drawdown from the accepted trades' own equity record, skipping rejected ones", () => {
    // $1,000 positions from $1,500: +20, (short refused), −30, (too big: 30 × $100 refused), −10, +50
    const s = constrainedBacktest(bt([T(1, "LONG", 20), T(2, "SHORT", -99), T(3, "LONG", -30), T(4, "LONG", 999, 30), T(5, "LONG", -10), T(6, "LONG", 50)]), 10, 1500, LIMITS);
    expect(s.trades).toBe(4);
    expect(s.rejectedBy).toEqual({ SHORT_NOT_SUPPORTED: 1, INSUFFICIENT_PAPER_CAPITAL: 1 });
    expect(s.netPnl).toBe(30);
    expect(s.avgPnl).toBe(7.5);
    // equity 1500 → 1520 → 1490 → 1480 → 1530: peak 1520, trough 1480
    expect(s.curve.map((c) => c.equity)).toEqual([1500, 1520, 1490, 1480, 1530]);
    expect(s.maxDrawdownUsd).toBe(40);
    expect(s.maxDrawdownPct).toBeCloseTo(40 / 1520, 12);
    expect(s.maxConsecutiveLosses).toBe(2);
  });

  it("B applies the Worker's order limit", () => {
    const s = constrainedBacktest(bt([T(1, "LONG", 5, 60)]), 10, 100000, LIMITS); // 60 × $100 = $6,000
    expect(s.rejectedBy).toEqual({ MAX_ORDER_NOTIONAL: 1 });
  });

  it("profit factor is reported as missing (not infinite) without a losing trade", () => {
    expect(rawBacktest(bt([T(1, "LONG", 5)]), 10, 0).profitFactor).toBeNull();
  });
});

// ---------------------------------------------------------------- pages

const wallet = (w: string, over: Partial<PaperWallet> = {}): PaperWallet => ({
  wallet: w, kind: w === "MAIN" ? "MAIN" : "STRATEGY", available_usd: 0, reserved_usd: 0, realized_pnl_usd: 0, net_funding_usd: 0,
  unrealized_pnl_usd: 0, book_balance_usd: 0, equity_usd: 0, open_positions: 0, updated_at: "2026-11-07T00:00:00Z", ...over,
});
const portfolio = (over: Partial<PaperPortfolio> = {}): PaperPortfolio => ({
  label: "ALPHA PAPER", simulated: true, active: true,
  wallets: [
    wallet("MAIN", { available_usd: 77.77, book_balance_usd: 77.77, net_funding_usd: 77.77 }),
    wallet("SOLUSD", { available_usd: 3.33, reserved_usd: 21.11, realized_pnl_usd: 4.44, net_funding_usd: 20, book_balance_usd: 24.44, equity_usd: 24.94, unrealized_pnl_usd: 0.5, open_positions: 1 }),
    wallet("ETHUSD"), wallet("BTCUSD"), wallet("HYPEUSD"), wallet("KAITOUSD"),
  ],
  totals: { book_balance_usd: 102.21, unallocated_usd: 77.77, available_usd: 81.1, reserved_usd: 21.11, realized_pnl_usd: 4.44, net_funding_usd: 97.77, unrealized_pnl_usd: 0.5 },
  consistency: { ok: true, issues: [] },
  history: [{ id: 1, at: "2026-11-07T00:00:00Z", kind: "TRANSFER_IN", wallet: "SOLUSD", counterparty: "MAIN", ref: "r", note: null, available_change_usd: 20, reserved_change_usd: 0 }],
  strategies: { SOLUSD: { validated_engine: true, settings: { strategy: "SOLUSD", applied: { version: 1, risk_usd: 10, status: "APPLIED", requested_at: "2026-11-07T00:00:00Z", applied_at: "2026-11-07T00:01:00Z", note: null }, pending: null, history: [], compounding: false } } },
  validated_engines: ["SOLUSD"],
  limits: { max_order_notional_usd: 5000, max_position_exposure_usd: 10000, short_selling_enabled: false },
  ...over,
});
function data(p?: PaperPortfolio): DashboardData {
  return {
    generated_at: "2026-11-07T00:02:00Z", mode: "PAPER", execution: "DRY_RUN_ONLY", broker_submission: false, enable_trading: false,
    engine: null, broker: { mode: "PAPER", read_only: true, errors: [], account: null, positions: [], clock: null },
    counts: { alerts: { total: 0, dry_run: 0, rejected: 0, processing: 0, duplicates: 0 }, risk: { total: 0, approved: 0, rejected: 0 }, orders: { total: 0, dry_run_accepted: 0, unknown: 0, failed: 0 }, trades: { total: 0, open: 0, closed: 0, realized_pnl: 0 } },
    recent: { alerts: [], risk: [], orders: [], trades: [], activity: [] },
    ...(p ? { portfolio: p } : {}),
  } as DashboardData;
}
const ok = (d: DashboardData): FeedState => ({ ...initialFeedState, status: "ok", data: d, lastSuccessAt: Date.parse("2026-11-07T00:02:00Z") });
const page = (path: string, state: FeedState) => renderToStaticMarkup(
  <MemoryRouter initialEntries={[path]}>
    <DashboardContext.Provider value={{ state, refresh: () => {}, signOut: idleSignOut, doSignOut: () => {}, dismissSignOut: () => {}, reconnected: false }}>
      <TerminalRoutes />
    </DashboardContext.Provider>
  </MemoryRouter>,
);

describe("PAPER portfolio pages", () => {
  it("portfolio page shows the Worker's balances, allocation and history, labelled as simulated", () => {
    const html = page("/portfolio", ok(data(portfolio())));
    for (const v of ["$102.21", "$77.77", "$21.11", "+$4.44", "$24.44", "$3.33 available", "Transfer in"]) expect(html).toContain(v);
    expect(html).toContain("No real funds, broker or exchange");
    expect(html).toContain("Allocation: Unallocated $77.77, SOL $24.44");
    expect(html).toContain("Passphrase");
  });

  it("home shows the summary card, and an unfunded portfolio shows no invented numbers", () => {
    const home = page("/", ok(data(portfolio())));
    expect(home).toContain("Capital"); // the Home capital overview (WalletOverview) replaced the summary card
    expect(home).toContain("MAIN available");
    const empty = portfolio({ active: false, totals: { book_balance_usd: 0, unallocated_usd: 0, available_usd: 0, reserved_usd: 0, realized_pnl_usd: 0, net_funding_usd: 0, unrealized_pnl_usd: 0 } });
    expect(page("/", ok(data(empty)))).toContain("Not funded yet");
  });

  it("a failed consistency check is shown, not hidden", () => {
    const html = page("/portfolio", ok(data(portfolio({ consistency: { ok: false, issues: ["SOLUSD: reserved differs from its open positions"] } }))));
    expect(html).toContain("Ledger check failed");
    expect(html).toContain("reserved differs");
  });

  it("strategy page separates balance figures and shows the applied risk; no backtest is invented while loading", () => {
    const html = page("/portfolio/SOLUSD", ok(data(portfolio())));
    for (const v of ["$3.33", "$21.11", "+$4.44", "+$0.50", "$20.00", "$24.94"]) expect(html).toContain(v);
    expect(html).toContain("Applied (engine confirmed)");
    expect(html).toContain("$10.00 · v1");
    expect(html).toContain("Fixed USD at the stop");
    expect(html).not.toContain("A · Raw");
  });

  it("a PAPER-constrained result with no accepted trade shows N/A, not a profit factor", () => {
    // $20 on SOL: every historical entry is too large or a short, so B has no trades.
    const result = bt([T(1, "LONG", 20), T(2, "SHORT", -10)]);
    const s = constrainedBacktest(result, 10, 20, LIMITS);
    expect(s.trades).toBe(0);
    expect(s.profitFactor).toBeNull();
    expect(s.avgPnl).toBeNull();
  });

  it("an asset without a validated engine is a wallet only", () => {
    const html = page("/portfolio/ETHUSD", ok(data(portfolio())));
    expect(html).toContain("No validated strategy for this asset yet");
  });

  it("an older Worker without a portfolio shows unavailable, not zeros", () => {
    expect(page("/portfolio", ok(data()))).toContain("Portfolio unavailable");
  });
});
