# Simulator audit, trend-edge test and execution-route check (2026-11-22)

Research only. No strategy was added or optimised.
* **Drawdown targets:** 10 % preferred, 15 % research ceiling. These are unchanged; the spot line's official 2 % is also unchanged.
* **Reused data:** every result here uses data examined before. **None of it is independent validation.**

## 1. Simulator audit

| Check | Result |
|---|---|
| Independent re-implementation (`perp-independent.mjs`) | Written from the specification with a different structure: P&L split at the trade price, explicit equity. Compared on **all 126** pre-registered configurations and windows: max relative difference in final equity **4.6e-13**; max drawdown difference **2.5e-12 pp**; liquidation counts identical. |
| Ledger identity | final = capital + price P&L − fees − slippage − funding, holding to within **$3e-9** in every run |
| Refactor safety | Shared setup was extracted; the results file is **byte-identical** before and after |
| Regression tests | Synthetic random paths: both cost modes, leverage 0.5–6× with liquidations, both compounding modes, rebalance band, and the v1 low-price fee defect. **12 simulator tests**; full suite passes. |
| v1 defective results | Preserved (`perp-results-v1-DEFECTIVE.json`), with Amendment 1 documenting the two defects |

**Limitation:** both implementations were written by the same author from the same specification. The audit rules out coding errors, not modelling errors.

The known modelling simplifications are labelled throughout:
* spot price as a proxy for the perpetual's price;
* Binance funding as a proxy for the actual contract's funding;
* hourly bars with worst-case intrabar order;
* 5 % maintenance margin.

## 2. Is the trend result genuine timing skill or market exposure?

**Setup (`edge-test.mjs`):** gross daily returns, fixed sizing, annualized arithmetic means (geometric returns are lower).
* **Beta and alpha:** a regression on the 50/50 BTC/ETH market. Alpha is the return not explained by market exposure; its 90 % CI comes from a 20-day block bootstrap.
* **Random-timing null:** 2,000 circular shifts of each asset's signal. This keeps time in market and run lengths but destroys timing.

| | Beta | Alpha %/yr (90 % CI) | Random-timing p |
|---|---|---|---|
| H1 long-only, 2017-01 → 2026-09 | 0.59 | +26.9 (7.7 to 48.6) | **0.021** |
| H1, 2018-04 → 2026-09 | 0.48 | +20.2 (2.1 to 39.6) | 0.077 |
| H1, 2022-01 → 2026-09 | 0.36 | +21.6 (2.4 to 39.8) | 0.056 |
| H1, excluding 2017 | 0.51 | +15.9 (−3.7 to 35.3) | 0.100 |
| H2 long/short, 2017-01 → 2026-09 | 0.17 | +53.7 (15.4 to 97.2) | **0.025** |
| H2, 2018-04 → 2026-09 | −0.04 | +40.4 (4.2 to 79.3) | 0.078 |
| H2, 2022-01 → 2026-09 | −0.27 | +43.2 (4.8 to 79.5) | 0.057 |
| H2, excluding 2017 | 0.01 | +31.9 (−7.4 to 70.5) | 0.115 |

**Conclusion:**
* There is some evidence of timing value beyond market exposure. It is **borderline**:
  * significant over the full sample, which includes 2017;
  * p ≈ 0.06–0.12, with CIs including 0, once 2017 is excluded.
* It rests on a few events, chiefly sidestepping or shorting the 2018 and 2022 bear markets.
* This is consistent with the published time-series-momentum literature, but **not independently confirmed** here.

## 3. Execution routes for fractional, leveraged long/short crypto exposure (Ontario, official automation)

| Route | Ontario | Leverage | Short | Granularity at $100 | Fixed cost per order | Verdict |
|---|---|---|---|---|---|---|
| Registered crypto trading platforms (Kraken, Ndax, …) | yes | **none**: CSA registration terms ban margin and leverage | no | fine | % fees | long-only spot |
| Crypto CFDs (CIRO dealers) | **not offered to retail**: the OSC decision for Fortrade Canada excludes crypto CFDs; Plus500 Canada does not offer them | — | — | — | — | not available |
| Futures via NinjaTrader (CME micro, Coinbase nano, dated and perp-style) | yes | yes (ETH overnight ≈ 1×) | yes | **whole contracts, $172–$612** | $0.50–$0.69 | not viable at $100 (CONTRACT-AUDIT.md) |
| Bitnomial / Coinbase US perpetuals | **US clients only** | — | — | — | — | not available |
| TSX crypto ETFs + BetaPro Inverse Bitcoin (BITI) via IBKR Canada | yes (CIRO dealer) | none in a cash account | **BTC only**, through a daily-reset futures-based inverse ETF (MER reported 2–5 %, unverified) | fine (shares ≈ $10–25) | **CAD $1.00 minimum per order** | possible but unlevered, BTC-only shorts, TSX hours only (weekend gaps); costs 1 % of equity per order at $100 |

**Result:**
* **No legitimate, officially automatable route gives fractional *leveraged* long/short crypto exposure to an Ontario resident at $100.**
* The only fine-grained long/short route is unlevered ETFs. Its $1 minimum commission makes a 10–20-order-a-year strategy cost 10–20 % of a $100 account per year.

## 4. Minimum capital instead of a $100 executable strategy

| Route and strategy | Minimum capital | Basis |
|---|---|---|
| NinjaTrader futures, trend volatility-targeted, 1 contract per leg | **≈ $4,200** (ETH $1,150 + BTC $3,070) | typical position ≥ 1 nano perp-style contract, overnight margin ($170 / $260), 15 % loss buffer |
| Same, ≥ 5 contracts per leg (reasonable sizing precision) | **≈ $21,000** | — |
| IBKR Canada ETFs, unlevered trend (BTC shorts via BITI), ~16 orders/yr | **≈ $1,600** | commissions ≤ 1 % of equity per year at the $1 minimum |

## 5. Single most useful next research step

**A pre-registered cross-market replication of the frozen trend signal**, before any capital or execution decision:
* **Rules:** H1 and H2 unchanged.
* **Data:** the 10 other Kraken coins already extracted (XRP, XLM, LTC, XMR, ETC, ADA, BCH, ZEC, DASH, DOGE). It is the first test of these rules on those coins. The coins' prices were used before by other rules, so it is still reused data.
* **Tests:** the same beta/alpha and random-timing tests.

**Why this step:** it is cheap, needs no new infrastructure or optimisation, and directly answers whether the borderline BTC/ETH edge reflects a general effect or a few BTC/ETH episodes. Forward PAPER data is the only fully independent evidence, and it would follow only if replication holds.
