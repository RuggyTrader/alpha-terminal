// Simulated execution costs on the dashboard: gross, fees, slippage and net. Fixture data exists only in this file.
// Worked example (Ndax profile: 0.20% maker and taker, 0.10% taker slippage):
//   BUY 0.1 SOL, maker limit fill at 160.00          → value 16.00,  fee 0.032
//   SELL 0.1 SOL, taker stop, reference 170.00       → executes at 169.83 (slippage 0.017), value 16.983, fee 0.033966
//   gross 1.00 · slippage 0.017 · fees 0.065966 · net 0.917034

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { TradeCard } from "./components/TradeCard";
import { costMoney } from "./fmt";
import { costTotals, CostBreakdown } from "./pages/Performance";
import { SettingsPage } from "./pages/Settings";
import { pnlFromFills, ProofView } from "./pages/TradeProof";
import { initialFeedState, type FeedState } from "./poller";
import { idleSignOut } from "./signOut";
import { DashboardContext } from "./store";
import { PAPER_FILL_DISCLOSURE } from "./disclosures";
import type { DashboardData, PaperPortfolio, ProofFill, TradeProof, TradeRow, VerifiedTrade } from "./types";

const NDAX_CAVEAT = "Ndax costs applied to Kraken SOLUSD prices: these are not verified Ndax SOL/CAD executions";

const buy: ProofFill = {
  id: 1, client_order_id: "at-b", alert_id: "ENG-BUY", risk_decision_fk: 1, kind: "OPEN", side: "buy", qty: 0.1, price: 160,
  price_source: "kraken:SOLUSD", price_at: "2026-11-05T14:20:05Z", realized_pnl: 0, position_qty_after: 0.1, avg_entry_after: 160,
  filled_at: "2026-11-05T14:20:05Z", reference_price: 160, liquidity: "MAKER", fee_micro: 32000, slippage_micro: 0, cost_profile: "ndax",
};
const sell: ProofFill = {
  id: 2, client_order_id: "at-s", alert_id: "ENG-CLOSE", risk_decision_fk: 2, kind: "CLOSE", side: "sell", qty: 0.1, price: 169.83,
  price_source: "kraken:SOLUSD", price_at: "2026-11-05T15:20:04Z", realized_pnl: 0.983, position_qty_after: 0, avg_entry_after: 160,
  filled_at: "2026-11-05T15:20:04Z", reference_price: 170, liquidity: "TAKER", fee_micro: 33966, slippage_micro: 17000, cost_profile: "ndax",
};

const tradeRow = (over: Partial<TradeRow> = {}): TradeRow => ({
  id: 7, symbol: "SOLUSD", direction: "LONG", status: "CLOSED", strategy: "OTE Pro Strat (engine)", entry_qty: "0.1", entry_avg_price: "160",
  exit_qty: "0.1", exit_avg_price: "169.83", open_qty: "0", realized_pnl: "0.917034", return_pct: "5.731463", opened_at: "2026-11-05T14:20:05Z",
  closed_at: "2026-11-05T15:20:04Z", source: "ALPHA_PAPER", gross_pnl: "1", fees_usd: "0.065966", slippage_usd: "0.017", cost_profile: "ndax", ...over,
});

describe("costMoney", () => {
  it("shows sub-cent costs instead of rounding them to $0.00", () => {
    expect(costMoney(0.032)).toBe("−$0.0320");
    expect(costMoney(-0.017)).toBe("−$0.0170");
    expect(costMoney(12.345)).toBe("−$12.35");
    expect(costMoney(0)).toBe("$0.00");
    expect(costMoney(null)).toBe("N/A");
  });
});

describe("trade proof with simulated costs", () => {
  const proof = (over: Partial<TradeProof> = {}): TradeProof => ({
    verified: true, verification: "Closed by the ALPHA PAPER ledger.", trade: tradeRow(), fills: [buy, sell],
    alerts: [], risk_decisions: [], orders: [], ...over,
  });

  it("recomputes net = sells − buys − fees and matches the recorded net P&L", () => {
    const c = pnlFromFills([buy, sell])!;
    expect(c.costed).toBe(true);
    expect(c.beforeFees).toBeCloseTo(0.983, 8);
    expect(c.fees).toBeCloseTo(0.065966, 8);
    expect(c.slippage).toBeCloseTo(0.017, 8);
    expect(c.pnl).toBeCloseTo(0.917034, 8);
    expect(c.gross).toBeCloseTo(1.0, 8);
    const html = renderToStaticMarkup(<MemoryRouter><ProofView proof={proof()} /></MemoryRouter>);
    expect(html).toContain("MATCHES");
    expect(html).toContain("Gross (before slippage and fees)");
    expect(html).toContain("Net (sold − bought − fees)");
    expect(html).toContain("Reference price");
    expect(html).toContain("Execution price");
    expect(html).toContain("TAKER");
    expect(html).toContain("−$0.0340"); // exit fee 0.033966
    expect(html).toContain("Simulated costs (ndax)");
  });

  it("discloses how PAPER fills are priced and that maker/taker is inferred, on costed and older proofs alike", () => {
    const escaped = PAPER_FILL_DISCLOSURE.replace(/'/g, "&#x27;");
    for (const p of [proof(), proof({ fills: [{ ...buy, cost_profile: null, liquidity: null, fee_micro: null }] })]) {
      const html = renderToStaticMarkup(<MemoryRouter><ProofView proof={p} /></MemoryRouter>);
      expect(html).toContain(escaped);
    }
    const html = renderToStaticMarkup(<MemoryRouter><ProofView proof={proof()} /></MemoryRouter>);
    expect(html).toContain("Liquidity (inferred)");
    expect(html).not.toMatch(/confirmed (resting|maker)/i);
  });

  it("does not match when the recorded P&L is the gross figure", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ProofView proof={proof({ trade: tradeRow({ realized_pnl: "1" }) })} /></MemoryRouter>);
    expect(html).toContain("DOES NOT MATCH");
  });

  it("treats fills from before cost accounting as gross, with no cost rows", () => {
    const old = [{ ...buy, reference_price: null, liquidity: null, fee_micro: null, slippage_micro: null, cost_profile: null },
      { ...sell, price: 170, reference_price: null, liquidity: null, fee_micro: null, slippage_micro: null, cost_profile: null }];
    const c = pnlFromFills(old)!;
    expect(c.costed).toBe(false);
    expect(c.pnl).toBeCloseTo(1.0, 8);
    const html = renderToStaticMarkup(<MemoryRouter><ProofView proof={proof({ fills: old, trade: tradeRow({ realized_pnl: "1", cost_profile: null }) })} /></MemoryRouter>);
    expect(html).toContain("MATCHES");
    expect(html).toContain("recorded before cost accounting");
    expect(html).not.toContain("Execution price");
  });
});

describe("trade card", () => {
  it("shows gross, slippage, fees and net for a costed trade", () => {
    const html = renderToStaticMarkup(<MemoryRouter><TradeCard t={tradeRow()} defaultOpen /></MemoryRouter>);
    expect(html).toContain("Gross P&amp;L");
    expect(html).toContain("+$1.00");
    expect(html).toContain("Slippage");
    expect(html).toContain("−$0.0170");
    expect(html).toContain("−$0.0660");
    expect(html).toContain("Net P&amp;L");
    expect(html).toContain("+$0.92");
  });

  it("keeps the single realized row for trades closed before cost accounting", () => {
    const html = renderToStaticMarkup(<MemoryRouter><TradeCard t={tradeRow({ cost_profile: null, gross_pnl: null, fees_usd: null, slippage_usd: null })} defaultOpen /></MemoryRouter>);
    expect(html).toContain("Net P&amp;L");
    expect(html).toContain("closed before cost accounting");
    expect(html).not.toContain("Slippage");
  });
});

describe("performance cost breakdown", () => {
  const vt = (id: number, over: Partial<VerifiedTrade>): VerifiedTrade => ({
    id, symbol: "SOLUSD", direction: "LONG", strategy: "x", realized_pnl: 0, return_pct: null, cost_basis: 16, opened_at: "2026-11-05T14:00:00Z",
    closed_at: "2026-11-05T15:00:00Z", price_sources: "kraken:SOLUSD", ...over,
  });

  it("totals gross, fees, slippage and net over costed trades and counts older gross trades separately", () => {
    const trades = [
      vt(1, { realized_pnl: 0.917034, gross_pnl: 1, fees_usd: 0.065966, slippage_usd: 0.017, cost_profile: "ndax" }),
      vt(2, { realized_pnl: -1.1, gross_pnl: -1, fees_usd: 0.07, slippage_usd: 0.03, cost_profile: "ndax" }),
      vt(3, { realized_pnl: 5 }),
    ];
    const c = costTotals(trades);
    expect(c).toMatchObject({ costed: 2, uncosted: 1, profiles: ["ndax"] });
    expect(c.gross).toBeCloseTo(0, 6);
    expect(c.fees).toBeCloseTo(0.135966, 6);
    expect(c.slippage).toBeCloseTo(0.047, 6);
    expect(c.net).toBeCloseTo(-0.182966, 6);
    const html = renderToStaticMarkup(<CostBreakdown trades={trades} />);
    expect(html).toContain("Execution costs");
    expect(html).toContain("1 older trade closed before cost accounting");
    expect(renderToStaticMarkup(<CostBreakdown trades={[vt(3, { realized_pnl: 5 })]} />)).toBe("");
  });
});

describe("settings cost profile", () => {
  const portfolio = (costs: PaperPortfolio["costs"]): PaperPortfolio => ({
    label: "ALPHA PAPER", simulated: true, active: true, wallets: [],
    totals: { book_balance_usd: 99.93, unallocated_usd: 0, available_usd: 99.93, reserved_usd: 0, realized_pnl_usd: 0.983, fees_usd: 0.065966,
      net_realized_pnl_usd: 0.917034, net_funding_usd: 99, unrealized_pnl_usd: 0 },
    consistency: { ok: true, issues: [] }, history: [], strategies: {}, validated_engines: ["SOLUSD"],
    limits: { max_order_notional_usd: 5000, max_position_exposure_usd: 10000, short_selling_enabled: false },
    costs,
  });
  const dash = (p: PaperPortfolio): DashboardData => ({
    generated_at: "2026-11-09T12:00:00Z", mode: "PAPER", execution: "DRY_RUN_ONLY", broker_submission: false, enable_trading: false,
    engine: { state: "STOPPED", kill_switch: 0, killed_at: null, reason: null, updated_at: "2026-10-31T00:00:00Z", updated_by: "admin" },
    broker: { mode: "PAPER", read_only: true, errors: [], account: null, positions: [], clock: null },
    portfolio: p,
    counts: { alerts: { total: 0, dry_run: 0, rejected: 0, processing: 0, duplicates: 0 }, risk: { total: 0, approved: 0, rejected: 0 }, orders: { total: 0, dry_run_accepted: 0, unknown: 0, failed: 0 }, trades: { total: 0, open: 0, closed: 0, realized_pnl: 0 } },
    recent: { alerts: [], risk: [], orders: [], trades: [], activity: [] },
  } as DashboardData);
  const render = (node: ReactElement, d: DashboardData) => {
    const state: FeedState = { ...initialFeedState, status: "ok", data: d, lastSuccessAt: Date.now() };
    return renderToStaticMarkup(
      <MemoryRouter>
        <DashboardContext.Provider value={{ state, refresh: () => {}, signOut: idleSignOut, doSignOut: () => {}, dismissSignOut: () => {}, reconnected: false }}>{node}</DashboardContext.Provider>
      </MemoryRouter>,
    );
  };

  it("shows the active profile, its sources and the Ndax caveat, plus fees and net realized", () => {
    const html = render(<SettingsPage />, dash(portfolio({
      profile: "ndax", name: "Ndax (0.20% flat)", maker_pct: 0.2, taker_pct: 0.2, taker_slippage_pct: 0.1, min_qty: 0, min_notional_usd: 5,
      fee_source: "Ndax fee schedule", slippage_source: "estimate", caveat: `${NDAX_CAVEAT} (different market).`,
    })));
    expect(html).toContain("Execution costs");
    expect(html).toContain("Ndax (0.20% flat)");
    expect(html).toContain("Taker slippage (estimate)");
    expect(html).toContain(NDAX_CAVEAT);
    expect(html).toContain("Simulated fees paid");
    expect(html).toContain("Net realized ledger P&amp;L");
  });

  it("shows the fill-pricing disclosure with the execution-cost settings (Worker text first, frontend copy otherwise)", () => {
    const escaped = PAPER_FILL_DISCLOSURE.replace(/'/g, "&#x27;");
    const base = { profile: "ndax", name: "Ndax (0.20% flat)", maker_pct: 0.2, taker_pct: 0.2, taker_slippage_pct: 0.1, min_qty: 0, min_notional_usd: 5,
      fee_source: "x", slippage_source: "y", caveat: null };
    expect(render(<SettingsPage />, dash(portfolio({ ...base, fill_disclosure: PAPER_FILL_DISCLOSURE })))).toContain(escaped);
    expect(render(<SettingsPage />, dash(portfolio(base)))).toContain(escaped);
    expect(render(<SettingsPage />, dash(portfolio(undefined)))).toContain(escaped);
    expect(render(<SettingsPage />, dash(portfolio(base)))).toContain("Maker fee (inferred: limit entry, take-profit)");
  });

  it("flags an invalid profile and an older Worker without cost accounting", () => {
    expect(render(<SettingsPage />, dash(portfolio({ profile: "bogus", invalid: true })))).toContain("INVALID: bogus");
    expect(render(<SettingsPage />, dash(portfolio(undefined)))).toContain("NOT AVAILABLE ON THIS WORKER");
  });
});
