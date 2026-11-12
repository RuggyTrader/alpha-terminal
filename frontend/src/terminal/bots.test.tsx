import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { botPhase, botState, groupTotals, pipelineLine, type Bot } from "./bots";
import { BotCard } from "./pages/Bots";
import { botLevels, chartFigures } from "./pages/BotChart";
import { answer, findBot, UNKNOWN } from "./assistant";
import { BotView, FundedView, MirrorView } from "./components/PerformanceSelector";
import type { VerifiedState } from "./useVerified";

const NOW = Date.parse("2026-11-12T06:00:00Z");
const PAPER0 = { trades: 0, long_trades: 0, short_trades: 0, wins: 0, losses: 0, break_even: 0, gross_usd: 0, fees_usd: 0, net_usd: 0, win_rate: null, profit_factor: null, expectancy_usd: null, max_drawdown_usd: 0 };
const bot = (o: Partial<Bot> = {}): Bot => ({
  bot_id: "ALPHA-02", name: "ALPHA 02", group: "SOLANA", symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", inputs_hash: "c826d785d58a4a39",
  status: "ACTIVE", ledger_api: "legacy", entries_paused: false, wallet: "ALPHA-02", risk_usd: 10, risk_setting: null,
  balances: { available_usd: 50, reserved_usd: 0, shortfall_usd: 0 },
  funding: { allocated_usd: 50, transferred_in_usd: 0, withdrawn_usd: 0, profit_swept_to_main_usd: 0 },
  open_positions: [], paper: { ...PAPER0 }, mirror: [],
  engine: { status_text: "Waiting for a swing", last_candle_time: "2026-11-12T05:50:00Z", last_candle_close: 150, received_at: "2026-11-12T05:59:30Z", ledger_check: { status: "OK" } },
  ...o,
});
const html = (b: Bot) => renderToStaticMarkup(<MemoryRouter><BotCard b={b} nowMs={NOW} /></MemoryRouter>);
const r = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
const fleet = (bots: Bot[]) => ({ available: true, generated_at: "2026-11-12T06:00:00Z", main: { available_usd: 900, profit_received_usd: 1.5 }, groups: [], bots });

describe("bot state comes from the bot's own telemetry only", () => {
  it("ONLINE / STALE / OFFLINE by the age of its own report, against its own timeframe", () => {
    expect(botState(bot(), NOW)).toBe("ONLINE");
    expect(botState(bot({ engine: { received_at: "2026-11-12T05:45:00Z" } }), NOW)).toBe("STALE");
    expect(botState(bot({ engine: { received_at: "2026-11-12T05:00:00Z" } }), NOW)).toBe("OFFLINE");
    expect(botState(bot({ timeframe: "1m", engine: { received_at: "2026-11-12T05:55:00Z" } }), NOW)).toBe("STALE");
    expect(botState(bot({ engine: null }), NOW)).toBe("NO_REPORT");
    expect(botState(bot({ entries_paused: true }), NOW)).toBe("PAUSED");
  });
  it("a PROPOSED bot is never shown as active, and no activity is invented for it", () => {
    const p = bot({ bot_id: "ALPHA-01", name: "ALPHA 01", timeframe: "1m", status: "PROPOSED", engine: null });
    expect(botState(p, NOW)).toBe("PROPOSED");
    expect(pipelineLine(p, NOW)).toBe("ALPHA 01 · SOLUSD 1m · Proposed, not running");
    const out = html(p);
    expect(out).toContain("not approved and not running");
    expect(out).not.toContain("Waiting for a swing");
  });
  it("pipeline phase comes from structured state: position, pending order, scanning", () => {
    expect(pipelineLine(bot(), NOW)).toBe("ALPHA 02 · SOLUSD 5m · Scanning");
    const pend = bot({ engine: { ...bot().engine, strategy_state: { direction: "SHORT", leg_start: 160, leg_end: 150, setup_bars: 3, max_age_bars: 50, pending_order: { side: "SHORT", qty: 0.5, limit: 157, stop: 160, tp: 149 }, current_stop: null, break_even_done: false, trailing: false } } });
    expect(botPhase(pend, NOW).phase).toBe("Limit order pending");
    expect(botPhase(pend, NOW).detail).toContain("SHORT 157");
    const pos = bot({ open_positions: [{ trade_id: "T1", symbol: "SOLUSD", side: "SHORT", qty: 0.5, entry_price: 157, stop: 160, tp: 149, collateral_usd: 78.5, opened_at: "2026-11-12T05:40:00Z", mark_price: 156, mark_at: null }] });
    expect(pipelineLine(pos, NOW)).toBe("ALPHA 02 · SOLUSD 5m · Managing SHORT");
  });
  it("group totals add funded PAPER figures only, never the mirror", () => {
    const a = bot({ paper: { ...PAPER0, trades: 2, gross_usd: 3, fees_usd: 1, net_usd: 2 }, mirror: [{ account_id: "m", trades: 40, gross: 300, net_modelled: -100, last_candle_time: null, hypothetical: true }] });
    const b = bot({ bot_id: "ALPHA-01", paper: { ...PAPER0, trades: 1, gross_usd: -1, fees_usd: 0.5, net_usd: -1.5 } });
    const t = groupTotals([a, b]);
    expect(t.net_usd).toBeCloseTo(0.5);
    expect(t.trades).toBe(3);
    expect(t.available_usd).toBe(100);
  });
  it("a shortfall is shown and never hidden", () => {
    expect(html(bot({ balances: { available_usd: 0, reserved_usd: 0, shortfall_usd: 2.5 } }))).toContain("Recorded shortfall $2.50");
  });
});

describe("chart helpers use recorded levels only", () => {
  it("no position and no pending order means no levels to draw", () => {
    expect(botLevels(bot())).toBeNull();
  });
  it("a short position's figures come from its real qty, entry, stop and mark", () => {
    const b = bot({ open_positions: [{ trade_id: "T1", symbol: "SOLUSD", side: "SHORT", qty: 2, entry_price: 100, stop: 102, tp: 96, collateral_usd: 200, entry_fee_usd: 0.4, opened_at: "", mark_price: 99, mark_at: null }] });
    const lv = botLevels(b)!;
    const f = chartFigures(lv, 99);
    expect(f.stopRisk).toBeCloseTo(4);
    expect(f.rr).toBeCloseTo(2);
    expect(f.gross).toBeCloseTo(2);
    expect(f.estNet).toBeCloseTo(2 - 0.4 - 99 * 2 * 0.002);
    expect(f.atTarget).toBeCloseTo(8);
    expect(chartFigures(lv, null).gross).toBeNull();
  });
});

describe("ALPHA Assistant is deterministic and read-only", () => {
  const bots = [bot(), bot({ bot_id: "ALPHA-04", name: "ALPHA 04", group: "BITCOIN", symbol: "BTCUSD", status: "PROPOSED", engine: null })];
  it("finds bots by id, by market and timeframe, or by context", () => {
    expect(findBot("what is alpha 02 doing", bots)?.bot_id).toBe("ALPHA-02");
    expect(findBot("bitcoin 5 minute status", bots)?.bot_id).toBe("ALPHA-04");
    expect(findBot("fees?", bots, "ALPHA-02")?.bot_id).toBe("ALPHA-02");
    expect(findBot("fees?", bots)).toBeNull();
  });
  it("refuses actions", () => {
    expect(answer("close the SOL 5m position", fleet(bots), NOW).text).toContain("read-only");
  });
  it("answers from records, with evidence, and says when it does not know", () => {
    expect(answer("What is my MAIN balance?", fleet(bots), NOW).text).toContain("$900.00");
    expect(answer("Which bot is making the most money?", fleet(bots), NOW).text).toContain("No bot has closed");
    expect(answer("What is BTC 5m doing?", fleet(bots), NOW).text).toContain("not approved or running");
    expect(answer("anything", null, NOW).text).toBe(UNKNOWN);
    const fees = answer("How much did SOL 5m pay in fees?", fleet(bots), NOW);
    expect(fees.known).toBe(true);
    expect(fees.evidence.length).toBeGreaterThan(0);
  });
});

describe("Home performance selector keeps datasets apart", () => {
  it("funded view with no closed trade shows 0 and says mirror trades are not counted", () => {
    const v = { status: "ok", data: { trades: [] }, error: null } as unknown as VerifiedState;
    const out = r(<FundedView verified={v} now={NOW} />);
    expect(out).toContain("No funded PAPER trade has closed yet");
    expect(out).toContain("<b>0</b>");
  });
  it("mirror view is labelled hypothetical", () => {
    expect(r(<MirrorView overview={{ label: "", disclosure: "", note: "", markets: [] }} />)).toContain("Hypothetical");
  });
  it("bot view shows that bot's funded figures and its mirror separately", () => {
    const b = bot({ paper: { ...PAPER0, trades: 3, long_trades: 1, short_trades: 2, gross_usd: 4, fees_usd: 1, net_usd: 3 }, mirror: [{ account_id: "m", trades: 9, gross: 20, net_modelled: -5, last_candle_time: null, hypothetical: true }] });
    const out = r(<BotView fleet={fleet([b])} botId="ALPHA-02" />);
    expect(out).toContain("3 (1 L / 2 S)");
    expect(out).toContain("Mirror (hypothetical)");
  });
});
