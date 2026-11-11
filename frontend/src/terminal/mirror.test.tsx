// Strategy Mirror pages. Fixture data exists only in this file and is labelled as test input.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { defaultMarket, type MirrorMarket, type MirrorMetrics, type MirrorOverview, type MirrorProof, type MirrorSummary, type MirrorTrade } from "./mirror";
import { MarketOverview, MirrorLinkCard, MirrorProofView, MirrorView } from "./pages/Mirror";

const html = (n: ReactElement) => renderToStaticMarkup(<MemoryRouter>{n}</MemoryRouter>);

function metrics(over: Partial<MirrorMetrics> = {}, risk: Partial<MirrorMetrics["risk"]> = {}): MirrorMetrics {
  return {
    trades: 0, longs: 0, shorts: 0, wins: 0, losses: 0, flat: 0, win_rate_pct: null, gross_pnl: 0, gross_profit: 0, gross_loss: 0,
    profit_factor: null, max_drawdown: 0, est_fees: 0, est_slippage: 0, net_modelled_pnl: 0,
    long: { trades: 0, wins: 0, gross: 0, est_costs: 0, net_modelled: 0 }, short: { trades: 0, wins: 0, gross: 0, est_costs: 0, net_modelled: 0 },
    exits: {}, first_trade_at: null, last_exit_at: null,
    risk: { reporting_equity_usd: 10000, end_equity: 10000, min_equity: 10000, negative_equity: false, first_negative_at: null, max_notional_usd: 0,
      median_notional_usd: null, fixed_risk_usd: null, max_implied_leverage: null, margin_required_usd: {}, liquidation_risk_trades: {}, liquidation_model: "model text", ...risk },
    curve: [], ...over,
  };
}

const HIST = metrics({
  trades: 579, longs: 308, shorts: 271, wins: 217, losses: 268, flat: 94, win_rate_pct: 37.48, gross_pnl: 150.24, gross_profit: 2130.71, gross_loss: 1980.47,
  profit_factor: 1.076, max_drawdown: 225.97, est_fees: 8176.15, est_slippage: 1568.22, net_modelled_pnl: -9594.13,
  long: { trades: 308, wins: 124, gross: 230.97, est_costs: 5046, net_modelled: -4815 }, short: { trades: 271, wins: 93, gross: -80.73, est_costs: 4698, net_modelled: -4779 },
  first_trade_at: "2026-06-12T03:00:00Z", last_exit_at: "2026-11-08T20:00:00Z",
  curve: [{ t: "2026-06-12T04:00:00Z", equity: 10005, net_equity: 9990 }, { t: "2026-07-25T00:25:00Z", equity: 9846.2, net_equity: 7000 }, { t: "2026-11-08T20:00:00Z", equity: 10150.24, net_equity: 405.87 }],
}, { min_equity: 9846.2, max_notional_usd: 15061, median_notional_usd: 3077, fixed_risk_usd: 10, max_implied_leverage: 1.53,
  margin_required_usd: { "1x": 15061, "5x": 3012.2, "10x": 1506.1 }, liquidation_risk_trades: { "5x": 0, "10x": 0 } });

function summary(over: Partial<MirrorSummary> = {}): MirrorSummary {
  return {
    label: "Hypothetical — unlimited buying power, not executable performance",
    disclosure: "Strategy Mirror trades are the original strategy's own simulated fills ... margin-0 ...",
    accounts: [],
    account: { account_id: "MIRROR-SOLUSD-5m-c826d785d58a4a39", symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", strategy: "OTE Pro Strat (engine)",
      inputs_hash: "c826d785d58a4a39", engine_version: "0.1.0", engine_release: null, engine_commit: null, activated_at: "2026-11-10T12:00:00Z",
      first_seen_at: "2026-11-10T12:00:00Z", last_seen_at: "2026-11-10T12:05:00Z", last_candle_time: "2026-11-10T12:00:00Z", last_candle_close: 86.1,
      candles_processed: 721, risk_usd: 10, reporting_equity_usd: 10000, margin: "0" },
    cost_model: { id: "ndax", name: "Ndax (0.20% flat)", maker_pct: 0.2, taker_pct: 0.2, taker_slippage_pct: 0.1, fee_source: "x", slippage_source: "y", caveat: null, note: "Comparison only." },
    health: { state: "OK", issues: [], last_contiguous_seq: 579, max_seq_seen: 579 },
    reconciliation: { ok: true, journal_entries: 579, journal_total: 150.24, trades: 579, trades_gross: 150.24, issues: [] },
    categories: { live: metrics(), catch_up: metrics(), historical: HIST },
    open_position: null, activity: [], interruptions: [],
    ...over,
  };
}

const trade = (over: Partial<MirrorTrade> = {}): MirrorTrade => ({
  trade_id: "MIR-SOLUSD-5-2026-11-07T15:00:00Z-LONG", seq: 579, side: "LONG", qty: 68.57, entry_time: "2026-11-07T15:00:00Z", entry_price: 89.69,
  exit_time: "2026-11-07T15:05:00Z", exit_price: 89.54, stop_price: 89.54, tp2_price: 90.2, exit_kind: "SL", result: "SL", exit_r: -1, gross_pnl: -10.29,
  risk_usd: 10, notional_usd: 6150.04, est_fees: 24.58, est_slippage: 6.14, net_modelled_pnl: -41.01, classification: "historical", exit_late: 0,
  provenance_complete: 1, reference_price: null, processed_at: "2026-11-07T15:10:05Z", ...over,
});

describe("Strategy Mirror page", () => {
  it("always shows the hypothetical label and that it is never added to funded results", () => {
    const h = html(<MirrorView s={summary()} category="historical" onCategory={() => {}} trades={[trade()]} />);
    expect(h).toContain("Hypothetical — unlimited buying power, not executable performance");
    expect(h).toContain("Never added to funded ALPHA PAPER balances or results.");
    expect(h).toContain("never added to funded PAPER results");
  });

  it("keeps live, catch-up and historical separate; an empty live category shows no invented trades", () => {
    const h = html(<MirrorView s={summary()} category="live" onCategory={() => {}} trades={[]} />);
    expect(h).toContain("Live · 0");
    expect(h).toContain("Catch-up · 0");
    expect(h).toContain("Historical · 579");
    expect(h).toContain("No completed live trades");
    expect(h).not.toContain("+$150.24");
  });

  it("historical replay: gross, modelled net, LONG/SHORT, win rate, profit factor, drawdown, margin figures", () => {
    const h = html(<MirrorView s={summary()} category="historical" onCategory={() => {}} trades={[trade()]} />);
    expect(h).toContain("Historical replay");
    expect(h).toContain("+$150.24");
    expect(h).toContain("−$9,594.13"); // the terminal writes a true minus sign
    expect(h).toContain("308 long · 271 short");
    expect(h).toContain("37.5%");
    expect(h).toContain("1.08");
    expect(h).toContain("$225.97");
    expect(h).toContain("Margin needed for the largest position at 10x");
    expect(h).toContain("1.5×");
    expect(h).toContain("HYPOTHETICAL");
    expect(h).toContain("/mirror/trade/MIR-SOLUSD-5-2026-11-07T15%3A00%3A00Z-LONG");
  });

  it("negative hypothetical equity is shown, not capped", () => {
    const neg = summary({ account: { ...summary().account!, reporting_equity_usd: 100 }, categories: { live: metrics(), catch_up: metrics(), historical: { ...HIST, risk: { ...HIST.risk, reporting_equity_usd: 100, min_equity: -53.75, negative_equity: true, first_negative_at: "2026-07-25T00:25:00Z" } } } });
    const h = html(<MirrorView s={neg} category="historical" onCategory={() => {}} trades={[]} />);
    expect(h).toContain("Negative hypothetical equity");
    expect(h).toContain("−$53.75");
  });

  it("health problems are listed and the state is visible", () => {
    const h = html(<MirrorView s={summary({ health: { state: "DIVERGED", issues: ["sequence gap: records 4..5 are not all stored"], last_contiguous_seq: 3, max_seq_seen: 5 } })} category="historical" onCategory={() => {}} trades={null} />);
    expect(h).toContain("DIVERGED");
    expect(h).toContain("sequence gap");
    expect(h).toContain("3 of 5");
  });

  it("observation gaps (engine down, candles processed late) are disclosed in the health card", () => {
    const h = html(<MirrorView s={summary({ health: { state: "OK", issues: [], last_contiguous_seq: 3, max_seq_seen: 3, no_trade_intervals: 2,
      observation_gaps: [{ from: "2026-11-10T03:25:00Z", to: "2026-11-10T20:15:00Z", candles: 197, processed_at: "2026-11-10T20:21:02Z" }] } })} category="live" onCategory={() => {}} trades={[]} />);
    expect(h).toContain("Observation gaps");
    expect(h).toContain("197 candles");
    expect(h).toContain("never Live");
    expect(h).toContain("2 interval(s) without any Kraken trade");
  });

  it("before the mirror reports, nothing is shown in its place", () => {
    const h = html(<MirrorView s={summary({ account: null, categories: null, health: { state: "NOT_ACTIVE", issues: ["no mirror account has reported yet"] } })} category="live" onCategory={() => {}} trades={null} />);
    expect(h).toContain("has not reported yet");
    expect(h).not.toContain("$");
  });

  it("open hypothetical position and interruptions", () => {
    const h = html(<MirrorView s={summary({
      open_position: { trade_id: "MIR-SOLUSD-5-2026-11-10T03:05:00Z-SHORT", side: "SHORT", qty: 35.61, entry_time: "2026-11-10T03:05:00Z", entry_price: 86.4, initial_stop: 86.69, current_stop: 86.69, tp2: 86, notional_usd: 3076.7, unrealized_at_last_close: 2.1, classification: "live" },
      interruptions: [{ seq: 7, classification: "live", recorded_at: "2026-11-11T00:00:00Z", side: "LONG", qty: 30, entry_time: "2026-11-10T20:00:00Z", entry_price: 87, reason: "gap of 900 candles" }],
    })} category="live" onCategory={() => {}} trades={[]} />);
    expect(h).toContain("SHORT 35.61");
    expect(h).toContain("gap of 900 candles");
  });
});

describe("Strategy Mirror trade proof and entry point", () => {
  it("shows candles, provenance, inferred maker/taker and verified checks", () => {
    const p: MirrorProof = {
      label: "Hypothetical — unlimited buying power, not executable performance", disclosure: "d",
      trade: { ...trade(), cost_profile: "ndax", engine_release: "6b70cc97c579", entry_liquidity: "maker", exit_liquidity: "taker" },
      candles: { entry: { t: "2026-11-07T15:00:00Z", o: 89.8, h: 89.9, l: 89.6, c: 89.7 }, exit: { t: "2026-11-07T15:05:00Z", o: 89.7, h: 89.75, l: 89.5, c: 89.55 } },
      journal_entry: { entry_key: "PNL:x", amount_usd: -10.29, classification: "historical", created_at: "2026-11-10T00:00:00Z" },
      account: null, checks: { gross_equals_price_move: true, journal_matches: true, net_equals_gross_minus_costs: true },
    };
    const h = html(<MirrorProofView p={p} />);
    expect(h).toContain("Source candles");
    expect(h).toContain("maker / taker");
    expect(h).toContain("6b70cc97c579");
    expect(h).toContain("not recorded (not live)");
    expect(h.match(/Verified/g)?.length).toBe(3);
  });
  it("the Engine page entry point says it is kept apart from funded PAPER", () => {
    expect(html(<MirrorLinkCard />)).toContain("kept apart from funded PAPER");
  });
});

describe("Strategy Mirror V2: market overview and selector", () => {
  const cat = (trades: number, gross: number) => ({ trades, longs: trades, shorts: 0, wins: trades ? 1 : 0, gross_pnl: gross, net_modelled_pnl: gross - 1, last_exit_at: null });
  const market = (symbol: string, over: Partial<MirrorMarket> = {}): MirrorMarket => ({
    account_id: `MIRROR-${symbol}-5m-abc`, symbol, timeframe: "5m", profile: "solusd-5m", inputs_hash: "abc", engine_release: "rel", activated_at: "2026-11-11T03:41:08Z",
    last_seen_at: "2026-11-11T04:00:00Z", last_candle_time: "2026-11-11T03:55:00Z", last_candle_close: 1,
    health: { state: "OK", issues: [], last_seen_age_seconds: 10, observation_gaps: [] }, reconciled: true, open_position: null,
    categories: { live: cat(0, 0), catch_up: cat(0, 0), historical: cat(6, 29.36) }, ...over,
  });
  const o = (markets: MirrorMarket[]): MirrorOverview => ({ label: "Hypothetical — unlimited buying power, not executable performance", disclosure: "d", note: "Each market and each category is measured on its own. Nothing is added across markets or to funded PAPER results.", markets });

  it("one card per market with each category separate, and no total across markets", () => {
    const ov = o([market("BTCUSD", { categories: { live: cat(1, -10.5), catch_up: cat(0, 0), historical: cat(3, 12) } }), market("ETHUSD", { health: { state: "STALE", issues: [], last_seen_age_seconds: 4000, observation_gaps: [{ from: "a", to: "b", candles: 40 }] } }), market("SOLUSD")]);
    const h = html(<MarketOverview o={ov} selected="MIRROR-SOLUSD-5m-abc" onSelect={() => {}} />);
    for (const s of ["BTCUSD", "ETHUSD", "SOLUSD"]) expect(h).toContain(`${s} market`);
    expect(h).toContain("−$10.50");
    expect(h).toContain("+$12.00");
    expect(h).toContain("STALE");
    expect(h).toContain("1 observation gap(s)");
    expect(h).toContain("Nothing is added across markets");
    expect(h).not.toMatch(/total/i);
    expect(h).not.toContain("+$41.36"); // 12 + 29.36: never summed
  });

  it("SOLUSD is shown first by default; a single market needs no selector; older Workers (no overview) fall back", () => {
    expect(defaultMarket(o([market("BTCUSD"), market("SOLUSD")]))).toBe("MIRROR-SOLUSD-5m-abc");
    expect(defaultMarket(o([market("ETHUSD"), market("BTCUSD")]))).toBe("MIRROR-ETHUSD-5m-abc");
    expect(defaultMarket(null)).toBeNull();
    expect(html(<MarketOverview o={o([market("SOLUSD")])} selected={null} onSelect={() => {}} />)).toBe("");
  });

  it("trade links carry the market's account", () => {
    const h = html(<MirrorView s={summary()} category="historical" onCategory={() => {}} trades={[trade()]} />);
    expect(h).toContain("?account=MIRROR-SOLUSD-5m-c826d785d58a4a39");
  });
});
