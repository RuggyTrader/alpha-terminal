import { describe, expect, it } from "vitest";
import type { ActivityEvent, AlertBrief, TradeRow } from "../types/api";
import {
  alertStage, alertsToday, newMilestones, reachedMilestones, strategyStats, toastForEvent, tradeTone,
} from "./derive";
import { compactMoney, pct, signedMoney, tone } from "./format";

const trade = (o: Partial<TradeRow>): TradeRow => ({
  id: 1, symbol: "SPY", market: "STOCKS", strategy: "OTE", direction: "LONG", side: "BUY", status: "CLOSED", qty: "1",
  open_qty: "0", order_type: "MARKET", entry_price: "100", exit_price: "110", exit_qty: "1", realized_pnl: "10.00",
  return_pct: "10", opened_at: "2026-10-29T14:00:00Z", closed_at: "2026-10-29T15:00:00Z", alert_id: "a", alpaca_order_id: "o",
  close_order_id: "c", order_status: "filled", badge: "VERIFIED PAPER", leg_count: 2, ...o,
});

const event = (o: Partial<ActivityEvent>): ActivityEvent => ({
  id: 1, ts: "2026-10-29T14:00:00Z", category: "BROKER", level: "info", message: "", alert_id: null, symbol: null, action: null,
  strategy: null, qty: null, validation_result: null, risk_result: null, rejection_reason: null, alpaca_order_id: null,
  alpaca_status: null, error_detail: null, ...o,
});

describe("strategyStats", () => {
  it("counts only closed trades and keeps first-seen colour order", () => {
    const s = strategyStats([
      trade({ id: 1, strategy: "OTE", realized_pnl: "10" }),
      trade({ id: 2, strategy: "OTE", realized_pnl: "-4" }),
      trade({ id: 3, strategy: "scalp", status: "OPEN", realized_pnl: "0", opened_at: "2026-10-29T16:00:00Z" }),
    ]);
    expect(s.map((x) => x.name)).toEqual(["OTE", "SCALP"]);
    expect(s[0]).toMatchObject({ closed: 2, wins: 1, realized: 6 });
    expect(s[1]).toMatchObject({ closed: 0, wins: 0, realized: 0 });
  });
  it("returns nothing for no trades (no invented strategies)", () => {
    expect(strategyStats([])).toEqual([]);
  });
});

describe("tradeTone", () => {
  it("classifies win / loss / flat / open", () => {
    expect(tradeTone(trade({ realized_pnl: "1" }))).toBe("win");
    expect(tradeTone(trade({ realized_pnl: "-1" }))).toBe("loss");
    expect(tradeTone(trade({ realized_pnl: "0" }))).toBe("flat");
    expect(tradeTone(trade({ status: "OPEN" }))).toBe("open");
  });
});

describe("toasts come only from important real events", () => {
  it("maps fills, risk blocks and engine changes", () => {
    expect(toastForEvent(event({ level: "success", message: "PAPER order filled @ 100", symbol: "SPY" }))?.title).toBe("PAPER order filled");
    expect(toastForEvent(event({ category: "RISK", level: "error", message: "BUY rejected" }))?.tone).toBe("error");
    expect(toastForEvent(event({ category: "ENGINE", level: "success", message: "Engine RUNNING" }))?.title).toBe("ENGINE RUNNING");
  });
  it("ignores routine events", () => {
    expect(toastForEvent(event({ category: "WEBHOOK", level: "decision", message: "TradingView alert received" }))).toBeNull();
    expect(toastForEvent(event({ category: "AUTH", level: "success", message: "Alert authenticated" }))).toBeNull();
  });
});

describe("milestones", () => {
  it("are derived from real closed trades", () => {
    expect(reachedMilestones([], 0)).toEqual([]);
    const keys = reachedMilestones([trade({ realized_pnl: "5" })], 10).map((m) => m.key);
    expect(keys).toEqual(["first-profitable", "closed-10"]);
    expect(reachedMilestones([trade({ realized_pnl: "-5" })], 1)).toEqual([]);
  });
  it("first visit records history silently; later only new ones celebrate", () => {
    const now = reachedMilestones([trade({ realized_pnl: "5" })], 10);
    expect(newMilestones(now, null)).toEqual([]);
    expect(newMilestones(now, ["first-profitable"]).map((m) => m.key)).toEqual(["closed-10"]);
  });
});

describe("alerts", () => {
  const a = (o: Partial<AlertBrief>): AlertBrief => ({
    id: 1, alert_id: "x", received_at: new Date().toISOString(), symbol: "SPY", action: "buy", strategy: "OTE", status: "rejected",
    code: null, rejection_reason: null, requested_qty: "1", accepted_qty: null, duplicate_count: 0, ...o,
  });
  it("names the deciding stage from the stored code", () => {
    expect(alertStage(a({ status: "accepted" }))).toBe("Alpaca PAPER");
    expect(alertStage(a({ code: "INVALID_SYMBOL" }))).toBe("Validation");
    expect(alertStage(a({ code: "ENGINE_STOPPED" }))).toBe("Engine");
    expect(alertStage(a({ code: "BROKER_TIMEOUT" }))).toBe("Broker");
    expect(alertStage(a({ code: "NO_POSITION" }))).toBe("Risk");
  });
  it("counts today's alerts only", () => {
    expect(alertsToday([a({}), a({ received_at: "2020-01-01T00:00:00Z" })])).toBe(1);
  });
});

describe("formatting never invents numbers", () => {
  it("renders N/A for missing values", () => {
    expect(signedMoney(null)).toBe("N/A");
    expect(pct(undefined)).toBe("N/A");
    expect(compactMoney("")).toBe("N/A");
    expect(tone(null)).toBe("na");
  });
  it("signs and rounds correctly", () => {
    expect(signedMoney("368.42")).toBe("+$368.42");
    expect(signedMoney("-6.5")).toBe("−$6.50");
    expect(signedMoney("0")).toBe("$0.00");
    expect(compactMoney("10482.7")).toBe("$10,483");
    expect(compactMoney("-38", true)).toBe("−$38.00");
    expect(pct("142.3")).toBe("+142%");
    expect(tone("-0.001")).toBe("zero");
  });
});
