# Cross-market replication of the frozen trend rules on 10 coins: results (2026-11-22)

**Recommendation: REJECT.** There is no convincing repeatable timing advantage.
* Pre-registration `REPLICATION-PREREGISTRATION.md` (commit `1a29f35`); run once. Results: `replication-results.json`.
* Rules, parameters and coins are unchanged; every coin is reported.
* **Status:** reused data, not independent validation. Net results are THEORETICAL PAPER ONLY.

## Pooled results (equal-weight across the 10 coins, 2018-01 → 2026-09, 3,192 days)

| | Gross alpha %/yr (90 % CI) | Random-timing p (same shift for all coins) | **Net alpha %/yr (90 % CI), conservative** | Coins with positive net alpha | Mean pairwise correlation | Effective independent coins | Pooled max drawdown (conservative, fixed) |
|---|---|---|---|---|---|---|---|
| **H2 long/short** | −0.9 (−21.2 to +19.0) | 0.24 | −7.9 (−22.5 to +6.4) | **1 / 10** | 0.28 | **2.8** | 1×: 58 % · volatility-targeted: 104 % |
| **H1 long-only** | −0.4 (−10.6 to +9.5) | 0.23 | **−13.6 (−23.4 to −3.8)** | **1 / 10** | 0.37 | **2.3** | 1×: 51 % · volatility-targeted: 60 % |

## Per coin, excluding 2017 (H2 long/short; H1 in brackets)

| Coin (signal from) | Passive %/yr | Gross alpha %/yr | Random-timing p | Net alpha %/yr | 1× conservative compounded: %/yr, max DD |
|---|---|---|---|---|---|
| XRP (2017-12) | 46.1 | −18.3 (−9.2) | 0.69 | −13.6 (−22.5) | ruin, >100 % (ruin) |
| XLM (2017-08) | 45.3 | −1.2 (−0.6) | 0.24 | −10.8 (−12.8) | ruin (−14.2 %, 80 %) |
| LTC (2014-06) | 25.8 | −1.8 (−0.9) | 0.36 | −13.1 (−11.5) | ruin (−11.0 %, 82 %) |
| XMR (2017-07) | 44.0 | −23.9 (−11.9) | 0.94 | −14.3 (−21.7) | ruin (ruin) |
| ETC (2017-02) | 36.5 | −9.0 (−4.5) | 0.47 | −13.8 (−17.3) | ruin (−18.4 %, 95 %) |
| **ADA (2019-04)** | 62.6 | **+22.4 (+11.2)** | **0.10** | **+12.0 (+1.1)** | +3.4 %, 86 % (+19.8 %, 63 %) |
| BCH (2018-02) | 33.0 | −4.8 (−2.4) | 0.55 | −8.8 (−14.6) | ruin (−16.9 %, 84 %) |
| ZEC (2017-05) | 75.3 | −9.6 (−4.8) | 0.42 | −15.1 (−24.8) | ruin (ruin) |
| DASH (2017-10) | 25.1 | −4.1 (−2.0) | 0.43 | −11.9 (−16.7) | ruin (ruin) |
| DOGE (2020-07) | 167.0 | −3.1 (−1.6) | 0.09 | −21.1 (−12.6) | +31.9 %, 82 % (+52.0 %, 64 %) |

**Notes on the per-coin results:**
* **Including 2017** (LTC, ETC, ZEC, XLM, XMR, XRP, DASH, where coverage allows): net alpha was positive only for LTC under H2 (+12.7 %/yr, p 0.31). All others were negative.
* **Drawdown targets:** **no run on any coin, rule, sizing or cost model stayed within 15 %**, let alone 10 %. Ideal-cost drawdowns were 61–98 %.
* **Trades, recovery, worst losses:** 67–223 orders per coin over the period. The longest recoveries ran 1,176–3,193 days, and many accounts never recovered.
* **Ruin under conservative costs:** compounded accounts shrink while the $0.50-per-order minimum and the $10 minimum liquidation fee stay fixed. This drives them below zero. "Worst day" percentages beyond −100 % are artefacts of equity near zero. The gross results, which carry no costs, do not depend on this.

## Concentration and correlation

* **Concentration:** the one positive coin (ADA) depends on 2021; its gross alpha falls from +22.4 % to +6.5 %/yr without its best year. For the other coins, removing their best year (mostly 2021 or 2022) leaves alpha at or below 0.
* **Correlation:** the coins' strategy returns are correlated (mean pairwise 0.28–0.37), giving an effective **2.3–2.8 independent coins**. Even a 10/10 success would have amounted to about three independent confirmations. The observed 1/10 is not a near miss.

## Against the decision rule

* **H2 meets the pre-registered REJECT condition:**
  * pooled net CI includes 0;
  * pooled p = 0.24 ≥ 0.10;
  * 1/10 coins ≤ 5/10.
* **H1 is worse than the REJECT condition requires:**
  * its pooled net alpha is *significantly negative* (CI −23.4 to −3.8);
  * gross alpha is ≈ 0 with p = 0.23;
  * 1/10 coins are positive.
* No ADVANCE criterion is met by either rule.

## Combined with the BTC/ETH result

* On BTC/ETH, the timing value was significant including 2017 and borderline without it (p 0.10–0.12).
* Across 10 other coins it does not appear at all, before or after costs.
* The most consistent reading is that the BTC/ETH result reflects a few BTC/ETH-specific episodes (2018 and 2022 bear markets), not a general, repeatable trend-timing advantage in crypto at these settings.

## Limitations

* **Reused data:** these coins' prices were examined in Phase 3 (daily) and H-L1 (hourly). The rules were chosen on BTC/ETH.
* **Survivorship bias:** only coins still in Kraken's 2026 archive were tested; failed or delisted coins are absent. This would usually *flatter* passive holding. Its effect on trend timing is ambiguous.
* **Short histories and gaps:**
  * ADA from 2019, DOGE from 2020, BCH from 2018: few independent cycles;
  * missing hourly bars in thin early markets;
  * the "including 2017" window exists for only 7 coins.
* **Costs and funding:** funding is a constant proxy (0.01 %/8 h, longs pay). Conservative costs use a per-order minimum that dominates small positions. Gross results avoid both assumptions and reach the same conclusion.

## Tests

The full engine suite passes (see the commit). The replication used only the audited simulator (`perp.mjs`: independent re-implementation agreement < 5e-13, ledger identity < $3e-9) and the unchanged rule definitions.
