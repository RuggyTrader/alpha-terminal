// Kraken OHLC stand-in as its OWN process (test-only), so a test that blocks on spawnSync while an engine runs cannot
// starve it. Serves the committed real SOLUSD, BTCUSD (XBTUSD) and ETHUSD 5m fixtures by pair; the number of completed candles is read from a control file
// on every request (the test writes it). Prints the port on stdout.
//   node test/lib/ohlc-server.mjs <control file>

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIX = (f) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", f), "utf8")).candles;
// Kraken pair (as the engine requests it) -> [result key Kraken returns, committed real fixture]. SOLUSD is the default.
const PAIRS = { SOLUSD: ["SOLUSD", FIX("SOLUSD-5m-kraken.json")], XBTUSD: ["XXBTZUSD", FIX("BTCUSD-5m-kraken.json")], ETHUSD: ["XETHZUSD", FIX("ETHUSD-5m-kraken.json")] };
const control = process.argv[2];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/0/public/OHLC") { res.writeHead(404).end(); return; }
  const visible = Number(readFileSync(control, "utf8"));
  const since = Number(url.searchParams.get("since") ?? 0);
  // `visible` completed candles plus the next one as the still-forming last row (the engine drops it).
  const [key, CANDLES] = PAIRS[url.searchParams.get("pair") ?? "SOLUSD"] ?? PAIRS.SOLUSD;
  const rows = CANDLES.slice(0, visible + 1).filter((k) => k.t / 1000 > since)
    .map((k) => [k.t / 1000, String(k.o), String(k.h), String(k.l), String(k.c), String(k.c), String(k.v ?? 1), k.n ?? 1]);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: [], result: { [key]: rows, last: rows.at(-1)?.[0] ?? since } }));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
