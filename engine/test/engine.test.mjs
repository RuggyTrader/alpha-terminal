// Engine tests: indicators, the fill emulator, the strategy port on real Kraken candles, and the live runner's
// restart / duplicate / reconnection behaviour. No network: candles come from a committed fixture of real
// Kraken SOLUSD 5m candles; synthetic bars below are labelled as test inputs, never reported as results.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { atrStep, highest, lowest, newAtr, pivot, roundToTick, zonedParts } from "../src/indicators.mjs";
import { cancelAll, closeAll, newBroker, placeEntry, placeExit, processBar } from "../src/broker.mjs";
import { createState, onBar } from "../src/ote.mjs";
import { EngineRunner } from "../src/runner.mjs";
import { checkFills, runBacktest } from "../src/cli/backtest.mjs";
import { loadConfig } from "../src/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8"));
const CANDLES = FIX.candles;
const STEP = 300_000;
const bar = (t, o, h, l, c) => ({ t, o, h, l, c, i: 0 }); // synthetic test bar

describe("indicators (Pine equivalents)", () => {
  it("ta.atr(14): SMA of the first 14 true ranges, then Wilder's RMA", () => {
    const s = newAtr();
    const trs = [];
    let prevC = null;
    for (let i = 0; i < 20; i++) {
      const h = 10 + (i % 3), l = 8 - (i % 2), c = 9 + (i % 4) / 2;
      trs.push(prevC === null ? h - l : Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
      const v = atrStep(s, h, l, 14);
      s.prevClose = c;
      prevC = c;
      if (i < 13) assert.equal(v, null, `na before 14 bars (bar ${i})`);
    }
    let expect = trs.slice(0, 14).reduce((a, b) => a + b) / 14;
    for (let i = 14; i < 20; i++) expect = (trs[i] + 13 * expect) / 14;
    assert.ok(Math.abs(s.value - expect) < 1e-12);
  });

  it("pivots need L bars each side; lowest/highest are na until n bars", () => {
    assert.equal(pivot([1, 2, 5, 2, 1], 2, "high"), 5);
    assert.equal(pivot([1, 2, 5, 5, 1], 2, "high"), null); // equal neighbour: not a strict pivot
    assert.equal(pivot([1, 2, 5, 5, 1], 2, "high", { left: "strict", right: "loose" }), 5);
    assert.equal(pivot([5, 4, 1, 4, 5], 2, "low"), 1);
    assert.equal(pivot([1, 2, 5, 2], 2, "high"), null);
    assert.equal(lowest([3, 1, 2], 4), null);
    assert.equal(lowest([3, 1, 2], 3), 1);
    assert.equal(highest([3, 1, 2], 2), 2);
  });

  it("round_to_mintick and New York session time (DST aware)", () => {
    assert.equal(roundToTick(93.145, 0.01), 93.15);
    assert.equal(roundToTick(93.1449, 0.01), 93.14);
    assert.deepEqual(zonedParts(Date.parse("2026-11-02T21:45:00Z"), "America/New_York"), { hour: 16, minute: 45, dow: 2 }); // EST
    assert.deepEqual(zonedParts(Date.parse("2026-07-03T20:45:00Z"), "America/New_York"), { hour: 16, minute: 45, dow: 6 }); // EDT, Friday
  });
});

describe("fill emulator (TradingView broker emulator rules)", () => {
  it("orders placed at a close are worked from the next bar; market entries fill at the next open", () => {
    const br = newBroker();
    placeEntry(br, { id: "L", side: 1, qty: 2, limit: null });
    assert.equal(br.pos, null, "nothing fills at the bar where the order is placed");
    const ev = processBar(br, bar(STEP, 100, 101, 99, 100.5));
    assert.equal(ev[0].type, "ENTRY_FILL");
    assert.equal(ev[0].price, 100);
  });

  it("buy limit fills at its price, or at the open when the bar gaps below it", () => {
    let br = newBroker();
    placeEntry(br, { id: "L", side: 1, qty: 1, limit: 99.5 });
    processBar(br, bar(STEP, 100, 100.2, 99.0, 99.8));
    assert.equal(br.pos.avg, 99.5);
    br = newBroker();
    placeEntry(br, { id: "L", side: 1, qty: 1, limit: 99.5 });
    processBar(br, bar(STEP, 99.0, 99.4, 98.8, 99.2));
    assert.equal(br.pos.avg, 99.0);
  });

  it("stop loss gaps fill at the open (worse), TP gaps at the open (better)", () => {
    let br = newBroker();
    br.pos = { side: 1, qty: 1, avg: 100, entryId: "L", entryTime: 0, entryBar: 0 };
    placeExit(br, { from: "L", limit: 105, stop: 98 });
    processBar(br, bar(STEP, 97, 97.5, 96, 97));
    assert.equal(br.closed[0].exitPrice, 97);
    assert.equal(br.closed[0].exitKind, "SL");
    br = newBroker();
    br.pos = { side: 1, qty: 1, avg: 100, entryId: "L", entryTime: 0, entryBar: 0 };
    placeExit(br, { from: "L", limit: 105, stop: 98 });
    processBar(br, bar(STEP, 106, 107, 105.5, 106));
    assert.equal(br.closed[0].exitPrice, 106);
    assert.equal(br.closed[0].exitKind, "TP");
  });

  it("when both TP and SL are inside one bar, the intrabar path decides (open nearer the high → high first)", () => {
    const run = (o, h, l, c) => {
      const br = newBroker();
      br.pos = { side: 1, qty: 1, avg: 100, entryId: "L", entryTime: 0, entryBar: 0 };
      placeExit(br, { from: "L", limit: 102, stop: 98 });
      processBar(br, bar(STEP, o, h, l, c));
      return br.closed[0].exitKind;
    };
    assert.equal(run(101.5, 102.5, 97.5, 100), "TP"); // open nearer high: O→H→L→C
    assert.equal(run(98.5, 102.5, 97.5, 100), "SL"); // open nearer low: O→L→H→C
  });

  it("entry and its bracket can both fill on the same bar, along the path", () => {
    const br = newBroker();
    placeEntry(br, { id: "L", side: 1, qty: 1, limit: 99 });
    placeExit(br, { from: "L", limit: 101, stop: 97 });
    processBar(br, bar(STEP, 100, 101.5, 98.5, 101)); // O→L(98.5) fills entry at 99, then →H(101.5) hits TP
    assert.equal(br.closed.length, 1);
    assert.deepEqual([br.closed[0].entryPrice, br.closed[0].exitPrice, br.closed[0].exitKind], [99, 101, "TP"]);
  });

  it("cancel_all removes pending orders; close_all exits at the close", () => {
    const br = newBroker();
    placeEntry(br, { id: "L", side: 1, qty: 1, limit: 99 });
    cancelAll(br);
    processBar(br, bar(STEP, 100, 100, 90, 95));
    assert.equal(br.pos, null);
    br.pos = { side: -1, qty: 2, avg: 100, entryId: "S", entryTime: 0, entryBar: 0 };
    const ev = [];
    closeAll(br, { t: 2 * STEP, o: 99, h: 99, l: 97, c: 98, i: 2 }, ev);
    assert.equal(br.closed.at(-1).exitPrice, 98);
    assert.equal(br.closed.at(-1).pnl, 4); // short: (100 − 98) × 2
  });
});

describe("strategy port on real Kraken SOLUSD 5m candles", () => {
  const full = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 });

  it("produces orders and trades, and every fill lies inside its real candle", () => {
    assert.ok(full.events.some((e) => e.type === "ORDER_PLACED"));
    assert.ok(full.trades.length > 0, "the fixture period contains at least one trade");
    assert.deepEqual(checkFills(CANDLES, full.trades), []);
  });

  it("is deterministic", () => {
    const again = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 });
    assert.deepEqual(again.events, full.events);
  });

  it("has no lookahead: decisions up to a bar do not change when later candles are added", () => {
    for (const k of [200, 400, 600]) {
      const part = runBacktest({ candles: CANDLES.slice(0, k), symbol: "SOLUSD", intervalMin: 5 });
      const upTo = full.events.filter((e) => e.bar < k);
      assert.deepEqual(part.events, upTo, `cut at ${k}`);
    }
  });

  it("restart: saving state as JSON mid-run and resuming gives exactly the uninterrupted result", () => {
    const S = createState({ symbol: "SOLUSD", timeframeMin: 5 });
    const ev = [];
    for (const k of CANDLES.slice(0, 333)) ev.push(...onBar(S, k).map((e) => ({ ...e, time: new Date(k.t).toISOString() })));
    const resumed = JSON.parse(JSON.stringify(S));
    for (const k of CANDLES.slice(333)) ev.push(...onBar(resumed, k).map((e) => ({ ...e, time: new Date(k.t).toISOString() })));
    assert.deepEqual(ev, full.events);
    assert.throws(() => onBar(resumed, CANDLES.at(-1)), /not after the last processed bar/);
  });

  it("break-even moves the stop exactly to entry and trailing only ever tightens", () => {
    let inTrade = null;
    for (const e of full.events) {
      if (e.type === "IN_TRADE") inTrade = { ...e, stop: e.stop };
      if (e.type === "STOP_TO_BREAK_EVEN") assert.equal(e.stop, inTrade.entry);
      if (e.type === "TRAILING_STOP_MOVED") {
        if (inTrade.side === 1) assert.ok(e.stop >= inTrade.stop - 1e-9); else assert.ok(e.stop <= inTrade.stop + 1e-9);
      }
      if (e.type === "STOP_TO_BREAK_EVEN" || e.type === "TRAILING_STOP_MOVED") inTrade.stop = e.stop;
    }
  });

  it("risk per trade scales the size, not the decisions", () => {
    const half = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, inputs: { riskUSD: 100 } });
    assert.equal(half.trades.length, full.trades.length);
    for (let i = 0; i < full.trades.length; i++) {
      assert.ok(Math.abs(half.trades[i].qty * 2 - full.trades[i].qty) < 1e-9);
      assert.equal(half.trades[i].entryTime, full.trades[i].entryTime);
    }
  });
});

// ---------------------------------------------------------------- live runner (fake market data + fake ALPHA TERMINAL)

function harness({ firstLive, http } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "alpha-engine-"));
  const cfg = { symbol: "SOLUSD", intervalMin: 5, inputs: {}, sync: true, apiBase: "http://alpha.test", webhookSecret: "test-secret", dataDir, lateBars: 2, krakenBase: "" };
  let visible = firstLive; // candles [0, visible) are "completed" so far
  let marketDown = false;
  const sent = [];
  const fetchCandles = async ({ sinceMs }) => {
    if (marketDown) throw new Error("ECONNRESET");
    return CANDLES.slice(0, visible).filter((k) => sinceMs === null || k.t > sinceMs);
  };
  const now = () => CANDLES[visible - 1].t + STEP + 10_000; // 10 s after the newest candle closed
  const fakeHttp = http ?? (async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    if (url.endsWith("/webhook/engine-status")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, code: "DRY_RUN_ACCEPTED" }), { status: 200 });
  });
  const make = () => new EngineRunner(cfg, { fetchCandles, http: fakeHttp, now, log: () => {} });
  return { cfg, sent, make, advance: (n = 1) => { visible += n; }, setMarketDown: (v) => { marketDown = v; } };
}

const fillBars = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 }).events
  .filter((e) => e.type === "ENTRY_FILL" || e.type === "EXIT_FILL").map((e) => e.bar);

describe("live runner: completed candles, outbox, restarts", () => {
  const firstFill = fillBars[0];
  assert.ok(firstFill > 100, "fixture has warm-up room before the first fill");

  it("warm-up history is processed but never sent; live fills are sent once with deterministic ids", async () => {
    const h = harness({ firstLive: firstFill }); // warm-up ends just before the first fill bar
    const r = h.make();
    await r.tick();
    assert.equal(h.sent.filter((s) => s.url.endsWith("/dry-run")).length, 0);
    assert.equal(r.state.strategy.bar, firstFill - 1);
    h.advance(); // the fill bar closes
    await r.tick();
    const orders = h.sent.filter((s) => s.url.endsWith("/dry-run"));
    assert.equal(orders.length, 1);
    const b = orders[0].body;
    assert.match(b.id, /^ENG-SOLUSD-5-\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ-(BUY|SELL)$/);
    assert.equal(b.symbol, "SOLUSD");
    assert.equal(b.strategy, "OTE Pro Strat (engine)");
    assert.equal(b.secret, "test-secret");
    assert.ok(Number(b.qty) > 0);
    assert.ok(h.sent.some((s) => s.url.endsWith("/webhook/engine-status") && s.body.status.mode === "PAPER"));

    await r.tick(); // nothing new
    assert.equal(h.sent.filter((s) => s.url.endsWith("/dry-run")).length, 1);
    const restarted = h.make(); // process restart from the saved state file
    await restarted.tick();
    assert.equal(h.sent.filter((s) => s.url.endsWith("/dry-run")).length, 1, "a restart does not resend");
    assert.equal(restarted.state.strategy.bar, firstFill);
  });

  it("ALPHA TERMINAL down (5xx): the signal stays pending and is delivered exactly once when it is back", async () => {
    let down = true;
    const calls = [];
    const http = async (url, init) => {
      if (url.endsWith("/webhook/engine-status")) return new Response("{}", { status: 200 });
      calls.push(JSON.parse(init.body).id);
      return down ? new Response(JSON.stringify({ code: "LEDGER_ERROR", retryable: true }), { status: 500 })
        : new Response(JSON.stringify({ code: "DRY_RUN_ACCEPTED" }), { status: 200 });
    };
    const h = harness({ firstLive: firstFill, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    assert.equal(r.state.outbox.filter((x) => x.status === "pending").length, 1);
    assert.equal(r.state.lastError.where, "sync");
    down = false;
    await h.make().tick(); // restart while it was failing
    const r2 = h.make();
    assert.equal(r2.state.outbox.filter((x) => x.status === "accepted").length, 1);
    assert.equal(new Set(calls).size, 1, "only one signal id was ever sent");
    await r2.tick();
    assert.equal(calls.length, 2, "one failed attempt + one delivery, no more");
  });

  it("a rejection (422) is final and recorded with ALPHA TERMINAL's code", async () => {
    const http = async (url) => (url.endsWith("/webhook/engine-status") ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({ code: "MAX_ORDER_NOTIONAL", message: "above the limit" }), { status: 422 }));
    const h = harness({ firstLive: firstFill, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    assert.deepEqual(r.state.outbox.map((x) => [x.status, x.code]), [["rejected", "MAX_ORDER_NOTIONAL"]]);
  });

  it("market data outage: no candle is skipped or invented; processing resumes in order", async () => {
    const h = harness({ firstLive: firstFill - 5 });
    const r = h.make();
    await r.tick();
    h.setMarketDown(true);
    h.advance(3);
    const out = await r.tick();
    assert.equal(out.processed, 0);
    assert.equal(r.state.lastError.where, "market-data");
    h.setMarketDown(false);
    await r.tick();
    assert.equal(r.state.strategy.bar, firstFill - 3);
    assert.equal(r.state.lastError, null);
  });

  it("catch-up after downtime: fills from candles that closed long ago are recorded as late, not sent", async () => {
    const h = harness({ firstLive: firstFill });
    const r = h.make();
    await r.tick();
    h.advance(10); // engine was down for 10 candles; the fill bar is now 9 candles old
    await r.tick();
    const fills = r.state.outbox.filter((x) => x.barTime === new Date(CANDLES[firstFill].t).toISOString().replace(".000Z", "Z"));
    assert.equal(fills.length, 1);
    assert.equal(fills[0].status, "late");
    assert.equal(h.sent.filter((s) => s.url.endsWith("/dry-run")).length,
      r.state.outbox.filter((x) => x.status === "accepted").length);
  });
});

describe("configuration", () => {
  it("only SOLUSD is enabled; futures and gold are refused; secrets stay out of printed config", () => {
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "does-not-exist" }).symbol, "SOLUSD");
    for (const s of ["MES1!", "MES", "MNQ", "GOLD", "BTCUSD", "SPY"]) assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_SYMBOL: s }), /not enabled/);
    assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_SYNC: "on" }), /needs ALPHA_API_BASE/);
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "x", STRAT_RISK_USD: "20" }).inputs.riskUSD, 20);
  });

  it("the engine has no broker or order-submission code", () => {
    for (const f of ["runner.mjs", "ote.mjs", "broker.mjs", "kraken.mjs", "config.mjs", "cli/run.mjs"]) {
      const src = readFileSync(join(HERE, "..", "src", f), "utf8");
      assert.ok(!/alpaca|\/v2\/orders|ENABLE_TRADING\s*=\s*true/i.test(src), f);
    }
  });
});

describe("env file and TradingView comparison tooling", () => {
  it("env files support comments and quoted values", async () => {
    const { writeFileSync } = await import("node:fs");
    const { loadEnvFile } = await import("../src/config.mjs");
    const dir = mkdtempSync(join(tmpdir(), "alpha-env-"));
    const f = join(dir, "e.env");
    writeFileSync(f, "# c\nENGINE_SYMBOL=SOLUSD   # note\nALPHA_WEBHOOK_SECRET=\"a#b c\"\nSTRAT_RISK_USD=20\n");
    assert.deepEqual(loadEnvFile(f), { ENGINE_SYMBOL: "SOLUSD", ALPHA_WEBHOOK_SECRET: "a#b c", STRAT_RISK_USD: "20" });
  });

  it("reads a TradingView 'List of trades' CSV (test input) and lists every difference", async () => {
    const { readTradingViewTrades, compareTrades } = await import("../src/cli/compare-tv.mjs");
    const csv = [
      "Trade #,Type,Signal,Date/Time,Price USD,Contracts,Profit USD",
      "2,Exit long,OTE Long TP2,2026-11-02 14:15,93.87,242.43,0",
      "2,Entry long,OTE Long,2026-11-02 13:05,93.87,242.43,0",
      "1,Exit short,OTE Short TP2,2026-11-01 23:35,94.29,367.71,0",
      "1,Entry short,OTE Short,2026-11-01 23:10,94.29,367.71,0",
    ].join("\n");
    const tv = readTradingViewTrades(csv, "UTC");
    assert.equal(tv.length, 2);
    assert.equal(tv[0].side, "SHORT");
    const engine = [
      { side: "SHORT", qty: 367.71, entryTime: "2026-11-01T23:10:00.000Z", entryPrice: 94.29, exitTime: "2026-11-01T23:35:00.000Z", exitPrice: 94.29, pnl: 0 },
      { side: "LONG", qty: 242.43, entryTime: "2026-11-02T13:05:00.000Z", entryPrice: 93.88, exitTime: "2026-11-02T14:15:00.000Z", exitPrice: 93.87, pnl: 0 },
    ];
    const r = compareTrades(tv, engine);
    assert.equal(r.matchedByEntry, 2);
    assert.equal(r.identical, 1);
    assert.match(r.differences[0].differences[0], /entry price TV 93.87 vs engine 93.88/);
    assert.equal(readTradingViewTrades(csv.replace(/2026-11-01 23:10/, "2026-11-01 18:10"), "America/New_York")[0].entryTime, Date.parse("2026-11-01T23:10:00Z"));
  });
});

// ---------------------------------------------------------------- engine ↔ ALPHA PAPER ledger synchronisation

const FILLS = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 }).events
  .filter((e) => e.type === "ENTRY_FILL" || e.type === "EXIT_FILL").map((e) => ({ bar: e.bar, type: e.type }));
// Fixture trades (real data): [entry FILLS[0], exit FILLS[1]], [entry FILLS[2], exit FILLS[3]], …
const fakeAlpha = (decide) => {
  const calls = [];
  const http = async (url, init) => {
    if (url.endsWith("/webhook/engine-status")) return new Response("{}", { status: 200 });
    const body = JSON.parse(init.body);
    calls.push(`${body.action}:${body.id}`);
    const [status, json] = decide(body, calls);
    return new Response(JSON.stringify(json), { status });
  };
  return { http, calls };
};
const accept = () => [200, { code: "DRY_RUN_ACCEPTED" }];
async function runTo(h, r, bar) { while (r.state.strategy.bar < bar) { h.advance(); await r.tick(); } }

describe("engine ↔ ALPHA PAPER ledger sync", () => {
  it("accepted entry → its CLOSE is sent after it, both accepted, position shown as MIRRORED while open", async () => {
    const { http, calls } = fakeAlpha(accept);
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    assert.deepEqual(r.statusPayload().position.ledger, { status: "MIRRORED", reason: null });
    await runTo(h, r, FILLS[1].bar);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^(BUY|SELL):/);
    assert.match(calls[1], /^CLOSE:/);
    const [entry, exit] = r.state.outbox;
    assert.deepEqual([entry.status, exit.status, exit.entryId], ["accepted", "accepted", entry.id]);
  });

  it("rejected entry followed by a simulated exit: the CLOSE is never sent, recorded as skipped with the reason", async () => {
    const { http, calls } = fakeAlpha((b) => (b.action === "CLOSE" ? accept() : [422, { code: "MAX_ORDER_NOTIONAL", message: "Estimated notional $40988 is above the limit $5000" }]));
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    const link = r.statusPayload().position.ledger;
    assert.equal(link.status, "NOT_IN_LEDGER");
    assert.match(link.reason, /rejected: MAX_ORDER_NOTIONAL/);
    await runTo(h, r, FILLS[1].bar);
    assert.equal(calls.length, 1, "only the entry was submitted");
    const [entry, exit] = r.state.outbox;
    assert.deepEqual([entry.status, entry.code], ["rejected", "MAX_ORDER_NOTIONAL"]);
    assert.match(entry.reason, /above the limit/);
    assert.deepEqual([exit.status, exit.code], ["skipped", "ENTRY_NOT_IN_LEDGER"]);
    assert.match(exit.reason, /was rejected \(MAX_ORDER_NOTIONAL\)/);
    assert.equal(r.statusPayload().last_rejection.status, "skipped");
  });

  it("historical warm-up position followed by a live CLOSE: nothing is sent", async () => {
    const { http, calls } = fakeAlpha(accept);
    const h = harness({ firstLive: FILLS[0].bar + 1, http }); // warm-up includes the entry fill
    const r = h.make();
    await r.tick();
    assert.equal(r.state.outbox[0].status, "historical");
    assert.equal(r.statusPayload().position.ledger.status, "NOT_IN_LEDGER");
    await runTo(h, r, FILLS[1].bar);
    assert.equal(calls.length, 0);
    assert.deepEqual([r.state.outbox[1].status, r.state.outbox[1].code], ["skipped", "ENTRY_NOT_IN_LEDGER"]);
    assert.match(r.state.outbox[1].reason, /was historical/);
  });

  it("network interruption: entry and exit wait while ALPHA TERMINAL is unreachable, then go out once each, in order", async () => {
    let up = false;
    const { http, calls } = fakeAlpha(accept);
    const flaky = async (url, init) => { if (!up && url.endsWith("/dry-run")) throw new TypeError("fetch failed"); return http(url, init); };
    const h = harness({ firstLive: FILLS[0].bar, http: flaky });
    const r = h.make();
    await r.tick();
    // stay down while the entry and (lateBars allowing) the exit happen
    const exitBar = FILLS[1].bar;
    const near = exitBar - FILLS[0].bar <= 2;
    await runTo(h, r, near ? exitBar : FILLS[0].bar);
    assert.equal(calls.length, 0);
    assert.ok(r.state.outbox.every((x) => x.status === "pending"));
    assert.equal(r.state.lastError.where, "sync");
    up = true;
    await r.tick(); // reconnect: nothing new from the market, outbox flushes
    await runTo(h, r, exitBar);
    await h.make().tick(); // and a restart afterwards
    assert.deepEqual(calls.map((c) => c.split(":")[0]), [calls[0].split(":")[0], "CLOSE"]);
    assert.equal(new Set(calls).size, calls.length, "each signal once");
    assert.deepEqual(h.make().state.outbox.map((x) => x.status), ["accepted", "accepted"]);
  });

  it("data gap re-warm: an open ledger position the engine would forget is closed (reconciliation), once", async () => {
    const { http, calls } = fakeAlpha(accept);
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance(); // entry accepted, engine position open
    await r.tick();
    assert.equal(r.statusPayload().position.ledger.status, "MIRRORED");
    // Kraken now only has candles after a hole: drop the next 3 candles from the feed.
    const realFetch = r.fetchCandles;
    const holeFrom = CANDLES[FILLS[0].bar + 1].t, holeTo = CANDLES[FILLS[0].bar + 3].t;
    r.fetchCandles = async (a) => (await realFetch(a)).filter((k) => k.t < holeFrom || k.t > holeTo);
    h.advance(5);
    await r.tick();
    const resync = r.state.outbox.filter((x) => x.exitKind === "RECONCILE_AFTER_DATA_GAP");
    assert.equal(resync.length, 1);
    assert.deepEqual([resync[0].action, resync[0].status, resync[0].entryId], ["CLOSE", "accepted", r.state.outbox[0].id]);
    assert.equal(calls.filter((c) => c.startsWith("CLOSE")).length, 1);
    assert.equal(r.state.resets.at(-1).reason.startsWith("gap of"), true);
    assert.ok(r.state.warmedUpAt, "re-warmed from available history");
  });

  it("duplicate after a crash: the Worker's DUPLICATE adopts the original result (accepted or rejected)", async () => {
    const seen = new Map();
    const { http, calls } = fakeAlpha((b) => {
      if (seen.has(b.id)) return [200, { code: "DUPLICATE", data: seen.get(b.id) }];
      const res = b.action === "CLOSE" ? { original_status: "dry_run", original_code: "DRY_RUN_ACCEPTED" } : { original_status: "rejected", original_code: "SHORT_DISABLED" };
      seen.set(b.id, res);
      return b.action === "CLOSE" ? accept() : [422, { code: "SHORT_DISABLED" }];
    });
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    const entry = r.state.outbox[0];
    entry.status = "pending"; // crash after sending, before the result was saved
    r.save();
    const r2 = h.make();
    await r2.flush();
    assert.deepEqual([r2.state.outbox[0].status, r2.state.outbox[0].code], ["rejected", "SHORT_DISABLED"]);
    await runTo(h, r2, FILLS[1].bar);
    assert.equal(r2.state.outbox[1].status, "skipped", "the CLOSE of a rejected entry is still not sent");
    assert.equal(calls.filter((c) => c.startsWith("CLOSE")).length, 0);
  });

  it("engine P&L in the status equals the engine's own closed trades", async () => {
    const { http } = fakeAlpha(accept);
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    await runTo(h, r, FILLS[3].bar);
    const st = r.statusPayload();
    const closed = r.state.strategy.broker.closed;
    assert.equal(st.trades.closed, closed.length);
    assert.equal(st.trades.net_pnl, Number(closed.reduce((s, t) => s + t.pnl, 0).toFixed(2)));
    assert.equal(st.position, null);
    assert.equal(st.outbox.accepted, 4);
  });
});

describe("PAPER test profile", () => {
  it("only lowers risk per trade; every other input stays at the Pine default", async () => {
    const { DEFAULT_INPUTS } = await import("../src/ote.mjs");
    const base = loadConfig({ ENGINE_ENV_FILE: "x" }, join(HERE, ".."));
    const test = loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_PROFILE: "paper-test" }, join(HERE, ".."));
    assert.deepEqual([base.profile, base.inputs], ["default", {}]);
    assert.deepEqual([test.profile, test.inputs], ["paper-test", { riskUSD: 5 }]);
    assert.equal(DEFAULT_INPUTS.riskUSD, 200, "the strategy default is unchanged");
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_PROFILE: "" }, join(HERE, "..")).profile, "default");
    assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_PROFILE: "nope" }, join(HERE, "..")), /not found/);
  });

  it("on the real fixture, every paper-test order fits ALPHA TERMINAL's $5,000 per-order limit; the default does not", () => {
    const test = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5, inputs: { riskUSD: 5 } });
    const dflt = runBacktest({ candles: CANDLES, symbol: "SOLUSD", intervalMin: 5 });
    assert.ok(test.trades.every((t) => t.qty * t.entryPrice <= 5000));
    assert.ok(dflt.trades.some((t) => t.qty * t.entryPrice > 5000));
    assert.deepEqual(test.trades.map((t) => [t.entryTime, t.exitTime, t.result]), dflt.trades.map((t) => [t.entryTime, t.exitTime, t.result]), "same decisions, smaller size");
  });
});
