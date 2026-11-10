// Strategy Mirror V1 (src/mirror.mjs + runner integration): parity, funded-track isolation and reliability.
// No network: real Kraken SOLUSD 5m candles from committed fixtures; the Worker is a small in-process fake that
// follows the real endpoint's contract (worker/src/mirror.ts; the real endpoint is tested in worker/test/mirror.test.mjs).
//   node --test test/mirror.test.mjs

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";
import { metrics } from "../src/cli/baseline.mjs";
import { activate, createMirror, mirrorStep, resetForGap } from "../src/mirror.mjs";
import { EngineRunner } from "../src/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEP = 300_000;
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const cfg150 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, join(HERE, ".."));
const P5 = cfg150; // the production profile (solusd-5m): both directions, fixed $10 risk

// 150 days of Kraken SOLUSD 5m (the corrected baseline dataset, STRATEGY-AUDIT-2026-11-09.md section 3).
const D150 = JSON.parse(gunzipSync(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-150d.rows.json.gz"))).toString("utf8"));
const C150 = D150.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
// The committed TradingView benchmark window (2026-10-19 .. 2026-11-07) and its report (screenshots, not a CSV).
const BENCH = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-2026-10-19_2026-11-07.json"), "utf8")).rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const TV = JSON.parse(readFileSync(join(HERE, "..", "parity", "tv-solusd-5m-2026-11-07.json"), "utf8"));
// 720 real candles (Kraken OHLC endpoint) for the live-runner tests.
const C720 = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;

/** Replays candles through a mirror exactly as the runner does (one candle at a time, processed after its close). */
function replay(candles, inputs, { activateAfter = null } = {}) {
  const ctx = { nowMs: 0, lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs, inputsHash: "0123456789abcdef" };
  const M = createMirror({ ...ctx, nowMs: candles[0].t });
  candles.forEach((k, i) => {
    mirrorStep(M, k, { ...ctx, nowMs: k.t + STEP + 5_000 });
    if (activateAfter !== null && i === activateAfter) activate(M, k.t + STEP + 5_000);
  });
  return M;
}
const tradesOf = (M) => M.outbox.filter((x) => x.type === "TRADE");
const key = (a) => [a.side, a.qty, a.entryTime.replace(".000Z", "Z"), a.entryPrice, a.exitTime.replace(".000Z", "Z"), a.exitPrice, a.exitKind, a.result ?? "TIME_EXIT", Number(a.pnl.toFixed(4))];
const mkey = (m) => [m.side, m.qty, m.entry_time, m.entry_price, m.exit_time, m.exit_price, m.exit_kind, m.result, Number(m.gross_pnl.toFixed(4))];
const r2 = (v) => Math.round(v * 100) / 100;

describe("A. historical parity: 150 days, trade by trade against the verified Model A replay", () => {
  const A = runBacktest({ candles: C150, symbol: "SOLUSD", intervalMin: 5, inputs: cfg150.inputs }).trades;
  const M = replay(C150, cfg150.inputs);
  const T = tradesOf(M);

  it("the committed dataset is the one the baseline study used (43,188 candles, checksum)", () => {
    assert.equal(C150.length, 43_188);
    assert.equal(createHash("sha256").update(JSON.stringify(D150.rows)).digest("hex"), D150.rows_sha256);
    assert.equal(D150.from, "2026-06-12T00:00:00.000Z");
    assert.equal(D150.to, "2026-11-09T00:00:00.000Z");
  });

  it("579 closed trades, +$150.24 gross, 308 longs and 271 shorts, same exit mix", () => {
    assert.equal(A.length, 579, "reference replay (STRATEGY-AUDIT section 3)");
    assert.equal(T.length, 579);
    assert.equal(r2(T.reduce((s, t) => s + t.gross_pnl, 0)), 150.24);
    assert.equal(T.filter((t) => t.side === "LONG").length, 308);
    assert.equal(T.filter((t) => t.side === "SHORT").length, 271);
    assert.equal(r2(T.filter((t) => t.side === "LONG").reduce((s, t) => s + t.gross_pnl, 0)), 230.97);
    assert.equal(r2(T.filter((t) => t.side === "SHORT").reduce((s, t) => s + t.gross_pnl, 0)), -80.73);
    const mix = (list, f) => list.reduce((o, t) => ((o[f(t)] = (o[f(t)] ?? 0) + 1), o), {});
    assert.deepEqual(mix(T, (t) => t.result), { SL: 121, TRAILING_SL: 261, TP2: 127, SAME_BAR: 23, BREAK_EVEN: 47 });
    const m = metrics(T.map((t) => ({ side: t.side, pnl: t.gross_pnl, entryTime: t.entry_time, exitTime: t.exit_time, result: t.result })));
    assert.equal(m.profit_factor, 1.076);
    assert.equal(m.max_drawdown, 225.97);
    assert.equal(m.winners, 217);
  });

  it("every trade matches: side, quantity, entry/exit time and price, exit kind, outcome and P&L", () => {
    const diffs = [];
    for (let i = 0; i < A.length; i++) if (JSON.stringify(key(A[i])) !== JSON.stringify(mkey(T[i]))) diffs.push({ i, a: key(A[i]), m: mkey(T[i]) });
    assert.deepEqual(diffs.slice(0, 3), [], `${diffs.length} trades differ`);
  });

  it("provenance: unique ids, contiguous sequence, initial stop and TP2 on every trade, fills inside their candles", () => {
    assert.equal(new Set(T.map((t) => t.trade_id)).size, 579);
    assert.deepEqual(T.map((t) => t.seq), Array.from({ length: 579 }, (_, i) => i + 1));
    for (const t of T) {
      assert.ok(t.provenance_complete && t.stop_price > 0 && t.tp2_price > 0, t.trade_id);
      assert.ok(t.side === "LONG" ? t.stop_price < t.tp2_price : t.stop_price > t.tp2_price, t.trade_id);
      assert.equal(t.entry_candle.t, t.entry_time);
      assert.equal(t.exit_candle.t, t.exit_time);
      assert.ok(t.entry_price >= t.entry_candle.l && t.entry_price <= t.entry_candle.h, `${t.trade_id} entry inside its candle`);
      assert.ok(t.exit_price >= t.exit_candle.l && t.exit_price <= t.exit_candle.h, `${t.trade_id} exit inside its candle`);
      assert.ok(Math.abs(t.gross_pnl - (t.exit_price - t.entry_price) * t.qty * (t.side === "LONG" ? 1 : -1)) < 1e-9);
      // Fixed $10 risk: qty = 10 / (unrounded entry level - unrounded stop); orders sit at tick-rounded prices, so the
      // distance between the rounded levels differs by at most one tick (a gap fill at the open differs more).
      assert.equal(t.risk_usd, 10);
      if (t.entry_price !== t.entry_candle.o) assert.ok(Math.abs(t.qty * Math.abs(t.entry_price - t.stop_price) - 10) <= t.qty * 0.01 + 1e-9, `${t.trade_id} risk`);
      assert.equal(t.classification, "historical", "no activation in a replay: everything is historical");
    }
  });

  it("same-candle entry and exit are recorded as such (23), inside one candle", () => {
    const same = T.filter((t) => t.result === "SAME_BAR");
    assert.equal(same.length, 23);
    for (const t of same) assert.equal(t.entry_time, t.exit_time);
  });
});

describe("A. benchmark window against the TradingView report (external evidence: screenshots, not a CSV export)", () => {
  const T = tradesOf(replay(BENCH, cfg150.inputs));
  it("summary equals the TradingView Strategy Report: 69 trades, 32 winners, PF 3.298, max DD $21.95, net $249.98", () => {
    const m = metrics(T.map((t) => ({ side: t.side, pnl: t.gross_pnl, entryTime: t.entry_time, exitTime: t.exit_time, result: t.result })));
    assert.equal(T.length, TV.summary.closed_trades);
    assert.equal(m.winners, TV.summary.winning_trades);
    assert.equal(m.profit_factor, TV.summary.profit_factor);
    assert.equal(m.max_drawdown, TV.summary.max_drawdown);
    assert.ok(Math.abs(m.net - TV.summary.net_pnl) <= 0.02, `net ${m.net} vs ${TV.summary.net_pnl}`);
  });
  it("every trade listed in the report matches at its trade number (time, side, prices, quantity, P&L)", () => {
    for (const r of TV.trades) {
      const t = T[r.n - 1];
      assert.ok(t, `trade #${r.n}`);
      assert.deepEqual([t.side, t.entry_time, t.exit_time], [r.side, r.entry, r.exit], `#${r.n}`);
      assert.ok(Math.abs(t.entry_price - r.entry_price) < 0.005 && Math.abs(t.exit_price - r.exit_price) < 0.005, `#${r.n} prices`);
      assert.ok(Math.abs(t.qty - r.qty) < 0.006 && Math.abs(t.gross_pnl - r.pnl) < 0.006, `#${r.n} qty/P&L`);
    }
  });
});

// ---------------------------------------------------------------- live runner harness (fake Kraken + fake Worker)

/** In-process model of POST /webhook/engine-mirror: idempotent by id, refuses a reused sequence or changed content. */
function fakeMirrorWorker() {
  const store = new Map();
  const bySeq = new Map();
  const w = { store, bySeq, calls: 0, mode: "up", accounts: [], stored: [] };
  w.handle = (body) => {
    w.calls += 1;
    w.accounts.push(body.account);
    const results = [];
    for (const it of body.items) {
      const id = it.type === "TRADE" ? it.trade_id : it.event_id;
      const text = JSON.stringify(it);
      if (store.has(id)) results.push({ seq: it.seq, id, status: store.get(id) === text ? "duplicate" : "conflict", code: store.get(id) === text ? undefined : "TRADE_CONFLICT" });
      else if (bySeq.has(it.seq)) results.push({ seq: it.seq, id, status: "conflict", code: "SEQ_CONFLICT" });
      else { store.set(id, text); bySeq.set(it.seq, id); w.stored.push(it); results.push({ seq: it.seq, id, status: "stored" }); }
    }
    return { ok: true, results, account: { last_contiguous_seq: bySeq.size, max_seq_seen: Math.max(0, ...bySeq.keys()), missing: 0 } };
  };
  return w;
}

/**
 * candles: the "market"; visible: how many have completed. decide(body) answers funded /webhook/dry-run (default:
 * every entry refused for capital, as production's $10 SOLUSD balance does). mirror: true/false.
 */
function harness({ candles = C720, visible, mirror = true, decide, worker = fakeMirrorWorker(), dataDir = mkdtempSync(join(tmpdir(), "alpha-mirror-")), feed } = {}) {
  const cfg = { symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, sync: true, apiBase: "http://alpha.test", webhookSecret: "test-secret", dataDir, lateBars: 2, krakenBase: "", mirror, profile: "test" };
  const h = { cfg, worker, visible, sent: [], clockMs: null, dataDir };
  h.now = () => h.clockMs ?? candles[h.visible - 1].t + STEP + 10_000;
  const fetchCandles = feed ? (args) => feed(h, args) : async ({ sinceMs }) => candles.slice(0, h.visible).filter((k) => sinceMs === null || k.t > sinceMs);
  const ledger = { position: null, alerts: {} };
  const answer = decide ?? ((b) => (b.action === "CLOSE" ? [200, { code: "DRY_RUN_ACCEPTED" }] : [422, { code: "INSUFFICIENT_PAPER_CAPITAL", message: "Estimated $3000 exceeds SOLUSD PAPER balance available $10" }]));
  h.http = async (url, init) => {
    const body = JSON.parse(init.body);
    h.sent.push({ url, body });
    if (url.endsWith("/webhook/engine-status")) return new Response("{}", { status: 200 });
    if (url.endsWith("/webhook/engine-ledger")) {
      const ids = body.alert_ids ?? [];
      return new Response(JSON.stringify({ ok: true, position: ledger.position, alerts: Object.fromEntries(ids.filter((i) => ledger.alerts[i]).map((i) => [i, ledger.alerts[i]])) }), { status: 200 });
    }
    if (url.endsWith("/webhook/engine-mirror")) {
      const w = h.worker;
      if (w.mode === "down") return new Response(JSON.stringify({ ok: false, code: "D1_ERROR" }), { status: 503 });
      if (w.mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      const res = w.handle(body);
      if (w.mode === "lost-reply") throw new TypeError("fetch failed (reply lost after the Worker stored the records)");
      return new Response(JSON.stringify(res), { status: 200 });
    }
    const [status, json] = answer(body);
    if (status === 200 && json.code === "DRY_RUN_ACCEPTED") {
      ledger.alerts[body.id] = { status: "dry_run", response_code: "DRY_RUN_ACCEPTED" };
      ledger.position = body.action === "CLOSE" ? null : { symbol: "SOLUSD", side: body.action === "BUY" ? "long" : "short", status: "OPEN", qty: Number(body.qty), open_alert_id: body.id };
    } else ledger.alerts[body.id] = { status: "rejected", response_code: json.code, rejection_reason: json.message ?? null };
    return new Response(JSON.stringify(json), { status });
  };
  h.make = () => new EngineRunner(cfg, { fetchCandles, http: h.http, now: h.now, log: () => {} });
  h.audit = () => readFileSync(join(dataDir, "audit-SOLUSD-5m.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return h;
}

const WARM = 200;
async function runLive(h, r, until = C720.length, onStep) {
  while (h.visible < until) {
    h.visible += 1;
    await r.tick();
    if (onStep) await onStep(r);
  }
}

describe("live runner: the mirror runs on the same candles, independently of the funded track", () => {
  it("records every trade of the strategy (= the replay of the same candles) while the funded track's entries are all refused", async () => {
    const h = harness({ visible: WARM });
    const r = h.make();
    await r.tick();
    assert.ok(r.mirror.activatedAt, "activated after the warm-up batch");
    let openWhileFundedDropped = 0;
    await runLive(h, r, C720.length, (rr) => {
      const dropped = h.audit().filter((a) => a.type === "entry_dropped").length;
      if (dropped && rr.mirror.strategy.broker.pos && !rr.state.strategy.broker.pos) openWhileFundedDropped += 1;
    });
    const ref = runBacktest({ candles: C720, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs }).trades;
    const stored = h.worker.stored.filter((x) => x.type === "TRADE");
    assert.ok(ref.length >= 10, "the fixture has trades");
    assert.deepEqual(stored.map(mkey), ref.map(key), "mirror = uninterrupted strategy replay, trade by trade");
    assert.ok(r.state.refusedEntries > 0, "the funded track's entries were refused and dropped");
    assert.ok(r.state.strategy.broker.closed.length < stored.length, "the funded track's own record is shorter (it drops refused entries)");
    assert.ok(openWhileFundedDropped > 0, "the mirror held a position while the funded track had dropped its own");
    const act = Date.parse(r.mirror.activatedAt);
    for (const t of stored) assert.equal(t.classification, Date.parse(t.entry_time) + STEP <= act ? "historical" : "live", t.trade_id);
    assert.ok(stored.some((t) => t.classification === "live") && stored.some((t) => t.classification === "historical"));
    assert.equal(r.mirror.outbox.length, 0, "everything delivered");
    assert.deepEqual([...h.worker.bySeq.keys()].sort((a, b) => a - b), Array.from({ length: h.worker.bySeq.size }, (_, i) => i + 1));
    const a = h.worker.accounts.at(-1);
    assert.match(a.account_id, /^MIRROR-SOLUSD-5m-[0-9a-f]{16}$/);
    assert.equal(a.activated_at, r.mirror.activatedAt);
    assert.equal(JSON.stringify(a).includes("test-secret"), false, "no secret in the account record");
    assert.ok(h.sent.filter((s) => s.url.endsWith("/engine-mirror")).every((s) => s.body.secret === "test-secret" && s.body.items.every((i) => !("secret" in i))));
  });

  it("funded-track isolation: with the mirror on, the funded state, its requests and its audit are byte-identical", async () => {
    const run = async (mirror) => {
      const h = harness({ visible: WARM, mirror, decide: (b) => (b.action === "CLOSE" || Number(/T\d\d:(\d\d)/.exec(b.id)[1]) % 10 === 0 ? [200, { code: "DRY_RUN_ACCEPTED" }] : [422, { code: "INSUFFICIENT_PAPER_CAPITAL" }]) });
      const r = h.make();
      await r.tick();
      await runLive(h, r);
      return {
        state: readFileSync(join(h.dataDir, "state-SOLUSD-5m.json"), "utf8"),
        funded: JSON.stringify(h.sent.filter((s) => !s.url.endsWith("/engine-mirror") && !s.url.endsWith("/engine-status"))),
        status: JSON.stringify(h.sent.filter((s) => s.url.endsWith("/engine-status")).map((s) => s.body.status)),
        audit: JSON.stringify(h.audit().filter((a) => !a.type.startsWith("mirror_"))),
        accepted: r.state.outbox.filter((x) => x.status === "accepted").length,
        refused: r.state.outbox.filter((x) => x.status === "rejected").length,
      };
    };
    const off = await run(false), on = await run(true);
    assert.ok(off.accepted > 0 && off.refused > 0, "the scenario has accepted and refused funded entries");
    assert.equal(on.state, off.state, "funded state file");
    assert.equal(on.funded, off.funded, "dry-run and ledger requests");
    assert.equal(on.status, off.status, "engine status heartbeats");
    assert.equal(on.audit, off.audit, "funded audit trail");
  });

  it("engine restart with an open mirror position: resumes exactly; the result equals the uninterrupted run", async () => {
    const full = harness({ visible: WARM });
    let r = full.make();
    await r.tick();
    await runLive(full, r);
    const h = harness({ visible: WARM });
    r = h.make();
    await r.tick();
    let restarts = 0;
    while (h.visible < C720.length) {
      h.visible += 1;
      await r.tick();
      if (r.mirror.strategy.broker.pos && restarts < 5) { r = h.make(); restarts += 1; } // process restart from the saved files
    }
    assert.equal(restarts, 5);
    assert.deepEqual(h.worker.stored.map((x) => mkey(x)), full.worker.stored.map((x) => mkey(x)));
    assert.equal(r.mirror.recordedTrades, full.worker.stored.length);
  });

  it("Worker down, timeouts and a lost reply: records wait, then each is stored exactly once, in order, nothing lost", async () => {
    const h = harness({ visible: WARM });
    const r = h.make();
    await r.tick();
    const modes = ["down", "timeout", "lost-reply", "up"];
    let i = 0;
    await runLive(h, r, C720.length, () => { h.worker.mode = modes[Math.floor(i++ / 40) % modes.length]; });
    h.worker.mode = "up";
    await r.tick();
    const ref = runBacktest({ candles: C720, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs }).trades;
    const stored = h.worker.stored.filter((x) => x.type === "TRADE").sort((a, b) => a.seq - b.seq);
    assert.deepEqual(stored.map(mkey), ref.map(key));
    assert.equal(new Set(stored.map((t) => t.trade_id)).size, stored.length, "no trade stored twice");
    assert.equal(r.mirror.outbox.length, 0);
    assert.ok(h.sent.filter((s) => s.url.endsWith("/engine-mirror")).length > ref.length / 2, "retries happened");
    assert.ok(h.worker.calls > 0 && h.audit().every((a) => a.type !== "mirror_divergence"), "a lost reply is a duplicate, not a divergence");
  });

  it("a record the Worker refuses (conflict) is kept and reported as a divergence, never dropped silently", async () => {
    const h = harness({ visible: WARM });
    const r = h.make();
    await r.tick();
    // Another writer already used sequence numbers 1-3 for something else.
    for (const s of [1, 2, 3]) h.worker.bySeq.set(s, `other-${s}`);
    await runLive(h, r, WARM + 200);
    assert.ok(r.mirror.outbox.some((x) => x.status === "refused" && x.refused_code === "SEQ_CONFLICT"));
    assert.ok(h.audit().some((a) => a.type === "mirror_divergence"));
    assert.ok(r.mirrorAccount().refused > 0);
  });
});

describe("candles: repeated, out of order, late, missing; no lookahead", () => {
  it("repeated and out-of-order candles are ignored by the mirror (counted), never re-run", () => {
    const clean = tradesOf(replay(C720, P5.inputs));
    const ctx = { nowMs: 0, lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: "0123456789abcdef" };
    const M = createMirror({ ...ctx, nowMs: C720[0].t });
    let extra = 0;
    C720.forEach((k, i) => {
      mirrorStep(M, k, { ...ctx, nowMs: k.t + STEP + 5_000 });
      if (i % 50 === 0) { mirrorStep(M, k, { ...ctx, nowMs: k.t + STEP + 6_000 }); extra += 1; } // repeated
      if (i > 3 && i % 70 === 0) { mirrorStep(M, C720[i - 3], { ...ctx, nowMs: k.t + STEP + 7_000 }); extra += 1; } // out of order
    });
    assert.equal(M.skippedCandles, extra);
    assert.deepEqual(tradesOf(M).map(mkey), clean.map(mkey));
  });

  it("a feed that keeps re-sending old candles changes nothing (funded and mirror both skip them)", async () => {
    const plain = harness({ visible: WARM });
    let r = plain.make();
    await r.tick();
    await runLive(plain, r, WARM + 150);
    const noisy = harness({ visible: WARM, feed: async (h) => C720.slice(0, h.visible) }); // ignores sinceMs
    r = noisy.make();
    await r.tick();
    await runLive(noisy, r, WARM + 150);
    assert.deepEqual(noisy.worker.stored.map(mkey), plain.worker.stored.map(mkey));
    assert.equal(readFileSync(join(noisy.dataDir, "state-SOLUSD-5m.json"), "utf8").length > 0, true);
  });

  it("catch-up after downtime (history still available): late candles are recorded as catch_up, not live; funded entries expire", async () => {
    const h = harness({ visible: WARM });
    const r = h.make();
    await r.tick();
    await runLive(h, r, WARM + 40);
    h.visible = WARM + 400; // the engine was down for 360 candles (30 hours); Kraken still has them
    await r.tick();
    await runLive(h, r);
    const stored = h.worker.stored.filter((x) => x.type === "TRADE");
    const catchUp = stored.filter((t) => t.classification === "catch_up");
    assert.ok(catchUp.length > 0, "trades entered during the outage are catch_up");
    for (const t of catchUp) {
      const ms = Date.parse(t.entry_time);
      assert.ok(ms + STEP > C720[WARM + 39].t + STEP && ms < C720[WARM + 400].t, t.trade_id);
    }
    assert.ok(stored.every((t) => t.classification !== "live" || Date.parse(t.entry_time) >= C720[WARM + 399].t));
    const ref = runBacktest({ candles: C720, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs }).trades;
    assert.deepEqual(stored.map(mkey), ref.map(key), "no trade lost or invented by the catch-up");
    assert.ok(r.state.outbox.some((x) => x.code === "SIGNAL_EXPIRED"), "the funded track does not send stale entries");
  });

  it("a real data gap: fresh warm-up, an open hypothetical position is recorded as POSITION_INTERRUPTED (no exit, no P&L)", async () => {
    // Find a candle where the mirror holds a position, then make the next 30 candles unavailable (beyond Kraken's history).
    let cut = null;
    const ctx = { nowMs: 0, lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: "0123456789abcdef" };
    const M = createMirror({ ...ctx, nowMs: C720[0].t });
    for (let i = 0; i < C720.length && cut === null; i++) {
      mirrorStep(M, C720[i], { ...ctx, nowMs: C720[i].t + STEP + 5_000 });
      if (i > WARM && M.strategy.broker.pos) cut = i + 1;
    }
    assert.ok(cut !== null);
    const missing = 30;
    const h = harness({ visible: cut, feed: async (hh, { sinceMs }) => C720.slice(0, hh.visible).filter((k, i) => (i < cut || i >= cut + missing) && (sinceMs === null || k.t > sinceMs)) });
    const r = h.make();
    await r.tick();
    assert.ok(r.mirror.strategy.broker.pos, "open position before the gap");
    h.visible = cut + missing + 5;
    await r.tick();
    const ev = h.worker.stored.filter((x) => x.type === "POSITION_INTERRUPTED");
    assert.equal(ev.length, 1);
    assert.match(ev[0].reason, /gap of 30 candles/);
    assert.equal(r.mirror.interruptions, 1);
    assert.equal(h.worker.stored.filter((x) => x.type === "TRADE" && x.trade_id === ev[0].trade_id).length, 0, "the interrupted position has no invented exit");
    assert.ok(h.audit().some((a) => a.type === "mirror_reset" && a.open_position_interrupted === true));
    assert.equal(r.mirror.activatedAt !== null, true, "activation is not reset");
  });

  it("no lookahead: everything decided up to a candle is identical whether or not later candles exist", () => {
    for (const n of [250, 400, 555]) {
      const part = replay(C720.slice(0, n), P5.inputs);
      const full = replay(C720, P5.inputs);
      const doneBy = C720[n - 1].t;
      const fullDone = tradesOf(full).filter((t) => Date.parse(t.exit_time) <= doneBy);
      assert.deepEqual(tradesOf(part).map(mkey), fullDone.map(mkey), `trades closed by candle ${n}`);
      const again = replay(C720.slice(0, n), P5.inputs);
      assert.equal(JSON.stringify(again.strategy), JSON.stringify(part.strategy), "deterministic");
    }
  });

  it("reset helper keeps the account, the sequence and activation", () => {
    const ctx = { nowMs: C720[300].t, lateMs: 2 * STEP, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: "0123456789abcdef" };
    const M = replay(C720.slice(0, 300), P5.inputs, { activateAfter: 100 });
    const before = { id: M.accountId, seq: M.seq, act: M.activatedAt };
    resetForGap(M, ctx, "test");
    assert.deepEqual({ id: M.accountId, seq: M.seq - (M.interruptions ? 1 : 0), act: M.activatedAt }, before);
    assert.equal(M.strategy.lastTime, null);
  });
});

describe("configuration", () => {
  it("ENGINE_MIRROR is off unless turned on, and only accepts on/off", () => {
    assert.equal(cfg150.mirror, false);
    assert.equal(loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_MIRROR: "on" }, join(HERE, "..")).mirror, true);
    assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_MIRROR: "yes" }, join(HERE, "..")), /ENGINE_MIRROR/);
  });
  it("mirror state from different strategy inputs is kept aside and a new account starts", async () => {
    const h = harness({ visible: WARM });
    await h.make().tick();
    const file = join(h.dataDir, "mirror-SOLUSD-5m.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, inputsHash: "ffffffffffffffff" }));
    const r = h.make();
    assert.equal(r.mirror, null, "not reused");
    await r.tick();
    assert.notEqual(r.mirror.accountId.endsWith("ffffffffffffffff"), true);
  });
});
