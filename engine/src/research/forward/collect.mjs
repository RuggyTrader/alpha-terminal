// RESEARCH forward collector: catches up completed candles from Coinbase Exchange public market data (no key) into
// the forward store. Because the exchange serves history, a run after downtime fills the gap with the same candles a
// 24/7 collector would have stored, so the shadow test does NOT need an always-on machine. A daily run is enough;
// first_seen_at records the actual collection delay for the information audit.
import { appendCandles, readCandles } from "./store.mjs";

export const SOURCE = "Coinbase Exchange public candles (api.exchange.coinbase.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultFetchJson(url) {
  for (let a = 0; ; a++) {
    const res = await fetch(url, { headers: { "User-Agent": "research-client/1.0", Accept: "application/json" } });
    if (res.ok) return res.json();
    if (a >= 4) throw new Error(`${res.status} ${url}`);
    await sleep(1000 * (a + 1));
  }
}

/** Collects one market/granularity from the last stored candle (or warmupFrom) to now. fetchJson is injectable. */
export async function collectMarket(dir, m, g, { warmupFrom, now = Date.now(), fetchJson = defaultFetchJson, pauseMs = 150 } = {}) {
  const { candles } = readCandles(dir, m, g);
  let from = candles.length ? candles.at(-1).t + g * 1000 : Date.parse(warmupFrom);
  const totals = { added: 0, revised: 0, skippedOpen: 0, requests: 0 };
  // also re-read the last stored candle so a late exchange revision is detected and recorded
  if (candles.length) from -= g * 1000;
  while (from < now) {
    const to = Math.min(now, from + 300 * g * 1000);
    const url = `https://api.exchange.coinbase.com/products/${m}-USD/candles?granularity=${g}&start=${new Date(from).toISOString()}&end=${new Date(to - 1000).toISOString()}`;
    const rows = await fetchJson(url); totals.requests++;
    const fetched = rows.map(([t, l, h, o, c, v]) => ({ t: t * 1000, o, h, l, c, v })).filter((k) => k.o > 0 && k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c));
    const r = appendCandles(dir, m, g, fetched, { now, source: SOURCE });
    totals.added += r.added; totals.revised += r.revised; totals.skippedOpen += r.skippedOpen;
    from = to;
    if (pauseMs) await sleep(pauseMs);
  }
  return totals;
}
