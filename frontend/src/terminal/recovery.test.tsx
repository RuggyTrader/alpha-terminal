// Recovery 2026-11-14: the strategy engine's status from its own telemetry (never the Alpaca route), durable PAPER
// orders in the Trades stages, and actual-PAPER-only primary views. TEST fixtures only.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { engineStatus, fleetEngineStatus, type Bot } from "./bots";
import { allBotRecords } from "./components/AllBotTrades";
import type { DurableOrder } from "./botOrders";
import { BotCard } from "./pages/Bots";
import { riskRewardBands } from "./pages/BotChart";

const NOW = Date.parse("2026-11-14T22:00:00Z");
const PAPER0 = { trades: 0, long_trades: 0, short_trades: 0, wins: 0, losses: 0, break_even: 0, gross_usd: 0, fees_usd: 0, net_usd: 0, win_rate: null, profit_factor: null, expectancy_usd: null, max_drawdown_usd: 0 };
const bot = (o: Partial<Bot> = {}): Bot => ({
  bot_id: "ALPHA-01", name: "ALPHA 01", group: "SOLANA", symbol: "SOLUSD", timeframe: "1m", profile: "solusd-1m", inputs_hash: "0932a1a0cfac03f9",
  status: "ACTIVE", ledger_api: "bot", entries_paused: false, wallet: "ALPHA-01", risk_usd: 10, risk_setting: null,
  balances: { available_usd: 50, reserved_usd: 0, shortfall_usd: 0 },
  funding: { allocated_usd: 50, transferred_in_usd: 0, withdrawn_usd: 0, profit_swept_to_main_usd: 0 },
  open_positions: [], paper: { ...PAPER0 }, mirror: [{ account_id: "m", trades: 9, gross: 20, net_modelled: -5, last_candle_time: null, hypothetical: true }],
  engine: { last_candle_time: "2026-11-14T21:58:00Z", received_at: "2026-11-14T21:59:40Z", ledger_check: { status: "OK" } },
  ...o,
});

describe("strategy engine status: seven owner states from the bot's own telemetry", () => {
  it("Online — scanning / Pending order / Position open / Paused", () => {
    expect(engineStatus(bot(), NOW).label).toBe("Online — scanning");
    expect(engineStatus(bot({ engine: { ...bot().engine, strategy_state: { direction: "SHORT", leg_start: 1, leg_end: 2, setup_bars: 3, max_age_bars: 120, pending_order: { side: "SHORT", qty: 1, limit: 80, stop: 81, tp: 78 }, current_stop: null, break_even_done: false, trailing: false } } }), NOW).label).toBe("Pending order");
    expect(engineStatus(bot({ open_positions: [{ trade_id: "t", symbol: "SOLUSD", side: "SHORT", qty: 1, entry_price: 80, stop: 81, tp: 78, collateral_usd: 80, opened_at: "2026-11-14T21:00:00Z", mark_price: null, mark_at: null }] }), NOW).label).toBe("Position open");
    expect(engineStatus(bot({ entries_paused: true }), NOW).label).toBe("Paused");
  });
  it("Market data stale / Backend disconnected / Engine offline", () => {
    expect(engineStatus(bot({ engine: { last_candle_time: "2026-11-14T21:40:00Z", received_at: "2026-11-14T21:59:40Z" } }), NOW).label).toBe("Market data stale");
    expect(engineStatus(bot({ engine: { ...bot().engine, ledger_check: { status: "UNVERIFIED", issues: ["ledger query failed: HTTP 503"] } } }), NOW).label).toBe("Backend disconnected");
    expect(engineStatus(bot({ engine: { last_candle_time: "2026-11-13T03:30:00Z", received_at: "2026-11-13T03:35:00Z" } }), NOW).label).toBe("Engine offline");
    expect(engineStatus(bot({ engine: null }), NOW).label).toBe("Engine offline");
    expect(engineStatus(bot({ status: "PROPOSED" }), NOW).label).toBe("Not active");
  });
  it("the website being reachable never makes the engine ONLINE; the fleet headline is the most serious active bot", () => {
    const off = bot({ bot_id: "ALPHA-02", engine: null });
    const f = fleetEngineStatus([bot(), off, bot({ bot_id: "ALPHA-03", status: "PROPOSED" })], NOW);
    expect(f.worst?.label).toBe("Engine offline");
    expect(f.byBot.map((x) => x.bot.bot_id)).toEqual(["ALPHA-01", "ALPHA-02"]);
  });
});

describe("bot cards are compact and actual-PAPER only", () => {
  it("status, last scan, allocated, net P&L and a prominent View chart; technical detail folded; no Mirror figures", () => {
    const html = renderToStaticMarkup(<MemoryRouter><BotCard b={bot()} nowMs={NOW} /></MemoryRouter>);
    expect(html).toContain("Online — scanning");
    expect(html).toContain("Last scan");
    expect(html).toContain("Net PAPER P&amp;L");
    expect(html).toContain("View chart");
    expect(html).toContain("<details");
    expect(html).not.toContain("Strategy Mirror");
    expect(html).not.toContain("-$5.00");
  });
});

describe("Trades stages use the ledger's durable PAPER orders", () => {
  const order = (o: Partial<DurableOrder>): DurableOrder => ({
    order_id: "ENG-ALPHA-01-X-PLACE_SHORT", bot_id: "ALPHA-01", symbol: "SOLUSD", timeframe_min: 1, side: "SHORT", limit: 80, stop: 80.2, tp: 79.6,
    requested_qty: 1, accepted_qty: 0.5, risk_usd: 10, actual_risk_usd: 0.1, collateral_usd: 40, fee_estimate_usd: 0.08,
    placed_at: "2026-11-14T21:50:00Z", expires_at: "2026-11-14T23:50:00Z", status: "PENDING", code: "ORDER_PENDING", message: null, fill_trade_id: null,
    received_at: "2026-11-14T21:50:01Z", updated_at: "2026-11-14T21:50:01Z", ...o,
  });
  const fleet = { available: true, groups: [], bots: [bot()] };
  it("Pending comes from the durable record (accepted vs requested, risk, expiry); cancelled/expired/rejected are listed with their reason", () => {
    const r = allBotRecords(fleet, null, { market: null, timeframe: null, side: null }, [
      order({}),
      order({ order_id: "A", status: "EXPIRED", code: "ORDER_EXPIRED", message: "the setup expired (strategy maxAge)" }),
      order({ order_id: "B", status: "REJECTED", code: "INSUFFICIENT_BOT_CAPITAL", message: "even the venue minimum needs more", side: "LONG" }),
      order({ order_id: "C", status: "REPLACED", code: "ORDER_REPLACED" }),
      order({ order_id: "D", status: "FILLED", code: "FILLED", fill_trade_id: "T" }),
    ]);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].qty).toBe(0.5);
    expect(r.pending[0].durable?.requested_qty).toBe(1);
    expect(r.rejected.map((x) => x.kind)).toEqual(["EXPIRED", "REJECTED"]);
    expect(r.rejected[1].text).toContain("Not enough capital");
    const shortsOnly = allBotRecords(fleet, null, { market: null, timeframe: null, side: "LONG" }, [order({})]);
    expect(shortsOnly.pending).toHaveLength(0);
  });
  it("without the ledger record (schema 6) the engine report is used, labelled", () => {
    const b = bot({ engine: { ...bot().engine, strategy_state: { direction: "LONG", leg_start: 1, leg_end: 2, setup_bars: 1, max_age_bars: 120, pending_order: { side: "LONG", qty: 1, limit: 80, stop: 79, tp: 82 }, current_stop: null, break_even_done: false, trailing: false } } });
    const r = allBotRecords({ available: true, groups: [], bots: [b] }, null, { market: null, timeframe: null, side: null }, null);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].durable).toBeUndefined();
  });
});

describe("chart risk / reward shading is direction-specific and only from recorded levels", () => {
  it("LONG: reward above the entry, risk below", () => {
    expect(riskRewardBands("LONG", 80, 79, 82)).toEqual({ reward: { base: 80, value: 82, fill: "above" }, risk: { base: 80, value: 79, fill: "below" } });
  });
  it("SHORT: reward BELOW the entry, risk ABOVE", () => {
    expect(riskRewardBands("SHORT", 80, 81, 78)).toEqual({ reward: { base: 80, value: 78, fill: "below" }, risk: { base: 80, value: 81, fill: "above" } });
  });
  it("nothing is drawn when a level is missing or on the wrong side", () => {
    expect(riskRewardBands("SHORT", 80, 79, 78)).toBeNull();
    expect(riskRewardBands("LONG", 80, null, 82)).toBeNull();
  });
});
