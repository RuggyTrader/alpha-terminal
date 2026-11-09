// Simulated execution costs for ALPHA PAPER fills. PAPER only: nothing here talks to an exchange.
//
// Execution rules (every PAPER fill):
//   * The market observation is the live Kraken reference price the risk check used.
//   * MAKER fill (a resting limit order: the engine's limit entry or its take-profit): executes at the reference
//     price, pays the maker fee, no slippage.
//   * TAKER fill (stop-loss, break-even, trailing stop, time exit, reconciliation close, a market order, or any
//     signal that does not say otherwise): executes at the reference price moved AGAINST the trade by the profile's
//     slippage (a BUY pays more, a SELL receives less) and pays the taker fee.
//   * fee = execution price x quantity x multiplier x fee rate. Slippage cost = |execution - reference| x qty x mult.
//   * Minimum order: exposure-increasing BUY and partial SELL must meet the profile's minimum quantity and value; a
//     CLOSE of what is held is always allowed (never trap a position).
//   * Capital: a BUY needs execution value + its fee available in the strategy balance (no leverage).
// Conservative limit fills (a limit fills only when price trades through it) are an engine option
// (ENGINE_LIMIT_THROUGH_TICKS); the Worker cannot see order books.

export interface CostProfile {
  id: string;
  name: string;
  makerPct: number;
  takerPct: number;
  takerSlipPct: number;
  minQty: number;
  minNotionalUsd: number;
  /** Where the numbers come from and what is verified. Shown on the dashboard. */
  feeSource: string;
  slippageSource: string;
  caveat: string | null;
}

export const COST_PROFILES: Readonly<Record<string, CostProfile>> = Object.freeze({
  none: {
    id: "none", name: "No execution costs", makerPct: 0, takerPct: 0, takerSlipPct: 0, minQty: 0, minNotionalUsd: 0,
    feeSource: "none", slippageSource: "none", caveat: "Gross simulation: no fees or slippage are charged.",
  },
  ndax: {
    id: "ndax", name: "Ndax (0.20% flat)", makerPct: 0.2, takerPct: 0.2, takerSlipPct: 0.1, minQty: 0, minNotionalUsd: 5,
    feeSource: "Published: ndax.io/fees (read 2026-11-09): flat 0.20% on every buy and sell, no maker/taker split",
    slippageSource: "ESTIMATE 0.10% on taker fills: Ndax SOL/CAD liquidity was not measured",
    caveat: "Ndax costs applied to Kraken SOLUSD prices: these are not verified Ndax SOL/CAD executions (different market, CAD quote, unmeasured liquidity). Minimum order about $5 (Ndax help centre: about $1-5).",
  },
  kraken_pro_t1: {
    id: "kraken_pro_t1", name: "Kraken Pro Tier 1 (0.40% / 0.80%)", makerPct: 0.4, takerPct: 0.8, takerSlipPct: 0.03, minQty: 0.05, minNotionalUsd: 0.5,
    feeSource: "Published: kraken.com/pro/fees (read 2026-11-09): Tier 1 ($0+ 30-day volume) spot maker 0.40%, taker 0.80%",
    slippageSource: "0.03% on taker fills: measured SOLUSD spread $0.02 (0.023%) on 2026-11-09; a $100 order filled at the best price",
    caveat: "Minimums 0.05 SOL and $0.50 (Kraken AssetPairs). A 0.02% 'selected pairs' discount was not confirmed for SOL/USD.",
  },
});

/**
 * How every ALPHA PAPER fill is priced and classified. Shown with the execution-cost settings and on every trade
 * proof (the frontend keeps the same sentence in src/terminal/disclosures.ts; a test checks they are identical).
 */
export const PAPER_FILL_DISCLOSURE =
  "PAPER fills are simulated using the Kraken reference price when the signal is processed, not necessarily the Pine strategy's original entry or exit price. Maker/taker classifications are inferred from strategy order types and are not verified against a live exchange order book.";

export type Liquidity = "MAKER" | "TAKER";

/** The configured profile, or null when the configuration names an unknown one (fills are then refused). */
export function costProfile(env: { PAPER_COST_PROFILE?: string }): CostProfile | null {
  const id = (env.PAPER_COST_PROFILE ?? "none").trim() || "none";
  return COST_PROFILES[id] ?? null;
}

export interface Execution {
  liquidity: Liquidity;
  referencePrice: number;
  price: number;           // simulated execution price
  feeMicro: number;
  slippageMicro: number;
  profile: string;
}

const micro = (usd: number) => Math.round(usd * 1_000_000);

export function execute(p: CostProfile, side: "buy" | "sell", liquidity: Liquidity, referencePrice: number, qty: number, multiplier: number): Execution {
  const slip = liquidity === "TAKER" ? p.takerSlipPct / 100 : 0;
  // Rounded to 8 decimals so stored prices are stable; the slippage is always against the trade.
  const raw = side === "buy" ? referencePrice * (1 + slip) : referencePrice * (1 - slip);
  const price = Math.round(raw * 1e8) / 1e8;
  const rate = (liquidity === "MAKER" ? p.makerPct : p.takerPct) / 100;
  return {
    liquidity, referencePrice, price, profile: p.id,
    feeMicro: micro(price * qty * multiplier * rate),
    slippageMicro: micro(Math.abs(price - referencePrice) * qty * multiplier),
  };
}

/** Minimum order check; null when the order is allowed. A CLOSE is never blocked. */
export function minimumOrderProblem(p: CostProfile, action: "buy" | "sell" | "close", qty: number, value: number): string | null {
  if (action === "close") return null;
  if (p.minQty > 0 && qty < p.minQty - 1e-12) return `quantity ${qty} is below the ${p.name} minimum of ${p.minQty}`;
  if (p.minNotionalUsd > 0 && value < p.minNotionalUsd - 1e-9) return `order value $${value.toFixed(2)} is below the ${p.name} minimum of $${p.minNotionalUsd}`;
  return null;
}

/** Signal liquidity hint: 'maker' only when the sender says so; everything else is a taker fill. */
export function parseLiquidity(v: unknown): Liquidity | "INVALID" {
  if (v === undefined || v === null) return "TAKER";
  if (typeof v !== "string") return "INVALID";
  const s = v.trim().toLowerCase();
  return s === "maker" ? "MAKER" : s === "taker" ? "TAKER" : "INVALID";
}
