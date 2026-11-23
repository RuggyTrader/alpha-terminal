# Futures contract feasibility audit for a $100 PAPER account (2026-11-22)

**Result: no contract is viable at $100.** All are rejected before backtesting. Starting capital and the drawdown ceiling were not changed.

## Viability test (stated before evaluating)

A contract must allow, at $100:

1. **Holding a position** (long or short) through the daily margin cut-off. Equity must stay ≥ the overnight (initial) margin.
2. **Risk-sized trades.** One contract's loss at a 1-day-σ stop must be ≤ 2 % of equity ($2), so that 5 consecutive losers stay inside the 10 % preferred drawdown. The maximum notional is therefore $2 ÷ σ_day: ETH ≈ $57 (σ 3.5 %), BTC ≈ $80 (σ 2.5 %), SOL ≈ $44 (σ 4.5 %).
3. **Compounding.** The contract must leave room for more than one size step.
4. **Costs.** A round trip must cost well below the $2 risk budget.

## Feasibility table

Prices are Kraken, 2026-11-22. Margins are from NinjaTrader's live table ("as of 2026-11-22"). Fees are NinjaTrader all-in, Free plan.

| Contract | Size | $ exposure (× equity) | Day / overnight margin | Round trip | Funding / roll | Ontario via NinjaTrader | Automation | Verdict |
|---|---|---|---|---|---|---|---|---|
| CME Micro Ether (MET) | 0.1 ETH | $172 (1.7×) | $50 / $49.50 | $1.38 | monthly roll | yes | NinjaScript | **reject:** 3× the $57 risk-sized notional; probe showed 50–76 % drawdowns and liquidation lock-out |
| Coinbase nano Ether, dated (ET) | 0.1 ETH | $172 (1.7×) | $25 / **$162.80** | $1.00 | monthly roll | yes | NinjaScript | **reject:** cannot be held past the margin cut-off at $100 |
| Coinbase nano Ether perp-style (ETP) | 0.1 ETH | $172 (1.7×) | $85 / **$170** | $1.00 | hourly funding | yes | NinjaScript | **reject:** cannot be held past the daily cut-off; 3× the risk-sized notional |
| Coinbase nano Bitcoin, dated (BIT) | 0.01 BTC | $612 (6.1×) | $25 / **$379.50** | $1.00 | monthly roll | yes | NinjaScript | **reject:** 7.6× the risk-sized notional; a 1-σ day = $15 |
| Coinbase nano Bitcoin perp-style (BIP) | 0.01 BTC | $612 (6.1×) | **$130** / $260 | $1.00 | hourly funding | yes | NinjaScript | **reject:** cannot even be opened ($130 > $100) |
| Coinbase nano Solana | 5 SOL | $353 (3.5×) | **$500** / $605 | $1.00 | — | yes | NinjaScript | **reject:** cannot be opened |
| Bitnomial BTC perp (PBTCUCZ50) | 0.01 BTC | $612 (6.1×) | — | — | funding | **no:** offered to eligible US clients (Kraken Derivatives US); not on NinjaTrader's schedule | Kraken Pro (US) | **reject** |
| Bitnomial ETH perp (PETHIUZ50) | **0.5 ETH** | **$862 (8.6×)** | — | — | funding | no | — | **reject:** low margin ≠ low exposure |
| Bitnomial SOL perp (PSOLUZ50) | 5 SOL | $353 (3.5×) | — | — | funding | no | — | **reject** |
| Bitnomial "Small Size" perps (NinjaTrader margins page, ~$1 margins) | not published on the pages read | — | ~$0.67 / ~$1.35 (BTC) | not on schedule | funding | **not verified; US offering** | — | **reject:** unverified size and eligibility |

**Rules common to all:**
* Whole contracts only (Kraken Derivatives US spec page).
* Margin must be met at all times; liquidation fees $10 (nano and perp-style) or $25 / $50.
* Margins may be raised 4× before news for new positions.
* **Costs:** every round trip costs **1.0–1.4 % of a $100 account**, i.e. 50–70 % of the $2 per-trade risk budget, before spread, slippage and funding.

## Recommended research direction: an isolated fractional-size PAPER model

To study leveraged long/short strategies honestly **without pretending the orders are executable** through NinjaTrader at $100:

* **Instrument model:** "perpetual-style ETH and BTC" with **fractional size**. The cost per dollar of notional is taken from the real contracts:
  * nano ETH: $0.50 / $172 = 0.29 % per side; nano BTC: $0.50 / $612 = 0.08 % per side;
  * plus a measured spread and slippage, and stop slippage.
* **Funding:** hourly accrual. History from Binance's public funding series (already downloaded, 2019+), labelled as a **proxy** for Coinbase perp-style funding.
* **Prices:** Kraken's official hourly and 5-minute archive. Drawdown is the high-water-mark measure including intraday movements, with 10 % preferred and 15 % ceiling. This is separate from the spot line's official 2 %, which is unchanged.
* **Margin model:** mirrors NinjaTrader's intraday and overnight margin ratios and liquidation rule, applied pro rata.
* **Honesty field on every result: "executable capital".** This is the account size at which the strategy's typical position equals at least N whole real contracts (e.g. ≥ 5 nano ETH). It shows what an executable version would need. No result is presented as executable at $100.
* **Method:** as before. Pre-register hypotheses, rules and criteria; no tuning on examined periods; reused data labelled.
