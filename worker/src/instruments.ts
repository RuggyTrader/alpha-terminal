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
  | { source: "kraken"; pair: string }
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
  { symbol: "BTCUSD", name: "Bitcoin / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "XBTUSD" }, alpacaPaperSymbol: "BTCUSD" },
  { symbol: "ETHUSD", name: "Ether / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "ETHUSD" }, alpacaPaperSymbol: "ETHUSD" },
  { symbol: "SOLUSD", name: "Solana / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "SOLUSD" }, alpacaPaperSymbol: "SOLUSD" },
  { symbol: "HYPEUSD", name: "Hyperliquid / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "HYPEUSD" }, alpacaPaperSymbol: "HYPEUSD" },
  { symbol: "KAITOUSD", name: "Kaito / USD", assetClass: "crypto", qtyRule: "decimal8", multiplier: 1, price: { source: "kraken", pair: "KAITOUSD" }, alpacaPaperSymbol: null },
];

const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

/**
 * Maps a TradingView ticker to a canonical symbol, or null when it is not one of the instruments.
 * Accepts an exchange prefix (KRAKEN:SOLUSD), a slash pair (SOL/USD) and futures contract tickers:
 * continuous (MES1!) or dated (MESZ2026).
 */
export function normalizeSymbol(raw: string): string | null {
  let s = raw.trim().toUpperCase();
  if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1);
  s = s.replace("/", "");
  const fut = /^(MES|MNQ)(?:\d{1,2}!|[FGHJKMNQUVXZ]\d{1,4})$/.exec(s);
  if (fut) s = fut[1];
  return BY_SYMBOL.has(s) ? s : null;
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

const KRAKEN_TICKER = "https://api.kraken.com/0/public/Ticker";

/** Latest traded price from the instrument's truthful source. Read-only GET; never estimates. */
export async function referencePrice(instrument: Instrument): Promise<PriceResult> {
  const src = instrument.price;
  if (src.source === "none") return { ok: true, price: null, source: "none", reason: src.reason };

  let body: { error?: unknown; result?: Record<string, { c?: unknown[] }> };
  try {
    const r = await fetch(`${KRAKEN_TICKER}?pair=${encodeURIComponent(src.pair)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!r.ok) {
      return { ok: false, status: 502, code: "MARKET_DATA_UNAVAILABLE", message: `Kraken market data returned HTTP ${r.status} for ${instrument.symbol}` };
    }
    body = await r.json();
  } catch {
    return { ok: false, status: 502, code: "MARKET_DATA_UNAVAILABLE", message: `Could not reach Kraken market data for ${instrument.symbol}` };
  }
  const errors = Array.isArray(body.error) ? body.error : [];
  const entry = body.result ? Object.values(body.result)[0] : undefined;
  const last = Number(entry?.c?.[0]);
  if (errors.length > 0 || !(last > 0)) {
    return { ok: false, status: 502, code: "MARKET_DATA_UNAVAILABLE", message: `Kraken returned no price for ${instrument.symbol}` };
  }
  return { ok: true, price: last, source: `kraken:${src.pair}`, at: new Date().toISOString() };
}
