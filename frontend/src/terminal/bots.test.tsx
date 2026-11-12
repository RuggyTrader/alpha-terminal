import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { botState, pipelineLine, type Bot } from "./bots";
import { BotCard } from "./pages/Bots";

const NOW = Date.parse("2026-11-12T06:00:00Z");
const bot = (o: Partial<Bot> = {}): Bot => ({
  bot_id: "ALPHA-02", name: "ALPHA 02", symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", status: "ACTIVE", entries_paused: false,
  wallet: "SOLUSD", allocation_cap_usd: null, reserved_usd: 0, risk_pct: 1, max_risk_usd: 10, open_positions: [],
  paper: { trades: 0, realized_net_usd: 0, wins: 0, win_rate: null, profit_factor: null, max_drawdown_usd: 0 },
  mirror: [], engine: { status_text: "Waiting for a swing", last_candle_time: "2026-11-12T05:50:00Z", received_at: "2026-11-12T05:59:30Z", ledger_check: { status: "OK" } },
  ...o,
});
const html = (b: Bot) => renderToStaticMarkup(<MemoryRouter><BotCard b={b} nowMs={NOW} /></MemoryRouter>);

describe("bot state comes from the bot's own telemetry only", () => {
  it("ONLINE / STALE / OFFLINE by the age of its own report, against its own timeframe", () => {
    expect(botState(bot(), NOW)).toBe("ONLINE");
    expect(botState(bot({ engine: { received_at: "2026-11-12T05:45:00Z" } }), NOW)).toBe("STALE");
    expect(botState(bot({ engine: { received_at: "2026-11-12T05:00:00Z" } }), NOW)).toBe("OFFLINE");
    expect(botState(bot({ timeframe: "1m", engine: { received_at: "2026-11-12T05:55:00Z" } }), NOW)).toBe("STALE"); // a 1m bot is stale sooner
    expect(botState(bot({ engine: null }), NOW)).toBe("NO_REPORT");
    expect(botState(bot({ entries_paused: true }), NOW)).toBe("PAUSED");
  });
  it("a PROPOSED bot is never shown as active, and no activity is invented for it", () => {
    const p = bot({ bot_id: "ALPHA-01", name: "ALPHA 01", timeframe: "1m", profile: null, status: "PROPOSED", engine: null });
    expect(botState(p, NOW)).toBe("PROPOSED");
    expect(pipelineLine(p, NOW)).toBe("ALPHA 01 · SOLUSD 1m · Proposed, not running");
    const out = html(p);
    expect(out).toContain("Not approved and not running");
    expect(out).not.toContain("Waiting for a swing");
  });
  it("the pipeline line uses the engine's own status text, or the open position", () => {
    expect(pipelineLine(bot(), NOW)).toBe("ALPHA 02 · SOLUSD 5m · Waiting for a swing");
    const open = bot({ open_positions: [{ id: 1, symbol: "SOLUSD", qty: 0.11, avg_entry_price: 84, mark_price: 84.2, opened_at: "2026-11-12T05:40:00Z", open_alert_id: "ENG-SOLUSD-5-x-BUY" }], engine: { ...bot().engine, position: { side: "LONG", qty: 0.11, entry: 84, stop: 83.5 } } });
    expect(pipelineLine(open, NOW)).toBe("ALPHA 02 · SOLUSD 5m · Managing open LONG");
  });
});

describe("bot card", () => {
  it("shows the bot's own PAPER figures and keeps the mirror separate and labelled hypothetical", () => {
    const out = html(bot({ reserved_usd: 9.2, paper: { trades: 4, realized_net_usd: 1.25, wins: 3, win_rate: 0.75, profit_factor: 2.5, max_drawdown_usd: 0.4 },
      mirror: [{ account_id: "MIRROR-SOLUSD-5m-c826", trades: 11, gross: 15.47, last_candle_time: null, hypothetical: true }] }));
    expect(out).toContain("ALPHA 02");
    expect(out).toContain("SOLUSD · 5m");
    expect(out).toContain("$9.20");
    expect(out).toContain("75%");
    expect(out).toContain("Strategy Mirror (hypothetical)");
    expect(out).toContain("never added to PAPER results");
    expect(out).toContain("Shared SOLUSD wallet");
    expect(out).toContain("1% · max $10.00");
  });
  it("missing data stays missing (N/A), never estimated", () => {
    const out = html(bot({ engine: null }));
    expect(out).toContain("NO REPORT");
    expect(out).toMatch(/Latest candle<\/span><b>N\/A/);
  });
});
