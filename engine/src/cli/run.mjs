// Engine entry point (the release launcher always starts this file).
//   ENGINE_MARKETS set (e.g. BTCUSD,ETHUSD): the mirror-only multi-market process (run-markets.mjs).
//   Otherwise: the single-market engine (run-single.mjs), exactly as before; production SOLUSD runs this way.
//   node src/cli/run.mjs [--once]

import { marketList } from "../config.mjs";

if (marketList().length) await import("./run-markets.mjs");
else await import("./run-single.mjs");
