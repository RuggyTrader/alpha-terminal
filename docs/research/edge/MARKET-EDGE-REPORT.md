# Market Edge Discovery Report: liquidations, open interest, volatility (BTC / ETH / SOL), 2026-11-25

## Bottom line

**No statistically and economically convincing trading edge was found.**

| Hypothesis | Finding |
|---|---|
| Liquidation cascades (rebound or continuation) | No relationship of tradeable size, for all three assets |
| Open-interest divergence | One **SOL-only** reversal pattern (+48 bps over 4 h, Holm-significant), absent on BTC and ETH; positive only without conservative Jupiter costs |
| Extreme volatility | A real but tiny BTC continuation (+15 bps), below Jupiter's cost |

No strategy was built, simulated with leverage, or activated.

**Procedure:**
* Pre-registration `PREREGISTRATION.md` (d750dda), committed before the data were downloaded.
* Code committed before each run (d1afe36, 1b151a8).
* One run per test; sensitivity variants reported in full, never used to choose.
* Every step is in `LEDGER.md`.

The account rule is $100 PAPER with a $75 absolute shutdown, which can be overshot. Research only: the four bots, S3, P1 (its forward study is still collecting), production and wallets are untouched.

## 1. Data sources

| Data | Source | Granularity | Coverage | Limitations |
|---|---|---|---|---|
| Liquidation orders, long vs short | Tardis.dev free CSVs: Binance USDT-M `forceOrder`, Bybit `liquidation` | per order, ms | **the first day of each month only**, 2020-09..2026-11: 75 days (BTC, ETH), 74 (SOL); 688 events | **Not continuous** (about 1 day in 30). Binance has reported **at most 1 liquidation per symbol per second** since 2021-04-27 (an undercount). Bybit SOL starts 2021-07. OKX and BitMEX not used. |
| Prices / volume | Binance USDT-M futures 1-minute klines | 1 min | the liquidation days plus the next day | Binance prices, not Jupiter oracle prices |
| Open interest | Binance USDT-M `metrics` (`sum_open_interest`) | 5 min | 2021-12..2026-11, 5,634 files, none missing | one venue |
| Prices for H-OI | Binance USDT-M 5-minute klines | 5 min | 2021-12..2026-10 | |
| Prices for H-VOL | Binance spot 1 h (from the Jupiter work) | 1 h | 2018-01..2026-09 | spot, not perpetual |

* **Not obtained free:** continuous liquidation history (Coinglass and Coinalyze need payment or an account; Binance's historical liquidation snapshots are no longer published), and historical order-book depth.
* **Liquidity / depth was not used.** The only free historical depth (Tardis first-of-month books) was not added to these studies.
* **Reused price paths.** All price paths up to 2026-09 were used by earlier ALPHA TERMINAL rounds. **The liquidation and OI data had never been used**, but the price data they are combined with are not unseen.

## 2. Liquidation event study (H-L, Phase 1)

**Event definition:**
* the 5-minute liquidation notional on one side ≥ the 99.5th percentile of **earlier days only**;
* 6-day burn-in;
* 60-minute declustering.

**Entry:** the open **1 minute after** the event is observable.

**Controls:** up to 5 matched non-event minutes per event, with:
* the same symbol;
* the same UTC hour ±1;
* the same decile of the preceding 15-minute move and of the 60-minute volatility;
* low liquidations;
* no event within ±2 h.

100 % of events found controls.

**Inference:** day-clustered bootstrap, a t-test on day means, and Holm correction over 30 tests.

**Result: 0 of 30 tests significant after Holm** (smallest adjusted p = 0.44).

Pooled direction-normalized forward returns (positive = rebound), mean raw (bps):

| | 5 min | 15 min | 1 h | 4 h | 24 h |
|---|---|---|---|---|---|
| Long-liquidation events (n = 371, 61 days) | +0.4 | +2.4 | +8.6 | +16.9 | +42.6 |
| Short-liquidation events (n = 317, 53 days) | +0.3 | −3.5 | −13.2 | −5.3 | −102.6 |

Neither direction dominates:
* The rebound probability is 0.46–0.55.
* The 1 h favourable and adverse excursions are roughly symmetric (about ±50–125 bps).
* The median time to half-retrace the pre-event move is 16 minutes, but that is ordinary noise, not an edge.

**Per asset.** The best single cell is BTC long-liquidation, 1 h: +18 bps raw, unadjusted p = 0.05. It is not significant after correction and is below the 30 bps baseline cost.

**Sensitivity** (99 / 99.9 %, 1 / 15-minute windows, 3 / 5-minute delays, each exchange alone, before / after the Binance change):
* raw means stay within ±25 bps at 15 min–4 h;
* the only larger values come from 10 events before 2021-04-27.

**Verdict: REJECTED.** There is neither a tradeable rebound nor a continuation after large liquidations.

## 3. Other market-structure hypotheses (Phase 2)

**H-OI** (strong hourly moves > 2σ, split by the OI change; vs neutral-OI moves; 36 tests):
* **4 Holm-significant results, all SOL.**
* **Strong down hour + OI falling** (long closing): SOL reverses, raw +22.6 bps at 1 h and **+48.4 bps at 4 h** (Holm 0.009); both halves agree (−68 / −37 bps effect).
* **Strong up hour + OI rising** (new longs): SOL fades 32 bps raw at 4 h (Holm 0.006 on the controlled effect).
* **BTC / ETH:** no comparable effect. The same groups give −2 to −4 bps raw, with effects of the opposite sign or insignificant.
* **Verdict:** fails the pre-registered breadth condition (the same sign on at least 2 of 3 assets) → **not tradeable**. A SOL-only lead.

**H-VOL** (an hour with a range ≥ 4× the trailing 7-day median; continuation measured from the next hour's open; 9 tests):
* **BTC:** 1 h continuation **+14.5 bps** (Holm 0.012), 4 h +17.7 bps.
* **ETH:** +12 / +20.5 bps.
* **SOL:** the opposite (−26 bps).
* **Verdict:** significant but **below the 30 bps cost bar → not tradeable**.

## 4. Candidate edge table

| Rank | Hypothesis | Statistical evidence | Gross per event | Net, baseline 30 bps | Net, conservative 60 bps | Breadth | Status |
|---|---|---|---|---|---|---|---|
| 1 | **SOL: strong down hour + falling OI → 4 h reversal (long)** | Holm 0.009, both halves | +48 bps | **+18 bps** | −12 bps | SOL only | lead for forward observation |
| 2 | SOL: strong up hour + rising OI → 4 h fade (short) | Holm 0.006 (effect), raw weaker | +32 bps | +2 bps | −28 bps | SOL only (ETH weak) | not tradeable |
| 3 | BTC/ETH: extreme-range hour → 1–4 h continuation | Holm 0.012 (BTC 1 h) | +12 to +20 bps | −10 to −18 bps | negative | BTC + ETH (SOL opposite) | not tradeable |
| 4 | Liquidation rebound / continuation (all assets) | none (0 / 30) | −13 to +17 bps | negative | negative | — | **rejected** |

**Caveat on the SOL lead.** It was selected as the best of 36 tests. Holm controls the family-wise error, but the price paths are reused, and the effect does not appear on BTC or ETH. That combination often means a sample-specific artefact.

## 5. Jupiter feasibility ($100 account)

**Per-trade costs.** These come from the earlier on-chain reading of Jupiter's parameters.

| Cost item | Size |
|---|---|
| Open + close fee | 12 bps of size |
| Price impact | negligible at $100 |
| Keeper delay | 5–20 bps per side (assumed; no historical keeper data) |
| Long-collateral swap (USDC → asset) | 10–30 bps of collateral per swap |
| Network | $0.02–0.10 per transaction (×3 per trade: open, stop, close) |
| Borrow at 4 h | about 0.6 bps (longs) |

**Effective round trip at $100:**
* **About 30–45 bps (baseline)** for a 1.1× long with $90 collateral.
* **60–80 bps conservative.** The swap fee and network fees are proportionally large at this size, and they do not shrink with leverage, because collateral stays at least $10.

**The lead (+48 bps gross) is therefore at most marginally positive at baseline costs and negative at conservative costs:**
* **Frequency:** about 105 events a year on SOL.
* **Baseline:** roughly +15–20 %/yr of notional at 1×.
* **Conservative:** about −10 %/yr.

That estimate is illustrative only, and no account simulation was run (see below).

**Execution.** The event is observable on public Binance OI within about 5 minutes of the hour. Jupiter longs via the keeper path (seconds to a minute of delay) and USDC collateral swapped to SOL are feasible at $10+ collateral and ≥ 1.1× leverage. The existing engine is hourly, which suits this hour-aligned signal (see `ENGINE-AUDIT.md`).

## 6. Risk analysis

**No account-level simulation was run**, by design: no hypothesis met its pre-registered tradeable condition, so building a rule and testing leverage would itself be optimizing on reused data.

What the event study shows:
* **Short-horizon dispersion is large relative to the edges.** The standard deviation of all SOL 4 h returns (2021-12..2026-10, 42,975 windows) is **about 204 bps**, against a +48 bps mean edge. It is likely larger right after strong moves (not measured separately). At 3–5× leverage, a short run of losers would reach the $75 shutdown.
* **Liquidation risk.** At 5×, Jupiter liquidates at about −19.8 % (protective stop about −10 %).
  * The worst SOL 4 h move in the sample was **−32.2 %**.
  * **0.12 %** of 4 h windows fell 10 % or more.
  * Liquidation takes all collateral.
* **Shutdown overshoot.** As measured in the earlier Jupiter study (equity fell to $64.34), the $75 shutdown can be overshot by several dollars.

## 7. Recommendation

**No strategy should be built or activated.** The single hypothesis that merits further work is **the SOL long-closing reversal (H-OI rank 1)**, and only as **forward observation on new data**:
1. A read-only collector of Binance's public 5-minute OI and SOL prices, logging each qualifying event and its 4 h outcome. No trading, no leverage, no strategy.
2. Pre-registered pass criteria, fixed before collection:
   * at least 60 new events (about 7 months);
   * mean 4 h reversal > 60 bps (above conservative cost);
   * a 90 % interval excluding 30 bps.
3. Only if those pass: build the minute- or hour-aligned Jupiter rule and run the account and risk simulation. Approval is needed again at each step.

**Starting the collector needs your approval.** It is read-only, but it is a new scheduled process.

If you decline, the research conclusion stands as stated in §1.

**Remaining blockers for any real-money use (unchanged):**
* no qualifying edge;
* Ontario legal eligibility and legal-age requirements;
* Jupiter's Perps API is still a work in progress;
* historical keeper latency and borrow rates are unknown.

## Files

**`docs/research/edge/`:**
* `PREREGISTRATION.md`
* `LEDGER.md`
* `ENGINE-AUDIT.md`
* `liq-results.json` (all 688 events with controls)
* `oi-results.json`
* `vol-results.json`
* this report

**Code (`engine/src/research/edge/`):**
* `fetch-liq.mjs`, `fetch-oi.mjs`
* `zip.mjs`
* `stats.mjs`
* `liq-study.mjs`
* `phase2-study.mjs`

**Tests (`engine/test/`):**
* `edge-stats.test.mjs`
* `edge-liq.test.mjs`
* `edge-phase2.test.mjs`

**Data (outside Git, with SHA-256 manifests):** `%USERPROFILE%\AlphaTerminal\research\edge\liqdata` and `oidata`.

**Source references:**
* [Tardis.dev datasets](https://docs.tardis.dev/downloadable-csv-files)
* [Binance public data](https://data.binance.vision)
* [Jupiter Perps docs](https://developers.jup.ag/docs/perps/index.md)
