// Independent bots (docs/MULTI-BOT-ARCHITECTURE.md). PERMANENT requirement: every market, timeframe or strategy is a
// bot in src/bots.mjs, and these tests must keep passing for every bot.
//   node --test test/fleet.test.mjs

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BOTS, botIdPrefix, botTag, registryProblems, selectBots } from "../src/bots.mjs";
import { CapitalBook, pendingEntryCost, SimLedger } from "../src/capital.mjs";
import { loadBotConfigs, loadConfig } from "../src/config.mjs";
import { CandleCache, FleetRunner } from "../src/fleet.mjs";
import { EngineRunner } from "../src/runner.mjs";
import { aggregate, runFleetBacktest } from "../src/cli/fleet-backtest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const ONE = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-1m-2026-11-10_2026-11-12.json"), "utf8")).candles;
const FIVE = aggregate(ONE, 5);
const temps = [];
after(() => { for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* locked */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "alpha-fleet-")); temps.push(d); return d; };
// TEST registry: ALPHA-01 made ACTIVE with the 5m profile as PLACEHOLDER inputs (mechanics only, never production).
const TEST_BOTS = BOTS.map((b) => (b.id === "ALPHA-01" ? { ...b, status: "ACTIVE", profile: "solusd-5m" } : b));

describe("bot registry (permanent gate)", () => {
  it("the production registry is valid: unique ids, files, strategies; verified instruments; hard risk caps", () => {
    assert.deepEqual(registryProblems(BOTS), []);
    for (const b of BOTS) {
      assert.match(b.id, /^ALPHA-\d{2}$/);
      assert.ok(b.maxRiskUSD > 0 && b.riskPct > 0 && b.riskPct <= 10, b.id);
    }
  });
  it("only ALPHA-02 (the production SOLUSD 5m engine) is ACTIVE; the others are PROPOSED and refused for production", () => {
    assert.deepEqual(BOTS.filter((b) => b.status === "ACTIVE").map((b) => b.id), ["ALPHA-02"]);
    for (const id of ["ALPHA-01", "ALPHA-03", "ALPHA-04", "ALPHA-05", "ALPHA-06"]) assert.throws(() => selectBots([id]), /PROPOSED/);
    assert.equal(BOTS.find((b) => b.id === "ALPHA-01").profile, null, "no 1m inputs are assumed: the owner's 1m settings are required");
  });
  it("ALPHA-02 keeps the production file names and signal ids, so its saved state resumes unchanged", () => {
    const b = BOTS.find((x) => x.id === "ALPHA-02");
    assert.equal(botTag(b), "SOLUSD-5m");
    assert.equal(botIdPrefix(b), "ENG-SOLUSD-5");
    assert.equal(botTag(TEST_BOTS[0]), "ALPHA-01-SOLUSD-1m", "new bots carry their id in file names");
    assert.equal(botIdPrefix(TEST_BOTS[0]), "ENG-ALPHA-01-SOLUSD-1", "and in signal ids, so two bots never share an id");
  });
  it("invalid registries are refused with the reason", () => {
    const base = BOTS.find((b) => b.id === "ALPHA-02");
    const cases = [
      [[base, { ...base }], /duplicate bot id/],
      [[base, { ...base, id: "ALPHA-09" }], /same market, timeframe and profile|collide|only one legacy/],
      [[{ ...base, id: "BOT-2" }], /ALPHA-NN/],
      [[{ ...base, profile: null }], /needs a strategy profile/],
      [[{ ...base, id: "ALPHA-09", legacy: false, symbol: "BTCUSD", profile: "x" }], /not funded-eligible/],
      [[{ ...base, maxRiskUSD: 0 }], /maxRiskUSD/],
      [[{ ...base, symbol: "DOGEUSD" }], /no verified instrument/],
    ];
    for (const [list, re] of cases) assert.match(registryProblems(list).join("; "), re);
  });
});

describe("bot configuration", () => {
  it("ALPHA-02's fleet config is the production single-engine config plus its identity (same inputs hash, files, ids)", () => {
    const env = { ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: tmp() };
    const [{ cfg }] = loadBotConfigs(["ALPHA-02"], env, ENGINE);
    const single = loadConfig({ ...env, ENGINE_PROFILE: "solusd-5m", ENGINE_RISK_PCT: "1", ENGINE_MAX_RISK_USD: "10" }, ENGINE);
    const { botId, botName, fileTag, idPrefix, priority, wallet, ...rest } = cfg;
    assert.deepEqual(rest, single);
    assert.deepEqual({ botId, fileTag, idPrefix, wallet }, { botId: "ALPHA-02", fileTag: "SOLUSD-5m", idPrefix: "ENG-SOLUSD-5", wallet: "SOLUSD" });
  });
  it("the registry's risk policy cannot be loosened by the environment", () => {
    const [{ cfg }] = loadBotConfigs(["ALPHA-02"], { ENGINE_ENV_FILE: "none", ENGINE_RISK_PCT: "5", ENGINE_MAX_RISK_USD: "500", ENGINE_SYNC: "on", ALPHA_API_BASE: "http://x", ALPHA_WEBHOOK_SECRET: "s" }, ENGINE);
    assert.equal(cfg.sizing.riskPct, 1);
    assert.equal(cfg.sizing.maxRisk, 10);
    assert.equal(cfg.sizing.mode, "percent", "funded + ledger: affordable percent sizing");
  });
  it("a bot without the owner's settings cannot be configured", () => {
    assert.throws(() => loadBotConfigs(["ALPHA-01"], { ENGINE_ENV_FILE: "none" }, ENGINE, { allowProposed: true }), /owner's inputs/);
  });
});

describe("bot identity on the wire", () => {
  it("a fleet bot sends bot_id with every signal, ledger query, status and mirror report; the single engine sends none", async () => {
    const seen = [];
    const http = async (url, init) => { seen.push({ url: String(url).replace(/^.*\/webhook\//, ""), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, balance: { available_usd: 50 }, alerts: {} }), { status: 200 }); };
    const env = { ENGINE_ENV_FILE: "none", ENGINE_SYNC: "on", ALPHA_API_BASE: "http://127.0.0.1:9", ALPHA_WEBHOOK_SECRET: "s", ENGINE_DATA_DIR: tmp(), ENGINE_MIRROR: "on" };
    const [{ cfg }] = loadBotConfigs(["ALPHA-01"], env, ENGINE, { list: TEST_BOTS, allowProposed: true });
    const clock = { now: ONE[400].t + 70_000 };
    const r = new EngineRunner(cfg, { fetchCandles: async () => ONE.filter((k) => k.t + 60_000 <= clock.now), http, now: () => clock.now, log: () => {} });
    await r.tick();
    assert.ok(seen.length >= 2);
    for (const s of seen) assert.equal(s.url === "engine-mirror" ? s.body.account.bot_id : s.url === "engine-status" ? s.body.status.bot_id : s.body.bot_id, "ALPHA-01", s.url);
    assert.ok(r.file.endsWith("state-ALPHA-01-SOLUSD-1m.json"));
    assert.ok(r.mirrorFile.endsWith("mirror-ALPHA-01-SOLUSD-1m.json"));
    assert.equal(r.statusPayload().bot_id, "ALPHA-01");
    const single = new EngineRunner(loadConfig({ ...env, ENGINE_DATA_DIR: tmp(), ENGINE_PROFILE: "solusd-5m" }, ENGINE), { fetchCandles: async () => [], http, now: () => clock.now, log: () => {} });
    assert.deepEqual(single.botFields(), {}, "unchanged payloads for the production single engine");
  });
});

describe("shared capital protection", () => {
  it("the capital book earmarks other bots' resting entries on the same wallet (never the bot's own, never other wallets)", () => {
    const book = new CapitalBook();
    const S1 = { broker: { entry: { side: 1, qty: 0.1, limit: 80 } }, sizing: { priceBufferPct: 0.5, feePct: 0.4 } };
    const S2 = { broker: { entry: null }, sizing: {} };
    book.register("ALPHA-01", { wallet: "SOLUSD", pendingCost: () => pendingEntryCost(S1) });
    book.register("ALPHA-02", { wallet: "SOLUSD", pendingCost: () => pendingEntryCost(S2) });
    book.register("ALPHA-04", { wallet: "BTCUSD", pendingCost: () => 1000 });
    const cost = 0.1 * 80 * 1.005 * 1.004;
    assert.ok(Math.abs(book.capitalFor("ALPHA-02", 10) - (10 - cost)) < 1e-9);
    assert.equal(book.capitalFor("ALPHA-01", 10), 10, "its own earmark is not subtracted");
    assert.equal(book.capitalFor("ALPHA-02", null), null, "unknown stays unknown");
    assert.equal(book.capitalFor("ALPHA-02", 5), 0, "never below zero");
    S1.broker.entry.side = -1;
    assert.equal(pendingEntryCost(S1), 0, "a short is never sent to the long-only ledger: no earmark");
  });
  it("the simulated ledger: two bots, same symbol, separate positions; shared wallet never overspent; caps; exits isolated", () => {
    const L = new SimLedger({ wallets: { SOLUSD: 100 }, caps: { "ALPHA-01": 30 } });
    assert.equal(L.buy("ALPHA-02", "SOLUSD", 0.75, 80), null);
    assert.equal(L.buy("ALPHA-01", "SOLUSD", 0.5, 80), "BOT_ALLOCATION_EXCEEDED");
    assert.equal(L.buy("ALPHA-01", "SOLUSD", 0.25, 80), null);
    assert.equal(L.positions.size, 2);
    assert.equal(L.buy("ALPHA-03", "SOLUSD", 0.3, 80), "INSUFFICIENT_PAPER_CAPITAL");
    assert.equal(L.sell("ALPHA-01", 82), null);
    assert.ok(L.positions.has("ALPHA-02") && !L.positions.has("ALPHA-01"), "one bot's exit never closes another's");
    assert.equal(L.sell("ALPHA-01", 82), "NO_POSITION");
    assert.ok(L.reconciles());
  });
});

describe("fleet process", () => {
  it("one market-data request per market and timeframe per round", async () => {
    let calls = 0;
    const cache = new CandleCache(async ({ intervalMin }) => { calls += 1; return (intervalMin === 1 ? ONE : FIVE).slice(0, 50); });
    cache.newRound();
    await cache.fetch({ symbol: "SOLUSD", intervalMin: 1, sinceMs: ONE[10].t });
    const second = await cache.fetch({ symbol: "SOLUSD", intervalMin: 1, sinceMs: ONE[20].t });
    await cache.fetch({ symbol: "SOLUSD", intervalMin: 5, sinceMs: null });
    assert.equal(calls, 2);
    assert.ok(second.every((k) => k.t > ONE[20].t), "each bot still gets only the candles after its own last one");
  });

  it("each bot in the fleet ends EXACTLY as it would alone (real 1m and 5m candles), even when another bot fails", async () => {
    const env = (dir) => ({ ENGINE_ENV_FILE: "none", ENGINE_DATA_DIR: dir, ENGINE_MIRROR: "on" });
    const fleetDir = tmp();
    const bots = loadBotConfigs(["ALPHA-01", "ALPHA-02"], env(fleetDir), ENGINE, { list: TEST_BOTS, allowProposed: true });
    const clock = { now: 0 };
    const visible = ({ intervalMin, sinceMs }) => (intervalMin === 1 ? ONE : FIVE).filter((k) => k.t + intervalMin * 60_000 <= clock.now && (sinceMs === null || k.t > sinceMs));
    let failing = false;
    const fleet = new FleetRunner(bots, {
      pauseMs: 0, log: () => {}, fetchCandles: async (a) => visible(a),
      makeRunner: (cfg, deps) => new EngineRunner(cfg, { ...deps, fetchCandles: async (a) => { if (failing && cfg.botId === "ALPHA-01") throw new Error("TEST outage"); return deps.fetchCandles(a); }, now: () => clock.now, log: () => {} }),
    });
    assert.deepEqual(fleet.bots.map((b) => b.id), ["ALPHA-02", "ALPHA-01"], "allocation order: priority, then id");
    // Each bot alone, in its own process, with the SAME data it would see (ALPHA-01 alone suffers the same outage and
    // catches up exactly as a restarted engine does).
    const solo = Object.fromEntries(bots.map(({ bot, cfg }) => [bot.id, new EngineRunner({ ...cfg, dataDir: tmp() }, {
      fetchCandles: async (a) => { if (failing && bot.id === "ALPHA-01") throw new Error("TEST outage"); return visible(a); }, now: () => clock.now, log: () => {} })]));
    const start = ONE[0].t + 300 * 60_000, end = ONE[0].t + 1200 * 60_000;
    let failedRounds = 0;
    for (let t = start; t <= end; t += 60_000) {
      clock.now = t + 15_000;
      failing = t >= start + 400 * 60_000 && t < start + 410 * 60_000; // ALPHA-01's feed fails for 10 minutes
      const res = await fleet.round();
      if (res.find((r) => r.bot === "ALPHA-01").ok === false) failedRounds += 1;
      assert.equal(res.find((r) => r.bot === "ALPHA-02").ok, true, "ALPHA-02 is unaffected by ALPHA-01's failure");
      for (const r of Object.values(solo)) await r.tick().catch(() => {});
    }
    assert.ok(failedRounds >= 1, "the failure really happened");
    for (const b of fleet.bots) {
      const strip = (S) => JSON.stringify(S.strategy);
      assert.equal(strip(b.runner.state), strip(solo[b.id].state), `${b.id}: strategy state identical to running alone`);
      assert.equal(JSON.stringify(b.runner.mirror.strategy), JSON.stringify(solo[b.id].mirror.strategy), `${b.id}: mirror identical`);
      assert.equal(b.runner.state.candlesProcessed, solo[b.id].state.candlesProcessed);
    }
    assert.notEqual(fleet.bots[0].runner.file, fleet.bots[1].runner.file, "separate state files");
    assert.equal(fleet.health().length, 2);
  });
});

describe("combined backtest (shared capital, chronological, no lookahead)", () => {
  const inputs = Object.fromEntries(Object.entries(loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, ENGINE).inputs));
  for (const balance of [10, 25, 50, 100, 1000]) {
    it(`$${balance}: both bots trade from one wallet, nothing is ever refused, the ledger reconciles`, () => {
      const r = runFleetBacktest({
        bots: [
          { id: "ALPHA-02", symbol: "SOLUSD", intervalMin: 5, wallet: "SOLUSD", priority: 1, inputs, candles: FIVE },
          { id: "ALPHA-01", symbol: "SOLUSD", intervalMin: 1, wallet: "SOLUSD", priority: 2, inputs, candles: ONE },
        ],
        ledger: { wallets: { SOLUSD: balance }, feePct: 0, slippagePct: 0, maxOrderNotional: 5000, maxTotalExposure: 25000, maxOpenPositions: 5 },
      });
      assert.equal(r.combined.reconciles, true);
      assert.equal(r.combined.paper.refused, 0, "the capital book prevents double-spending before the ledger has to refuse");
      assert.ok(r.combined.min_available >= -1e-9, "the shared wallet never goes below $0 (never more reserved than it holds)");
      for (const b of Object.values(r.per_bot)) assert.ok(!("SHORT_SELLING_DISABLED" in b.paper.refused_by_code), "shorts are skipped before sending, never refused");
      assert.equal(r.per_bot["ALPHA-01"].timeframe, "1m");
      assert.equal(r.per_bot["ALPHA-02"].timeframe, "5m");
    });
  }
  it("aggregated 5m candles are exact OHLC aggregates of the real 1m candles", () => {
    for (const k of FIVE.slice(0, 50)) {
      const parts = ONE.filter((x) => x.t >= k.t && x.t < k.t + 300_000);
      assert.equal(k.o, parts[0].o); assert.equal(k.c, parts.at(-1).c);
      assert.equal(k.h, Math.max(...parts.map((x) => x.h))); assert.equal(k.l, Math.min(...parts.map((x) => x.l)));
    }
  });
});
