// The forward trial panel: clearly a separate research account, never mixed with the portfolio; one-time start only
// while proposed; forward results and the historical backtest are labelled apart. (TEST values.)
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrialView, type TrialReport } from "./components/TrialPanel";

const base: TrialReport = {
  available: true, label: "Forward PAPER trial — a separate research account; not part of your portfolio, its P&L or its funding",
  account: { status: "ACTIVE", activated_at: "2026-11-16T00:00:00Z", last_run_at: "2026-11-20T00:01:00Z", last_error: null },
  equity: { start_usd: 100, equity_usd: 101.5, net_usd: 1.5, cash_usd: 40, marked_at_close: 66000 },
  trades: { completed: 1, gross_usd: 1.9, fees_usd: 0.4, net_usd: 1.5, win_rate: 1, profit_factor: null, avg_net_usd: 1.5, avg_net_ci95: null, avg_hold_days: 9, longest_losing_streak: 0, evidence: "1 of 30 completed trades: not yet an initial evidence milestone" },
  open_position: null, drawdown: { max_usd: 0.8, max_pct: 0.8 }, time_in_cash_pct: 60,
  benchmarks: { buy_and_hold_btc: { net_usd: -3.2 }, research: { label: "Historical backtest", periods: [{ name: "Final test 2025-07 to 2026-11", net_usd: 4.12, trades: 19, profit_factor: 1.57 }] } },
  execution: { orders: "market orders at the open of the first Kraken candle starting after acceptance", stops: "simulated stop-market (not exchange-native)", slippage_pct: 0.05, fee_pct_per_fill: 0.2 },
};
const html = (t: TrialReport) => renderToStaticMarkup(<TrialView t={t} />);

describe("forward trial panel", () => {
  it("says it is a separate research account and shows forward results apart from the historical backtest", () => {
    const out = html(base);
    expect(out).toContain("not part of your portfolio");
    expect(out).toContain("Forward trial · BTC 50-day trend");
    expect(out).toContain("1 of 30 completed trades");
    expect(out).toContain("Historical backtest of the same rule (not forward results)");
    expect(out).toContain("buy and hold BTC since the start");
    expect(out).not.toContain("Start the trial");
  });
  it("while proposed: the frozen rules and a one-time start, no results", () => {
    const out = html({ ...base, account: { ...base.account!, status: "PROPOSED" } });
    expect(out).toContain("Start the trial"); expect(out).toContain("Settings are frozen");
    expect(out).not.toContain("Completed trades");
  });
  it("an open position shows its stop and actual risk; nothing when unavailable", () => {
    const out = html({ ...base, open_position: { opened_at: "2026-11-18T00:02:00Z", qty: 0.0005, entry: 66000, stop: 62000, initial_stop: 61000, risk_at_entry_usd: 2.5, open_risk_usd: 2 } });
    expect(out).toContain("Open LONG 0.0005 BTC"); expect(out).toContain("initial");
    expect(html({ available: false })).toBe("");
  });
});
