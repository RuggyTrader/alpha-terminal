// Command-center redesign: display names, closed-trade selection, the talking globe's truthfulness, the activity
// stream, the assistant's new questions, navigation and scalability. Pure functions and static renders only.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { aliasText, BOT_DISPLAY, displayName, pairLabel } from "./botNames";
import { closedCards, holdTime } from "./recentClosed";
import type { BotTradeRow } from "./botTrades";
import { insights, nextInsight, type CompanionInput } from "./companion";
import { mergeStream, type ActivityItem } from "./activity";
import { answer } from "./assistant";
import type { Bot, Fleet } from "./bots";
import type { Metrics } from "./performance";
import { viewOf } from "./pages/TradesHub";
import { BotTile, matchesSearch, matchesStatus } from "./pages/Bots";
import { ClosedTrades } from "./components/ClosedTrades";

const NOW = Date.parse("2026-11-16T05:00:00Z");
const PAPER0 = { trades: 0, long_trades: 0, short_trades: 0, wins: 0, losses: 0, break_even: 0, gross_usd: 0, fees_usd: 0, net_usd: 0, win_rate: null, profit_factor: null, expectancy_usd: null, max_drawdown_usd: 0 };
const bot = (o: Partial<Bot> = {}): Bot => ({
  bot_id: "ALPHA-02", name: "SOL Orbit", group: "SOLANA", symbol: "SOLUSD", timeframe: "5m", profile: "solusd-5m", inputs_hash: "x",
  status: "ACTIVE", ledger_api: "bot", entries_paused: false, wallet: "ALPHA-02", risk_usd: 2, risk_setting: null,
  balances: { available_usd: 20, reserved_usd: 0, shortfall_usd: 0 },
  funding: { allocated_usd: 20, transferred_in_usd: 0, withdrawn_usd: 0, profit_swept_to_main_usd: 0 },
  open_positions: [], paper: { ...PAPER0 }, mirror: [],
  engine: { status_text: "Waiting for a swing", last_candle_time: "2026-11-16T04:58:00Z", received_at: "2026-11-16T04:59:30Z", ledger_check: { status: "OK" } },
  ...o,
});
const fleet = (bots: Bot[]): Fleet => ({ available: true, generated_at: "2026-11-16T05:00:00Z", main: { available_usd: 20, profit_received_usd: 0 }, groups: [], bots });
const row = (o: Partial<BotTradeRow>): BotTradeRow => ({ trade_id: "T1", bot_id: "ALPHA-03", ledger: "bot", symbol: "BTCUSD", side: "SHORT", status: "CLOSED", qty: 0.0003, entry_price: 65000,
  exit_price: 65010, opened_at: "2026-11-16T04:20:00Z", closed_at: "2026-11-16T04:40:00Z", gross_usd: -0.003, fees_usd: 0.078, net_usd: -0.081, swept_usd: 0, stop: null, tp: null, proof_url: "/bots/trade/T1", ...o });
const metrics = (o: Partial<Metrics> = {}): Metrics => ({ trades: 6, wins: 1, losses: 5, totalPnl: -0.37, returnPct: -0.37, winRate: 16.7, profitFactor: 0.32, expectancy: null, maxDrawdown: null, curve: [], ...o });
const input = (o: Partial<CompanionInput> = {}): CompanionInput => ({ feedStatus: "ok", feedAt: NOW, fleet: fleet([bot()]), fleetStale: false, metrics: metrics(), closed: [], now: NOW, ...o });

describe("bot display names are presentation-only", () => {
  it("maps the four registered ids and falls back safely for any other bot", () => {
    expect(["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"].map((id) => displayName(id))).toEqual(["SOL Flare", "SOL Orbit", "BTC Hash", "BTC Atlas"]);
    expect(displayName("ALPHA-17", "ALPHA 17")).toBe("ALPHA 17");
    expect(displayName("ALPHA-17")).toBe("ALPHA-17");
    expect(displayName(null)).toBe("Unknown bot");
    expect(Object.keys(BOT_DISPLAY)).toEqual(["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"]);
  });
  it("renames standalone bot references in Worker text but never an id", () => {
    expect(aliasText("ALPHA 01 | SOLUSD 1m")).toBe("SOL Flare | SOLUSD 1m");
    expect(aliasText("ALPHA-03 refused")).toBe("BTC Hash refused");
    expect(aliasText("ENG-ALPHA-01-SOLUSD-1-2026-11-16T02:20:00Z-OPEN_SHORT")).toBe("ENG-ALPHA-01-SOLUSD-1-2026-11-16T02:20:00Z-OPEN_SHORT");
    expect(aliasText("ALPHA PAPER · ALPHA TERMINAL")).toBe("ALPHA PAPER · ALPHA TERMINAL");
    expect(aliasText("ALPHA 19 | ETHUSD 5m")).toBe("ALPHA 19 | ETHUSD 5m"); // unregistered: unchanged
    expect(pairLabel("SOLUSD")).toBe("SOL/USD");
  });
});

describe("Home closed trades: completed funded PAPER trades only", () => {
  it("excludes open, pending and unrecorded results; newest first with a stable tie-break; bounded", () => {
    const rows = [
      row({ trade_id: "A", closed_at: "2026-11-16T04:40:00Z" }),
      row({ trade_id: "B", status: "OPEN", closed_at: null, net_usd: null }),
      row({ trade_id: "C", closed_at: "2026-11-16T04:45:00Z", net_usd: 0.08, side: "LONG", bot_id: "ALPHA-02", symbol: "SOLUSD", qty: 0.27, entry_price: 71.59 }),
      row({ trade_id: "D", closed_at: "2026-11-16T04:40:00Z" }),
      row({ trade_id: "E", status: "CLOSED", net_usd: null }),
      row({ trade_id: "A", closed_at: "2026-11-16T04:40:00Z" }), // a duplicate row
      ...[1, 2, 3, 4].map((i) => row({ trade_id: `Z${i}`, closed_at: `2026-11-15T0${i}:00:00Z` })),
    ];
    const c = closedCards(rows, 4);
    expect(c.map((x) => x.key)).toEqual(["bot:C", "bot:D", "bot:A", "bot:Z4"]);
    expect(c[0].net).toBe(0.08);
    expect(c[0].returnPct).toBeCloseTo((0.08 / (0.27 * 71.59)) * 100, 6);
    expect(closedCards(rows, 2)).toHaveLength(2);
    expect(holdTime("2026-11-16T04:20:00Z", "2026-11-16T04:40:00Z")).toBe("20m");
  });
  it("cards show the display name, side, net after fees and the right tone; zero is neutral", () => {
    const cards = closedCards([row({ trade_id: "P", net_usd: 0.12 }), row({ trade_id: "N", net_usd: -0.01, closed_at: "2026-11-16T04:30:00Z" }), row({ trade_id: "Z", net_usd: 0, closed_at: "2026-11-16T04:20:00Z" })]);
    const html = renderToStaticMarkup(<MemoryRouter><ClosedTrades cards={cards} loading={false} error={null} stale={false} /></MemoryRouter>);
    expect(html).toContain("BTC Hash");
    expect(html).toContain("SHORT");
    expect(html).toContain("+$0.12");
    expect(html).toContain("−$0.01");
    expect(html).toMatch(/ct-card ct-pos/);
    expect(html).toMatch(/ct-card ct-neg/);
    expect(html).toMatch(/ct-card ct-zero/);
    expect(html).toContain("/trades?view=completed");
    expect(html).not.toContain("is-new"); // the first render never animates as "new"
  });
  it("an empty or failed history is said honestly", () => {
    const empty = renderToStaticMarkup(<MemoryRouter><ClosedTrades cards={[]} loading={false} error={null} stale={false} /></MemoryRouter>);
    expect(empty).toContain("No funded PAPER trade has closed yet.");
    const failed = renderToStaticMarkup(<MemoryRouter><ClosedTrades cards={[]} loading={false} error="HTTP 502" stale={false} /></MemoryRouter>);
    expect(failed).toContain("Closed trades unavailable: HTTP 502");
  });
});

describe("talking globe: records only, never more than they say", () => {
  it("a pending order is described as waiting, never as filled", () => {
    const b = bot({ engine: { ...bot().engine!, strategy_state: { direction: "LONG", leg_start: 70, leg_end: 72, setup_bars: 3, max_age_bars: 36, pending_order: { side: "LONG", qty: 0.27, limit: 71.59, stop: 71.1, tp: 72.3 }, current_stop: null, break_even_done: false, trailing: false } } });
    const all = insights(input({ fleet: fleet([b]) }));
    const t = all.map((x) => x.text).join(" ");
    expect(t).toContain("SOL Orbit is waiting for a long limit fill at");
    expect(t).not.toMatch(/filled|entered|opened/i);
  });
  it("performance lines copy the verified figures exactly; no profit is claimed for a loss", () => {
    const t = insights(input()).map((x) => x.text);
    expect(t).toContain("Your verified P&L is down $0.37 across 6 closed trades.");
    expect(insights(input({ metrics: metrics({ totalPnl: 1.25, trades: 3 }) })).map((x) => x.text)).toContain("Your verified P&L is up $1.25 across 3 closed trades.");
  });
  it("a just-closed trade reports its recorded net after fees, and only when recent", () => {
    const c = closedCards([row({ trade_id: "X", closed_at: "2026-11-16T04:50:00Z", net_usd: -0.06 })]);
    expect(insights(input({ closed: c })).map((x) => x.text)).toContain("BTC Hash just closed a short at −$0.06 after fees.");
    const old = closedCards([row({ trade_id: "Y", closed_at: "2026-11-16T03:00:00Z", net_usd: 0.5 })]);
    expect(insights(input({ closed: old })).some((x) => x.key.startsWith("closed-"))).toBe(false);
  });
  it("stale or failed data is never presented as live; issues come first", () => {
    const stale = insights(input({ feedStatus: "stale" }));
    expect(stale[0].priority).toBe(1);
    expect(stale[0].text).toContain("The last refresh failed");
    expect(stale.some((x) => x.key === "scan-all")).toBe(false);
    const off = insights(input({ fleet: fleet([bot({ engine: { ...bot().engine!, received_at: "2026-11-16T03:00:00Z" } })]) }));
    expect(off[0].text).toContain("may be offline");
    expect(insights(input({ fleetStale: true })).some((x) => /scanning/.test(x.text))).toBe(false);
  });
  it("all-scanning is said only when every active bot is genuinely scanning on live data", () => {
    expect(insights(input()).some((x) => x.key === "scan-all")).toBe(true);
    expect(insights(input({ feedStatus: "error" })).some((x) => x.key === "scan-all")).toBe(false);
  });
  it("rotation: the most important unseen line first, with a cooldown, deterministic", () => {
    const list = insights(input({ feedStatus: "stale" }));
    const shown = new Map<string, number>();
    const a = nextInsight(list, shown, NOW)!; shown.set(a.key, NOW);
    const b = nextInsight(list, shown, NOW + 1000)!;
    expect(a.priority).toBe(1);
    expect(b.key).not.toBe(a.key);
  });
});

describe("ALPHA Activity stream", () => {
  const it_ = (id: string, at: string, o: Partial<ActivityItem> = {}): ActivityItem => ({ id, at, source: "funded", symbol: "SOLUSD", title: id, outcome: "", tone: "info", url: null, ...o });
  it("is chronological (oldest first, newest last) with unique ids", () => {
    const s = mergeStream([], [it_("b", "2026-11-16T04:10:00Z"), it_("a", "2026-11-16T04:00:00Z"), it_("c", "2026-11-16T04:20:00Z")]);
    expect(s.map((x) => x.id)).toEqual(["a", "b", "c"]);
    const s2 = mergeStream(s, [it_("c", "2026-11-16T04:20:00Z"), it_("d", "2026-11-16T04:30:00Z")]);
    expect(s2.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("the newest page is authoritative for its time span (an order later shown as its fill appears once)", () => {
    const cur = [it_("old", "2026-11-16T03:00:00Z"), it_("Oorder", "2026-11-16T04:21:00Z")];
    const page = [it_("E77", "2026-11-16T04:21:00Z"), it_("E78", "2026-11-16T04:30:00Z")];
    expect(mergeStream(cur, page).map((x) => x.id)).toEqual(["old", "E77", "E78"]);
    const dev = it_("D-on", "2026-11-16T04:25:00Z", { source: "device" });
    expect(mergeStream([dev], page).map((x) => x.id)).toContain("D-on"); // this device's own note is kept
  });
  it("older history is added above without disturbing what is held; the cap keeps the right end", () => {
    const cur = [it_("n1", "2026-11-16T04:00:00Z"), it_("n2", "2026-11-16T04:10:00Z")];
    const older = [it_("o1", "2026-11-16T03:00:00Z")];
    expect(mergeStream(cur, older, "oldest").map((x) => x.id)).toEqual(["o1", "n1", "n2"]);
    const many = Array.from({ length: 5 }, (_, i) => it_(`x${i}`, `2026-11-16T0${i}:00:00Z`));
    expect(mergeStream([], many, "newest", 3).map((x) => x.id)).toEqual(["x2", "x3", "x4"]);
    expect(mergeStream([], many, "oldest", 3).map((x) => x.id)).toEqual(["x0", "x1", "x2"]);
  });
});

describe("assistant: new portfolio questions, answered from records only", () => {
  const f = fleet([
    bot({ paper: { ...PAPER0, trades: 4, gross_usd: 0.05, fees_usd: 0.3, net_usd: -0.25 } }),
    bot({ bot_id: "ALPHA-03", name: "BTC Hash", group: "BITCOIN", symbol: "BTCUSD", timeframe: "1m", paper: { ...PAPER0, trades: 2, gross_usd: 0.01, fees_usd: 0.13, net_usd: -0.12 },
      open_positions: [{ trade_id: "ENG-ALPHA-03-X-OPEN_SHORT", symbol: "BTCUSD", side: "SHORT", qty: 0.0003, entry_price: 65020.7, stop: 65138.7, tp: 64560.2, collateral_usd: 19.5, opened_at: "2026-11-16T04:23:00Z", mark_price: null, mark_at: null }] }),
  ]);
  it("why is my portfolio down: the recorded gross, fees and net, nothing else", () => {
    const a = answer("Why is my portfolio down?", f, NOW);
    expect(a.known).toBe(true);
    expect(a.text).toContain("down $0.37 after fees over 6 closed trades");
    expect(a.text).toContain("+$0.06 before fees");
    expect(a.text).toContain("fees of $0.43");
  });
  it("open positions, fees, bots doing, most recent trade", () => {
    expect(answer("What positions are currently open?", f, NOW).text).toContain("BTC Hash: SHORT 0.0003 @ 65020.7");
    expect(answer("How much have I paid in fees?", f, NOW).text).toContain("$0.43 in simulated PAPER fees over 6 closed trades");
    expect(answer("What are my bots doing?", f, NOW).text).toContain("SOL Orbit:");
    expect(answer("What was my most recent trade?", f, NOW).known).toBe(false); // history not loaded: says so
    const c = closedCards([row({ trade_id: "R", net_usd: -0.01 })]);
    expect(answer("What was my most recent trade?", f, NOW, null, { closed: c }).text).toContain("BTC Hash closed a SHORT on BTCUSD");
    expect(answer("Which bot has performed best?", f, NOW).text).toContain("BTC Hash");
  });
  it("display names are understood, and it still refuses to act", () => {
    expect(answer("What is SOL Orbit doing?", f, NOW).text).toContain("SOL Orbit (SOLUSD 5m)");
    expect(answer("close my BTC Hash position", f, NOW).text).toContain("I'm read-only");
  });
});

describe("navigation and scalability", () => {
  it("Trades sections come from the URL; older ?bot= / ?signal= links open the records they filter", () => {
    expect(viewOf(new URLSearchParams(""))).toBe("completed");
    expect(viewOf(new URLSearchParams("view=performance&bot=ALPHA-01"))).toBe("performance");
    expect(viewOf(new URLSearchParams("signal=ENG-X"))).toBe("records");
    expect(viewOf(new URLSearchParams("bot=ALPHA-02"))).toBe("records");
    expect(viewOf(new URLSearchParams("view=nonsense"))).toBe("completed");
  });
  it("twenty bots: tiles stay compact, unknown ids fall back, search and status filters work", () => {
    const many = Array.from({ length: 20 }, (_, i) => bot({ bot_id: `ALPHA-${String(i + 1).padStart(2, "0")}`, name: displayName(`ALPHA-${String(i + 1).padStart(2, "0")}`, `ALPHA ${String(i + 1).padStart(2, "0")}`),
      symbol: i % 2 ? "BTCUSD" : "SOLUSD", group: i % 2 ? "BITCOIN" : "SOLANA", timeframe: i % 3 ? "5m" : "1m" }));
    const html = renderToStaticMarkup(<MemoryRouter>{many.map((b) => <BotTile key={b.bot_id} b={b} nowMs={NOW} />)}</MemoryRouter>);
    expect((html.match(/class="bt /g) ?? []).length).toBe(20);
    expect(html).toContain("ALPHA 17");
    expect(html).toContain("SOL Flare");
    expect(html).toContain("/bots/ALPHA-20/chart");
    expect(many.filter((b) => matchesSearch(b, "btc/usd")).length).toBe(10);
    expect(many.filter((b) => matchesSearch(b, "orbit")).map((b) => b.bot_id)).toEqual(["ALPHA-02"]);
    expect(many.filter((b) => matchesStatus(b, "scanning", NOW)).length).toBe(20);
    expect(many.filter((b) => matchesStatus(b, "attention", NOW)).length).toBe(0);
  });
});
