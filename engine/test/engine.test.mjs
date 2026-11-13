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
    assert.equal(pivot([1, 2, 5, 5, 1], 2, "high"), null); // tie with a NEWER bar: not a pivot (TradingView)
    assert.equal(pivot([1, 5, 5, 2, 1], 2, "high"), 5); // tie with an OLDER bar: still a pivot (TradingView)
    assert.equal(pivot([9, 5, 5, 6, 9], 2, "low"), 5);
    assert.equal(pivot([1, 5, 5, 2, 1], 2, "high", { left: "strict", right: "strict" }), null);
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
  let clockSkewMs = 0;
  const now = () => CANDLES[visible - 1].t + STEP + 10_000 + clockSkewMs; // 10 s after the newest candle closed
  const inner = http ?? (async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    if (url.endsWith("/webhook/engine-status")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, code: "DRY_RUN_ACCEPTED" }), { status: 200 });
  });
  // A tiny model of the ALPHA PAPER ledger, kept from the dry-run responses (like D1), served by the
  // read-only /webhook/engine-ledger the engine uses for its checks. Tests can tamper with it.
  const ledger = { position: null, alerts: {}, queries: 0, down: false };
  const fakeHttp = async (url, init) => {
    if (url.endsWith("/webhook/engine-ledger")) {
      ledger.queries += 1;
      if (ledger.down) throw new TypeError("fetch failed");
      const ids = JSON.parse(init.body).alert_ids ?? [];
      return new Response(JSON.stringify({ ok: true, position: ledger.position, alerts: Object.fromEntries(ids.filter((i) => ledger.alerts[i]).map((i) => [i, ledger.alerts[i]])) }), { status: 200 });
    }
    const res = await inner(url, init);
    if (url.endsWith("/webhook/dry-run")) {
      const b = JSON.parse(init.body);
      const j = await res.clone().json().catch(() => ({}));
      if (res.status === 200 && j.code === "DRY_RUN_ACCEPTED") {
        ledger.alerts[b.id] = { status: "dry_run", response_code: "DRY_RUN_ACCEPTED", rejection_reason: null };
        ledger.position = b.action === "CLOSE" ? null : { symbol: b.symbol, side: b.action === "BUY" ? "long" : "short", status: "OPEN", qty: Number(b.qty), open_alert_id: b.id };
      } else if (res.status === 400 || res.status === 422) {
        ledger.alerts[b.id] = { status: "rejected", response_code: j.code ?? null, rejection_reason: j.message ?? null };
      } else if (res.status >= 500) {
        ledger.alerts[b.id] = { status: "error", response_code: j.code ?? null, rejection_reason: null };
      }
    }
    return res;
  };
  const make = () => new EngineRunner(cfg, { fetchCandles, http: fakeHttp, now, log: () => {} });
  return { cfg, sent, make, ledger, advance: (n = 1) => { visible += n; }, setMarketDown: (v) => { marketDown = v; }, skewClock: (ms) => { clockSkewMs = ms; } };
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

  it("every entry signal carries its recorded plan and every exit its strategy reason (stored by the Worker in payload_json)", async () => {
    const h = harness({ firstLive: firstFill });
    const r = h.make();
    await r.tick();
    for (let b = fillBars[0]; b <= fillBars[1]; b++) { h.advance(); await r.tick(); } // candle by candle, through the exit bar
    const orders = h.sent.filter((s) => s.url.endsWith("/dry-run")).map((s) => s.body);
    assert.ok(orders.length >= 2, `entry and exit sent (${orders.length})`);
    const [entry, exit] = orders;
    assert.equal(entry.plan.side, entry.action === "BUY" ? "LONG" : "SHORT");
    assert.ok(entry.plan.swing && Number.isFinite(entry.plan.swing.origin) && Number.isFinite(entry.plan.swing.end), "swing leg recorded");
    assert.equal(entry.plan.order.type, "LIMIT");
    assert.equal(entry.plan.order.limit, entry.plan.strategy_entry, "the limit the strategy placed is the price it filled at");
    assert.ok(Math.abs(entry.plan.ote_705 - entry.plan.order.limit) < 0.011, "the limit is the 70.5% OTE level, tick-rounded");
    assert.ok(Array.isArray(entry.plan.confluence) && entry.plan.confluence.length >= 1 && entry.plan.score >= 1, "the PD arrays that qualified");
    assert.ok(Number.isFinite(entry.plan.initial_stop) && Number.isFinite(entry.plan.tp2));
    assert.equal(entry.plan.inputs_hash.length, 16);
    assert.equal(exit.action, "CLOSE");
    assert.ok(["SL", "TP"].includes(exit.exit.kind) && typeof exit.exit.result === "string", JSON.stringify(exit.exit));
    assert.equal(exit.exit.initial_stop, entry.plan.initial_stop);
    assert.ok(!JSON.stringify(entry.plan).includes("secret"));
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

  it("catch-up after downtime: an entry from a candle that closed long ago is expired, not sent", async () => {
    const h = harness({ firstLive: firstFill });
    const r = h.make();
    await r.tick();
    h.advance(10); // engine was down for 10 candles; the fill bar is now 9 candles old
    await r.tick();
    const fills = r.state.outbox.filter((x) => x.barTime === new Date(CANDLES[firstFill].t).toISOString().replace(".000Z", "Z"));
    assert.equal(fills.length, 1);
    assert.deepEqual([fills[0].status, fills[0].code], ["skipped", "SIGNAL_EXPIRED"]);
    assert.notEqual(r.state.openEntryId, fills[0].id, "the engine does not keep a position the ledger never received");
    assert.ok(!r.state.outbox.some((x) => x.kind === "EXIT" && x.entryId === fills[0].id && x.status === "accepted"));
    assert.equal(h.sent.filter((s) => s.url.endsWith("/dry-run")).length,
      r.state.outbox.filter((x) => x.status === "accepted").length);
  });
});

describe("configuration", () => {
  it("SOLUSD and BTCUSD (owner-approved 2026-11-12) are enabled; futures, gold and stocks are refused; secrets stay out of printed config", () => {
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "does-not-exist" }).symbol, "SOLUSD");
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_SYMBOL: "BTCUSD" }).symbol, "BTCUSD");
    for (const s of ["MES1!", "MES", "MNQ", "GOLD", "ETHUSD", "SPY"]) assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "x", ENGINE_SYMBOL: s }), /not enabled/);
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

  it("rejected entry: recorded with the Worker's code, the engine position is dropped and no CLOSE ever follows", async () => {
    const { http, calls } = fakeAlpha((b) => (b.action === "CLOSE" ? accept() : [422, { code: "MAX_ORDER_NOTIONAL", message: "Estimated notional $40988 is above the limit $5000" }]));
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    const [entry] = r.state.outbox;
    assert.deepEqual([entry.status, entry.code, entry.positionDropped], ["rejected", "MAX_ORDER_NOTIONAL", true]);
    assert.match(entry.reason, /above the limit/);
    assert.equal(r.statusPayload().position, null, "the engine holds nothing the ledger does not hold");
    assert.equal(r.state.strategy.status, "Waiting for a swing");
    assert.equal(r.statusPayload().last_rejection.code, "MAX_ORDER_NOTIONAL");
    await runTo(h, r, FILLS[1].bar);
    assert.equal(calls.filter((c) => c.startsWith("CLOSE")).length, 0);
    assert.ok(!r.state.outbox.some((x) => x.entryId === entry.id), "no exit is created for a refused entry");
  });

  it("insufficient PAPER capital: refused BUY is dropped, never counted as an engine trade, stays flat across restarts, never re-sent", async () => {
    const decide = (b) => (b.action === "CLOSE" ? accept() : [422, { code: "INSUFFICIENT_PAPER_CAPITAL", message: "Estimated $1246.93 exceeds SOLUSD PAPER balance $10" }]);
    const { http, calls } = fakeAlpha(decide);
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    const entry = r.state.outbox[0];
    assert.deepEqual([entry.status, entry.code], ["rejected", "INSUFFICIENT_PAPER_CAPITAL"]);
    const st = r.statusPayload();
    assert.equal(st.position, null);
    assert.equal(st.refused_entries, 1);
    assert.equal(st.trades.closed, 0, "the refused trade is not an engine trade either");
    assert.equal(r.state.ledgerCheck.status, "OK", "engine and ledger are both flat");
    const audit = readFileSync(join(h.cfg.dataDir, "audit-SOLUSD-5m.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const dropped = audit.filter((a) => a.type === "entry_dropped");
    assert.deepEqual(dropped.map((a) => [a.id, a.code]), [[entry.id, "INSUFFICIENT_PAPER_CAPITAL"]]);
    // Restart from the saved state: still flat, nothing re-sent, nothing dropped twice.
    const r2 = h.make();
    await r2.tick();
    assert.equal(r2.statusPayload().position, null);
    assert.equal(r2.statusPayload().refused_entries, 1);
    assert.equal(calls.filter((c) => c.endsWith(entry.id)).length, 1, "the refused signal is sent exactly once");
    await runTo(h, r2, FILLS[1].bar);
    assert.equal(calls.filter((c) => c.startsWith("CLOSE")).length, 0);
  });

  it("upgrade: a refused position kept by an older engine's saved state is dropped once at start-up", async () => {
    let up = false;
    const { http, calls } = fakeAlpha(() => [422, { code: "INSUFFICIENT_PAPER_CAPITAL" }]);
    const h = harness({ firstLive: FILLS[0].bar, http: async (url, init) => { if (!up && url.endsWith("/dry-run")) throw new TypeError("fetch failed"); return http(url, init); } });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    assert.ok(r.statusPayload().position, "position held while the entry is pending");
    // What the previous engine version saved after a refusal: entry rejected, position still held.
    Object.assign(r.state.outbox[0], { status: "rejected", code: "INSUFFICIENT_PAPER_CAPITAL", reason: "older engine" });
    r.save();
    up = true;
    const r2 = h.make();
    assert.equal(r2.statusPayload().position, null);
    assert.equal(r2.state.outbox[0].positionDropped, true);
    assert.equal(h.make().statusPayload().refused_entries, 1, "dropped once");
    await r2.tick();
    assert.equal(calls.length, 0, "nothing re-sent");
  });

  it("recovery: after a refused entry, the next setup is taken once capital is available and runs to a recorded close", async () => {
    let funded = false;
    const { http, calls } = fakeAlpha((b) => (funded || b.action === "CLOSE" ? accept() : [422, { code: "INSUFFICIENT_PAPER_CAPITAL", message: "not enough" }]));
    const h = harness({ firstLive: FILLS[0].bar, http });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    assert.equal(r.state.outbox[0].status, "rejected");
    funded = true; // the owner adds PAPER capital
    const last = CANDLES.length - 1;
    while (r.state.strategy.bar < last && !r.state.outbox.some((x) => x.kind === "EXIT" && x.status === "accepted")) { h.advance(); await r.tick(); }
    const entries = r.state.outbox.filter((x) => x.kind === "ENTRY");
    assert.ok(entries.length >= 2, "a later setup produced a new entry");
    const taken = entries.find((x) => x.status === "accepted");
    assert.ok(taken, "the new entry was accepted");
    const exit = r.state.outbox.find((x) => x.kind === "EXIT" && x.entryId === taken.id);
    assert.equal(exit?.status, "accepted", "its CLOSE was sent and recorded");
    assert.equal(new Set(calls).size, calls.length, "every signal id sent once");
    assert.equal(r.statusPayload().trades.closed, 1, "only the trade the ledger took is an engine trade");
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

  it("duplicate after a lost reply: the Worker's DUPLICATE adopts the original refusal and drops the position once", async () => {
    const seen = new Map();
    let dropReply = true;
    const { http, calls } = fakeAlpha((b) => {
      if (seen.has(b.id)) return [200, { code: "DUPLICATE", data: seen.get(b.id) }];
      seen.set(b.id, { original_status: "rejected", original_code: "INSUFFICIENT_PAPER_CAPITAL" });
      return [422, { code: "INSUFFICIENT_PAPER_CAPITAL" }];
    });
    // The Worker records the refusal, but the connection drops before the engine reads the reply.
    const lossy = async (url, init) => {
      const res = await http(url, init);
      if (url.endsWith("/dry-run") && dropReply) { dropReply = false; throw new TypeError("socket hang up"); }
      return res;
    };
    const h = harness({ firstLive: FILLS[0].bar, http: lossy });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    const entry = r.state.outbox[0];
    assert.equal(entry.status, "pending", "outcome unknown after the lost reply");
    assert.ok(r.statusPayload().position, "the position is kept while the outcome is unknown");
    const r2 = h.make(); // restart
    await r2.flush();
    assert.deepEqual([r2.state.outbox[0].status, r2.state.outbox[0].code, r2.state.outbox[0].positionDropped], ["rejected", "INSUFFICIENT_PAPER_CAPITAL", true]);
    assert.equal(r2.statusPayload().position, null);
    assert.equal(r2.statusPayload().refused_entries, 1);
    await r2.flush();
    assert.equal(h.make().statusPayload().refused_entries, 1, "dropped once, not again");
    await runTo(h, r2, FILLS[1].bar);
    assert.equal(calls.filter((c) => c.startsWith("CLOSE")).length, 0);
    assert.equal(calls.filter((c) => c.endsWith(entry.id)).length, 2, "the original attempt plus one retry that learned the outcome");
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

// ---------------------------------------------------------------- freshness at delivery, guarded closes, ledger checks

describe("signal freshness and ledger reconciliation", () => {
  const dryRuns = (h) => h.sent.filter((x) => x.url.endsWith("/dry-run"));

  it("prolonged outage: an entry that never arrived is expired at delivery and never fills at a later price", async () => {
    let down = true;
    const h = harness({ firstLive: FILLS[0].bar, http: async (url, init) => {
      if (down && url.endsWith("/dry-run")) throw new TypeError("fetch failed");
      h.sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ code: "DRY_RUN_ACCEPTED" }), { status: 200 });
    } });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick(); // entry attempted, network down
    const entry = r.state.outbox[0];
    assert.deepEqual([entry.status, entry.attempts], ["pending", 1]);
    h.skewClock(45 * 60_000); // 45 minutes pass with nothing new from the market
    down = false;
    await h.make().tick(); // restart, network back
    const after = h.make().state.outbox[0];
    assert.deepEqual([after.status, after.code], ["skipped", "SIGNAL_EXPIRED"]);
    assert.match(after.reason, /not sent so it cannot fill at a later price/);
    assert.equal(after.positionDropped, true);
    assert.equal(h.make().statusPayload().position, null, "expired entry: engine flat, like the ledger");
    assert.equal(dryRuns(h).length, 0, "the old entry was not delivered");
  });

  it("expired entry whose earlier attempt did reach ALPHA TERMINAL: its real (accepted) outcome is adopted, not re-sent", async () => {
    let first = true;
    const h = harness({ firstLive: FILLS[0].bar, http: async (url, init) => {
      const b = JSON.parse(init.body);
      if (url.endsWith("/dry-run") && first) {
        first = false; // the Worker committed it, then the connection dropped before the reply
        h.ledger.alerts[b.id] = { status: "dry_run", response_code: "DRY_RUN_ACCEPTED", rejection_reason: null };
        h.ledger.position = { symbol: b.symbol, side: b.action === "BUY" ? "long" : "short", status: "OPEN", qty: Number(b.qty), open_alert_id: b.id };
        throw new TypeError("socket hang up");
      }
      h.sent.push({ url, body: b });
      return new Response(JSON.stringify({ code: "DRY_RUN_ACCEPTED" }), { status: 200 });
    } });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    h.skewClock(45 * 60_000);
    await r.tick();
    assert.deepEqual([r.state.outbox[0].status, r.state.outbox[0].reason], ["accepted", "confirmed in the ledger (earlier attempt)"]);
    assert.equal(r.statusPayload().position.ledger.status, "MIRRORED");
    assert.equal(dryRuns(h).length, 0, "not re-sent");
  });

  it("an exit of an accepted entry found during catch-up is still delivered, once, and marked as delayed", async () => {
    const h = harness({ firstLive: FILLS[0].bar });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick(); // entry accepted
    h.advance(FILLS[1].bar - FILLS[0].bar + 6); // engine down; the exit candle is now 6 candles old
    await r.tick();
    const exit = r.state.outbox.find((x) => x.kind === "EXIT");
    assert.deepEqual([exit.status, exit.code], ["accepted", "DRY_RUN_ACCEPTED"]);
    assert.ok(exit.delayedMin >= 30);
    assert.match(exit.reason, /delivered \d+ min after the engine's exit; the ledger closed at the live price/);
    assert.equal(h.ledger.position, null);
    assert.equal(dryRuns(h).filter((x) => x.body.action === "CLOSE").length, 1);
  });

  it("ledger divergence is reported, never called mirrored: wrong quantity, missing position, unknown engine position", async () => {
    const h = harness({ firstLive: FILLS[0].bar });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    assert.equal(r.statusPayload().ledger_check.status, "OK");
    assert.equal(r.statusPayload().position.ledger.status, "MIRRORED");
    h.ledger.position.qty += 1; // someone changed the ledger
    await r.tick();
    let st = r.statusPayload();
    assert.equal(st.ledger_check.status, "DIVERGED");
    assert.match(st.ledger_check.issues[0], /ledger qty .* vs engine/);
    assert.equal(st.position.ledger.status, "DIVERGED");
    h.ledger.position = null;
    await r.tick();
    assert.match(r.statusPayload().ledger_check.issues[0], /the ledger has no open SOLUSD position/);
    // engine flat but the ledger holds an engine-opened position
    const h2 = harness({ firstLive: FILLS[0].bar - 1 });
    const r2 = h2.make();
    await r2.tick();
    h2.ledger.position = { symbol: "SOLUSD", side: "long", status: "OPEN", qty: 3, open_alert_id: "ENG-SOLUSD-5-2026-10-01T00:00:00Z-BUY" };
    await r2.tick();
    st = r2.statusPayload();
    assert.equal(st.position, null);
    assert.equal(st.ledger_check.status, "DIVERGED");
    assert.match(st.ledger_check.issues[0], /engine-opened SOLUSD position .* that the engine does not hold/);
  });

  it("a CLOSE is not sent when the ledger no longer holds that entry's position; nothing misleading is created", async () => {
    const h = harness({ firstLive: FILLS[0].bar });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    h.ledger.position = null; // closed elsewhere (e.g. by hand)
    await runTo(h, r, FILLS[1].bar);
    const exit = r.state.outbox.find((x) => x.kind === "EXIT");
    assert.deepEqual([exit.status, exit.code], ["skipped", "LEDGER_NOT_HOLDING_ENTRY"]);
    assert.equal(dryRuns(h).filter((x) => x.body.action === "CLOSE").length, 0);
  });

  it("while the ledger cannot be read, a CLOSE waits (no blind close) and the position is UNVERIFIED", async () => {
    const h = harness({ firstLive: FILLS[0].bar });
    const r = h.make();
    await r.tick();
    h.advance();
    await r.tick();
    h.ledger.down = true;
    await r.tick();
    assert.equal(r.statusPayload().position.ledger.status, "UNVERIFIED");
    await runTo(h, r, FILLS[1].bar);
    const exit = r.state.outbox.find((x) => x.kind === "EXIT");
    assert.equal(exit.status, "pending");
    assert.equal(r.state.lastError.where, "ledger");
    h.ledger.down = false;
    await r.tick();
    assert.equal(exit.status, "accepted");
    assert.equal(dryRuns(h).filter((x) => x.body.action === "CLOSE").length, 1);
  });

  it("a second CLOSE for an already-closed entry is never sent (reconciliation and strategy exits cannot double up)", async () => {
    const h = harness({ firstLive: FILLS[0].bar });
    const r = h.make();
    await r.tick();
    await runTo(h, r, FILLS[1].bar);
    const [entry, exit] = r.state.outbox;
    assert.equal(exit.status, "accepted");
    r.state.outbox.push({ ...exit, id: `${exit.id}-RESYNC`, status: "pending", code: null, reason: null, attempts: 0, exitKind: "RECONCILE_AFTER_DATA_GAP" });
    await r.flush();
    assert.deepEqual([r.state.outbox.at(-1).status, r.state.outbox.at(-1).code], ["skipped", "ALREADY_CLOSED"]);
    assert.equal(dryRuns(h).filter((x) => x.body.action === "CLOSE").length, 1);
    assert.equal(entry.status, "accepted");
  });
});
