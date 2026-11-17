// Forward research shadow: append-only store (no rewrite, revisions recorded, open candles never stored), audit hash
// chain, catch-up after downtime equals continuous collection, deterministic replay from start_at, minimums required,
// and isolation from every production path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCandles, audit, readCandles, verifyAudit } from "../src/research/forward/store.mjs";
import { collectMarket } from "../src/research/forward/collect.mjs";
import { evaluateForward, LABEL } from "../src/research/forward/shadow.mjs";

const H = 3_600_000, DAY = 86_400_000;
const tmp = () => mkdtempSync(join(tmpdir(), "fwd-"));
const k = (t, c) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1 });

describe("forward store", () => {
  it("stores only closed candles, never rewrites, and records revisions while keeping first-seen values", () => {
    const d = tmp();
    const r1 = appendCandles(d, "X", 3600, [k(0, 10), k(H, 11), k(2 * H, 12)], { now: 2 * H + 10, source: "test" });
    assert.deepEqual(r1, { added: 2, revised: 0, skippedOpen: 1 }, "the forming candle is not stored");
    const r2 = appendCandles(d, "X", 3600, [k(H, 99), k(2 * H, 12)], { now: 3 * H, source: "test" });
    assert.deepEqual(r2, { added: 1, revised: 1, skippedOpen: 0 });
    const { candles, revisions } = readCandles(d, "X", 3600);
    assert.equal(candles.find((c) => c.t === H).c, 11, "first-seen value kept");
    assert.equal(revisions.length, 1);
  });
  it("audit log is hash-chained and detects tampering", () => {
    const d = tmp();
    audit(d, { kind: "A", at: "x" }); audit(d, { kind: "B", at: "y" });
    assert.deepEqual(verifyAudit(d), { ok: true, rows: 2 });
    const f = join(d, "audit.jsonl"), rows = readFileSync(f, "utf8").split("\n").filter(Boolean);
    rows[0] = rows[0].replace('"kind":"A"', '"kind":"Z"'); writeFileSync(f, rows.join("\n") + "\n");
    assert.equal(verifyAudit(d).ok, false);
  });
});

/** A fake exchange serving a fixed hourly history (Coinbase row order: [time, low, high, open, close, volume]). */
function fakeExchange(hist) {
  return async (url) => {
    const u = new URL(url), s = Date.parse(u.searchParams.get("start")), e = Date.parse(u.searchParams.get("end"));
    return hist.filter((x) => x.t >= s && x.t <= e).reverse().map((x) => [x.t / 1000, x.l, x.h, x.o, x.c, 1]);
  };
}

describe("collector", () => {
  const hist = Array.from({ length: 100 }, (_, i) => k(i * H, 100 + i));
  it("a run after downtime stores exactly what continuous runs would have", async () => {
    const a = tmp(), b = tmp(), f = fakeExchange(hist);
    for (let n = 10; n <= 100; n += 10) await collectMarket(a, "X", 3600, { warmupFrom: "1970-01-01T00:00:00Z", now: n * H, fetchJson: f, pauseMs: 0 });
    await collectMarket(b, "X", 3600, { warmupFrom: "1970-01-01T00:00:00Z", now: 100 * H, fetchJson: f, pauseMs: 0 });
    const strip = (d) => readCandles(d, "X", 3600).candles.map(({ t, o, h, l, c }) => [t, o, h, l, c]);
    assert.deepEqual(strip(a), strip(b));
    assert.equal(strip(b).length, 100);
  });
});

describe("shadow evaluator", () => {
  function store(d, m, n, f) { appendCandles(d, m, 86400, Array.from({ length: n }, (_, i) => { const c = f(i); return { t: i * DAY, o: c, h: c * 1.01, l: c * 0.99, c }; }), { now: (n + 1) * DAY, source: "test" }); }
  const reg = (over = {}) => ({ id: "RESEARCH-FWD-M1", source_candidate: "R8-M1-1440-30", registered_at: "x", start_at: new Date(60 * DAY).toISOString(), basket: ["UP", "DN"], scenario: "B", capital: 100,
    minimums: { UP: { minQty: 0, minCost: 0.5 }, DN: { minQty: 0, minCost: 0.5 } }, min_days: 180, min_trades: 30, ...over });
  it("trades only from start_at, is labelled hypothetical, is deterministic, and stays COLLECTING with little data", () => {
    const d = tmp(); store(d, "UP", 120, (i) => 100 * 1.01 ** i); store(d, "DN", 120, (i) => 100 * 0.99 ** i);
    const a = evaluateForward(d, reg(), { now: 0 }), b = evaluateForward(d, reg(), { now: 0 });
    assert.deepEqual(a, b);
    assert.equal(a.label, LABEL);
    assert.match(a.status, /COLLECTING/);
    assert.ok(a.selected_costs.fees > 0 || a.open_positions.length > 0);
    for (const x of a.information_audit) assert.ok(Date.parse(x.decided_at_close) >= 60 * DAY, "no decision before start_at");
    assert.ok(a.open_positions.every((p) => p.market === "UP"), "only the rising market is held");
  });
  it("excludes a market with no published minimum instead of assuming zero", () => {
    const d = tmp(); store(d, "UP", 120, (i) => 100 * 1.01 ** i); store(d, "DN", 120, (i) => 100);
    const r = evaluateForward(d, reg({ minimums: { DN: { minQty: 0, minCost: 0.5 } } }), { now: 0 });
    assert.deepEqual(r.excluded_markets.map((x) => x.market), ["UP"]);
    assert.equal(r.markets_with_data, 1);
  });
  it("refuses an isolated (per-bot) scenario: forward shadow is a shared research account", () => {
    assert.throws(() => evaluateForward(tmp(), reg({ scenario: "A" })), /shared-account/);
  });
});

describe("isolation from production", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/research/forward");
  it("imports nothing from the engine's execution, sync, ledger or Worker code and uses only public market-data hosts", () => {
    for (const f of readdirSync(dir)) {
      // the refusal guard names production paths only to refuse them; every other line must not mention them
      const src = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.includes("refusing research state path") && !l.trim().startsWith("//")).join("\n");
      for (const imp of src.matchAll(/from\s+"([^"]+)"/g)) {
        const p = imp[1];
        assert.ok(p.startsWith("node:") || p.startsWith("./") || p.startsWith("../r8/") || p.startsWith("../r7/") || p === "../../cli/fleet-backtest.mjs", `${f} imports ${p}`);
      }
      for (const h of src.matchAll(/https:\/\/([a-z0-9.-]+)/g)) assert.ok(["api.exchange.coinbase.com", "api.kraken.com"].includes(h[1]), `${f} contacts ${h[1]}`);
      assert.doesNotMatch(src, /workers\.dev|\/api\/paper|ENGINE_|engine\.env|ADMIN_SECRET|PASSPHRASE|AddOrder|private\//i, `${f} references a production path`);
    }
  });
  it("the registry is frozen research: start_at after registration, shared scenario, RESEARCH-FWD ids", () => {
    const reg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/research/forward/registry.json"), "utf8"));
    assert.ok(reg.candidates.length >= 3);
    for (const c of reg.candidates) {
      assert.match(c.id, /^RESEARCH-FWD-/);
      assert.ok(Date.parse(c.start_at) > Date.parse(c.registered_at));
      assert.notEqual(c.scenario, "A");
    }
  });
});
