// Local stand-in for Kraken's public Ticker endpoint, for Worker tests (127.0.0.1 only; the Worker accepts a loopback
// KRAKEN_API_BASE). It makes tests independent of Kraken's availability: on 2026-11-09 the live API returned HTTP 503 /
// "EService:Internal error", which failed tests that had nothing to do with market data.
//
// Quotes:
//   SOLUSD  a REAL recorded Kraken SOLUSD 5m close from the committed engine fixture (default: the last candle).
//   others  labelled TEST quotes (the repository holds no recorded data for them). Tests that use them assert rules
//           that hold at any realistic price (e.g. 1 BTC is above the $5,000 order limit), never a market value.
// A test can change a quote with set(symbol, price) or make the endpoint fail with fail(true).

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOL = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "engine", "test", "fixtures", "SOLUSD-5m-kraken.json"), "utf8")).candles;

/** Kraken pair (as the Worker requests it) → result key (as Kraken returns it). Same as worker/src/instruments.ts. */
const KEYS = { SOLUSD: "SOLUSD", XBTUSD: "XXBTZUSD", ETHUSD: "XETHZUSD", HYPEUSD: "HYPEUSD", KAITOUSD: "KAITOUSD" };

export const TEST_QUOTES = Object.freeze({ XBTUSD: 100000, ETHUSD: 3500, HYPEUSD: 40, KAITOUSD: 1.5 }); // TEST values, not market data

export async function startKrakenStub({ sol = SOL.at(-1).c } = {}) {
  const quotes = { SOLUSD: sol, ...TEST_QUOTES };
  let failing = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/0/public/Ticker") { res.writeHead(404).end(); return; }
    if (failing) { res.writeHead(503, { "Content-Type": "application/json" }).end("{}"); return; }
    const result = {};
    for (const pair of (url.searchParams.get("pair") ?? "").split(",")) if (KEYS[pair] && quotes[pair] > 0) result[KEYS[pair]] = { c: [String(quotes[pair]), "1.0"] };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    set: (pair, price) => { quotes[pair] = price; },
    fail: (on) => { failing = on; },
    close: () => new Promise((r) => server.close(r)),
  };
}
