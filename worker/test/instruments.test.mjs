// Instrument list, symbol mapping, quantity rules and truthful price sources.
//   node --test test/instruments.test.mjs   (Node 22.18+ loads the .ts module directly)

import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
// The worker package is not "type": "module", so load the (self-contained) module as .mts.
const mod = join(mkdtempSync(join(tmpdir(), "alpha-instruments-")), "instruments.mts");
copyFileSync(join(WORKER_DIR, "src", "instruments.ts"), mod);
const { INSTRUMENTS, getInstrument, normalizeSymbol, qtyProblem, referencePrice } = await import(pathToFileURL(mod).href);
const LIST = ["MES", "MNQ", "GOLD", "BTCUSD", "ETHUSD", "SOLUSD", "HYPEUSD", "KAITOUSD"];

describe("instrument list", () => {
  it("is exactly MES, MNQ, GOLD, BTCUSD, ETHUSD, SOLUSD, HYPEUSD, KAITOUSD", () => {
    assert.deepEqual(INSTRUMENTS.map((i) => i.symbol), LIST);
  });

  it("matches ALLOWED_SYMBOLS in wrangler.jsonc, with no old stock tickers", () => {
    const cfg = readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8");
    const allowed = /"ALLOWED_SYMBOLS":\s*"([^"]*)"/.exec(cfg)[1].split(",");
    assert.deepEqual(allowed, LIST);
    assert.ok(!/ALLOW_FRACTIONAL_QTY/.test(cfg));
  });

  it("maps TradingView tickers to the canonical symbol", () => {
    const cases = {
      "KRAKEN:SOLUSD": "SOLUSD", "SOL/USD": "SOLUSD", btcusd: "BTCUSD", "COINBASE:ETHUSD": "ETHUSD",
      HYPEUSD: "HYPEUSD", "KRAKEN:KAITOUSD": "KAITOUSD", "TVC:GOLD": "GOLD", GOLD: "GOLD",
      "MES1!": "MES", "CME_MINI:MES1!": "MES", MESZ2026: "MES", "MNQ1!": "MNQ", MNQH2027: "MNQ", MES: "MES",
    };
    for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeSymbol(raw), want, raw);
  });

  it("rejects everything else, including the old stock list", () => {
    for (const raw of ["SPY", "QQQ", "AAPL", "NVDA", "BTCUSDT", "XAUUSD", "MGC1!", "ES1!", "NQ1!", "MESX", "", "KAITO"]) {
      assert.equal(normalizeSymbol(raw), null, raw);
    }
  });
});

describe("quantity rules", () => {
  it("futures take whole contracts only", () => {
    assert.equal(qtyProblem(getInstrument("MES"), 2), null);
    assert.match(qtyProblem(getInstrument("MNQ"), 1.5), /whole contracts/);
  });

  it("crypto and gold take up to 8 decimals", () => {
    assert.equal(qtyProblem(getInstrument("BTCUSD"), 0.00012345), null);
    assert.equal(qtyProblem(getInstrument("KAITOUSD"), 1234.5), null);
    assert.equal(qtyProblem(getInstrument("GOLD"), 0.5), null);
    assert.match(qtyProblem(getInstrument("SOLUSD"), 0.123456789), /8 decimal/);
  });
});

describe("truthful market-data sources", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("MES, MNQ and GOLD have no source, never call out and never use Alpaca", async () => {
    globalThis.fetch = () => { throw new Error("must not fetch"); };
    for (const s of ["MES", "MNQ", "GOLD"]) {
      const i = getInstrument(s);
      assert.equal(i.price.source, "none");
      assert.equal(i.alpacaPaperSymbol, null, `${s} must not be looked up on Alpaca`);
      const r = await referencePrice(i);
      assert.equal(r.ok, true);
      assert.equal(r.price, null);
      assert.match(r.reason, new RegExp(`No market data for ${s}`));
    }
    assert.match(getInstrument("GOLD").price.reason, /Gold\.com, Inc\. stock, not gold/);
  });

  it("crypto prices come from Kraken public market data with a GET", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init?.method]);
      return new Response(JSON.stringify({ error: [], result: { XXBTZUSD: { c: ["77790.7", "0.01"] } } }), { status: 200 });
    };
    const r = await referencePrice(getInstrument("BTCUSD"));
    assert.deepEqual(r.ok && r.price, 77790.7);
    assert.equal(r.source, "kraken:XBTUSD");
    assert.deepEqual(calls, [["https://api.kraken.com/0/public/Ticker?pair=XBTUSD", "GET"]]);
    const pairs = Object.fromEntries(INSTRUMENTS.filter((i) => i.assetClass === "crypto").map((i) => [i.symbol, i.price.pair]));
    assert.deepEqual(pairs, { BTCUSD: "XBTUSD", ETHUSD: "ETHUSD", SOLUSD: "SOLUSD", HYPEUSD: "HYPEUSD", KAITOUSD: "KAITOUSD" });
  });

  it("a Kraken error or empty price is MARKET_DATA_UNAVAILABLE, not a guess", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: ["EQuery:Unknown asset pair"], result: {} }), { status: 200 });
    const r = await referencePrice(getInstrument("KAITOUSD"));
    assert.equal(r.ok, false);
    assert.equal(r.code, "MARKET_DATA_UNAVAILABLE");
    globalThis.fetch = async () => { throw new TypeError("network down"); };
    assert.equal((await referencePrice(getInstrument("SOLUSD"))).code, "MARKET_DATA_UNAVAILABLE");
  });

  it("Alpaca PAPER positions are read only where Alpaca lists the asset (not KAITO)", () => {
    const paper = Object.fromEntries(INSTRUMENTS.map((i) => [i.symbol, i.alpacaPaperSymbol]));
    assert.deepEqual(paper, { MES: null, MNQ: null, GOLD: null, BTCUSD: "BTCUSD", ETHUSD: "ETHUSD", SOLUSD: "SOLUSD", HYPEUSD: "HYPEUSD", KAITOUSD: null });
  });

  it("the Worker no longer reads Alpaca stock market data", () => {
    for (const f of ["trade_core.ts", "index.ts", "instruments.ts", "dashboard_api.ts", "webhook_dry_run.ts"]) {
      const src = readFileSync(join(WORKER_DIR, "src", f), "utf8");
      assert.ok(!src.includes("/v2/stocks"), `${f} uses Alpaca stock data`);
      assert.ok(!src.includes("data.alpaca.markets"), `${f} uses Alpaca market data`);
    }
  });
});
