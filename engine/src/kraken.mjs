// Kraken public market data (read-only GET, no key). Only COMPLETED candles are ever returned.

export const KRAKEN_PAIRS = Object.freeze({ SOLUSD: "SOLUSD", BTCUSD: "XBTUSD", ETHUSD: "ETHUSD", HYPEUSD: "HYPEUSD", KAITOUSD: "KAITOUSD" });

/** Kraken base URL: the official API, or a loopback address for local test fixtures. Anything else is ignored. */
export function krakenBase(configured) {
  if (configured && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(configured.trim())) return configured.trim();
  return "https://api.kraken.com";
}

async function getJson(url, timeoutMs = 15_000) {
  const r = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Kraken HTTP ${r.status}`);
  const j = await r.json();
  if (Array.isArray(j.error) && j.error.length) throw new Error(`Kraken error: ${j.error.join(", ")}`);
  return j.result;
}

/**
 * Completed OHLC candles {t, o, h, l, c, v, n} with t (open time, ms) > sinceMs, oldest first.
 * Kraken returns at most the latest 720 candles; the newest row is the still-forming candle and is dropped,
 * as is any candle whose close time is still in the future. Candles with no trades (n = 0) are dropped too,
 * because TradingView has no bar for an interval without trades.
 */
export async function fetchCompletedCandles({ symbol, intervalMin, sinceMs = null, base, nowMs = Date.now() }) {
  const pair = KRAKEN_PAIRS[symbol];
  if (!pair) throw new Error(`no Kraken pair for ${symbol}`);
  const since = sinceMs === null ? "" : `&since=${Math.floor(sinceMs / 1000)}`;
  const result = await getJson(`${krakenBase(base)}/0/public/OHLC?pair=${pair}&interval=${intervalMin}${since}`);
  const key = Object.keys(result).find((k) => k !== "last");
  const rows = result[key] ?? [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t = r[0] * 1000;
    const isLastRow = i === rows.length - 1;
    if (isLastRow || t + intervalMin * 60_000 > nowMs) continue; // still forming
    if (sinceMs !== null && t <= sinceMs) continue;
    if (Number(r[7]) === 0) continue;
    out.push({ t, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]), n: Number(r[7]) });
  }
  return out;
}

/**
 * Historical candles rebuilt from Kraken's public trade list (every trade, paged), for periods older than the
 * 720 candles the OHLC endpoint keeps. Each candle = first/max/min/last trade price in its interval.
 */
export async function candlesFromTrades({ symbol, intervalMin, fromMs, toMs, base, pauseMs = 1100, onProgress }) {
  const pair = KRAKEN_PAIRS[symbol];
  const step = intervalMin * 60_000;
  const buckets = new Map();
  let since = BigInt(Math.floor(fromMs)) * 1_000_000n;
  for (;;) {
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await getJson(`${krakenBase(base)}/0/public/Trades?pair=${pair}&since=${since}&count=1000`);
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, pauseMs * (attempt + 2)));
      }
    }
    const key = Object.keys(result).find((k) => k !== "last");
    const trades = result[key] ?? [];
    let lastMs = 0;
    for (const tr of trades) {
      const ms = Math.round(Number(tr[2]) * 1000);
      lastMs = ms;
      if (ms < fromMs || ms >= toMs) continue;
      const p = Number(tr[0]), v = Number(tr[1]);
      const t = Math.floor(ms / step) * step;
      const k = buckets.get(t);
      if (!k) buckets.set(t, { t, o: p, h: p, l: p, c: p, v, n: 1 });
      else { k.h = Math.max(k.h, p); k.l = Math.min(k.l, p); k.c = p; k.v += v; k.n += 1; }
    }
    onProgress?.(lastMs, buckets.size);
    const next = BigInt(result.last);
    if (trades.length === 0 || lastMs >= toMs || next <= since) break;
    since = next;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t).map((k) => ({ ...k, v: Number(k.v.toFixed(8)) }));
}
