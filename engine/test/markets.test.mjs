// Strategy Mirror V2: mirror-only BTCUSD and ETHUSD markets next to the unchanged SOLUSD engine.
//   * configuration: ENGINE_FUNDED=off / ENGINE_MARKETS, refusals, the production SOLUSD config unchanged
//   * SOLUSD byte-identical to the deployed release 0db082f (state, mirror state, requests, audit)
//   * mirror-only markets: live replay = backtest trade by trade, never a funded request, own ids and sequences
//   * isolation: one market's API errors, hangs, data gaps and restarts never interrupt another
//   * the entry point (run.mjs) dispatches to the multi-market process, with per-market locks
// No network: real Kraken fixtures (SOLUSD, BTCUSD, ETHUSD 5m), in-process fakes and a local OHLC stand-in.
//   node --test test/markets.test.mjs

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadMarketConfigs, marketList } from "../src/config.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";
import { MarketsRunner } from "../src/markets.mjs";
import { EngineRunner, inputsHash } from "../src/runner.mjs";
import { startOhlcStub } from "./lib/release-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const REPO = join(ENGINE, "..");
const STEP = 300_000;
const FIX = (s) => JSON.parse(readFileSync(join(HERE, "fixtures", `${s}-5m-kraken.json`), "utf8")).candles;
const CANDLES = { SOLUSD: FIX("SOLUSD"), BTCUSD: FIX("BTCUSD"), ETHUSD: FIX("ETHUSD") };
const P5 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, ENGINE);
const mirrorCfg = (symbol, dataDir, over = {}) => ({ ...loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ENGINE_SYMBOL: symbol, ENGINE_FUNDED: "off", ENGINE_MIRROR: "on" }, ENGINE),
  sync: true, apiBase: "http://alpha.test", webhookSecret: "test-secret", dataDir, krakenBase: "", ...over });
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const key = (a) => [a.side, a.qty, a.entryTime.replace(".000Z", "Z"), a.entryPrice, a.exitTime.replace(".000Z", "Z"), a.exitPrice, a.exitKind, a.result ?? "TIME_EXIT"];
const mkey = (m) => [m.side, m.qty, m.entry_time, m.entry_price, m.exit_time, m.exit_price, m.exit_kind, m.result];

/** In-process ALPHA TERMINAL: records every request; mirror records idempotent per account (as the Worker). */
function alpha({ decide } = {}) {
  const a = { requests: [], stored: new Map() };
  a.http = async (url, init) => {
    const b = JSON.parse(init.body);
    a.requests.push({ path: new URL(url).pathname, body: b });
    if (url.endsWith("/webhook/engine-status")) return new Response("{}", { status: 200 });
    if (url.endsWith("/webhook/engine-ledger")) return new Response(JSON.stringify({ ok: true, position: null, alerts: {} }), { status: 200 });
    if (url.endsWith("/webhook/engine-mirror")) {
      const results = b.items.map((it) => {
        const k = `${b.account.account_id}|${it.trade_id ?? it.event_id}`;
        if (a.stored.has(k)) return { seq: it.seq, status: a.stored.get(k) === JSON.stringify(it) ? "duplicate" : "conflict" };
        a.stored.set(k, JSON.stringify(it));
        return { seq: it.seq, status: "stored" };
      });
      return new Response(JSON.stringify({ ok: true, results, account: {} }), { status: 200 });
    }
    const [status, json] = (decide ?? ((x) => (x.action === "CLOSE" ? [200, { code: "DRY_RUN_ACCEPTED" }] : [422, { code: "INSUFFICIENT_PAPER_CAPITAL" }])))(b);
    return new Response(JSON.stringify(json), { status });
  };
  a.trades = (account) => [...a.stored.entries()].filter(([k]) => k.startsWith(`${account}|`)).map(([, v]) => JSON.parse(v)).filter((x) => x.type === "TRADE").sort((x, y) => x.seq - y.seq);
  return a;
}
/** A market feed with a controllable clock: `visible` completed candles. */
function feed(candles, start) {
  const f = { visible: start, down: false, hang: false, skip: null };
  f.fetch = async ({ sinceMs }) => {
    if (f.hang) return new Promise(() => {});
    if (f.down) throw new Error("Kraken HTTP 503");
    return candles.slice(0, f.visible).filter((k, i) => (f.skip === null || i < f.skip[0] || i >= f.skip[1]) && (sinceMs === null || k.t > sinceMs));
  };
  f.now = () => f.clockMs ?? candles[f.visible - 1].t + STEP + 10_000;
  return f;
}

describe("configuration", () => {
  it("production SOLUSD is unchanged: funded, same inputs hash c826d785d58a4a39, website settings on, mirror only when set", () => {
    assert.equal(P5.funded, true);
    assert.equal(P5.symbol, "SOLUSD");
    assert.equal(inputsHash(P5), "c826d785d58a4a39");
    assert.equal(P5.remoteSettings, true);
    assert.equal(P5.mirror, false);
    assert.deepEqual(marketList({ ENGINE_ENV_FILE: "none" }, ENGINE), [], "no ENGINE_MARKETS: the single-market engine runs, as today");
  });

  it("mirror-only BTCUSD/ETHUSD: the same strategy inputs ($10 fixed, long and short), no website settings, own inputs hash", () => {
    for (const s of ["BTCUSD", "ETHUSD"]) {
      const c = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ENGINE_SYMBOL: s, ENGINE_FUNDED: "off", ENGINE_MIRROR: "on" }, ENGINE);
      assert.deepEqual([c.symbol, c.funded, c.mirror, c.remoteSettings], [s, false, true, false]);
      assert.deepEqual(c.inputs, P5.inputs, "inputs identical to the SOLUSD strategy: not tuned for this market");
      assert.equal(c.inputs.riskUSD, 10);
      assert.ok(c.inputs.allowLong && c.inputs.allowShort);
      assert.notEqual(inputsHash(c), inputsHash(P5));
    }
  });

  it("refusals: a funded BTCUSD, a mirror-only market without the mirror, SOLUSD or duplicates in ENGINE_MARKETS, unknown values", () => {
    const L = (env) => () => loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ...env }, ENGINE);
    assert.throws(L({ ENGINE_SYMBOL: "BTCUSD" }), /not enabled for the engine/);
    assert.throws(L({ ENGINE_SYMBOL: "ETHUSD", ENGINE_FUNDED: "off" }), /needs ENGINE_MIRROR=on/);
    assert.throws(L({ ENGINE_SYMBOL: "SOLUSD", ENGINE_FUNDED: "off", ENGINE_MIRROR: "on" }), /not enabled as a mirror-only market/);
    assert.throws(L({ ENGINE_FUNDED: "maybe" }), /ENGINE_FUNDED must be on or off/);
    const M = (v) => () => loadMarketConfigs({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m", ENGINE_MIRROR: "on", ENGINE_MARKETS: v }, ENGINE);
    assert.throws(M("SOLUSD,BTCUSD"), /SOLUSD is not a mirror-only market/);
    assert.throws(M("BTCUSD,BTCUSD"), /twice/);
    assert.throws(M("BTCUSD,DOGEUSD"), /DOGEUSD/);
    const two = M("BTCUSD, ETHUSD")();
    assert.deepEqual(two.map((c) => [c.symbol, c.funded, c.mirror]), [["BTCUSD", false, true], ["ETHUSD", false, true]]);
  });
});

describe("SOLUSD is byte-identical to the deployed release 0db082f", () => {
  it("funded state, mirror state, every request and the audit trail match on the same candles and answers", async () => {
    const old = mkdtempSync(join(tmpdir(), "alpha-0db082f-"));
    for (const f of execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", "0db082f", "engine/src", "engine/profiles", "engine/package.json"], { encoding: "utf8" }).trim().split("\n")) {
      mkdirSync(dirname(join(old, f)), { recursive: true });
      writeFileSync(join(old, f), execFileSync("git", ["-C", REPO, "show", `0db082f:${f}`]));
    }
    const runs = [];
    for (const RunnerMod of [await import(pathToFileURL(join(old, "engine", "src", "runner.mjs")).href), { EngineRunner }]) {
      const dir = mkdtempSync(join(tmpdir(), "alpha-sol-"));
      const a = alpha({ decide: (b) => (b.action === "CLOSE" || Number(/T\d\d:(\d\d)/.exec(b.id)[1]) % 10 === 0 ? [200, { code: "DRY_RUN_ACCEPTED" }] : [422, { code: "INSUFFICIENT_PAPER_CAPITAL" }]) });
      const f = feed(CANDLES.SOLUSD, 200);
      const cfg = { symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, sync: true, apiBase: "http://alpha.test", webhookSecret: "test-secret", dataDir: dir, lateBars: 2, krakenBase: "", mirror: true, profile: "solusd-5m" };
      const r = new RunnerMod.EngineRunner(cfg, { fetchCandles: f.fetch, http: a.http, now: f.now, log: () => {} });
      await r.tick();
      while (f.visible < CANDLES.SOLUSD.length) { f.visible += 1; await r.tick(); }
      runs.push({ files: Object.fromEntries(readdirSync(dir).sort().map((x) => [x, readFileSync(join(dir, x), "utf8")])), requests: JSON.stringify(a.requests) });
    }
    assert.deepEqual(Object.keys(runs[1].files), Object.keys(runs[0].files));
    for (const name of Object.keys(runs[0].files)) assert.equal(runs[1].files[name], runs[0].files[name], name);
    assert.equal(runs[1].requests, runs[0].requests);
  });
});

describe("mirror-only markets (BTCUSD, ETHUSD): live replay on real Kraken candles", () => {
  for (const symbol of ["BTCUSD", "ETHUSD"]) {
    it(`${symbol}: every trade = the strategy's backtest of the same candles; only mirror requests; own ids, account and sequence`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `alpha-${symbol}-`));
      const a = alpha();
      const f = feed(CANDLES[symbol], 200);
      const r = new EngineRunner(mirrorCfg(symbol, dir), { fetchCandles: f.fetch, http: a.http, now: f.now, log: () => {} });
      await r.tick();
      while (f.visible < CANDLES[symbol].length) { f.visible += 1; await r.tick(); }
      const ref = runBacktest({ candles: CANDLES[symbol], symbol, intervalMin: 5, inputs: P5.inputs }).trades;
      const got = a.trades(r.mirror.accountId);
      assert.deepEqual(got.map(mkey), ref.map(key));
      assert.ok(ref.length > 0, `${symbol} has trades in the fixture`);
      assert.deepEqual([...new Set(a.requests.map((x) => x.path))], ["/webhook/engine-mirror"], "never a funded signal, ledger query or engine status");
      assert.equal(existsSync(join(dir, `state-${symbol}-5m.json`)), false, "no funded state at all");
      assert.match(r.mirror.accountId, new RegExp(`^MIRROR-${symbol}-5m-[0-9a-f]{16}$`));
      assert.ok(got.every((t) => t.trade_id.startsWith(`MIR-${symbol}-5-`)));
      assert.deepEqual(got.map((t) => t.seq), got.map((_, i) => i + 1));
      const tick = symbol === "BTCUSD" ? 0.1 : 0.01;
      for (const t of got) {
        assert.equal(t.risk_usd, 10);
        if (t.entry_price !== t.entry_candle.o) assert.ok(Math.abs(t.qty * Math.abs(t.entry_price - t.stop_price) - 10) <= t.qty * tick + 1e-9, `${t.trade_id}: fixed $10 risk`);
        assert.ok(t.entry_price >= t.entry_candle.l && t.entry_price <= t.entry_candle.h && t.exit_price >= t.exit_candle.l && t.exit_price <= t.exit_candle.h, "fills inside their candles");
      }
      const act = Date.parse(r.mirror.activatedAt);
      for (const t of got) assert.equal(t.classification, Date.parse(t.entry_time) + STEP <= act ? "historical" : "live");
      assert.ok(a.requests.every((x) => !JSON.stringify(x.body.account ?? {}).includes("test-secret")));
    });
  }
});

describe("isolation between markets in one process", () => {
  const setup = (opts = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "alpha-markets-"));
    const a = alpha();
    const feeds = { BTCUSD: feed(CANDLES.BTCUSD, 200), ETHUSD: feed(CANDLES.ETHUSD, 200) };
    const make = () => new MarketsRunner(["BTCUSD", "ETHUSD"].map((s) => mirrorCfg(s, dir)), {
      makeRunner: (cfg) => new EngineRunner(cfg, { fetchCandles: feeds[cfg.symbol].fetch, http: a.http, now: feeds[cfg.symbol].now, log: () => {} }),
      sleep: async () => {}, timeoutMs: opts.timeoutMs ?? 5_000, log: () => {},
    });
    return { dir, a, feeds, make };
  };
  const advance = (feeds) => { for (const f of Object.values(feeds)) f.visible = Math.min(f.visible + 1, CANDLES.BTCUSD.length); };
  const reference = (s) => runBacktest({ candles: CANDLES[s], symbol: s, intervalMin: 5, inputs: P5.inputs }).trades.map(key);

  it("BTCUSD's Kraken calls fail for 40 polls: ETHUSD carries on every poll; BTCUSD catches up (catch_up, observation gap), nothing lost", async () => {
    const { a, feeds, make } = setup();
    const m = make();
    await m.round();
    let ethBefore = m.markets[1].runner.mirror.candlesProcessed;
    for (let i = 0; i < 300; i++) {
      advance(feeds);
      feeds.BTCUSD.down = i >= 60 && i < 100;
      const res = await m.round();
      const eth = m.markets[1].runner.mirror.candlesProcessed;
      assert.equal(eth, ethBefore + 1, `ETHUSD processed its candle at poll ${i}`);
      ethBefore = eth;
      if (feeds.BTCUSD.down) assert.equal(res[0].ok, false);
    }
    feeds.BTCUSD.down = false;
    while (feeds.BTCUSD.visible < CANDLES.BTCUSD.length) { advance(feeds); await m.round(); }
    const btc = m.markets[0].runner.mirror;
    assert.equal(btc.resets.length, 0);
    assert.ok(btc.observationGaps.some((g) => g.candles >= 38), "the outage is disclosed");
    assert.deepEqual(a.trades(btc.accountId).map(mkey), reference("BTCUSD"));
    assert.deepEqual(a.trades(m.markets[1].runner.mirror.accountId).map(mkey), reference("ETHUSD"));
  });

  it("a hung BTCUSD request times out; ETHUSD is still polled; BTCUSD is not polled twice while the hung poll is open", async () => {
    const { feeds, make } = setup({ timeoutMs: 30 });
    const m = make();
    await m.round();
    feeds.BTCUSD.hang = true;
    advance(feeds);
    const r1 = await m.round();
    assert.match(r1[0].error.message, /timed out/);
    assert.equal(r1[1].ok, true);
    const r2 = await m.round();
    assert.match(r2[0].error.message, /still running/);
    assert.equal(r2[1].ok, true);
  });

  it("a real data gap in BTCUSD resets only BTCUSD; ETHUSD is untouched", async () => {
    const { feeds, make } = setup();
    const m = make();
    await m.round();
    for (let i = 0; i < 100; i++) { advance(feeds); await m.round(); }
    const ethBefore = JSON.stringify(m.markets[1].runner.mirror.resets);
    feeds.BTCUSD.skip = [feeds.BTCUSD.visible, feeds.BTCUSD.visible + 30];
    feeds.BTCUSD.visible += 35;
    feeds.BTCUSD.clockMs = CANDLES.BTCUSD[feeds.BTCUSD.visible - 1].t + 800 * STEP; // beyond Kraken's history
    await m.round();
    assert.equal(m.markets[0].runner.mirror.resets.length, 1);
    assert.equal(JSON.stringify(m.markets[1].runner.mirror.resets), ethBefore);
  });

  it("process restart: both markets resume from their own files; the result equals an uninterrupted run", async () => {
    const run = async (restartEvery) => {
      const { a, feeds, make } = setup();
      let m = make();
      await m.round();
      for (let i = 0; i < 400; i++) { advance(feeds); await m.round(); if (restartEvery && i % restartEvery === 0) m = make(); }
      return ["BTCUSD", "ETHUSD"].map((s, i) => a.trades(m.markets[i].runner.mirror.accountId).map(mkey));
    };
    assert.deepEqual(await run(37), await run(0));
  });

  it("the process refuses funded configs and duplicate markets; ids never collide across markets", () => {
    assert.throws(() => new MarketsRunner([P5]), /mirror-only/);
    const dir = mkdtempSync(join(tmpdir(), "alpha-dup-"));
    assert.throws(() => new MarketsRunner([mirrorCfg("BTCUSD", dir), mirrorCfg("BTCUSD", dir)], { makeRunner: () => ({}) }), /twice/);
    const ids = ["BTCUSD", "ETHUSD"].map((s) => `MIR-${s}-5-2026-11-10T00:00:00Z-LONG`);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe("entry point (run.mjs) with the local Kraken stand-in", () => {
  const runOnce = (env, cwd = ENGINE) => new Promise((resolve) => {
    const p = spawn(process.execPath, ["src/cli/run.mjs", "--once"], { cwd, env: { ...process.env, ENGINE_ENV_FILE: "none", ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => resolve({ code, out }));
  });

  it("ENGINE_MARKETS starts the mirror-only process: one mirror file per market, no funded state, locks released; a held lock is refused", async () => {
    const kraken = await startOhlcStub(719);
    try {
      const dir = mkdtempSync(join(tmpdir(), "alpha-run-markets-"));
      const env = { ENGINE_MARKETS: "BTCUSD,ETHUSD", ENGINE_PROFILE: "solusd-5m", ENGINE_MIRROR: "on", ENGINE_SYNC: "off", KRAKEN_API_BASE: kraken.base, ENGINE_DATA_DIR: dir };
      const r = await runOnce(env);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /mirror-only \(hypothetical\)/);
      const files = readdirSync(dir).sort();
      assert.deepEqual(files.filter((f) => f.startsWith("mirror-")), ["mirror-BTCUSD-5m.json", "mirror-ETHUSD-5m.json"]);
      assert.deepEqual(files.filter((f) => f.startsWith("state-") || f.endsWith(".lock")), [], "no funded state; locks released");
      for (const s of ["BTCUSD", "ETHUSD"]) {
        const m = JSON.parse(readFileSync(join(dir, `mirror-${s}-5m.json`), "utf8"));
        assert.equal(m.candlesProcessed, 719);
        assert.equal(m.lastCandle.t, iso(CANDLES[s][718].t), `${s} read its own pair's candles`);
      }
      writeFileSync(join(dir, "engine-ETHUSD-5m.lock"), String(process.pid)); // a live process holds ETHUSD
      const busy = await runOnce(env);
      assert.equal(busy.code, 1);
      assert.match(busy.out, /already runs/);
    } finally { await kraken.close(); }
  });

  it("without ENGINE_MARKETS the single-market engine runs exactly as before (SOLUSD funded state)", async () => {
    const kraken = await startOhlcStub(719);
    try {
      const dir = mkdtempSync(join(tmpdir(), "alpha-run-single-"));
      const r = await runOnce({ ENGINE_PROFILE: "solusd-5m", ENGINE_SYNC: "off", KRAKEN_API_BASE: kraken.base, ENGINE_DATA_DIR: dir });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /PAPER only, no broker orders/);
      assert.ok(existsSync(join(dir, "state-SOLUSD-5m.json")));
      assert.equal(existsSync(join(dir, "mirror-SOLUSD-5m.json")), false, "mirror stays off unless set");
    } finally { await kraken.close(); }
  });
});
