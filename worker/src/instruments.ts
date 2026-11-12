// ALPHA TERMINAL instrument list (PAPER, dry run).
//
// Each instrument names where its reference price truthfully comes from and whether an Alpaca PAPER
// account can hold it. When there is no truthful source the price is unavailable and the risk engine
// rejects exposure-increasing orders with MARKET_DATA_UNAVAILABLE. No price is ever estimated.
//
// Sources checked on 2026-11-01:
//   * Kraken public market data (GET, no key) lists BTC/USD, ETH/USD, SOL/USD, HYPE/USD and KAITO/USD.
//   * Alpaca PAPER lists BTC/USD, ETH/USD, SOL/USD and HYPE/USD as crypto, not KAITO.
//   * Alpaca has no futures. Alpaca's "GOLD" is the stock of Gold.com, Inc., not gold.
//   * Kraken has no spot gold (XAU/USD). No keyless, licensed CME futures feed is available.

export type PriceSource =
  // pair: request name; key: the name Kraken uses for it in the response.
  | { source: "kraken"; pair: string; key: string }
  | { source: "none"; reason: string };

export interface Instrument {
  /** Canonical symbol, as listed in ALLOWED_SYMBOLS. */
  symbol: string;
  name: string;
  assetClass: "crypto" | "futures" | "metal";
  /** "contracts": whole numbers only. "decimal8": up to 8 decimal places. */
  qtyRule: "contracts" | "decimal8";
  /** USD value of 1 qty for a 1.00 move in price (futures point value). */
  multiplier: number;
  price: PriceSource;
  /** Symbol of this instrument in the Alpaca PAPER account, or null when Alpaca PAPER cannot hold it. */
  alpacaPaperSymbol: string | null;
}

const NO_CME =
  "Alpaca does not provide futures, and no licensed CME market-data source is configured; ALPHA TERMINAL does not estimate futures prices";

export const INSTRUMENTS: readonly Instrument[] = [
  {
    symbol: "MES",
    name: "Micro E-mini S&P 500 futures",
    assetClass: "futures",
    qtyRule: "contracts",
    multiplier: 5,
    price: { source: "none", reason: `No market data for MES: ${NO_CME}` },
    alpacaPaperSymbol: null,
  },
  {
    symbol: "MNQ",
    name: "Micro E-mini Nasdaq-100 futures",
    assetClass: "futures",
    qtyRule: "contracts",
    multiplier: 2,
    price: { source: "none", reason: `No market data for MNQ: ${NO_CME}` },
    alpacaPaperSymbol: null,
  },
  {
    symbol: "GOLD",
    name: "Gold spot (TradingView TVC:GOLD)",
    assetClass: "metal",
    qtyRule: "decimal8",
    multiplier: 1,
    price: {
      source: "none",
      reason:
        "No market data for GOLD: no spot-gold (XAU/USD) source is configured. Alpaca's GOLD is the Gold.com, Inc. stock, not gold, so it is not used",
    },
    alpacaPaperSymbol: null,
  },
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "XBTUSD", key: "XXBTZUSD" }, alpacaPaperSymbol: "BTCUSD" },
  { symbol: "ETHUSD", name: "Ether / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "ETHUSD", key: "XETHZUSD" }, alpacaPaperSymbol: "ETHUSD" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "SOLUSD", key: "SOLUSD" }, alpacaPaperSymbol: "SOLUSD" },
  { symbol: "HYPEUSD", name: "Hyperliquid / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "HYPEUSD", key: "HYPEUSD" }, alpacaPaperSymbol: "HYPEUSD" },
  { symbol: "KAITOUSD", name: "Kaito / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "KAITOUSD", key: "KAITOUSD" }, alpacaPaperSymbol: null },
];

const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

/**
 * The ONLY TradingView chart symbols ALPHA TERMINAL accepts (syminfo.ticker), and the internal symbol each
 * maps to. Exact match: no exchange prefixes, slash pairs, lower case, other contract months or aliases.
 * The Pine script carries the same list.
 */
export const TRADINGVIEW_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["MNQ1!", "MNQ"],
  ["MES1!", "MES"],
  ["GOLD", "GOLD"],
  ["BTCUSD", "BTCUSD"],
  ["ETHUSD", "ETHUSD"],
  ["SOLUSD", "SOLUSD"],
  ["HYPEUSD", "HYPEUSD"],
  ["KAITOUSD", "KAITOUSD"],
]);

/** Internal symbol for a supported TradingView symbol, or null for anything else. */
export function normalizeSymbol(raw: string): string | null {
  const s = TRADINGVIEW_SYMBOLS.get(raw.trim()) ?? null;
  return s !== null && BY_SYMBOL.has(s) ? s : null;
}

export function getInstrument(symbol: string): Instrument | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

/** Number of decimal places in a positive finite number, from its shortest decimal form. */
function decimals(n: number): number {
  const s = String(n);
  if (s.includes("e-")) return Number(s.split("e-")[1]) + (s.split("e-")[0].split(".")[1]?.length ?? 0);
  return s.split(".")[1]?.length ?? 0;
}

/** null when the qty fits the instrument, otherwise the reason it does not. */
export function qtyProblem(instrument: Instrument, qty: number): string | null {
  if (instrument.qtyRule === "contracts" && !Number.isInteger(qty)) {
    return `${instrument.symbol} trades in whole contracts; qty ${qty} is fractional`;
  }
  if (instrument.qtyRule === "decimal8" && decimals(qty) > 8) {
    return `${instrument.symbol} qty allows at most 8 decimal places`;
  }
  return null;
}

export type PriceResult =
  | { ok: true; price: number; source: string; at: string }
  | { ok: true; price: null; source: "none"; reason: string }
  | { ok: false; status: number; code: string; message: string };

const KRAKEN_OFFICIAL = "https://api.kraken.com";

/**
 * Kraken base URL. Always the official API, except a loopback address (127.0.0.1, localhost, [::1])
 * which local tests use for a controlled price fixture. Any other value is ignored.
 */
export function krakenBase(configured?: string | null): string {
  if (configured && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(configured.trim())) {
    return configured.trim();
  }
  return KRAKEN_OFFICIAL;
}

export interface MarketDataConfig {
  KRAKEN_API_BASE?: string;
}

const unavailable = (symbol: string, message: string): PriceResult => ({
  ok: false, status: 502, code: "MARKET_DATA_UNAVAILABLE", message: message.replace("{symbol}", symbol),
});

/**
 * Latest traded prices for several instruments from their truthful sources, keyed by symbol.
 * All Kraken instruments share ONE read-only GET. Never estimates: a missing price is an error result.
 */
export async function referencePrices(instruments: readonly Instrument[], cfg: MarketDataConfig = {}): Promise<Map<string, PriceResult>> {
  const out = new Map<string, PriceResult>();
  const kraken: { i: Instrument; pair: string; key: string }[] = [];
  for (const i of instruments) {
    if (out.has(i.symbol)) continue;
    if (i.price.source === "none") out.set(i.symbol, { ok: true, price: null, source: "none", reason: i.price.reason });
    else if (!kraken.some((k) => k.i.symbol === i.symbol)) kraken.push({ i, pair: i.price.pair, key: i.price.key });
  }
  if (kraken.length === 0) return out;

  const pairs = kraken.map((k) => k.pair).join(",");
  let body: { error?: unknown; result?: Record<string, { c?: unknown[] }> };
  try {
    const r = await fetch(`${krakenBase(cfg.KRAKEN_API_BASE)}/0/public/Ticker?pair=${encodeURIComponent(pairs).replace(/%2C/g, ",")}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Bounded: a stalled market-data request must not hold a fill or the dashboard (reported as unavailable).
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      for (const k of kraken) out.set(k.i.symbol, unavailable(k.i.symbol, `Kraken market data returned HTTP ${r.status} for {symbol}`));
      return out;
    }
    body = await r.json();
  } catch {
    for (const k of kraken) out.set(k.i.symbol, unavailable(k.i.symbol, "Could not reach Kraken market data for {symbol}"));
    return out;
  }
  const errors = Array.isArray(body.error) ? body.error : [];
  const at = new Date().toISOString();
  for (const k of kraken) {
    const entry = body.result?.[k.key] ?? (kraken.length === 1 && body.result ? Object.values(body.result)[0] : undefined);
    const last = Number(entry?.c?.[0]);
    out.set(
      k.i.symbol,
      errors.length > 0 || !(last > 0)
        ? unavailable(k.i.symbol, "Kraken returned no price for {symbol}")
        : { ok: true, price: last, source: `kraken:${k.pair}`, at }
    );
  }
  return out;
}

/** Latest traded price for one instrument from its truthful source. Read-only GET; never estimates. */
export async function referencePrice(instrument: Instrument, cfg: MarketDataConfig = {}): Promise<PriceResult> {
  return (await referencePrices([instrument], cfg)).get(instrument.symbol) as PriceResult;
}
