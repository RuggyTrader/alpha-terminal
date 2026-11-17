// Round 8 market sets and period (frozen in docs/research/round8/PREREGISTRATION.md).
export const UNTOUCHED = Object.freeze(["GRT", "CRV", "SNX", "COMP", "BAT", "ZEC", "XTZ", "MANA", "SAND", "AXS", "CHZ", "1INCH", "YFI", "SUSHI", "LRC", "ICP", "ENJ", "STORJ", "BAL", "QNT"]);
export const EXAMINED = Object.freeze(["BTC", "ETH", "SOL", "LTC", "LINK", "AVAX", "ADA", "BCH", "DOGE", "XRP", "DOT", "ATOM", "UNI", "AAVE", "XLM", "ETC", "FIL", "ALGO"]);
// dataFrom leaves warm-up history before the evaluation window (indicators need up to 55 x 4h / 30+14 days).
export const PERIOD = Object.freeze({ dataFrom: "2021-03-01", from: "2021-07-01", to: "2026-11-15" });
export const COSTS = Object.freeze({ selected: { feePct: 0.2, slipPct: 0.05 }, stress: { feePct: 0.4, slipPct: 0.1 } });
export const SCENARIOS = Object.freeze({
  A: { label: "A production model: $20 isolated wallet per market, 2% risk", isolated: true, sleeveCapital: 20, riskPct: 2 },
  B: { label: "B one $100 strategy, 2% risk, max 5 positions (PRIMARY)", scenario: "risk", sizing: { riskPct: 2, maxPositions: 5 } },
  C: { label: "C $100, 20% of equity per position, max 5", scenario: "fixed_fraction", sizing: { fractionPct: 20, maxPositions: 5 } },
  D: { label: "D $100 risk budget: 1%/trade, <=25% notional, <=6% total open risk, raise-to-min only within 2%", scenario: "risk_budget", sizing: { riskPct: 1, maxRiskPct: 2, openRiskPct: 6, maxNotionalPct: 25, allowRaiseToMin: true } },
});
export const SCREEN = Object.freeze({ firstBy: "2021-07-01", maxMissingPct: 2, minMarkets: 12 });
