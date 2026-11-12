// GET /api/dashboard/candles?symbol=SOLUSD&tf=1 (session; read-only): real Kraken OHLC for a bot chart.
// Completed candles are marked complete; the forming candle (Kraken's last row) is returned separately and labelled.
// Nothing is interpolated or invented: what Kraken returns is what the chart shows. Short in-isolate cache (15 s) so
// several open charts of the same market share one request; polled only while a chart is visible (frontend).

import { getInstrument, type MarketDataConfig } from "./instruments";

const TF = new Set([1, 5, 15, 30, 60]);
const cache = new Map<string, { at: number; body: unknown }>();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

function krakenBase(cfg: MarketDataConfig): string {
  const b = (cfg as { KRAKEN_API_BASE?: string }).KRAKEN_API_BASE ?? "";
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(b.replace(/\/+$/, "")) ? b.replace(/\/+$/, "") : "https://api.kraken.com";
}

export async function candlesForChart(cfg: MarketDataConfig, symbol: string, tfMin: number, nowMs = Date.now()) {
  const inst = getInstrument(symbol);
  const pair = inst?.price && "pair" in inst.price ? (inst.price as { pair: string }).pair : null;
  if (!inst || !pair || !TF.has(tfMin)) return { ok: false as const, status: 400, code: "INVALID_MARKET" };
  const key = `${symbol}|${tfMin}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < 15_000) return { ok: true as const, data: hit.body };
  let raw: { error?: string[]; result?: Record<string, unknown> };
  try {
    const r = await fetch(`${krakenBase(cfg)}/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${tfMin}`, { signal: AbortSignal.timeout(8000) });
    raw = await r.json();
  } catch (e) {
    return { ok: false as const, status: 503, code: "MARKET_DATA_UNAVAILABLE", message: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
  if (raw.error?.length || !raw.result) return { ok: false as const, status: 503, code: "MARKET_DATA_UNAVAILABLE", message: (raw.error ?? []).join("; ").slice(0, 120) };
  const rows = Object.entries(raw.result).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1] as unknown[][] | undefined;
  if (!rows) return { ok: false as const, status: 503, code: "MARKET_DATA_UNAVAILABLE" };
  const step = tfMin * 60;
  const all = rows.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[6]) }));
  const nowSec = Math.floor(nowMs / 1000);
  const completed = all.filter((k) => k.t + step <= nowSec).slice(-500);
  const forming = all.find((k) => k.t + step > nowSec) ?? null;
  const body = { source: "Kraken public OHLC", symbol, pair, timeframe_min: tfMin, fetched_at: new Date(nowMs).toISOString(), candles: completed, forming };
  cache.set(key, { at: nowMs, body });
  if (cache.size > 16) cache.delete(cache.keys().next().value as string);
  return { ok: true as const, data: body };
}

export async function handleCandles(cfg: MarketDataConfig, params: URLSearchParams): Promise<Response> {
  const r = await candlesForChart(cfg, String(params.get("symbol") ?? ""), Number(params.get("tf")));
  return r.ok ? json({ ok: true, data: r.data }) : json({ ok: false, code: r.code, message: "message" in r ? r.message : undefined }, r.status);
}
