// Trades synchronisation regressions (2026-11-13 review):
//   A  the unfiltered Trades page shows EVERY bot's records (legacy ALPHA-02 + bot ledger), each trade once;
//   B  filtered / all-bot lists refresh while the owner stays on the page (shared store, ledger-change trigger);
//   C  a page of 200 rows is never presented as lifetime performance (> 200 closed trades).
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Bot, Fleet } from "./bots";
import type { BotTradeRow, BotTrades, BotTradesSnapshot } from "./botTrades";

const mocks = vi.hoisted(() => ({ fleet: null as unknown, trades: null as unknown }));
vi.mock("./fleetStore", async (orig) => ({ ...(await orig<typeof import("./fleetStore")>()), useFleet: () => ({ fleet: mocks.fleet, error: null, fetchedAt: 1, stale: false, refresh: () => {} }) }));
vi.mock("./botTrades", async (orig) => {
  const real = await orig<typeof import("./botTrades")>();
  return { ...real, useBotTrades: () => ({ ...(mocks.trades as BotTradesSnapshot), refresh: () => {} }) };
});

const { createBotTradesStore, ledgerSignature, BOT_TRADES_LIMIT } = await vi.importActual<typeof import("./botTrades")>("./botTrades");
const { allBotRecords, refusalText } = await import("./components/AllBotTrades");
const { BotPerformanceView } = await import("./components/BotTradesView");
const { fromBotTrade } = await import("./tradeStory");
const { headlineMetrics, lifetimeMetrics } = await import("./performance");

const paper = (o: Partial<Bot["paper"]> = {}): Bot["paper"] => ({ trades: 0, long_trades: 0, short_trades: 0, wins: 0, losses: 0, break_even: 0, gross_usd: 0, fees_usd: 0, net_usd: 0,
  win_rate: null, profit_factor: null, expectancy_usd: null, max_drawdown_usd: 0, ...o });
const bot = (id: string, symbol: string, timeframe: string, o: Partial<Bot> = {}): Bot => ({ bot_id: id, name: id, group: symbol.startsWith("SOL") ? "SOLANA" : "BITCOIN", symbol, timeframe,
  profile: null, inputs_hash: null, status: "ACTIVE", ledger_api: id === "ALPHA-02" ? "legacy" : "bot", entries_paused: false, wallet: `BOT:${id}`, risk_usd: 10, risk_setting: null,
  balances: { available_usd: 100, reserved_usd: 0, shortfall_usd: 0 }, funding: { allocated_usd: 100, transferred_in_usd: 0, withdrawn_usd: 0, profit_swept_to_main_usd: 0 },
  open_positions: [], paper: paper(), mirror: [], engine: null, ...o });
const FLEET = (bots: Bot[]): Fleet => ({ available: true, generated_at: "x", groups: [], bots });
const row = (o: Partial<BotTradeRow>): BotTradeRow => ({ trade_id: "T1", bot_id: "ALPHA-01", ledger: "bot", symbol: "SOLUSD", side: "LONG", status: "CLOSED", qty: 1, entry_price: 100,
  exit_price: 101, opened_at: "2026-11-12T00:00:00Z", closed_at: "2026-11-12T00:10:00Z", gross_usd: 1, fees_usd: 0.402, net_usd: 0.598, swept_usd: 0.598, stop: 99, tp: 102,
  proof_url: "/bots/trade/T1", ...o });
const deferred = <T,>() => { let res!: (v: T) => void; const p = new Promise<T>((a) => { res = a; }); return { p, res }; };
const tradesOf = (trades: BotTradeRow[], o: Partial<BotTrades> = {}): BotTrades => ({ available: true, trades, orders: [], signals: [], ...o });

describe("B: shared bot-trades store refreshes and never regresses", () => {
  it("an older response cannot overwrite a newer one; a failure keeps the last data marked stale", async () => {
    const reqs: ReturnType<typeof deferred<BotTrades>>[] = [];
    let fail = false;
    const s = createBotTradesStore(() => { if (fail) return Promise.reject(new Error("TIMEOUT")); const d = deferred<BotTrades>(); reqs.push(d); return d.p; }, () => 7000);
    const f = { bot: "ALPHA-01", signal: null };
    const first = s.refresh(f);
    const second = s.refresh(f, true);
    reqs[1].res(tradesOf([row({ trade_id: "NEW" })]));
    await second;
    reqs[0].res(tradesOf([row({ trade_id: "OLD" })]));
    await first;
    expect(s.get(f).data?.trades[0].trade_id).toBe("NEW");
    fail = true;
    await s.refresh(f);
    expect(s.get(f)).toMatchObject({ stale: true, error: "TIMEOUT", fetchedAt: 7000 });
    expect(s.get(f).data?.trades[0].trade_id).toBe("NEW");
  });
  it("refreshActive refetches every filter on screen (a trade that closes appears without leaving the page)", async () => {
    let close = false;
    const s = createBotTradesStore(async (f) => tradesOf(close && f.bot === "ALPHA-01" ? [row({ status: "CLOSED" })] : [row({ status: "OPEN", net_usd: null, closed_at: null })]));
    const f = { bot: "ALPHA-01", signal: null };
    const seen: string[] = [];
    s.subscribe(f, (snap) => seen.push(snap.data?.trades[0].status ?? "none"));
    await s.refresh(f);
    close = true;
    await s.refreshActive();
    expect(seen).toEqual(["OPEN", "CLOSED"]);
  });
  it("requests a bounded page", async () => {
    let limit = 0;
    const s = createBotTradesStore(async (f) => { limit = f.limit; return tradesOf([]); });
    await s.refresh({ bot: null, signal: null });
    expect(limit).toBe(BOT_TRADES_LIMIT);
    expect(BOT_TRADES_LIMIT).toBeLessThanOrEqual(50); // the Worker's current D1 bound-parameter ceiling
  });
  it("the fleet's ledger signature changes on a fill, a close and a new pending order — and not on an unrelated refresh", () => {
    const a = FLEET([bot("ALPHA-01", "SOLUSD", "1m")]);
    const same = FLEET([bot("ALPHA-01", "SOLUSD", "1m", { balances: { available_usd: 99, reserved_usd: 1, shortfall_usd: 0 } })]);
    const filled = FLEET([bot("ALPHA-01", "SOLUSD", "1m", { open_positions: [{ trade_id: "T9", symbol: "SOLUSD", side: "LONG", qty: 1, entry_price: 80, stop: 79, tp: 82, collateral_usd: 80, opened_at: "x", mark_price: null, mark_at: null }] })]);
    const closed = FLEET([bot("ALPHA-01", "SOLUSD", "1m", { paper: paper({ trades: 1, net_usd: 0.5 }) })]);
    expect(ledgerSignature(a)).toBe(ledgerSignature(same));
    expect(ledgerSignature(filled)).not.toBe(ledgerSignature(a));
    expect(ledgerSignature(closed)).not.toBe(ledgerSignature(a));
    expect(ledgerSignature(null)).toBe("");
  });
});

describe("A: one all-bot view, every bot, each trade once", () => {
  const fleet = FLEET([
    bot("ALPHA-01", "SOLUSD", "1m", { engine: { strategy_state: { pending_order: { side: "LONG", qty: 0.5, limit: 82.93, stop: 82.67, tp: 83.98 } } } as unknown as Bot["engine"] }),
    bot("ALPHA-02", "SOLUSD", "5m", { open_positions: [{ trade_id: "ENG-SOLUSD-5-X-BUY", symbol: "SOLUSD", side: "LONG", qty: 0.12, entry_price: 81.43, stop: null, tp: null, collateral_usd: 9.9, opened_at: "2026-11-13T00:00:00Z", mark_price: null, mark_at: null }] }),
    bot("ALPHA-03", "BTCUSD", "1m"), bot("ALPHA-04", "BTCUSD", "5m"),
  ]);
  const data = tradesOf([
    row({ trade_id: "B1", bot_id: "ALPHA-01" }),
    row({ trade_id: "B3", bot_id: "ALPHA-03", symbol: "BTCUSD", side: "SHORT", net_usd: -0.385 }),
    row({ trade_id: "B4", bot_id: "ALPHA-04", symbol: "BTCUSD", side: "SHORT", status: "OPEN", net_usd: null, closed_at: null, exit_price: null }),
    row({ trade_id: "ENG-SOLUSD-5-OLD-BUY", legacy_id: 7, ledger: "legacy", bot_id: "ALPHA-02", proof_url: "/trades/7" }),
  ], {
    orders: [{ order_id: "O1", bot_id: "ALPHA-03", action: "OPEN_SHORT", symbol: "BTCUSD", requested_qty: 1, status: "REJECTED", code: "INSUFFICIENT_BOT_CAPITAL", message: "ALPHA-03 has $99.65 available; this LONG costs $4084.2 + fee $8.17.", trade_id: null, received_at: "2026-11-13T01:00:00Z" },
      { order_id: "O2", bot_id: "ALPHA-01", action: "OPEN_LONG", symbol: "SOLUSD", requested_qty: 1, status: "ACCEPTED", code: "DRY_RUN_ACCEPTED", message: null, trade_id: "B1", received_at: "2026-11-13T00:00:00Z" }],
  });
  it("includes bot-ledger AND legacy trades without needing a bot filter", () => {
    const r = allBotRecords(fleet, data, { market: null, timeframe: null, side: null });
    expect(r.completed.map((v) => v.botId).sort()).toEqual(["ALPHA-01", "ALPHA-02", "ALPHA-03"]);
    expect(r.open.map((v) => v.tradeId)).toEqual(["B4"]);
    expect(r.legacyOpen.map((x) => x.bot.bot_id)).toEqual(["ALPHA-02"]);
    expect(r.pending.map((p) => p.bot.bot_id)).toEqual(["ALPHA-01"]);
    expect(r.rejected.map((x) => x.code)).toEqual(["INSUFFICIENT_BOT_CAPITAL"]);
    expect(r.rejected[0].text).toMatch(/^Not enough capital in this bot's wallet/);
    const keys = [...r.completed, ...r.open].map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("a refusal shows a plain headline AND the ledger's recorded figures (never 'unknown')", () => {
    const r = allBotRecords(fleet, data, { market: null, timeframe: null, side: null });
    expect(r.rejected[0].text).toContain("$99.65 available");
    expect(r.rejected[0].text).not.toContain("unknown");
    expect(refusalText("BELOW_MIN_QTY", null)).toMatch(/minimum order/);
  });
  it("filters by market, timeframe and direction", () => {
    expect(allBotRecords(fleet, data, { market: "BTCUSD", timeframe: null, side: null }).completed.map((v) => v.tradeId)).toEqual(["B3"]);
    expect(allBotRecords(fleet, data, { market: null, timeframe: "5m", side: null }).completed.map((v) => v.tradeId)).toEqual(["7"]);
    const shorts = allBotRecords(fleet, data, { market: null, timeframe: null, side: "SHORT" });
    expect(shorts.completed.map((v) => v.tradeId)).toEqual(["B3"]);
    expect(shorts.pending).toEqual([]);
    expect(shorts.legacyOpen).toEqual([]);
  });
  it("a legacy row keeps its trades.id: same key as the dashboard list, and a chart link that resolves", () => {
    const v = fromBotTrade(row({ trade_id: "ENG-SOLUSD-5-OLD-BUY", legacy_id: 7, ledger: "legacy", bot_id: "ALPHA-02", proof_url: "/trades/7" }));
    expect(v.key).toBe("legacy-7");
    expect(v.chartUrl).toBe("/bots/ALPHA-02/chart?ledger=legacy&trade=7");
  });
  it("nothing is listed without the bot registry (schema 6 keeps the legacy page)", () => {
    const r = allBotRecords({ available: false, groups: [], bots: [] }, { available: false, trades: [], orders: [], signals: [] }, { market: null, timeframe: null, side: null });
    expect(r.completed.length + r.open.length + r.pending.length + r.rejected.length).toBe(0);
  });
});

describe("C: lifetime performance is never computed from a page of 200 rows", () => {
  // 250 closed trades exist; the page holds the latest 200. The first 50 (oldest) were large losses.
  const all = Array.from({ length: 250 }, (_, i) => row({ trade_id: `T${i}`, net_usd: i < 50 ? -2 : 0.5, gross_usd: i < 50 ? -1.6 : 0.9, fees_usd: 0.4, swept_usd: i < 50 ? 0 : 0.5,
    closed_at: `2026-11-${String(1 + Math.floor(i / 20)).padStart(2, "0")}T00:${String(i % 60).padStart(2, "0")}:00Z` }));
  const page = all.slice(50);
  const lifetimeNet = all.reduce((s, r) => s + (r.net_usd as number), 0); // -100 + 100 = 0
  const b = bot("ALPHA-01", "SOLUSD", "1m", { paper: paper({ trades: 250, long_trades: 250, net_usd: lifetimeNet, gross_usd: 100, fees_usd: 100, wins: 200, losses: 50, win_rate: 0.8, profit_factor: 1, max_drawdown_usd: 100 }),
    funding: { allocated_usd: 100, transferred_in_usd: 0, withdrawn_usd: 0, profit_swept_to_main_usd: 100 } });
  it("shows the server's lifetime figures and says how many rows are loaded", () => {
    mocks.fleet = FLEET([b]);
    mocks.trades = { data: tradesOf(page, { page: { limit: 200, returned: 200, total: 250, truncated: true } }), error: null, fetchedAt: 1, stale: false };
    const html = renderToStaticMarkup(<MemoryRouter><BotPerformanceView bot="ALPHA-01" /></MemoryRouter>);
    expect(html).toContain("Lifetime · all closed trades");
    expect(html).toMatch(/CLOSED TRADES<\/span><b class="pm-v">250</);
    expect(html).toContain("1.00"); // lifetime PF, not the page's (page has no losses → PF unavailable)
    expect(html).toContain("$100.00"); // lifetime max drawdown, not the page's $0
    expect(html).toContain("Showing the latest 200 of 250 trades");
    expect(html).not.toContain("disagree");
  });
  it("without the fleet snapshot, lifetime figures are unavailable — never estimated from the page", () => {
    mocks.fleet = null;
    mocks.trades = { data: tradesOf(page, { page: { limit: 200, returned: 200, total: 250, truncated: true } }), error: null, fetchedAt: 1, stale: false };
    const html = renderToStaticMarkup(<MemoryRouter><BotPerformanceView bot="ALPHA-01" /></MemoryRouter>);
    expect(html).not.toMatch(/CLOSED TRADES<\/span><b class="pm-v">200</);
    expect(html).toContain("Showing the latest 200 of 250 trades");
  });
});

describe("Home headline = the Worker's complete lifetime aggregate, never a page", () => {
  // Shape from docs/backend/API-2026-11-13.md (a labelled TEST fixture: 5,002 legacy trades + 1 bot trade).
  const lifetime = { scope: "all-funded-paper", bot_id: null, complete: true, closed_trades: 5003, wins: 2502, losses: 2501, break_even: 0, gross_usd: 3502.4, fees_usd: 1000.434,
    net_usd: 2501.966, win_rate: 2502 / 5003, expectancy_usd: 2501.966 / 5003, profit_factor: 1.5, max_drawdown_usd: 1, drawdown_basis: "closed-trade", first_close: null, last_close: null };
  it("uses lifetime (5,003 trades) even though the legacy list holds only 2 rows and is truncated", () => {
    const legacyPage = [{ id: 1, realized_pnl: 9, closed_at: "2026-11-01T00:00:00Z" }, { id: 2, realized_pnl: 9, closed_at: "2026-11-02T00:00:00Z" }] as never;
    const h = headlineMetrics({ verification: "v", trades: legacyPage, truncated: true, excluded_closed_trades: 0, lifetime } as never, Date.now(), 1000)!;
    expect(h.complete).toBe(true);
    expect(h.m.trades).toBe(5003);
    expect(h.m.totalPnl).toBeCloseTo(2501.966);
    expect(h.m.winRate).toBeCloseTo((2502 / 5003) * 100);
    expect(h.m.returnPct).toBeCloseTo(250.1966);
    expect(h.m.curve).toEqual([]); // the aggregate has no curve: none is invented
  });
  it("an older Worker without lifetime falls back to its legacy list and says whether it is complete", () => {
    const h = headlineMetrics({ verification: "v", trades: [], truncated: true, excluded_closed_trades: 0 } as never, Date.now(), null)!;
    expect(h.complete).toBe(false);
  });
  it("no closed trade: zero trades, rates unavailable", () => {
    const m = lifetimeMetrics({ ...lifetime, closed_trades: 0, wins: 0, losses: 0, net_usd: 0, win_rate: null, expectancy_usd: null, profit_factor: null, max_drawdown_usd: 0 }, null);
    expect([m.trades, m.winRate, m.profitFactor, m.maxDrawdown, m.returnPct]).toEqual([0, null, null, null, null]);
  });
});

describe("Capital card: equity, shortfall and mark age come from the Worker and the recorded marks", async () => {
  const { walletSummary, markSummary } = await import("./components/WalletOverview");
  const { executedSize } = await import("./pages/BotTradeProof");
  const { humanReason } = await import("./tradeStory");
  const base = { label: "", simulated: true, active: true, wallets: [], consistency: { ok: true, issues: [] }, history: [], strategies: {}, validated_engines: [], limits: {} } as never;
  const totals = (o: object) => ({ ...(base as object), totals: { book_balance_usd: 1000, unallocated_usd: 0, available_usd: 960, reserved_usd: 40, realized_pnl_usd: 0, net_funding_usd: 1000, unrealized_pnl_usd: -5, ...o } }) as never;
  it("uses the Worker's equity_usd (shortfall included), and null equity stays null (never zero)", () => {
    expect(walletSummary(totals({ equity_usd: 994.92, shortfall_usd: 0 })).equity).toBeCloseTo(994.92);
    expect(walletSummary(totals({ equity_usd: null })).equity).toBeNull();
    expect(walletSummary(totals({ equity_usd: 990, shortfall_usd: 5 })).shortfall).toBe(5);
    const older = { ...(totals({}) as object), wallets: [{ wallet: "SOLUSD", kind: "STRATEGY", unrealized_pnl_usd: -5, book_balance_usd: 1000 }] } as never;
    expect(walletSummary(older).equity).toBeCloseTo(995); // older Worker without equity_usd: book + unrealized, as before
  });
  it("mark age: missing marks counted, stale past 5 minutes", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(markSummary([{ at: "2026-11-13T11:59:30Z" }], now)).toMatchObject({ count: 1, missing: 0, oldestSeconds: 30, stale: false });
    expect(markSummary([{ at: "2026-11-13T11:50:00Z" }, { at: null }], now)).toMatchObject({ missing: 1, oldestSeconds: 600, stale: true });
  });
  it("filled vs requested quantity and the recorded reduction reason", () => {
    const pos = { trade_id: "T1" } as never;
    expect(executedSize({ position: pos, orders: [{ order_id: "T1", requested_qty: 0.5, message: "LONG 0.1 @ 80: purchase cost reserved; quantity reduced from 0.5 to 0.1 to keep planned stop risk within $2 at reference price 80" }] as never })).toEqual({ requested: 0.5, reason: expect.stringMatching(/stop risk/) });
    expect(executedSize({ position: pos, orders: [{ order_id: "T1", requested_qty: 0.5, message: "quantity reduced from 0.5 to 0.2 to fit ALPHA-01's available $16 at the fill price 80" }] as never }).reason).toMatch(/available capital/);
    expect(executedSize({ position: pos, orders: [] as never }).requested).toBeNull();
  });
  it("new refusal codes have plain explanations", () => {
    for (const c of ["BOT_PROFILE_MISMATCH", "BOT_SHORTFALL", "CONCURRENT_ORDER"]) expect(humanReason(c)).toBeTruthy();
  });
});
