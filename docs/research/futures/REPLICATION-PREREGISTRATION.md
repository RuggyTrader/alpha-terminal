# Pre-registration: cross-market replication of the frozen trend rules (10 coins), 2026-11-22

Committed before the runner is executed. Research only. **This is NOT independent out-of-sample validation:** see Disclosures.

## Rules (frozen, unchanged from PERP-PREREGISTRATION.md)

* **H1 (long-only):** long when the previous daily close > 200-day SMA; else flat.
* **H2 (long/short):** long above the SMA200, short below.
* **Sizing:**
  * **"1×"**: weight 0.5 of equity;
  * **"volatility-targeted"**: weight min(1.5, 0.106 / σ30).
  * The per-asset formulas are exactly as before, each coin traded alone.
* **Coins:** all 10 previously extracted, none dropped: XRP, XLM, LTC, XMR, ETC, ADA, BCH, ZEC, DASH, DOGE (Kraken XDG).
* **Coverage:** each coin's full Kraken history, from the first day its SMA200 exists, to 2026-09-30.

## Measures (per coin)

* **Gross timing edge** (daily close-to-close, no costs; the decision at the previous close applies to the day's return):
  * beta and alpha against **the coin's own passive exposure**, with a 90 % CI from a 20-day block bootstrap;
  * a **random-timing null**: 2,000 circular shifts (≥ 90 days) of the coin's signal; p = share with mean ≥ actual.
* **Net results:** the audited simulator (`perp.mjs`), hourly bars.
  * **Ideal costs:** 0.29 %/side fee, 0.10 % spread, 0.02 % slippage.
  * **Conservative costs:** max(0.29 %, $0.50) per order, 0.20 % spread, 0.05 % slippage, 2 % missed orders, 0.3 % liquidation slippage.
  * **Common to both:** funding PROXY 0.01 %/8 h (no per-coin funding history); margin 10 % initial / 5 % maintenance; rebalance band 25 %.
  * **Reported:** compounded and fixed sizing; annual return, maximum equity drawdown (high-water mark incl. intrabar), worst day, trades, longest recovery, liquidations.
* **Net timing advantage:** alpha of the fixed-size, conservative-cost **net** daily returns against the coin's passive exposure, with a 90 % block-bootstrap CI.
* **Windows:** each coin's full coverage, and **2018-01-01 → 2026-09-30 (excluding 2017)**. The "including 2017" window exists only for coins with a valid SMA200 during 2017.
* **Concentration:** per calendar year, the alpha contribution. Gross alpha is recomputed **without each coin's best year**.
* **Correlation:**
  * the correlation matrix of the coins' strategy returns;
  * the effective number of independent results, N_eff = N² ÷ Σᵢⱼ ρᵢⱼ;
  * a **pooled** equal-weight portfolio of the 10 coin strategies, its alpha against an equal-weight passive basket, with a block bootstrap (which handles cross-correlation);
  * a pooled random-timing null that applies the **same** shift to every coin, so the cross-coin correlation of positions is kept.

## Recommendation rule (applied to H2 long/short and H1 long-only separately; the better-supported one is reported first)

**ADVANCE requires all of these:**
1. Pooled **net** (conservative) alpha 90 % CI > 0 in the full window **and** excluding 2017.
2. Pooled gross random-timing p < 0.05.
3. At least 6/10 coins with positive net alpha (point estimate).
4. Pooled gross alpha still > 0 without its best calendar year.
5. At least one frozen sizing with pooled maximum drawdown ≤ 15 %.

**REJECT:** pooled net alpha CI includes 0 in both windows **and** pooled p ≥ 0.10 **and** ≤ 5/10 coins with positive net alpha.

**INCONCLUSIVE:** anything else.

## Disclosures (fixed now)

* **Reused data.** These coins' daily and hourly prices were used before: Phase 3 (frozen A–D on 41 coins, daily) and H-L1 (hourly). The trend rules themselves were chosen on BTC/ETH. This is a first test **of these rules on these coins**, not untouched data.
* **Survivorship bias.** The coins are the 10 largest USD hourly files still in Kraken's 2026 archive. Coins that failed or were delisted (e.g. LUNA) are absent, which biases passive returns upward and may bias trend results.
* **Data limits.** Thin early markets have missing hourly bars, and short histories (DOGE from 2019-12, ADA from 2018-09) give few independent cycles. The funding is a constant proxy.
