# DD2 frontier report: historical return achievable at each maximum-drawdown limit (2026-11-21)

**Research only.** The owner's 2 % requirement is unchanged. This is not a proposal to raise it, and nothing here is
deployed or promoted.

## Method

* Protocol pre-registered in `FRONTIER-PREREGISTRATION.md` (commit `4befc9c`) and run mechanically by
  `engine/src/research/dd2/frontier.mjs`; a second run was byte-identical.
* Same data, costs (0.40 % + 0.05 %), Kraken minimums, strict drawdown, 2,912 configurations and
  training → validation → test periods as DD2.
* **The test period (2023-07 → 2026-11) was already seen once in DD2; this is a second look.** Nothing is chosen from it.
* "Annual" = compound annual rate.

## Summary: what each drawdown limit bought, out of sample (2023-07 → 2026-11, 3.4 years, $100 start)

| Limit | Pre-registered pick (best in validation) | Its test result | Best *robust* candidate | Its test result | Its 2016–2026 result |
|---|---|---|---|---|---|
| **2 %** | BTC momentum (DD2 winner) | +0.75 %/yr, DD 1.52 % · **fragile** | BTC+ETH+SOL momentum, 0.10 % risk | +0.57 %/yr, DD 0.90 % | $116.86, 1.44 %/yr, DD 1.38 % |
| **3 %** | BTC+ETH+SOL 14-day momentum | +2.98 %/yr, **DD 3.20 %: broke the limit** | BTC+ETH+SOL 20-day breakout, 0.25 % risk | **+2.78 %/yr, DD 2.66 %** | $137.43, 2.97 %/yr, DD 3.61 % |
| **5 %** | BTC+ETH+SOL 56-day momentum | +2.23 %/yr, DD 4.19 % · fragile | none | — | — |
| **10 %** | BTC+ETH+SOL 14-day momentum, 1 % risk | +7.15 %/yr, **DD 17.7 %: broke the limit** | BTC+ETH+SOL S3-type, 10 % vol target | **+3.63 %/yr, DD 8.84 %** | $229.78, 7.95 %/yr, DD 9.46 % |
| **15 %** | BTC+ETH+SOL 28-day momentum, 1 % risk | +6.80 %/yr, **DD 19.5 %: broke the limit** | none (best fragile: SMA-20 trend, 1 % risk) | +7.13 %/yr, DD 11.6 % | $250.25, 8.8 %/yr, DD 16.0 % |
| *Reference* | S3 (frozen), same costs | **+15.3 %/yr, DD 27.5 %** | Buy and hold BTC+ETH | +12.7 %/yr, DD 58.1 % | — |

**Robust** means all of the following, fixed in advance:
* profitable and within the limit in training, validation **and** test;
* the test return kept ≥ 25 % of the training rate;
* ≥ 50 % of neighbouring settings also passed;
* ≤ 25 % chance of breaching the limit when its trades are reshuffled;
* profitable under stress costs.

## What this shows

1. **Low limits buy very little return.** Between 2 % and 10 % drawdown, out-of-sample returns were roughly **0.6–3.6 %
   a year**. Meaningful returns (≈ 7 %+) only appeared at the 15 % limit, and S3's ≈ 15 % a year came with a 27.5 %
   drawdown.
2. **Drawdown limits chosen on history are not reliable.**
   * At 3 %, 10 % and 15 %, the strategy that looked best before the test **broke its own limit in the test**: 3.2 %,
     17.7 % and 19.5 %.
   * At the 10 % limit, the realised test drawdown was **1.8 times** the limit.
   * At higher risk, out-of-sample drawdowns ran about 1.1–1.8 times the in-sample limit (3.2 % on a 3 % limit, 17.7 % on
     10 %, 19.5 % on 15 %).
   * **Planning rule:** treat any historical drawdown as an underestimate.
3. **How often training winners survive:** of all configurations that passed training at each limit, only **36 % (2 %
   limit) to 54 % (15 %)** stayed profitable and within the limit in both later periods. Roughly half of what looks good
   in training does not hold.

## Which results look genuinely robust vs. overfitted

**Most robust:**
* **BTC+ETH+SOL 20-day breakout** (buy above the prior 20-day high, sell below the prior 10-day low, 1.5 × ATR trailing
  stop, 0.25 % risk):
  * about 3 %/yr in every period;
  * 5 of 7 neighbours also pass;
  * 17 % reshuffle risk of breaching 3 %;
  * profitable under stress costs.
* **BTC+ETH+SOL S3-type at a 10 % volatility target:** ≈ 0 % reshuffle risk at its limit and profitable under stress
  costs. But its return decayed from 12.5 %/yr (2016–20) to ≈ 4 %/yr afterwards, and the 2016–20 bull market flatters it.
* **At 2 %:** only the 0.10 %-risk momentum variant qualifies (≈ 0.6 %/yr in the test).

**Fragile:**
* The **DD2 2 % winner**: only 2 of 10 neighbours pass, and there is a 41 % chance of breaching 2 % by trade order alone.
* The 2 % breakout candidates: few trades.
* The 5 % and 15 % picks: high reshuffle risk, or test returns well below training.

**Overfitted or failed:** every 1 %-risk momentum pick, and two S3-type picks at the 3 % and 5 % limits (their
neighbours 0/3, test loss or breach).

**Recurring signal of overfitting:** high validation returns (14–16 %/yr) that collapse to 4–7 %/yr with
limit-breaking drawdowns in the test. Short-lookback momentum at 1 % risk is the clearest case.

## Bottom line

* The data supports a clear trade-off with no shortcut. Under 2–3 % drawdown, about **0.5–3 % a year**. About 10 %
  drawdown, about **4 % a year** robustly. Higher returns need drawdowns of 15–30 %, and the limits themselves are often
  exceeded out of sample.
* These are historical results on data examined in earlier rounds, not forecasts.
* No strategy is recommended for deployment, and the 2 % requirement stays as set by the owner.

Results: `docs/research/dd2/frontier-results.json`.
