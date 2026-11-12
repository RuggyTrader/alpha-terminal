// UNIVERSAL POSITION SIZING — shared acceptance tests and regression gate (docs/UNIVERSAL-POSITION-SIZING.md).
// Every market in the instrument registry, current and future, is tested here automatically: a new registry entry is
// picked up without editing this file, and a funded market that fails these checks cannot pass the engine suite.
//   node --test test/sizing-acceptance.test.mjs
//
// Prices: SOLUSD/BTCUSD/ETHUSD use the last REAL Kraken close of the committed fixtures. Stock/contract cases use
// clearly labelled TEST instrument specs (not real markets; nothing like them is enabled) to prove the shared engine
// handles whole-share and contract rules honestly.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { FUNDED_SYMBOLS, fundedStatus, getInstrument, INSTRUMENTS, specProblems } from "../src/instruments.mjs";
import { allocateCapital, OUTCOMES, sizeOrder, sizePosition } from "../src/sizing.mjs";
import { ENGINE_SYMBOLS, loadConfig } from "../src/config.mjs";
import { runBacktest } from "../src/cli/backtest.mjs";
import { createMirror, mirrorStep } from "../src/mirror.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const BALANCES = [10, 25, 50, 100, 500, 1000, 5000];
const POLICY = { riskPct: 1, maxRiskUSD: 10, feePct: 0.4, priceBufferPct: 0.5 };
const LIMITS = { maxOrderNotional: 5000, maxPositionExposure: 10000, maxTotalExposure: 25000, maxOpenPositions: 5 };
const lastClose = (f) => JSON.parse(readFileSync(join(HERE, "fixtures", f), "utf8")).candles.at(-1).c;
const REAL = { SOLUSD: lastClose("SOLUSD-5m-kraken.json"), BTCUSD: lastClose("BTCUSD-5m-kraken.json"), ETHUSD: lastClose("ETHUSD-5m-kraken.json") };
const TEST_SPEC = (o) => ({ provider: "TEST", providerSymbol: o.symbol, assetClass: "TEST", tick: 0.01, qtyDecimals: 0, qtyStep: 1, minQty: 1, minNotional: 0, fractional: false, multiplier: 1,
  margin: { allowed: false }, hours: "TEST", feeModel: { kind: "TEST" }, orderTypes: ["limit"], verified: { source: "TEST fixture (not a real market)", at: "2026-11-12" }, shortable: false, ...o });
const TEST = {
  FRACTIONAL_STOCK: TEST_SPEC({ symbol: "TESTFRAC", assetClass: "stock (TEST)", qtyStep: 0.000001, qtyDecimals: 6, minQty: 0.000001, minNotional: 1, fractional: true }),
  WHOLE_SHARE: TEST_SPEC({ symbol: "TESTWHOLE", assetClass: "stock (TEST)" }),
  CONTRACT: TEST_SPEC({ symbol: "TESTFUT", assetClass: "futures (TEST)", multiplier: 5, tick: 0.25 }),
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const stepOk = (q, s) => near(Math.round(q / s.qtyStep) * s.qtyStep, q, s.qtyStep / 1000);

describe("instrument registry: verified, per-market rules", () => {
  it("every registered market has a complete, sourced and dated specification", () => {
    for (const [sym, s] of Object.entries(INSTRUMENTS)) assert.deepEqual(specProblems(s), [], sym);
  });
  it("markets do not reuse SOLUSD's rules", () => {
    assert.notEqual(INSTRUMENTS.BTCUSD.minQty, INSTRUMENTS.SOLUSD.minQty);
    assert.notEqual(INSTRUMENTS.ETHUSD.minQty, INSTRUMENTS.SOLUSD.minQty);
    assert.notEqual(INSTRUMENTS.BTCUSD.tick, INSTRUMENTS.SOLUSD.tick);
    assert.deepEqual([INSTRUMENTS.BTCUSD.minQty, INSTRUMENTS.ETHUSD.minQty, INSTRUMENTS.SOLUSD.minQty], [0.00006, 0.002, 0.05]);
  });
  it("funded markets = verified AND approved; everything else is unavailable with a reason", () => {
    assert.deepEqual(FUNDED_SYMBOLS, ["SOLUSD"]);
    assert.deepEqual(ENGINE_SYMBOLS, FUNDED_SYMBOLS, "the engine's funded list comes from the registry only");
    assert.match(fundedStatus("BTCUSD").reason, /Strategy Mirror only/);
    for (const unknown of ["AAPL", "MES", "MNQ", "GOLD", "DOGEUSD"]) {
      assert.equal(fundedStatus(unknown).ok, false, unknown);
      assert.throws(() => loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_SYMBOL: unknown }), /not enabled for the engine/, unknown);
    }
    assert.equal(sizeOrder({ sizing: { mode: "percent" }, capital: 100, entry: 10, stop: 9, side: 1 }).code, "NO_INSTRUMENT_SPEC", "no silent SOLUSD fallback");
    assert.equal(sizePosition({ instrument: { symbol: "X" }, capital: 100, entry: 10, stop: 9, side: 1 }).code, "NO_INSTRUMENT_SPEC");
  });
});

describe("default risk policy: 1% of equity, at most $10, never above buying power, never increased", () => {
  for (const sym of Object.keys(INSTRUMENTS)) {
    it(`${sym}: every balance from $10 to $5,000 (real price ${REAL[sym]})`, () => {
      const spec = getInstrument(sym);
      const entry = REAL[sym], stop = entry * (1 - 0.008); // a typical 0.8% stop
      for (const cap of BALANCES) {
        const s = sizePosition({ instrument: spec, capital: cap, entry, stop, side: 1, policy: POLICY, limits: LIMITS });
        const target = Math.min(cap * 0.01, 10);
        assert.ok(near(s.riskTarget, Math.round(target * 100) / 100, 0.006), `${sym} $${cap}: target ${s.riskTarget} vs ${target}`);
        assert.equal(s.riskCappedByMax, cap > 1000, `${sym} $${cap}: max-risk cap applies only above $1,000`);
        if (s.ok) {
          assert.ok(s.qty * entry * 1.005 * 1.004 <= cap + 1e-6, `${sym} $${cap}: cost incl. headroom fits the equity`);
          assert.ok(s.qty * entry <= 5000 + 1e-6, "within the order-value limit");
          assert.ok(s.riskActual <= s.riskTarget + 0.005, `${sym} $${cap}: actual risk never above the target`);
          assert.ok(s.qty >= spec.minQty && s.qty * entry >= spec.minNotional, "venue minimums met");
          assert.ok(stepOk(s.qty, spec), "quantity on the instrument's step (rounded down)");
          assert.ok(["FULL_RISK", "REDUCED_TO_FIT"].includes(s.outcome));
          assert.equal(s.outcome === "REDUCED_TO_FIT", s.capped);
        } else {
          assert.ok(OUTCOMES[s.code], `documented code ${s.code}`);
          assert.ok(s.reason && s.explanation, "exact reason and plain explanation");
        }
      }
      // these three crypto markets are affordable from $10 with a typical stop
      assert.equal(sizePosition({ instrument: spec, capital: 10, entry, stop, side: 1, policy: POLICY, limits: LIMITS }).ok, true, `${sym} tradeable with $10`);
    });
  }

  it("documented examples: $10 → $0.10, $100 → $1, $500 → $5, $1,000 → $10, $5,000 → still $10", () => {
    const spec = getInstrument("SOLUSD");
    const t = (cap) => sizePosition({ instrument: spec, capital: cap, entry: 100, stop: 80, side: 1, policy: POLICY }).riskTarget;
    assert.deepEqual([t(10), t(100), t(500), t(1000), t(5000)], [0.1, 1, 5, 10, 10]);
    assert.equal(sizePosition({ instrument: spec, capital: 5000, entry: 100, stop: 80, side: 1, policy: { ...POLICY, maxRiskUSD: 20 } }).riskTarget, 20, "only the owner's setting changes the cap");
  });
});

describe("whole-share, fractional and contract instruments (TEST specs)", () => {
  it("fractional stock: trades from $10", () => {
    const s = sizePosition({ instrument: TEST.FRACTIONAL_STOCK, capital: 10, entry: 250, stop: 245, side: 1, policy: POLICY });
    assert.equal(s.ok, true);
    assert.ok(stepOk(s.qty, TEST.FRACTIONAL_STOCK) && s.qty < 1);
  });
  it("whole shares: a $250 share is not affordable with $10–$100; never rounded up; affordable from $500", () => {
    for (const cap of [10, 25, 50, 100]) {
      const s = sizePosition({ instrument: TEST.WHOLE_SHARE, capital: cap, entry: 250, stop: 245, side: 1, policy: POLICY });
      assert.deepEqual([s.ok, s.code, s.qty], [false, "BELOW_MIN_QTY", 0], `$${cap}`);
      assert.match(s.reason, /minimum order of 1 TESTWHOLE \(needs about \$252/);
      assert.equal(s.explanation, OUTCOMES.BELOW_MIN_QTY);
    }
    const ok = sizePosition({ instrument: TEST.WHOLE_SHARE, capital: 500, entry: 250, stop: 245, side: 1, policy: POLICY });
    assert.deepEqual([ok.ok, ok.qty], [true, 1]);
  });
  it("whole shares where the RISK (not the money) is too small: refused, never increased to one share", () => {
    const s = sizePosition({ instrument: TEST.WHOLE_SHARE, capital: 1000, entry: 250, stop: 200, side: 1, policy: POLICY }); // $10 risk, $50 stop → 0.2 share
    assert.equal(s.code, "BELOW_MIN_QTY");
    assert.match(s.reason, /never raised above the target risk/);
  });
  it("contracts: one $30,000 contract (×5 multiplier) is not affordable with any balance up to $5,000", () => {
    for (const cap of BALANCES) {
      const s = sizePosition({ instrument: TEST.CONTRACT, capital: cap, entry: 6000, stop: 5990, side: 1, policy: POLICY, limits: LIMITS });
      assert.equal(s.ok, false, `$${cap}`);
      assert.equal(s.code, "BELOW_MIN_QTY");
    }
  });
});

describe("edge cases", () => {
  const sol = getInstrument("SOLUSD");
  it("tight stop: capped by buying power (reduced to fit), never leveraged; optional fee-aware filter", () => {
    const s = sizePosition({ instrument: sol, capital: 100, entry: 100, stop: 99.9, side: 1, policy: POLICY });
    assert.deepEqual([s.ok, s.capped, s.cappedBy, s.outcome], [true, true, "BALANCE", "REDUCED_TO_FIT"]);
    assert.ok(s.riskActual < s.riskTarget);
    assert.equal(sizePosition({ instrument: sol, capital: 100, entry: 100, stop: 99.9, side: 1, policy: { ...POLICY, minStopPct: 0.3 } }).code, "STOP_TOO_TIGHT");
  });
  it("insufficient capital, stale price, shorts, unknown balance", () => {
    assert.equal(sizePosition({ instrument: sol, capital: 3, entry: 100, stop: 99, side: 1, policy: POLICY }).code, "BELOW_MIN_QTY");
    assert.equal(sizePosition({ instrument: sol, capital: 0, entry: 100, stop: 99, side: 1, policy: POLICY }).code, "NO_CAPITAL");
    assert.equal(sizePosition({ instrument: sol, capital: 100, entry: 100, stop: 99, side: 1, policy: POLICY, price: { ageSec: 600, maxAgeSec: 120 } }).code, "STALE_PRICE");
    assert.equal(sizePosition({ instrument: sol, capital: 100, entry: 100, stop: 101, side: -1, policy: POLICY }).code, "SHORT_NOT_ALLOWED");
    assert.equal(sizePosition({ instrument: sol, capital: null, entry: 100, stop: 99, side: 1, policy: POLICY }).code, "BALANCE_UNKNOWN");
  });
  it("Worker limits and existing exposure: open-position count, position and total exposure room", () => {
    assert.equal(sizePosition({ instrument: sol, capital: 100000, entry: 100, stop: 99, side: 1, policy: POLICY, limits: LIMITS, exposure: { openPositions: 5 } }).code, "MAX_OPEN_POSITIONS");
    const room = sizePosition({ instrument: sol, capital: 100000, entry: 100, stop: 99, side: 1, policy: { ...POLICY, maxRiskUSD: null }, limits: LIMITS, exposure: { total: 24900 } });
    assert.deepEqual([room.ok, room.cappedBy], [true, "TOTAL_EXPOSURE"]);
    assert.ok(room.qty * 100 <= 100 + 1e-6);
    assert.equal(sizePosition({ instrument: sol, capital: 100000, entry: 100, stop: 99, side: 1, policy: POLICY, limits: LIMITS, exposure: { total: 25000 } }).code, "EXPOSURE_LIMIT");
  });
  it("fees and price buffer are reserved: the order still fits if the fill is 0.5% higher and a 0.4% fee is charged", () => {
    for (const cap of BALANCES) {
      const s = sizePosition({ instrument: sol, capital: cap, entry: REAL.SOLUSD, stop: REAL.SOLUSD * 0.99, side: 1, policy: POLICY, limits: LIMITS });
      if (s.ok) assert.ok(s.qty * REAL.SOLUSD * 1.005 * 1.004 <= cap + 1e-6);
    }
  });
});

describe("multiple simultaneous signals for one wallet", () => {
  const c = [
    { id: "b", symbol: "ETHUSD", barClose: "2026-11-12T01:00:00Z", entry: REAL.ETHUSD, stop: REAL.ETHUSD * 0.99, side: 1 },
    { id: "a", symbol: "SOLUSD", barClose: "2026-11-12T01:00:00Z", entry: REAL.SOLUSD, stop: REAL.SOLUSD * 0.99, side: 1 },
    { id: "c", symbol: "BTCUSD", barClose: "2026-11-12T00:55:00Z", entry: REAL.BTCUSD, stop: REAL.BTCUSD * 0.99, side: 1 },
  ];
  it("deterministic order (earliest candle, then registry priority), never the same capital twice, never negative", () => {
    for (const cap of BALANCES) {
      const r1 = allocateCapital(c, { capital: cap, policy: POLICY, limits: LIMITS });
      const r2 = allocateCapital([...c].reverse(), { capital: cap, policy: POLICY, limits: LIMITS });
      assert.deepEqual(r1.map((x) => x.id), ["c", "a", "b"], "BTC's earlier candle first, then SOL (priority 1) before ETH");
      assert.deepEqual(r1, r2, "input order does not matter");
      const spent = r1.filter((x) => x.ok).reduce((t, x) => t + x.qty * x.entry * 1.005 * 1.004, 0);
      assert.ok(spent <= cap + 1e-6, `$${cap}: total ${spent} within the wallet`);
      assert.ok(r1.every((x) => x.capitalAfter >= 0));
    }
    const ten = allocateCapital(c, { capital: 10, policy: POLICY, limits: LIMITS });
    assert.equal(ten[0].ok, true);
    assert.ok(ten.slice(1).every((x) => !x.ok || x.capped), "later candidates are reduced or refused, never double-funded");
  });
});

describe("real historical SOLUSD setups (150 days of Kraken 5m) at every balance", () => {
  const D = JSON.parse(gunzipSync(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-150d.rows.json.gz"))).toString("utf8"));
  const C = D.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c })).slice(-8640); // the last 30 days
  for (const cap of BALANCES) {
    it(`$${cap}: qualifying long setups enter and exit; every order fits; nothing would be refused by the ledger`, () => {
      const run = runBacktest({ candles: C, symbol: "SOLUSD", intervalMin: 5, sizing: { mode: "percent", riskPct: 1, maxRiskUSD: 10 },
        ledger: { startCapital: cap, feePct: 0, maxNotional: 5000, longOnly: true } });
      assert.ok(run.trades.length > 10, `${run.trades.length} completed trades`);
      assert.ok(run.trades.every((t) => t.side === "LONG"));
      assert.equal(run.account.refused.length, 0, "no order the ledger would refuse");
      assert.ok(run.trades.every((t) => t.qty >= 0.05), "Kraken minimum met");
      assert.ok(run.account.endCapital > 0, "never negative");
      const skips = run.events.filter((e) => e.type === "ORDER_SKIPPED");
      assert.ok(skips.every((e) => OUTCOMES[e.code]), "every skip has a documented code");
    });
  }
});

describe("Strategy Mirror keeps the original fixed $10 risk, whatever the funded sizing is", () => {
  it("mirror quantities = TradingView-style $10 ÷ stop, independent of percent sizing and equity", () => {
    const C = JSON.parse(readFileSync(join(HERE, "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;
    const P5 = loadConfig({ ENGINE_ENV_FILE: "none", ENGINE_PROFILE: "solusd-5m" }, join(HERE, ".."));
    const ctx = { lateMs: 600_000, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs, inputsHash: "x" };
    const M = createMirror({ ...ctx, nowMs: C[0].t });
    for (const k of C) mirrorStep(M, k, { ...ctx, nowMs: k.t + 305_000 });
    assert.equal(M.strategy.sizing.mode, "fixed");
    const fixed = runBacktest({ candles: C, symbol: "SOLUSD", intervalMin: 5, inputs: P5.inputs });
    const m = M.outbox.filter((x) => x.type === "TRADE");
    assert.equal(m.length, fixed.trades.length);
    m.forEach((t, i) => assert.ok(near(t.qty, fixed.trades[i].qty, 1e-9), "same fixed-risk quantity"));
  });
});

describe("REGRESSION GATE: the shared sizing architecture cannot be bypassed", () => {
  it("no engine source file computes an order quantity outside src/sizing.mjs (and the Pine fixed formula in ote.mjs)", () => {
    for (const f of readdirSync(SRC, { recursive: true }).filter((x) => String(x).endsWith(".mjs"))) {
      const rel = String(f).replace(/\\/g, "/");
      if (rel === "sizing.mjs") continue;
      const text = readFileSync(join(SRC, rel), "utf8");
      const hits = text.split("\n").filter((l) => /riskUSD\s*(\*[^/]*)?\/\s*\(?\s*(Math\.abs|dist|\|)/.test(l) || /qty\s*=\s*[^;]*\/\s*\(?\s*Math\.abs\(\s*\w+\s*-\s*\w+/.test(l));
      if (rel === "ote.mjs") assert.equal(hits.length, 1, `ote.mjs: only the Pine fixed-risk formula (${hits.join(" | ")})`);
      else assert.deepEqual(hits, [], `${rel} computes a quantity itself; use src/sizing.mjs`);
    }
  });
  it("every funded market sizes by percent of equity when trading against the PAPER ledger; fixed needs a recorded research reason", () => {
    for (const sym of ENGINE_SYMBOLS) {
      const base = { ENGINE_ENV_FILE: "none", ENGINE_SYMBOL: sym, ENGINE_SYNC: "on", ALPHA_API_BASE: "http://x.test", ALPHA_WEBHOOK_SECRET: "x" };
      const c = loadConfig(base);
      assert.equal(c.sizing.mode, "percent", sym);
      assert.equal(c.sizing.maxRisk, "setting");
      assert.equal(c.sizing.instrument.symbol, sym, "its own instrument rules");
      assert.throws(() => loadConfig({ ...base, ENGINE_SIZING: "fixed" }), /ENGINE_SIZING_FIXED_REASON/);
      assert.equal(loadConfig({ ...base, ENGINE_SIZING: "fixed", ENGINE_SIZING_FIXED_REASON: "parity research" }).sizing.fixedReason, "parity research");
    }
  });
  it("no shipped profile sets fixed sizing", () => {
    const dir = join(HERE, "..", "profiles");
    for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /^\s*ENGINE_SIZING\s*=\s*fixed/m, f);
  });
  it("every funded market is covered by this suite with its own real price", () => {
    for (const sym of ENGINE_SYMBOLS) assert.ok(REAL[sym] > 0, `${sym}: add a real price fixture to the acceptance suite before enabling it`);
  });
});
