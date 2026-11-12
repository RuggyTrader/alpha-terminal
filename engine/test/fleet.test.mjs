// The bot fleet (docs/MULTI-BOT-ARCHITECTURE.md). PERMANENT requirement: every market, timeframe or strategy is a bot
// in src/bots.mjs with its own exact profile, wallet, dollar risk, LONG/SHORT simulation and accounting; these tests
// must keep passing for every bot.   node --test test/fleet.test.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BOTS, botIdPrefix, botTag, registryProblems, selectBots } from "../src/bots.mjs";
import { FleetLedgerSim, fromMicro, splitEqual, toMicro } from "../src/capital.mjs";
import { loadBotConfigs } from "../src/config.mjs";
import { CandleCache, FleetRunner } from "../src/fleet.mjs";
import { getInstrument } from "../src/instruments.mjs";
import { EngineRunner, inputsHash } from "../src/runner.mjs";
import { sizePosition } from "../src/sizing.mjs";
import { aggregate, profileInputs, runFleetBacktest } from "../src/cli/fleet-backtest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const SOL1 = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-1m-2026-11-10_2026-11-12.json"), "utf8")).candles;
const BTC1 = JSON.parse(readFileSync(join(HERE, "fixtures", "BTCUSD-1m-2026-11-01_2026-11-03.json"), "utf8")).candles;
const SOL5 = aggregate(SOL1, 5), BTC5 = aggregate(BTC1, 5);
const CANDLES = { "SOLUSD|1": SOL1, "SOLUSD|5": SOL5, "BTCUSD|1": BTC1, "BTCUSD|5": BTC5 };
const temps = [];
after(() => { for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "alpha-fleet-")); temps.push(d); return d; };
const ALL = ["ALPHA-01", "ALPHA-02", "ALPHA-03", "ALPHA-04"];
const env0 = (o = {}) => ({ ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: tmp(), ...o });

// The owner's master table (2026-11-12): the values that differ between the four profiles.
const MASTER = {
  "ALPHA-02": { swingLen: 5, minLegATR: 3.5, maxAge: 32, slBuf: 0.1, tp2Ext: 0.25, fvgMinATR: 0.1, rbWick: 0.5, rbMinATR: 0.8, rbLook: 8, beFrac: 0.45, trailFrac: 0.05, trailLen: 3, trailBuf: 0.05 },
  "ALPHA-01": { swingLen: 8, minLegATR: 5, maxAge: 75, slBuf: 0.1, tp2Ext: -0.55, fvgMinATR: 0.1, rbWick: 0.5, rbMinATR: 0.8, rbLook: 8, beFrac: 0.25, trailFrac: 0.2, trailLen: 4, trailBuf: 0.35 },
  "ALPHA-04": { swingLen: 8, minLegATR: 5.5, maxAge: 37, slBuf: 0, tp2Ext: -0.15, fvgMinATR: 0.15, rbWick: 0.6, rbMinATR: 1, rbLook: 15, beFrac: 0.4, trailFrac: 0.05, trailLen: 3, trailBuf: 0.2 },
  "ALPHA-03": { swingLen: 12, minLegATR: 5, maxAge: 85, slBuf: 0.2, tp2Ext: -0.55, fvgMinATR: 0.1, rbWick: 0.5, rbMinATR: 0.8, rbLook: 8, beFrac: 0.35, trailFrac: 0.2, trailLen: 4, trailBuf: 0.25 },
};
const COMMON = { minScore: 1, useFVG: true, useOB: true, useRB: true, dispATR: 1, maxZones: 70, allowLong: true, allowShort: true, riskUSD: 10, useBE: true, useTrail: true,
  useHours: false, weekendFlat: false, useSleep: false, entryMode: "Limit @ 0.705", slMode: "Swing origin (1.0)" };

describe("four-bot registry (permanent gate)", () => {
  it("the lineup: SOL 1m, SOL 5m (legacy production), BTC 1m, BTC 5m; ETH disabled; own wallets; Kraken data", () => {
    assert.deepEqual(registryProblems(BOTS), []);
    const live = BOTS.filter((b) => b.status !== "DISABLED").map((b) => [b.id, b.symbol, b.intervalMin, b.profile, b.group, b.wallet]);
    assert.deepEqual(live, [["ALPHA-01", "SOLUSD", 1, "solusd-1m", "SOLANA", "ALPHA-01"], ["ALPHA-02", "SOLUSD", 5, "solusd-5m", "SOLANA", "SOLUSD"],
      ["ALPHA-03", "BTCUSD", 1, "btcusd-1m", "BITCOIN", "ALPHA-03"], ["ALPHA-04", "BTCUSD", 5, "btcusd-5m", "BITCOIN", "ALPHA-04"]]);
    assert.deepEqual(BOTS.filter((b) => b.symbol === "ETHUSD").map((b) => b.status), ["DISABLED", "DISABLED"]);
    for (const b of BOTS) assert.equal(b.provider, "kraken", b.id);
    assert.equal(botTag(BOTS[1]), "SOLUSD-5m"); assert.equal(botIdPrefix(BOTS[1]), "ENG-SOLUSD-5", "ALPHA-02 keeps its production identity");
    assert.equal(botTag(BOTS[0]), "ALPHA-01-SOLUSD-1m"); assert.equal(botIdPrefix(BOTS[2]), "ENG-ALPHA-03-BTCUSD-1");
  });
  it("only ALPHA-02 is ACTIVE; the new bots are refused for production until approved", () => {
    assert.deepEqual(BOTS.filter((b) => b.status === "ACTIVE").map((b) => b.id), ["ALPHA-02"]);
    for (const id of ["ALPHA-01", "ALPHA-03", "ALPHA-04"]) assert.throws(() => selectBots([id]), /PROPOSED/);
    for (const id of ["ALPHA-05", "ALPHA-06"]) assert.throws(() => selectBots([id], { allowProposed: true }), /disabled/);
  });
  it("invalid registries are refused with the reason (shared wallet, wrong profile, placeholder inputs, not Kraken…)", () => {
    const a1 = BOTS[0];
    const cases = [
      [[a1, { ...a1 }], /duplicate bot id/],
      [[a1, { ...BOTS[2], wallet: "ALPHA-01" }], /own wallet|shared/],
      [[{ ...a1, profile: "solusd-5m" }], /not the SOLUSD 1m profile/],
      [[{ ...a1, profile: null }], /own exact strategy profile/],
      [[{ ...a1, provider: "binance" }], /Kraken/],
      [[{ ...a1, riskUSD: 0 }], /riskUSD/],
      [[{ ...a1, group: "BITCOIN" }], /group/],
      [[{ ...a1, id: "BOT-1" }], /ALPHA-NN/],
    ];
    for (const [list, re] of cases) assert.match(registryProblems(list).join("; "), re);
  });
});

describe("exact strategy profiles (no cross-contamination)", () => {
  const bots = loadBotConfigs(ALL, env0(), ENGINE, { allowProposed: true });
  it("every bot loads exactly the owner's master-table values from its own profile", () => {
    for (const { bot, cfg } of bots) {
      for (const [k, v] of Object.entries(MASTER[bot.id])) assert.equal(cfg.inputs[k], v, `${bot.id} ${k}`);
      for (const [k, v] of Object.entries(COMMON)) assert.equal(cfg.inputs[k], v, `${bot.id} ${k}`);
      assert.equal(cfg.symbol, bot.symbol); assert.equal(cfg.intervalMin, bot.intervalMin); assert.equal(cfg.profile, bot.profile);
    }
  });
  it("SOLUSD 5m keeps TP2 extension +0.25 and its production inputs hash c826d785d58a4a39; every bot has its own hash", () => {
    const h = Object.fromEntries(bots.map(({ bot, cfg }) => [bot.id, inputsHash(cfg)]));
    assert.deepEqual(h, { "ALPHA-01": "0932a1a0cfac03f9", "ALPHA-02": "c826d785d58a4a39", "ALPHA-03": "d828caa44611ad73", "ALPHA-04": "a6336dad6ffaed70" });
  });
  it("no global setting can override a bot's strategy: STRAT_* in the environment is ignored, in the shared env file refused", () => {
    const leaky = loadBotConfigs(ALL, env0({ STRAT_SWING_LEN: "99", STRAT_TP2_EXT: "3" }), ENGINE, { allowProposed: true });
    for (const { bot, cfg } of leaky) { assert.equal(cfg.inputs.swingLen, MASTER[bot.id].swingLen); assert.equal(cfg.inputs.tp2Ext, MASTER[bot.id].tp2Ext); }
    const dir = tmp(); const f = join(dir, "shared.env"); writeFileSync(f, "STRAT_SWING_LEN=99\n");
    assert.throws(() => loadBotConfigs(["ALPHA-01"], { ENGINE_ENV_FILE: f, ENGINE_DATA_DIR: dir }, ENGINE, { allowProposed: true }), /would override bot profiles/);
  });
  it("changing BTC 5m's profile does not change BTC 1m; changing SOL 1m's does not change SOL 5m", () => {
    const base = tmp(); cpSync(join(ENGINE, "profiles"), join(base, "profiles"), { recursive: true });
    const edit = (p, k, v) => { const f = join(base, "profiles", `${p}.env`); writeFileSync(f, readFileSync(f, "utf8").replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`)); };
    edit("btcusd-5m", "STRAT_SWING_LEN", "21"); edit("solusd-1m", "STRAT_TP2_EXT", "0.9");
    const c = Object.fromEntries(loadBotConfigs(ALL, env0(), base, { allowProposed: true }).map(({ bot, cfg }) => [bot.id, cfg]));
    assert.equal(c["ALPHA-04"].inputs.swingLen, 21);
    assert.equal(c["ALPHA-03"].inputs.swingLen, 12, "BTC 1m untouched");
    assert.equal(c["ALPHA-01"].inputs.tp2Ext, 0.9);
    assert.equal(c["ALPHA-02"].inputs.tp2Ext, 0.25, "SOL 5m untouched");
    assert.equal(inputsHash(c["ALPHA-02"]), "c826d785d58a4a39");
  });
  it("fleet bots size by their own dollar risk (no % of equity); ALPHA-02 keeps its approved legacy policy until its switch", () => {
    for (const { bot, cfg } of bots) {
      if (bot.ledgerApi === "bot") { assert.equal(cfg.sizing.mode, "dollar"); assert.equal(cfg.sizing.riskUSD, 10); assert.equal(cfg.sizing.feePct, 0.2); assert.equal(cfg.sizing.simulatedShort, true); }
      else assert.equal(bot.id, "ALPHA-02");
    }
  });
});

describe("dollar-risk sizing (own wallet, LONG and fully collateralised SHORT)", () => {
  const SOL = getInstrument("SOLUSD"), BTC = getInstrument("BTCUSD");
  const policy = { mode: "dollar", riskUSD: 10, feePct: 0.2, priceBufferPct: 0.5, simulatedShort: true };
  it("$5 wallet, $10 target: the largest affordable position, never the $10 risk; the actual risk is reported", () => {
    const s = sizePosition({ instrument: SOL, capital: 5, entry: 80, stop: 79, side: 1, policy });
    assert.equal(s.ok, true); assert.equal(s.outcome, "REDUCED_TO_FIT"); assert.equal(s.riskPct, null, "no percentage anywhere");
    assert.ok(s.qty * 80 * 1.005 * 1.002 <= 5 + 1e-9, "fully paid from its own $5");
    assert.ok(s.riskActual < 10 && s.riskActual > 0); assert.equal(s.riskTarget, 10);
  });
  it("a SHORT is sized the same way, with the cash as collateral (no leverage, proceeds never spendable)", () => {
    const l = sizePosition({ instrument: SOL, capital: 50, entry: 80, stop: 81, side: -1, policy });
    assert.equal(l.ok, true); assert.equal(l.direction, "SHORT"); assert.equal(l.collateralModel, "FULLY_COLLATERALISED_SHORT");
    assert.ok(l.collateral <= 50 + 1e-6);
    const legacy = sizePosition({ instrument: SOL, capital: 50, entry: 80, stop: 81, side: -1, policy: { riskPct: 1, maxRiskUSD: 10 } });
    assert.equal(legacy.code, "SHORT_NOT_ALLOWED", "the legacy (pre-fleet) policy stays long-only");
  });
  it("with ample capital the full dollar risk is used, never more", () => {
    const s = sizePosition({ instrument: SOL, capital: 100_000, entry: 80, stop: 79, side: 1, policy: { ...policy, riskUSD: 2 } });
    assert.equal(s.outcome, "FULL_RISK"); assert.ok(s.riskActual <= 2 + 1e-9 && s.riskActual > 1.99);
  });
  it("below the Kraken minimum the trade is skipped with the exact reason (never raised to the minimum)", () => {
    const s = sizePosition({ instrument: SOL, capital: 2, entry: 80, stop: 79, side: 1, policy });
    assert.equal(s.code, "BELOW_MIN_QTY"); assert.match(s.reason, /minimum order of 0.05 SOL/);
    const b = sizePosition({ instrument: BTC, capital: 4, entry: 77000, stop: 76500, side: 1, policy });
    assert.equal(b.code, "BELOW_MIN_QTY", "BTC's own minimum (0.00006), not SOL's");
    const b5 = sizePosition({ instrument: BTC, capital: 5, entry: 77000, stop: 76500, side: 1, policy });
    assert.equal(b5.ok, true); assert.ok(b5.qty >= 0.00006);
  });
});

describe("accounting: own wallets, equal split, Ndax fees, profit sweep to MAIN", () => {
  const bots = [{ id: "ALPHA-01", group: "SOLANA", priority: 2 }, { id: "ALPHA-02", group: "SOLANA", priority: 1 }, { id: "ALPHA-03", group: "BITCOIN", priority: 3 }, { id: "ALPHA-04", group: "BITCOIN", priority: 4 }];
  const fund = (L, id, usd) => { L.wallet[id].available = toMicro(usd); L.wallet[id].funding = toMicro(usd); };
  it("allocations split equally between a group's bots, to the micro-dollar, and later allocations add equally", () => {
    const L = new FleetLedgerSim({ bots, main: 100 });
    assert.deepEqual(L.allocate("SOLANA", 10).split.map((s) => s.amountMicro), [5e6, 5e6]);
    L.allocate("SOLANA", 25);
    assert.equal(L.available("ALPHA-01"), 17.5); assert.equal(L.available("ALPHA-02"), 17.5);
    assert.deepEqual(splitEqual(30_001, ["A", "B"]).map((s) => s.amountMicro), [15_001, 15_000], "remainder in priority order; nothing created or lost");
    assert.equal(L.allocate("BITCOIN", 1000).code, "INSUFFICIENT_MAIN");
    assert.equal(L.available("ALPHA-03"), 0);
    assert.ok(L.reconciles());
  });
  it("the owner's example: $50 → $51 at 0.20% per side: fees $0.100 + $0.102, net $0.798 swept to MAIN, bot back to its balance", () => {
    const L = new FleetLedgerSim({ bots, main: 0 });
    fund(L, "ALPHA-01", 60);
    assert.equal(L.open("ALPHA-01", "LONG", 1, 50), null);
    const { trade } = L.close("ALPHA-01", 51);
    assert.equal(fromMicro(trade.entryFee), 0.1); assert.equal(fromMicro(trade.exitFee), 0.102);
    assert.equal(fromMicro(trade.gross), 1); assert.equal(fromMicro(trade.net), 0.798); assert.equal(fromMicro(trade.sweep), 0.798);
    assert.equal(L.available("ALPHA-01"), 60, "no compounding: the bot keeps its pre-trade balance");
    assert.equal(fromMicro(L.wallet.MAIN.available), 0.798);
    assert.ok(L.reconciles());
  });
  it("SHORT P&L = (entry − exit) × qty; gross profit that fees turn negative is a loss (no sweep); exactly zero sweeps nothing", () => {
    const L = new FleetLedgerSim({ bots, main: 0 });
    for (const id of ["ALPHA-01", "ALPHA-02"]) fund(L, id, 100);
    L.open("ALPHA-01", "SHORT", 1, 50); const s = L.close("ALPHA-01", 49).trade;
    assert.equal(fromMicro(s.gross), 1); assert.ok(s.net > 0 && s.sweep === s.net);
    L.open("ALPHA-02", "LONG", 1, 50); const tiny = L.close("ALPHA-02", 50.1).trade; // gross +0.10, fees ≈ 0.2002
    assert.ok(tiny.gross > 0 && tiny.net < 0 && tiny.sweep === 0);
    assert.equal(L.available("ALPHA-02"), 100 + fromMicro(tiny.net), "the loss stays with ALPHA-02");
    const L2 = new FleetLedgerSim({ bots, main: 0, feePct: 0 }); fund(L2, "ALPHA-01", 10);
    L2.open("ALPHA-01", "LONG", 0.1, 50); assert.equal(L2.close("ALPHA-01", 50).trade.sweep, 0);
    assert.ok(L.reconciles() && L2.reconciles());
  });
  it("two bots on the same symbol: separate positions, opposing directions, independent exits; no cross-bot spending", () => {
    const L = new FleetLedgerSim({ bots, main: 20 });
    L.allocate("SOLANA", 20);
    assert.equal(L.open("ALPHA-01", "LONG", 0.12, 80), null);
    assert.equal(L.open("ALPHA-02", "SHORT", 0.12, 80), null, "SOL 5m shorts while SOL 1m is long");
    assert.equal(L.open("ALPHA-01", "LONG", 0.01, 80), "POSITION_ALREADY_OPEN", "pyramiding 0 per bot");
    L.close("ALPHA-01", 81);
    assert.ok(L.positions.has("ALPHA-02") && !L.positions.has("ALPHA-01"), "one bot's exit never closes another's");
    const L3 = new FleetLedgerSim({ bots, main: 10 }); L3.allocate("SOLANA", 10);
    assert.equal(L3.open("ALPHA-01", "LONG", 0.0623, 80), null, "SOL 1m uses all of its own $5");
    assert.equal(L3.open("ALPHA-02", "LONG", 0.0623, 80), null, "SOL 5m still has its own $5");
    assert.equal(L3.open("ALPHA-03", "LONG", 0.00006, 77000), "INSUFFICIENT_BOT_CAPITAL", "BTC bot has nothing of its own; never SOL's money");
  });
  it("a short loss beyond collateral and cash is a recorded shortfall: MAIN and other bots are untouched, entries pause", () => {
    const L = new FleetLedgerSim({ bots, main: 50 });
    L.allocate("SOLANA", 20);
    L.open("ALPHA-01", "SHORT", 0.12, 80);
    const mainBefore = L.wallet.MAIN.available, otherBefore = L.available("ALPHA-02");
    const t = L.close("ALPHA-01", 175).trade;
    assert.ok(t.shortfall > 0); assert.equal(L.available("ALPHA-01"), 0);
    assert.equal(L.wallet.MAIN.available, mainBefore); assert.equal(L.available("ALPHA-02"), otherBefore);
    assert.equal(L.open("ALPHA-01", "LONG", 0.06, 80), "BOT_ENTRIES_PAUSED");
    assert.equal(t.net, t.gross - t.entryFee - t.exitFee, "the trade's full loss is reported");
    assert.ok(L.reconciles());
  });
  it("a settled close cannot be applied twice", () => {
    const L = new FleetLedgerSim({ bots, main: 10 }); L.allocate("SOLANA", 10);
    L.open("ALPHA-01", "LONG", 0.06, 80, { openTime: 1 }); L.close("ALPHA-01", 82);
    assert.equal(L.close("ALPHA-01", 82).code, "NO_POSITION"); assert.equal(L.sweeps.length, 1);
  });
});

describe("bot identity on the wire (fleet path)", () => {
  it("a fleet bot sends OPEN_LONG / OPEN_SHORT / CLOSE with bot_id, levels and config hash to /webhook/bot-order", async () => {
    const seen = [];
    const http = async (url, init) => {
      const path = String(url).replace(/^.*\/webhook\//, ""); const body = JSON.parse(init.body); seen.push({ path, body });
      if (path === "bot-ledger") return new Response(JSON.stringify({ ok: true, position: null, alerts: {}, balance: { available_usd: 500, bot_available_usd: 500, max_order_notional_usd: 5000 } }), { status: 200 });
      if (path === "bot-order") return new Response(JSON.stringify({ ok: true, code: "DRY_RUN_ACCEPTED" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const [{ cfg }] = loadBotConfigs(["ALPHA-01"], env0({ ENGINE_SYNC: "on", ALPHA_API_BASE: "http://127.0.0.1:9", ALPHA_WEBHOOK_SECRET: "s", ENGINE_MIRROR: "on" }), ENGINE, { allowProposed: true });
    const clock = { now: 0 };
    const r = new EngineRunner(cfg, { fetchCandles: async ({ sinceMs }) => SOL1.filter((k) => k.t + 60_000 <= clock.now && (sinceMs === null || k.t > sinceMs)), http, now: () => clock.now, log: () => {} });
    clock.now = SOL1[300].t + 70_000; await r.tick();
    for (let i = 301; i < SOL1.length && !seen.some((s) => s.path === "bot-order"); i++) { clock.now = SOL1[i].t + 70_000; await r.tick(); }
    const order = seen.find((s) => s.path === "bot-order");
    assert.ok(order, "an order was sent from real candles");
    assert.equal(order.body.bot_id, "ALPHA-01");
    assert.match(order.body.action, /^OPEN_(LONG|SHORT)$/);
    assert.match(order.body.order_id, /^ENG-ALPHA-01-SOLUSD-1-/);
    assert.equal(order.body.config_hash, "0932a1a0cfac03f9");
    assert.ok(order.body.stop > 0 && order.body.tp > 0);
    for (const s of seen) if (s.path !== "engine-mirror" && s.path !== "engine-status") assert.equal(s.body.bot_id, "ALPHA-01", s.path);
    assert.equal(seen.find((s) => s.path === "engine-status").body.status.bot_id, "ALPHA-01");
    assert.equal(seen.find((s) => s.path === "engine-mirror").body.account.bot_id, "ALPHA-01");
    assert.ok(!seen.some((s) => s.path === "dry-run"), "never the legacy ledger");
    assert.equal(r.mirror.strategy.inputs.riskUSD, 10, "the mirror keeps the $10 reference risk");
  });
});

describe("four independent bots in one process", () => {
  it("one market-data request per market and timeframe per round", async () => {
    let calls = 0;
    const cache = new CandleCache(async ({ symbol, intervalMin }) => { calls += 1; return CANDLES[`${symbol}|${intervalMin}`].slice(0, 50); });
    cache.newRound();
    await cache.fetch({ symbol: "SOLUSD", intervalMin: 1, sinceMs: SOL1[10].t });
    await cache.fetch({ symbol: "SOLUSD", intervalMin: 1, sinceMs: SOL1[20].t });
    await cache.fetch({ symbol: "BTCUSD", intervalMin: 1, sinceMs: null });
    assert.equal(calls, 2);
  });
  it("each of the four bots ends EXACTLY as it would alone, on real SOL and BTC candles, even through another bot's outage", async () => {
    const bots = loadBotConfigs(ALL, { ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: tmp(), ENGINE_MIRROR: "on" }, ENGINE, { allowProposed: true });
    const clock = { now: {} };
    // each bot sees only its own market's real candles (SOL: 10-11 Nov, BTC: 1-2 Nov), each on its own clock
    const visible = ({ symbol, intervalMin, sinceMs }) => CANDLES[`${symbol}|${intervalMin}`].filter((k) => k.t + intervalMin * 60_000 <= clock.now[symbol] && (sinceMs === null || k.t > sinceMs));
    let failing = false;
    const fleet = new FleetRunner(bots, { pauseMs: 0, log: () => {}, fetchCandles: async (a) => visible(a),
      makeRunner: (cfg, deps) => new EngineRunner(cfg, { ...deps, fetchCandles: async (a) => { if (failing && cfg.botId === "ALPHA-03") throw new Error("TEST outage"); return deps.fetchCandles(a); }, now: () => clock.now[cfg.symbol], log: () => {} }) });
    const solo = Object.fromEntries(bots.map(({ bot, cfg }) => [bot.id, new EngineRunner({ ...cfg, dataDir: tmp() }, {
      fetchCandles: async (a) => { if (failing && bot.id === "ALPHA-03") throw new Error("TEST outage"); return visible(a); }, now: () => clock.now[cfg.symbol], log: () => {} })]));
    let failed = 0;
    for (let i = 0; i < 700; i++) {
      clock.now = { SOLUSD: SOL1[0].t + (300 + i) * 60_000 + 15_000, BTCUSD: BTC1[0].t + (300 + i) * 60_000 + 15_000 };
      failing = i >= 200 && i < 215;
      const res = await fleet.round();
      if (res.find((x) => x.bot === "ALPHA-03").ok === false) failed += 1;
      for (const x of res) if (x.bot !== "ALPHA-03") assert.equal(x.ok, true, `${x.bot} unaffected`);
      for (const r of Object.values(solo)) await r.tick().catch(() => {});
    }
    assert.ok(failed >= 1, "the outage really happened");
    for (const b of fleet.bots) {
      assert.equal(JSON.stringify(b.runner.state.strategy), JSON.stringify(solo[b.id].state.strategy), `${b.id}: identical to running alone`);
      assert.equal(JSON.stringify(b.runner.mirror.strategy), JSON.stringify(solo[b.id].mirror.strategy), `${b.id}: mirror identical`);
    }
    assert.equal(new Set(fleet.bots.map((b) => b.runner.file)).size, 4, "four separate state files");
  });
});

describe("combined funded backtest (real candles, own wallets, sweeps, no lookahead)", () => {
  const fleetBots = (risk = 10) => [
    { id: "ALPHA-01", group: "SOLANA", symbol: "SOLUSD", intervalMin: 1, priority: 2, inputs: profileInputs(ENGINE, "solusd-1m"), candles: SOL1, riskUSD: risk },
    { id: "ALPHA-02", group: "SOLANA", symbol: "SOLUSD", intervalMin: 5, priority: 1, inputs: profileInputs(ENGINE, "solusd-5m"), candles: SOL5, riskUSD: risk },
    { id: "ALPHA-03", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 1, priority: 3, inputs: profileInputs(ENGINE, "btcusd-1m"), candles: BTC1, riskUSD: risk },
    { id: "ALPHA-04", group: "BITCOIN", symbol: "BTCUSD", intervalMin: 5, priority: 4, inputs: profileInputs(ENGINE, "btcusd-5m"), candles: BTC5, riskUSD: risk },
  ];
  it("the backtest reads each bot's exact profile (same values as the engine)", () => {
    const cfgs = Object.fromEntries(loadBotConfigs(ALL, env0(), ENGINE, { allowProposed: true }).map(({ bot, cfg }) => [bot.id, cfg.inputs]));
    for (const b of fleetBots()) for (const [k, v] of Object.entries(b.inputs)) assert.equal(cfgs[b.id][k], v, `${b.id} ${k}`);
  });
  for (const perBot of [5, 10, 25, 50, 100]) {
    it(`$${perBot} per bot: wallets reconcile, MAIN only receives sweeps, no bot ever exceeds its allocation (no compounding)`, () => {
      const r = runFleetBacktest({ bots: fleetBots(), main: perBot * 4, allocations: [{ group: "SOLANA", amountUsd: perBot * 2 }, { group: "BITCOIN", amountUsd: perBot * 2 }] });
      assert.equal(r.combined.reconciles, true);
      assert.ok(Math.abs(r.combined.funded.main_end - r.combined.funded.swept_to_main) < 1e-6, "MAIN = its sweeps (all of MAIN was allocated)");
      for (const [id, b] of Object.entries(r.per_bot)) {
        assert.ok(b.funded.wallet_end <= perBot + 1e-6, `${id}: profits left the wallet`);
        assert.equal(b.funded.shortfall, 0);
        assert.equal(b.funded.refused.INSUFFICIENT_BOT_CAPITAL ?? 0, 0, `${id}: sized from its own wallet, never refused for capital`);
      }
      assert.ok(Object.values(r.per_bot).reduce((s, b) => s + b.funded.short_trades, 0) > 0, "simulated shorts are traded");
    });
  }
});

describe("regression: ALPHA-01 2026-11-09 11:17 SHORT (limit 86.14, filled at the close 86.75, +0.71% beyond the 0.5% sizing headroom)", () => {
  const bots = [{ id: "ALPHA-01", group: "SOLANA", priority: 1 }];
  const sol = getInstrument("SOLUSD");
  it("the quantity is reduced to fit the bot's own wallet at the fill price, floored to the step; the wallet still reconciles", () => {
    const L = new FleetLedgerSim({ bots, main: 0 });
    L.wallet["ALPHA-01"].available = 7_072_010; L.wallet["ALPHA-01"].funding = 7_072_010;
    assert.equal(L.open("ALPHA-01", "SHORT", 0.08152467, 86.75, { openTime: 1, instrument: sol }), null);
    const p = L.positions.get("ALPHA-01");
    assert.ok(p.qty < 0.08152467 && p.reduced === true && p.requestedQty === 0.08152467);
    assert.equal(p.qty, Math.floor((7.07201 / (86.75 * 1.002)) * 1e8) / 1e8);
    assert.ok(p.collateral + p.entryFee <= 7_072_010);
    assert.ok(L.reconciles());
  });
  it("refused only when even the reduced size is below the venue minimum", () => {
    const L = new FleetLedgerSim({ bots, main: 0 });
    L.wallet["ALPHA-01"].available = 3_000_000; L.wallet["ALPHA-01"].funding = 3_000_000; // $3 buys < 0.05 SOL at 86.75
    assert.equal(L.open("ALPHA-01", "SHORT", 0.08, 86.75, { openTime: 1, instrument: sol }), "INSUFFICIENT_BOT_CAPITAL");
    assert.equal(L.positions.size, 0);
  });
  it("the real Kraken candles around the event (fixture, 12 h warm-up): no refusal at $10 or $1,000, one reduced entry, reconciles", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sol1 = JSON.parse(readFileSync(join(here, "fixtures", "SOLUSD-1m-2026-11-08T12_2026-11-09T12.json"), "utf8")).candles;
    for (const per of [10, 1000]) {
      const r = runFleetBacktest({ bots: [{ id: "ALPHA-01", group: "SOLANA", symbol: "SOLUSD", intervalMin: 1, priority: 1, candles: sol1, inputs: profileInputs(join(here, ".."), "solusd-1m"), riskUSD: 10 }],
        main: per, allocations: [{ group: "SOLANA", amountUsd: per }], fromMs: Date.parse("2026-11-09T00:00:00Z") });
      const f = r.per_bot["ALPHA-01"].funded;
      assert.deepEqual(f.refused, {}); assert.equal(f.reduced_to_fit, 1); assert.ok(r.combined.reconciles);
    }
  });
});

describe("financial reconciliation identities (MAIN, every bot, every group, combined)", () => {
  it("internal transfers never change combined equity; it moves only by trading P&L and fees; MAIN receipts do not imply a profitable fleet", () => {
    const bots = [{ id: "ALPHA-01", group: "SOLANA", priority: 1 }, { id: "ALPHA-02", group: "SOLANA", priority: 2 }, { id: "ALPHA-03", group: "BITCOIN", priority: 3 }, { id: "ALPHA-04", group: "BITCOIN", priority: 4 }];
    const L = new FleetLedgerSim({ bots, main: 100 });
    const sum = (f) => Object.values(L.wallet).reduce((s, w) => s + f(w), 0);
    const book = () => sum((w) => w.available + w.reserved);
    assert.equal(book(), toMicro(100));
    L.allocate("SOLANA", 40); L.allocate("BITCOIN", 40);
    assert.equal(book(), toMicro(100), "allocation is internal: combined equity unchanged");
    assert.equal(sum((w) => w.funding), toMicro(100), "Σ net funding of all wallets = external deposits − withdrawals");
    // a winning LONG (swept to MAIN), a losing SHORT, a losing LONG, and a SHORT loss beyond its collateral and cash
    L.open("ALPHA-01", "LONG", 0.2, 80); L.close("ALPHA-01", 82);
    L.open("ALPHA-02", "SHORT", 0.2, 80); L.close("ALPHA-02", 81);
    L.open("ALPHA-03", "LONG", 0.0001, 100000); L.close("ALPHA-03", 99000);
    L.open("ALPHA-04", "SHORT", 0.00019, 100000); L.close("ALPHA-04", 220000);
    const T = L.trades;
    const gross = T.reduce((s, t) => s + t.gross, 0), fees = T.reduce((s, t) => s + t.entryFee + t.exitFee, 0), shortfall = T.reduce((s, t) => s + t.shortfall, 0);
    const swept = L.sweeps.reduce((s, x) => s + x.amountMicro, 0);
    assert.ok(shortfall > 0 && swept > 0 && gross - fees < 0, "scenario: profit swept to MAIN while the fleet as a whole lost money");
    // per wallet: available + reserved = net funding + realized (what the wallet paid/received) − fees
    assert.ok(L.reconciles());
    // combined: book = external funding + Σ gross − Σ fees + Σ shortfall (the unpaid part of a loss is a recorded liability)
    assert.equal(book(), toMicro(100) + gross - fees + shortfall);
    // equity net of liabilities = external funding + Σ gross − Σ fees: exactly the trading result, transfers excluded
    assert.equal(book() - sum((w) => w.shortfall), toMicro(100) + gross - fees);
    // MAIN = its own funding (initial − allocations + sweeps received); its receipts are not the fleet's result
    assert.equal(L.wallet.MAIN.available, toMicro(100) - toMicro(80) + swept);
    assert.ok(fromMicro(swept) > 0 && fromMicro(gross - fees) < 0);
    // per group: Σ of its bots' book = Σ its bots' funding + their realized − their fees
    for (const g of ["SOLANA", "BITCOIN"]) {
      const ws = bots.filter((b) => b.group === g).map((b) => L.wallet[b.id]);
      assert.equal(ws.reduce((s, w) => s + w.available + w.reserved, 0), ws.reduce((s, w) => s + w.funding + w.realized - w.fees, 0), g);
    }
  });
});
