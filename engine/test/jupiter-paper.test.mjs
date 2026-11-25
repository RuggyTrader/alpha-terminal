// Jupiter PAPER adapter + engine: read-only network guard, Jupiter-compatible request construction and validation,
// PAPER-vs-backtest parity, restart recovery, idempotency and the dashboard feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedFetch, buildRequest, validateRequest, LIVE_EXECUTION_ENABLED } from "../src/research/jupiter/adapter.mjs";
import { JupiterPaperEngine } from "../src/research/jupiter/paper-engine.mjs";
import { runBacktest } from "../src/research/jupiter/backtest.mjs";
import { aggregate, strategyA, sigmaAt, H, DAY } from "../src/research/jupiter/strategies.mjs";
import { Store } from "../src/research/jupiter/store.mjs";

const CFG = JSON.parse(readFileSync(new URL("../src/research/jupiter/config.frozen.json", import.meta.url), "utf8"));
const T0 = Date.parse("2024-01-01T00:00:00Z");
function synth(seed, days, drift) {
  let x = 100, s = seed; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32), rows = [];
  for (let i = 0; i < days * 24; i++) { const o = x; x *= Math.exp((rnd() - 0.5) * 0.03 + drift); rows.push([T0 + i * H, o, Math.max(o, x) * (1 + rnd() * 0.004), Math.min(o, x) * (1 - rnd() * 0.004), x, 1]); }
  return rows;
}
const DATA = { BTC: synth(3, 220, 0.0002), ETH: synth(5, 220, -0.0001), SOL: synth(9, 220, 0.0003) };
const source = (a, since, now) => DATA[a].filter((r) => r[0] >= since && r[0] < Math.floor(now / H) * H);

test("PAPER guard: only read-only calls pass; trading endpoints, other hosts and transaction RPCs are refused", async () => {
  assert.equal(LIVE_EXECUTION_ENABLED, false);
  const calls = [], f = guardedFetch(async (u, i) => { calls.push([u, i?.method ?? "GET"]); return { ok: true, json: async () => ({}) }; });
  await f("https://perps-api.jup.ag/v2/market-stats?mint=x");
  await f("https://api.mainnet-beta.solana.com", { method: "POST", body: JSON.stringify({ method: "getMultipleAccounts" }) });
  for (const [u, i] of [["https://perps-api.jup.ag/v2/positions/increase", { method: "POST", body: "{}" }], ["https://perps-api.jup.ag/v2/transaction/execute", { method: "POST", body: "{}" }],
    ["https://perps-api.jup.ag/v2/positions?walletAddress=x", {}], ["https://api.mainnet-beta.solana.com", { method: "POST", body: JSON.stringify({ method: "sendTransaction" }) }], ["https://example.com/", {}]])
    await assert.rejects(f(u, i), /PAPER guard/);
  assert.equal(calls.length, 2);
});

test("request construction matches the Perps API v2 shapes and is validated against Jupiter's constraints", () => {
  const open = buildRequest({ type: "OPEN", side: "long", sizeUsdDelta: 36.3, collateralUsdDelta: 33, key: "k1" }, { asset: "SOL", refPrice: 100 });
  assert.equal(open.path, "/positions/increase"); assert.equal(open.body.inputTokenAmount, "33000000"); assert.equal(open.body.sizeUsdDelta, "36300000");
  assert.equal(open.body.walletAddress, "PAPER-NO-WALLET"); assert.deepEqual(validateRequest(open, { rm: CFG.riskManager }), []);
  const small = buildRequest({ type: "OPEN", side: "short", sizeUsdDelta: 9.9, collateralUsdDelta: 9, key: "k2" }, { asset: "BTC" });
  assert.ok(validateRequest(small, { rm: CFG.riskManager }).some((x) => /minimum collateral/.test(x)));
  const lev = buildRequest({ type: "OPEN", side: "long", sizeUsdDelta: 3000, collateralUsdDelta: 10, key: "k3" }, { asset: "ETH" });
  assert.ok(validateRequest(lev, { rm: CFG.riskManager }).some((x) => /250x/.test(x)));
  const close = buildRequest({ type: "CLOSE", side: "long", sizeUsdDelta: 36.3, key: "k4" }, { asset: "SOL" });
  assert.equal(close.path, "/positions/decrease"); assert.equal(close.body.entirePosition, true); assert.deepEqual(validateRequest(close), []);
  assert.ok(validateRequest({ ...open, body: { ...open.body, walletAddress: "RealWallet111" } }, { rm: CFG.riskManager }).some((x) => /real wallet/.test(x)));
});

function runEngine(dir, candidate, startT, endT, stepDays, { crashAt } = {}) {
  let now = startT + H, eng = null, ticks = 0;
  const mk = () => new JupiterPaperEngine({ dir, config: CFG, candidate, costsName: "conservative", now: () => now, startT, barsSource: source, offline: true });
  eng = mk();
  return (async () => {
    while (now < endT) {
      now = Math.min(endT, now + stepDays * DAY);
      await eng.tick(); ticks++;
      if (crashAt && ticks === crashAt) eng = mk(); // restart from disk
    }
    return eng;
  })();
}

test("PAPER engine reproduces the backtester exactly (same signals, risk, ledger), across incremental ticks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jpaper-")), startT = T0 + 100 * DAY, endT = T0 + 215 * DAY;
  try {
    const cand = { strategy: "A", variant: "long_short", L: 2 };
    const eng = await runEngine(dir, cand, startT, endT, 3);
    const S = eng.state.run;
    const markets = Object.fromEntries(Object.entries(DATA).map(([a, rows]) => { const daily = aggregate(rows, DAY); return [a, { rows, daily, sigmaByDay: new Map(daily.map((d) => [d.t, sigmaAt(daily, d.t + DAY, 30)])), signals: strategyA(aggregate(rows, 4 * H), CFG.strategies.A, cand.variant) }]; }));
    const bt = runBacktest(markets, { from: startT, to: eng.state.lastBarT + H, L: 2, costs: CFG.costs.conservative, config: CFG });
    assert.ok(bt.trades > 0, "the fixture trades");
    assert.equal(S.trades.length, bt.trades); assert.equal(S.cash, bt.cash); assert.deepEqual(Object.keys(S.pos).sort(), bt.open.sort());
    const feed = JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8"));
    assert.equal(feed.mode, "PAPER"); assert.equal(feed.liveExecution, false); assert.equal(feed.pnl.verified, true);
    assert.ok(existsSync(join(dir, "dashboard.html")));
    const reqs = Object.values(eng.state.requests); assert.ok(reqs.length > 0);
    assert.equal(new Set(reqs.map((r) => r.key)).size, reqs.length, "one record per idempotency key");
    assert.ok(reqs.every((r) => ["EXECUTED", "SUPERSEDED", "PENDING", "EXPIRED_RETRYING", "REJECTED", "REJECTED_VALIDATION"].includes(r.status)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart recovery: a restarted engine continues to the identical result; an uncommitted tick is rolled back", async () => {
  const d1 = mkdtempSync(join(tmpdir(), "jpaper-")), d2 = mkdtempSync(join(tmpdir(), "jpaper-")), startT = T0 + 100 * DAY, endT = T0 + 180 * DAY;
  try {
    const cand = { strategy: "B", variant: "long_short", L: 3 };
    const a = await runEngine(d1, cand, startT, endT, 4), b = await runEngine(d2, cand, startT, endT, 4, { crashAt: 5 });
    assert.ok(a.state.run.trades.length + Object.keys(a.state.run.pos).length > 0, "the fixture trades");
    assert.equal(a.state.run.cash, b.state.run.cash); assert.equal(a.state.run.trades.length, b.state.run.trades.length);
    assert.deepEqual(a.state.run.rng, b.state.run.rng); assert.equal(a.state.lastBarT, b.state.lastBarT);
    appendFileSync(join(d2, "journal.jsonl"), JSON.stringify({ seq: 10 ** 6, type: "REQUEST", data: {} }) + "\n" + "{torn");
    const s = new Store(d2); assert.ok(s.recoveredOrphans >= 1);
    assert.match(readFileSync(join(d2, "journal.jsonl"), "utf8"), /ROLLED_BACK/);
  } finally { rmSync(d1, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true }); }
});

test("observation mode (no qualified strategy): ingests, monitors and reconciles, but never creates a request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jpaper-"));
  try {
    const eng = await runEngine(dir, null, T0 + 100 * DAY, T0 + 130 * DAY, 5);
    assert.equal(Object.keys(eng.state.requests).length, 0); assert.equal(eng.state.run.cash, 100);
    assert.equal(JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8")).status, "OBSERVATION_ONLY");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
