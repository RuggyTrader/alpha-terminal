# Pre-registration: fractional long/short perpetual-style research ($100, THEORETICAL PAPER ONLY), 2026-11-22

Committed before the first run. Research only.

**Not executable:** every result is **THEORETICAL PAPER ONLY**. Fractional contracts are not available, and NinjaTrader's perp-style contracts are not viable at $100 (CONTRACT-AUDIT.md).

## Model (`engine/src/research/futures/perp.mjs`, 9 accounting tests)

* **Instrument:** a fractional, 24/7 perpetual-style contract per asset (BTC, ETH).
* **Settlement and funding:** variation margin is settled hourly, and funding is charged hourly.
* **Price path:** Kraken official hourly **spot** OHLC, a **PROXY**. A real perp trades at a small premium or discount to spot. That premium is what funding pays for; it can widen in stress, which the proxy does not show.
* **Funding: PROXY.**
  * Binance USDT-margined perpetual 8-hourly rates (2019-09 onward), spread evenly over the following 8 hours.
  * Before 2019-09: an ASSUMED 0.01 % per 8 h (Binance's base rate).
  * **Why it differs from the executable contract:** Coinbase's US perp-style contracts compute their own hourly premium index (US venue, USD-settled, different participants). CME dated futures have no funding at all: they carry a basis that decays to expiry, plus roll costs. Binance funding is a reasonable indicator of the cost of leveraged positioning, not the exact cost of any US contract.
* **Margin (research, ASSUMED):** initial 10 %, maintenance 5 % (typical of 10× retail perps). Liquidation happens at the hour's worst price, with 0.3 % slippage.
* **NinjaTrader's actual overnight margins** are reported separately as an executability check: BTC perp-style $260 per $612 contract (≈ 42 %); ETH perp-style $170 per $172 (≈ 99 %).

### Two cost scenarios

| | **Ideal fractional** (idealized) | **Conservative execution** |
|---|---|---|
| Fees | % of notional from real nano contracts: ETH 0.29 %/side ($0.50 / $172), BTC 0.082 %/side ($0.50 / $612) | **$0.50 per WHOLE contract per side** (ceil of fractional units), i.e. never scaled down |
| Spread | 1 tick (ETH 0.029 %, BTC 0.008 %) | 2 ticks |
| Slippage | 0.02 % | 0.05 % (liquidation 0.3 %) |
| Missed orders | 0 % | 2 % of rebalance orders missed |
| Liquidation fee | 0.5 % of notional | $10 per whole contract |

## Hypotheses (decided at 00:00 UTC on Kraken daily closes; executed at that hour's open)

| | Rule | Economic basis | Note |
|---|---|---|---|
| **H1** trend long-only | each of BTC, ETH: long when close > 200-day SMA, else flat | time-series momentum (Moskowitz–Ooi–Pedersen 2012; crypto evidence: Liu & Tsyvinski 2021) | **REUSED** rule family (S1 / S3 earlier) |
| **H2** trend long/short | long above the SMA200, **short** below | the same trend effect, now harvesting downtrends (only possible with derivatives) | **new**: shorts never tested |
| **H3** relative momentum, market-neutral | every Monday, long the stronger and short the weaker of BTC/ETH by 28-day return, equal notional | cross-sectional momentum (Liu, Tsyvinski & Wu 2022) | long/short form **new**; the market-neutral leg removes most crypto beta |

### Sizing (all reported; nothing selected)

| Sizing | Definition |
|---|---|
| Fixed leverage | gross L ∈ {1×, 2×, 3×}: weight = sign × L / 2 per asset (H3: ± L / 2 per leg) |
| Volatility-targeted | per asset weight = sign × min(1.5, 0.106 ÷ σ30), σ30 = annualized 30-day volatility. Target 15 %/yr portfolio volatility (0.15 / √2 per asset), chosen a priori to equal the 15 % drawdown ceiling. |
| **Exploratory higher risk** (reported separately, never a candidate) | L = 5× |

**Position sizing:** compounded (base = equity) and fixed (base = $100), both reported.

## Windows (Kraken data; all REUSED by earlier price-based rounds)

* 2017-01 → 2026-09, 2018-04 → 2026-09, 2022-01 → 2026-09.
* **Cycles:** 2017–18 bull + bear, 2019 recovery, Mar-2020 crash, 2020–21 bull, 2022 bear, 2023–26.

## Reported for every run

* Final equity, net annual return, drawdown (high-water mark incl. intrabar extremes).
* Liquidations, fees, funding, missed orders.
* 2-week, monthly, quarterly and yearly returns (median, worst, best, share positive).
* Longest recovery, worst day.
* **Minimum executable capital:**
  * the account at which the typical non-zero position equals 1 real nano contract, and at which it equals 5 (for reasonable granularity);
  * NinjaTrader overnight margin plus a 15 % loss buffer;
  * whether the leverage is allowed at all under NinjaTrader's overnight margins.

## Candidate criteria (conservative costs; compounded)

A result is a **candidate for further investigation** only if all of these hold:
1. Drawdown ≤ 15 % in all three windows.
2. Net ≥ 15 %/yr over 2017–2026.
3. Profit in 2022–2026.

A drawdown ≤ 10 % earns "preferred".

**What a candidate means:** not proof of profitability. It is a reason to pre-register a confirmation on data not yet used for this hypothesis (forward PAPER), after which executability must be solved separately.

## Amendment 1 (after the first run; defects, not tuning)

The first run (`perp-results-v1-DEFECTIVE.json`, kept) exposed two **implementation defects**:

1. **Fees at historical prices.** The conservative fee was charged per *unit* of today's contract (0.1 ETH, 0.01 BTC) at *historical* prices. In 2017 ETH was about $8, so a 0.1-ETH "contract" was worth ~$1 but paid a $0.50 fee, and a 5× liquidation of ~312 such "contracts" cost $3,120. **Correction:** conservative fee per order = max(percentage fee, $0.50 minimum); conservative liquidation fee = max(0.5 % of notional, $10).
2. **No rebalance rule.** Compounding re-targeted every position every day, so the conservative scenario paid a $0.50 minimum fee on daily micro-adjustments: 165 orders and $128 of fees on a $100 account. The pre-registration did not specify a rebalance rule. **Correction:** trade only on a sign change, a move to or from zero, or a drift > 25 % of the target. This is the same 25 % band as the earlier overlay simulator (`lab/gz.mjs`), and it applies to both cost scenarios.

No hypothesis, sizing level, cost level, window or criterion was changed. The corrected run is the result; v1 is reported as defective.
