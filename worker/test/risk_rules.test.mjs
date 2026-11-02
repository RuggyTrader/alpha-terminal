// Asset-class-aware risk rules, run against the real validator and risk engine with fixture prices.
//   node --test test/risk_rules.test.mjs
//
// evaluateRisk() is pure: it takes the PAPER account, positions and a reference price as inputs. These
// fixtures stand in for those inputs only, so the rules can be checked (including a futures price that no
// live feed supplies today). Nothing here calls a broker or a market-data service.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(mkdtempSync(join(tmpdir(), "alpha-risk-")), "trade_core.mjs");
buildSync({ entryPoints: [join(WORKER_DIR, "src", "trade_core.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const { evaluateRisk, validateIntent } = await import(pathToFileURL(out).href);

// The deployed configuration, read from wrangler.jsonc.
const cfg = readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8");
const ENV = Object.fromEntries([...cfg.matchAll(/"([A-Z_]+)":\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));

const ACCOUNT = { status: "ACTIVE", trading_blocked: false, account_blocked: false, buying_power: "100000", non_marginable_buying_power: "25000", equity: "25000", last_equity: "25000", shorting_enabled: true };
const intent = (symbol, action, qty) => {
  const v = validateIntent({ symbol, action, qty }, ENV);
  assert.equal(v.ok, true, JSON.stringify(v));
  return v;
};
const risk = (symbol, qty, price, { position = null, positions = [], account = ACCOUNT, env = ENV } = {}) =>
  evaluateRisk(intent(symbol, "buy", qty), env, account, position, positions, price);
const checkNames = (r) => r.checks.map((c) => c.check);

describe("configuration", () => {
  it("ENABLE_TRADING is false and the futures rule is configured separately from the cash cap", () => {
    assert.equal(ENV.ENABLE_TRADING, "false");
    assert.equal(ENV.MAX_ORDER_NOTIONAL, "5000");
    assert.equal(ENV.MAX_ORDER_QTY, "10");
    assert.equal(ENV.MAX_FUTURES_ORDER_NOTIONAL, "75000");
  });
});

describe("crypto and gold keep the cash USD limits (unchanged)", () => {
  it("BUY 0.5 SOLUSD at $94.25 is approved with the cash checks", () => {
    const r = risk("SOLUSD", 0.5, 94.25);
    assert.equal(r.code, "APPROVED");
    assert.equal(r.estimatedNotional, 47.13);
    for (const c of ["max_order_notional", "max_position_exposure", "max_total_exposure", "buying_power"]) assert.ok(checkNames(r).includes(c), c);
    assert.ok(!checkNames(r).includes("max_futures_order_notional"));
  });

  it("BUY 1 BTCUSD at $77,790 is MAX_ORDER_NOTIONAL ($5,000 cap)", () => {
    const r = risk("BTCUSD", 1, 77790);
    assert.equal(r.code, "MAX_ORDER_NOTIONAL");
    assert.match(r.reason, /above the limit \$5000/);
  });

  it("crypto qty is not capped by MAX_ORDER_QTY (coins), only by USD", () => {
    assert.equal(risk("KAITOUSD", 15000, 0.2381).code, "APPROVED"); // $3,571.50
    assert.equal(risk("KAITOUSD", 25000, 0.2381).code, "MAX_ORDER_NOTIONAL"); // $5,952.50
  });

  it("position and total exposure, and non-marginable buying power, still apply to crypto", () => {
    assert.equal(risk("SOLUSD", 10, 94.25, { position: { qty: "100", market_value: "9500" } }).code, "MAX_POSITION_EXPOSURE");
    assert.equal(risk("SOLUSD", 10, 94.25, { positions: [{ qty: "1", market_value: "24500" }] }).code, "MAX_TOTAL_EXPOSURE");
    assert.equal(risk("SOLUSD", 10, 94.25, { account: { ...ACCOUNT, non_marginable_buying_power: "500" } }).code, "INSUFFICIENT_BUYING_POWER");
  });

  it("GOLD (if a price existed) is a cash asset: 2 oz at $2,700 is MAX_ORDER_NOTIONAL", () => {
    assert.equal(risk("GOLD", 2, 2700).code, "MAX_ORDER_NOTIONAL");
  });
});

describe("futures use their own rule", () => {
  it("with no futures feed (price null) MES and MNQ stop at MARKET_DATA_UNAVAILABLE", () => {
    for (const s of ["MES1!", "MNQ1!"]) {
      const r = evaluateRisk(intent(s, "buy", 1), ENV, ACCOUNT, null, [], null, `No market data: no licensed CME feed`);
      assert.equal(r.code, "MARKET_DATA_UNAVAILABLE");
      assert.equal(r.estimatedNotional, null);
    }
  });

  it("fixture price: 1 MES at 6,800 ($34,000 contract notional) is approved, not blocked by the $5,000 cash cap", () => {
    const r = risk("MES1!", 1, 6800);
    assert.equal(r.code, "APPROVED", r.reason);
    assert.equal(r.estimatedNotional, 34000);
    assert.ok(checkNames(r).includes("max_futures_order_notional"));
    for (const c of ["max_order_notional", "max_position_exposure", "max_total_exposure", "buying_power"]) assert.ok(!checkNames(r).includes(c), c);
  });

  it("fixture price: 1 MNQ at 25,000 ($50,000) is approved", () => {
    const r = risk("MNQ1!", 1, 25000);
    assert.equal(r.code, "APPROVED", r.reason);
    assert.equal(r.estimatedNotional, 50000);
  });

  it("contract notional above MAX_FUTURES_ORDER_NOTIONAL is rejected", () => {
    const r = risk("MNQ1!", 2, 25000); // $100,000
    assert.equal(r.code, "MAX_FUTURES_ORDER_NOTIONAL");
    assert.match(r.reason, /\$100000 is above the limit \$75000/);
    assert.equal(risk("MES1!", 3, 6800).code, "MAX_FUTURES_ORDER_NOTIONAL"); // $102,000
  });

  it("MAX_ORDER_QTY=10 stays the contract-count ceiling", () => {
    assert.equal(risk("MES1!", 11, 1).code, "MAX_ORDER_QTY");
  });

  it("a missing futures limit rejects futures instead of allowing them", () => {
    const { MAX_FUTURES_ORDER_NOTIONAL, ...noLimit } = ENV;
    assert.equal(MAX_FUTURES_ORDER_NOTIONAL, "75000");
    const r = risk("MES1!", 1, 6800, { env: noLimit });
    assert.equal(r.code, "MAX_FUTURES_ORDER_NOTIONAL");
    assert.match(r.reason, /not configured/);
  });

  it("account status, open-position count and daily loss still apply to futures", () => {
    assert.equal(risk("MES1!", 1, 6800, { account: { ...ACCOUNT, status: "INACTIVE" } }).code, "ACCOUNT_RESTRICTED");
    assert.equal(risk("MES1!", 1, 6800, { account: { ...ACCOUNT, equity: "22000" } }).code, "DAILY_LOSS_LIMIT");
    const five = Array.from({ length: 5 }, () => ({ qty: "1", market_value: "1" }));
    assert.equal(risk("MES1!", 1, 6800, { positions: five }).code, "MAX_OPEN_POSITIONS");
  });
});

describe("validation", () => {
  it("fractional futures quantities are rejected", () => {
    for (const s of ["MES1!", "MNQ1!"]) {
      const v = validateIntent({ symbol: s, action: "buy", qty: 1.5 }, ENV);
      assert.equal(v.code, "INVALID_QUANTITY");
      assert.match(v.message, /whole contracts/);
    }
  });

  it("only the 8 symbols pass; stocks, other crypto, other futures and aliases are INVALID_SYMBOL", () => {
    const ok = { "MNQ1!": "MNQ", "MES1!": "MES", GOLD: "GOLD", BTCUSD: "BTCUSD", ETHUSD: "ETHUSD", SOLUSD: "SOLUSD", HYPEUSD: "HYPEUSD", KAITOUSD: "KAITOUSD" };
    for (const [raw, sym] of Object.entries(ok)) {
      const v = validateIntent({ symbol: raw, action: "buy", qty: 1 }, ENV);
      assert.equal(v.ok, true, raw);
      assert.equal(v.symbol, sym);
    }
    for (const s of ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "MSFT", "GLD",
      "DOGEUSD", "XRPUSD", "ADAUSD", "BTCUSDT", "ETHBTC", "PAXGUSD", "XAUUSD",
      "ES1!", "NQ1!", "MGC1!", "GC1!", "CL1!", "MES2!", "MNQ2!", "MESZ2026", "MNQH2027", "MES", "MNQ",
      "KRAKEN:SOLUSD", "CME_MINI:MES1!", "TVC:GOLD", "SOL/USD", "BTC/USD", "btcusd", "mes1!", "Gold", "", "KAITO", "constructor"]) {
      assert.equal(validateIntent({ symbol: s, action: "buy", qty: 1 }, ENV).code, s === "" ? "MISSING_FIELD" : "INVALID_SYMBOL", s);
    }
  });
});
