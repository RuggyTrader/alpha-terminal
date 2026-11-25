// Forward SOL OI reversal collector: definitions identical to research H-OI, real-time-only detection, LATE labelling,
// outcomes, gaps/failures, lock, restart recovery, read-only guard, and the evaluation gate / confidence intervals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, hourlyReturn, sigmaBefore, entryTime, isPrimary, outcome, netReturns, clusters, gateMet, M5, H, RULES } from "../src/research/edge/forward/core.mjs";
import { runOnce, guard } from "../src/research/edge/forward/collect.mjs";
import { stats, tQuantile } from "../src/research/edge/forward/evaluate.mjs";
import { oiStudy } from "../src/research/edge/phase2-study.mjs";

const T0 = Date.parse("2026-01-01T00:00:00Z");
function market(hours, { crashHours = [] } = {}) {
  let s = 7, p = 100, o = 1e6; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32), k = {}, oi = {};
  for (let i = 0; i < hours * 12; i++) {
    const t = T0 + i * M5, h = Math.floor(i / 12), crash = crashHours.includes(h), op = p;
    p *= 1 + (rnd() - 0.5) * 0.002 + (crash ? -0.004 : 0); if (crashHours.includes(h - 1)) p *= 1.0008; // rebound after
    k[t] = [op, Math.max(op, p), Math.min(op, p), p];
    if (crash) o *= 0.9993; oi[t] = o;
  }
  return { k, oi };
}

test("classification is identical to the research H-OI study on the same data", () => {
  const crashHours = Array.from({ length: 12 }, (_, i) => 800 + i * 37);
  const { k, oi } = market(1400, { crashHours });
  const k5 = new Map(Object.entries(k).map(([t, [o, h, l, c]]) => [+t, { o, h, l, c }])), oiM = new Map(Object.entries(oi).map(([t, v]) => [+t, v]));
  const res = oiStudy({ X: { k5, oi: oiM } }, { from: T0, to: T0 + 1400 * H });
  let ours = 0; for (let T = T0 + 721 * H; T < T0 + 1400 * H; T += H) { const c = classify(k, oi, T); if (c.qualifying) ours++; }
  assert.equal(ours, res.log[0].groups.down_OIdown_longClosing); assert.ok(ours >= 10);
});

test("entry timing: T + 5 min if detected in time; otherwise the next 5-minute bar after detection; LATE beyond 15 min", () => {
  const T = T0 + 1000 * H;
  assert.equal(entryTime(T, T + 4 * 60_000), T + 5 * 60_000); assert.equal(entryTime(T, T + 6 * 60_000), T + 10 * 60_000);
  assert.ok(isPrimary(T, T + 15 * 60_000)); assert.ok(!isPrimary(T, T + 20 * 60_000));
  const k = { [T + 5 * 60_000]: [100, 0, 0, 0], [T + 5 * 60_000 + 4 * H - M5]: [0, 0, 0, 101] };
  assert.ok(Math.abs(outcome(k, T + 5 * 60_000) - 0.01) < 1e-12); assert.equal(outcome(k, T + 10 * 60_000), null);
  const n = netReturns(0.01, 1.5e-5); assert.ok(Math.abs(n.conservative - (0.01 - 0.006 - 2 * 4 * 1.5e-5)) < 1e-12);
});

test("evaluation: gate needs 60 events AND 40 clusters; CI uses the more conservative of bootstrap and t", () => {
  const mk = (n, gapH) => Array.from({ length: n }, (_, i) => ({ T: T0 + i * gapH * H, gross: 0.01 + ((i * 7919) % 100) / 1e4 - 0.005, net: { conservative: 0 } }));
  assert.equal(gateMet(mk(59, 10)), false); assert.equal(gateMet(mk(60, 10)), true);
  assert.equal(gateMet(mk(80, 1)), false, "80 events in one long cluster are not 40 clusters");
  assert.equal(clusters(mk(10, 5)).length, 10);
  const s = stats(mk(60, 10)); assert.ok(s.ci90_lower_used_bps <= s.ci90_bootstrap_bps[0] && s.ci90_lower_used_bps <= s.ci90_t_bps[0]);
  assert.ok(Math.abs(tQuantile(0.95, 9) - 1.833) < 2e-3); // t table: df 9, 90 % two-sided -> 1.833
});

test("read-only guard: only the allow-listed GET endpoints and Solana read RPCs", async () => {
  const f = guard(async () => ({ ok: true, json: async () => [] }));
  await f("https://fapi.binance.com/fapi/v1/klines?symbol=SOLUSDT");
  for (const [u, i] of [["https://fapi.binance.com/fapi/v1/order", { method: "POST" }], ["https://fapi.binance.com/fapi/v2/account", {}], ["https://perps-api.jup.ag/v2/positions/increase", { method: "POST" }], ["https://api.mainnet-beta.solana.com", { method: "POST", body: JSON.stringify({ method: "sendTransaction" }) }], ["https://evil.example/", {}]])
    await assert.rejects(f(u, i), /guard/);
});

// fake public API over a synthetic market, serving only bars that have CLOSED by "now"
function fakeApi(k, oi, failAt = new Set()) {
  return async (url) => {
    const u = new URL(url), now = fakeApi.now;
    if (failAt.has(now)) return { ok: false, status: 503, json: async () => ({}) };
    if (u.pathname === "/fapi/v1/klines") { const st = +u.searchParams.get("startTime"); const rows = Object.keys(k).map(Number).filter((t) => t >= st && t + M5 - 1 < now).sort((a, b) => a - b).slice(0, 1500).map((t) => [t, ...k[t].map(String), "0", t + M5 - 1]); return { ok: true, json: async () => rows }; }
    if (u.pathname === "/futures/data/openInterestHist") { const rows = Object.keys(oi).map(Number).filter((t) => t + 2.7 * 60_000 <= now).sort((a, b) => a - b).slice(-60).map((t) => ({ timestamp: t, sumOpenInterest: String(oi[t]) })); return { ok: true, json: async () => rows }; }
    throw new Error("unexpected " + url);
  };
}

test("collector end to end: real-time detection, LATE during downtime, outcomes after 4 h, failures, lock, restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fwd-"));
  try {
    const crashHours = [760, 800, 840];
    const { k, oi } = market(900, { crashHours });
    const start = T0 + 750 * H + 4 * 60_000;
    const down = new Set(); for (let t = T0 + 799 * H; t < T0 + 802 * H; t += M5) down.add(t + 4 * 60_000); // PC off around the 2nd crash
    const fails = new Set([T0 + 770 * H + 4 * 60_000]);
    for (let t = start; t < T0 + 870 * H; t += M5) {
      if (down.has(t)) continue; fakeApi.now = t;
      await runOnce({ dir, fetchFn: fakeApi(k, oi, fails), now: () => t });
    }
    const evs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.qualifying);
    const byT = Object.fromEntries(evs.map((e) => [Math.round((e.T - T0) / H), e]));
    assert.ok(byT[761] && byT[761].primary && byT[761].entryDelayMin === 5, JSON.stringify(byT[761]));
    assert.ok(byT[801] && !byT[801].primary && byT[801].late, "detected after downtime -> LATE, never primary");
    const outs = readFileSync(join(dir, "outcomes.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(outs.find((o) => o.id === byT[761].id && o.status === "RESOLVED"), "outcome: " + JSON.stringify(outs));
    const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    assert.ok(st.counts.gaps >= 1 && st.counts.apiFailures >= 1 && st.counts.restarts >= 1, "counts: " + JSON.stringify(st.counts));
    assert.equal(JSON.stringify(st).includes("gross"), false, "status never shows returns");
    // a fresh lock blocks a concurrent run; a stale lock (> 10 min) is taken over and recorded
    const tL = T0 + 870 * H; writeFileSync(join(dir, "lock"), String(tL - 2 * 60_000)); fakeApi.now = tL; // held 2 min ago
    assert.equal((await runOnce({ dir, fetchFn: fakeApi(k, oi), now: () => tL })).skipped, true);
    writeFileSync(join(dir, "lock"), String(tL - 20 * 60_000)); // held 20 min ago: a crashed run
    const r = await runOnce({ dir, fetchFn: fakeApi(k, oi), now: () => tL });
    assert.ok(!r.skipped, "stale lock run skipped"); assert.match(readFileSync(join(dir, "errors.jsonl"), "utf8"), /STALE_LOCK/);
    // no event before the collector started is ever created
    assert.ok(evs.every((e) => e.T > start), "pre-start event");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
