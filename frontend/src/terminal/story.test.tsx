import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { explainEntry, explainExit, fromLegacyTrade, hypotheticalFees, humanReason, planFigures, type TradeStory } from "./tradeStory";
import { answerTrade } from "./tradeAssistant";
import { TradeStoryCard } from "./components/TradeStoryCard";
import { tradeOverlay } from "./pages/BotChart";
import { scopeHero } from "./components/PerformanceSelector";
import { walletSummary } from "./components/WalletOverview";
import type { TradeRow, PaperPortfolio } from "./types";

// The owner's production trade #1 (13 Nov 00:30 UTC), with the plan the engine's audit recorded for it.
const STORY: TradeStory = {
  plan: { side: "LONG", setup_at: "2026-11-13T00:25:00.000Z", swing_origin: 81.18, swing_end: 81.72, ote_705: 81.3393, order_type: "LIMIT", order_placed_at: "2026-11-13T00:25:00.000Z",
    planned_entry: 81.34, strategy_entry: 81.34, filled_at: "2026-11-13T00:35:00.000Z", initial_stop: 81.1669, tp2: 81.585, score: 1, confluence: ["OB"], profile: "solusd-5m", inputs_hash: "c826d785d58a4a39",
    rules: { entry_mode: "Limit @ 0.705", sl_mode: "Swing origin (1.0)", sl_buf_atr: 0.1, tp2_ext: 0.25, min_score: 1 } },
  exit: { kind: "SL", result: "SL", exit_r: -0.9821, strategy_exit: 81.17, initial_stop: 81.1669, stop_at_exit: 81.1669, tp2: 81.585, stop_history: [] },
  missing: [],
};
const row = (story: TradeStory | null): TradeRow & { story: TradeStory | null } => ({
  id: 1, symbol: "SOLUSD", direction: "long", status: "CLOSED", strategy: "OTE Pro Strat (engine)", entry_qty: "0.12184277", entry_avg_price: "81.43", exit_qty: "0.12184277",
  exit_avg_price: "81.17", open_qty: "0", realized_pnl: "-0.03167912", return_pct: "-0.32", opened_at: "2026-11-13T00:35:02.211Z", closed_at: "2026-11-13T00:40:02.482Z", source: "ALPHA_PAPER",
  open_alert_id: "ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY", close_alert_id: "ENG-SOLUSD-5-2026-11-13T00:35:00Z-CLOSE", open_order_id: "o1", close_order_id: "o2", price_sources: "kraken:SOLUSD",
  gross_pnl: "-0.03167912", fees_usd: "0.0", slippage_usd: "0.0", cost_profile: "none", story,
} as unknown as TradeRow & { story: TradeStory | null });

describe("trade explanations come only from recorded fields", () => {
  const v = fromLegacyTrade(row(STORY));
  it("maps the legacy engine trade to ALPHA-02 SOLUSD 5m with a chart link for that trade", () => {
    expect([v.botId, v.timeframe, v.side, v.status]).toEqual(["ALPHA-02", "5m", "LONG", "CLOSED"]);
    expect(v.chartUrl).toBe("/bots/ALPHA-02/chart?ledger=legacy&trade=1");
  });
  it("why it entered / exited", () => {
    const e = explainEntry(v)!;
    for (const s of ["bullish swing from 81.18 to 81.72", "70.5% retracement of that swing (81.3393)", "Order Block confluence (score 1, minimum 1)", "LONG limit order at 81.34", "stop 81.1669", "target 81.585"]) expect(e).toContain(s);
    expect(explainExit(v)).toBe("Stop loss reached at 81.17 (-0.98R).");
  });
  it("plan figures: risk and reward at the actual quantity; the ledger fill gap is reported", () => {
    const f = planFigures(v);
    expect(f.risk).toBeCloseTo((81.34 - 81.1669) * 0.12184277, 6);
    expect(f.reward).toBeCloseTo((81.585 - 81.34) * 0.12184277, 6);
    expect(f.fillGap).toBeCloseTo(0.09, 6);
  });
  it("the fee-free legacy record is preserved; the 0.20% comparison is labelled, not charged", () => {
    const h = hypotheticalFees(v)!;
    expect(h.fees).toBeCloseTo(0.12184277 * (81.43 + 81.17) * 0.002, 8);
    expect(h.net).toBeCloseTo(-0.03167912 - h.fees, 8);
    const html = renderToStaticMarkup(<MemoryRouter><TradeStoryCard v={v} defaultOpen /></MemoryRouter>);
    expect(html).toContain("fee-free legacy record");
    expect(html).toContain("For comparison only (not charged)");
    expect(html).toContain("Ask ALPHA about this trade");
    expect(html).not.toContain("ENG-SOLUSD-5-2026-11-13T00:30:00Z-BUY"); // ids live on the proof page
  });
  it("a trade with no recorded plan says so; nothing is reconstructed", () => {
    const old = fromLegacyTrade(row({ plan: null, exit: null, missing: ["entry plan was not sent"] }));
    expect(explainEntry(old)).toBeNull();
    const html = renderToStaticMarkup(<MemoryRouter><TradeStoryCard v={old} defaultOpen /></MemoryRouter>);
    expect(html).toContain("Not recorded for this trade");
    const a = answerTrade("What was the point of this trade?", old);
    expect(a.known).toBe(false);
    expect(a.text).toContain("not recorded");
  });
});

describe("Ask ALPHA about this trade", () => {
  const v = fromLegacyTrade(row(STORY));
  it("answers the owner's question from the trade's own record, with evidence links", () => {
    const a = answerTrade("What was the point of this trade?", v);
    expect(a.known).toBe(true);
    expect(a.text).toContain("Order Block");
    expect(a.text).toContain("Stop loss reached");
    expect(a.evidence.some((e) => e.link === "/trades/1")).toBe(true);
  });
  it("stop, target, PD arrays, fees, size and why it lost", () => {
    expect(answerTrade("What was its original stop loss?", v).text).toContain("81.1669");
    expect(answerTrade("What was the take profit?", v).text).toContain("81.585");
    expect(answerTrade("Which PD arrays qualified?", v).text).toContain("Order Block");
    expect(answerTrade("How much did it pay in fees?", v).text).toContain("comparison only");
    expect(answerTrade("Why was the position so small?", v).text).toContain("capped by the capital in its own wallet");
    expect(answerTrade("Why did it lose money?", v).text).toContain("Stop loss reached");
  });
});

describe("chart overlays for one trade", () => {
  const v = fromLegacyTrade(row(STORY));
  it("planned entry, initial stop and target lines; entry and exit markers on the right candles", () => {
    const o = tradeOverlay(v, 5);
    expect(o.lines.map((l) => [l.title, l.price])).toEqual([["Planned entry", 81.34], ["Initial stop", 81.1669], ["Target", 81.585]]);
    expect(o.markers.map((m) => [m.time, m.shape])).toEqual([[Date.parse("2026-11-13T00:35:00Z") / 1000, "arrowUp"], [Date.parse("2026-11-13T00:40:00Z") / 1000, "circle"]]);
  });
  it("a SHORT points down and stop changes are drawn", () => {
    const s = fromLegacyTrade({ ...row({ ...STORY, exit: { ...STORY.exit!, stop_history: [{ at: "x", stop: 81.3, reason: "BREAK_EVEN" }] } }), direction: "short" } as never);
    const o = tradeOverlay(s, 5);
    expect(o.markers[0].shape).toBe("arrowDown");
    expect(o.lines.some((l) => l.title === "Stop → break-even" && l.price === 81.3)).toBe(true);
  });
});

describe("refusal reasons are explained, codes kept", () => {
  it("BELOW_MIN_QTY / INSUFFICIENT_BOT_CAPITAL / SHORT_NOT_ALLOWED", () => {
    expect(humanReason("BELOW_MIN_QTY")).toContain("smaller than Kraken's minimum order");
    expect(humanReason("INSUFFICIENT_BOT_CAPITAL", { available: 7.07, cost: 7.09 })).toContain("$7.07 available");
    expect(humanReason("SHORT_NOT_ALLOWED")).toContain("long-only");
    expect(humanReason("SOMETHING_NEW")).toBeNull();
  });
});

describe("Home: the hero follows the selected scope; capital is never double-counted", () => {
  it("Strategy Mirror scope is labelled hypothetical and uses mirror figures only", () => {
    const cat = (trades: number, gross: number, net: number, wins: number) => ({ trades, longs: 0, shorts: 0, wins, gross_pnl: gross, net_modelled_pnl: net, last_exit_at: null });
    const o = { label: "", disclosure: "", note: "", markets: [{ account_id: "A", symbol: "SOLUSD", timeframe: "5m", categories: { live: cat(4, 12, -3, 2), catch_up: cat(1, 1, 0, 1), historical: cat(9, 99, 9, 9) } }] } as never;
    const h = scopeHero("mirror", o, null, "")!;
    expect(h.label).toContain("HYPOTHETICAL");
    expect(h.value).toBe(13);
    expect(h.strip.map((x) => x.v)).toEqual(["−$3.00", "5", "60.0%"]);
  });
  it("By bot scope shows that bot's funded figures; funded scope uses the default hero", () => {
    const b = { bot_id: "ALPHA-02", name: "ALPHA 02", symbol: "SOLUSD", timeframe: "5m", paper: { trades: 2, net_usd: -0.5, win_rate: 0.5, fees_usd: 0.1 } };
    const h = scopeHero("bot", null, { available: true, groups: [], bots: [b] } as never, "ALPHA-02")!;
    expect(h.label).toContain("ALPHA 02");
    expect(h.value).toBe(-0.5);
    expect(scopeHero("funded", null, null, "")).toBeNull();
  });
  it("crypto groups are sums of their bot wallets inside the total", () => {
    const w = (wallet: string, kind: "MAIN" | "STRATEGY", book: number, avail = book) => ({ wallet, kind, available_usd: avail, reserved_usd: 0, realized_pnl_usd: 0, net_funding_usd: book, unrealized_pnl_usd: null, book_balance_usd: book, equity_usd: null, open_positions: 0, updated_at: "" });
    const p = { active: true, wallets: [w("MAIN", "MAIN", 60), w("SOLUSD", "STRATEGY", 10), w("ALPHA-01", "STRATEGY", 10), w("ALPHA-03", "STRATEGY", 10), w("ALPHA-04", "STRATEGY", 10)],
      totals: { book_balance_usd: 100, unallocated_usd: 60, available_usd: 100, reserved_usd: 0, realized_pnl_usd: 0, net_funding_usd: 100, unrealized_pnl_usd: null } } as unknown as PaperPortfolio;
    const s = walletSummary(p);
    expect([s.total, s.main, s.sol, s.btc]).toEqual([100, 60, 20, 20]);
    expect(s.main! + s.sol + s.btc).toBe(s.total);
  });
});
