import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { tradeFilter, type BotTradeProof, type BotTradeRow } from "./botTrades";
import { botTradeSummary, TradeRowLink } from "./components/BotTradesView";
import { createFleetStore } from "./fleetStore";
import type { Fleet } from "./bots";
import { BotTradeProofView } from "./pages/BotTradeProof";

const fleet = (tag: string): Fleet => ({ available: true, generated_at: tag, groups: [], bots: [] });
const deferred = <T,>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

describe("shared fleet store: one source, ordered, invalidated by mutations", () => {
  it("concurrent callers share one request", async () => {
    let calls = 0;
    const d = deferred<Fleet>();
    const s = createFleetStore(() => { calls++; return d.p; }, () => 1000);
    const a = s.refresh(), b = s.refresh();
    d.res(fleet("A"));
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(s.get().fleet?.generated_at).toBe("A");
  });
  it("an older response can never overwrite a newer snapshot", async () => {
    const reqs: ReturnType<typeof deferred<Fleet>>[] = [];
    const s = createFleetStore(() => { const d = deferred<Fleet>(); reqs.push(d); return d.p; }, () => 1000);
    const first = s.refresh();
    const second = s.invalidate(); // a mutation: forced new request while the first is still in flight
    reqs[1].res(fleet("NEW"));
    await second;
    reqs[0].res(fleet("OLD"));
    await first;
    expect(s.get().fleet?.generated_at).toBe("NEW");
  });
  it("a failed refresh keeps the last good snapshot, marked stale with its real time", async () => {
    let n = 0;
    const s = createFleetStore(() => (++n === 1 ? Promise.resolve(fleet("GOOD")) : Promise.reject(new Error("TIMEOUT"))), () => 5000);
    await s.refresh();
    await s.refresh();
    expect(s.get()).toMatchObject({ stale: true, error: "TIMEOUT", fetchedAt: 5000 });
    expect(s.get().fleet?.generated_at).toBe("GOOD");
  });
});

describe("Trades / Performance filters", () => {
  it("only well-formed bot ids and signal ids are used", () => {
    expect(tradeFilter(new URLSearchParams("bot=ALPHA-01"))).toEqual({ bot: "ALPHA-01", signal: null });
    expect(tradeFilter(new URLSearchParams("signal=ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG"))).toEqual({ bot: null, signal: "ENG-ALPHA-01-SOLUSD-1-L1-OPEN_LONG" });
    expect(tradeFilter(new URLSearchParams("bot=<script>&signal=a b"))).toEqual({ bot: null, signal: null });
  });
  const row = (o: Partial<BotTradeRow>): BotTradeRow => ({ trade_id: "T1", bot_id: "ALPHA-01", ledger: "bot", symbol: "SOLUSD", side: "LONG", status: "CLOSED", qty: 1, entry_price: 100,
    exit_price: 101, opened_at: "2026-11-12T00:00:00Z", closed_at: "2026-11-12T00:10:00Z", gross_usd: 1, fees_usd: 0.402, net_usd: 0.598, swept_usd: 0.598, stop: 99, tp: 102,
    proof_url: "/bots/trade/T1", ...o });
  it("each trade links to its own proof page", () => {
    const html = renderToStaticMarkup(<MemoryRouter><TradeRowLink t={row({})} /></MemoryRouter>);
    expect(html).toContain('href="/bots/trade/T1"');
    const legacy = renderToStaticMarkup(<MemoryRouter><TradeRowLink t={row({ ledger: "legacy", proof_url: "/trades/42" })} /></MemoryRouter>);
    expect(legacy).toContain('href="/trades/42"');
  });
  it("bot performance comes from the ledger's own net figures; profit sent to MAIN does not change the net", () => {
    const s = botTradeSummary([row({}), row({ trade_id: "T2", side: "SHORT", gross_usd: -2, fees_usd: 0.4, net_usd: -2.4, swept_usd: 0 }), row({ trade_id: "T3", status: "OPEN", net_usd: null, closed_at: null })]);
    expect(s.trades).toBe(2);
    expect(s.open).toBe(1);
    expect(s.net).toBeCloseTo(-1.802);
    expect(s.swept).toBeCloseTo(0.598);
    expect(s.long).toEqual({ trades: 1, net: 0.598 });
    expect(s.short.trades).toBe(1);
    expect(s.maxDrawdown).toBeCloseTo(2.4);
  });
});

describe("bot trade proof page", () => {
  const proof: BotTradeProof = {
    bot: { bot_id: "ALPHA-03", name: "ALPHA 03", symbol: "BTCUSD", timeframe_min: 1, profile: "btcusd-1m", inputs_hash: "d828caa44611ad73", wallet: "ALPHA-03" },
    position: { trade_id: "T9", bot_id: "ALPHA-03", symbol: "BTCUSD", side: "SHORT", status: "CLOSED", qty: 0.00009, entry_price: 100000, exit_price: 99000, opened_at: "2026-11-12T00:00:00Z",
      closed_at: "2026-11-12T00:30:00Z", stop: 100500, tp: 98000, entry_fee_usd: 0.018, exit_fee_usd: 0.01782, collateral_usd: 9, gross_usd: 0.09, net_usd: 0.05418, swept_usd: 0.05418, shortfall_usd: 0, fee_model: "ndax-flat-0.20-2026-11-12" },
    orders: [{ order_id: "T9", action: "OPEN_SHORT", requested_qty: 0.00009, status: "ACCEPTED", code: "DRY_RUN_ACCEPTED", message: null, received_at: "2026-11-12T00:00:00Z", engine_payload: { stop: 100500, tp: 98000, risk_usd: 10, timestamp: null, profile: "btcusd-1m", config_hash: "d828", qty: 0.00009 } }],
    fills: [{ fill_id: "T9", kind: "ENTRY", side: "SHORT", qty: 0.00009, price: 100000, notional_usd: 9, fee_usd: 0.018, fee_rate_pct: 0.2, fee_model: "ndax", price_source: "kraken", price_at: "2026-11-12T00:00:00Z", filled_at: "2026-11-12T00:00:00Z" }],
    wallet_entries: [{ entry_key: "SWEEP:T9:IN", kind: "TRANSFER_IN", wallet: "MAIN", available_change_usd: 0.05418, reserved_change_usd: 0, note: "net profit", created_at: "2026-11-12T00:30:00Z" }],
    events: [], checks: [{ name: "net = gross − entry fee − exit fee", ok: true, detail: "0.05418" }], all_checks_ok: true,
    labels: { mode: "PAPER (simulated; no broker order)", fee_model: "ndax-flat-0.20-2026-11-12", short_model: "simulated, fully collateralised (no borrowing)" },
  };
  it("shows the orders, fills, wallet movements and checks, labelled PAPER and simulated short", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/bots/trade/T9"]}><Routes><Route path="/bots/trade/:id" element={<BotTradeProofView p={proof} />} /></Routes></MemoryRouter>);
    for (const s of ["CHECKS PASS", "OPEN_SHORT", "Collateral (simulated short)", "TRANSFER_IN", "PAPER (simulated; no broker order)", "fully collateralised"]) expect(html).toContain(s);
  });
  it("a failed check is shown as a failure", () => {
    const html = renderToStaticMarkup(<MemoryRouter><BotTradeProofView p={{ ...proof, all_checks_ok: false, checks: [{ name: "x", ok: false, detail: "1 vs 2" }] }} /></MemoryRouter>);
    expect(html).toContain("CHECK FAILED");
    expect(html).toContain("MISMATCH");
  });
});

import { mergeFunded } from "./fundedTrades";
import { computeMetrics } from "./performance";
describe("Home funded set: legacy ledger + bot ledger, never twice, never the mirror", () => {
  it("adds closed bot-ledger trades; legacy rows from bot-trades and open trades are not added", () => {
    const legacy = { id: 7, symbol: "SOLUSD", direction: "long", strategy: null, realized_pnl: 1.5, return_pct: null, cost_basis: 10, opened_at: "2026-11-10T00:00:00Z", closed_at: "2026-11-10T01:00:00Z", price_sources: null };
    const v = { status: "ok" as const, data: { verification: "v", trades: [legacy], truncated: false, excluded_closed_trades: 0 }, error: null };
    const row = (o: Record<string, unknown>) => ({ trade_id: "T", bot_id: "ALPHA-01", ledger: "bot", symbol: "SOLUSD", side: "LONG", status: "CLOSED", qty: 1, entry_price: 80, exit_price: 81,
      opened_at: "2026-11-11T00:00:00Z", closed_at: "2026-11-11T00:10:00Z", gross_usd: 1, fees_usd: 0.322, net_usd: 0.678, swept_usd: 0.678, stop: null, tp: null, proof_url: "/bots/trade/T", ...o }) as never;
    const merged = mergeFunded(v, [row({}), row({ trade_id: "L", ledger: "legacy", net_usd: 1.5 }), row({ trade_id: "O", status: "OPEN", net_usd: null })]);
    expect(merged.data!.trades.map((t) => t.id)).toEqual([7, -1]);
    const m = computeMetrics(merged.data!.trades, "ALL", Date.parse("2026-11-12T00:00:00Z"), null);
    expect(m.trades).toBe(2);
    expect(m.totalPnl).toBeCloseTo(2.18);
    expect(mergeFunded(v, null)).toBe(v);
  });
});
