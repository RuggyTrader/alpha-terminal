# Strategy selection report: ONE long-term strategy (2026-11-21)

**Result:**
- Under the pre-registered rules, **S3, the 200-day SMA trend filter with 40% volatility targeting**, is **selected for forward PAPER validation**.
- This is **not** a claim of future profitability. It is the strongest *risk-adjusted* candidate on data no earlier round used, with the caveats below.
- **The < 2% drawdown objective is not achievable at the $100 account size.**

## Record

| Step | Commit / file |
|---|---|
| Pre-registration (before data and runs) | `d6d9c1f` |
| Code and tests (before any run) | `e4e6627` |
| Results | `select-results.json` (data hashes in `provenance`) |
| Reproduction | a fresh second run produced a **byte-identical** results file |

**Data:**
- Coinbase public daily candles (free).
- **Untouched confirmatory period: 2016-01-01 → 2021-05-31 (BTC, ETH)**; no earlier round used anything before 2021-06.
- Seen period 2021-06 → 2026-11 (BTC, ETH, SOL), used for consistency only.

**Setup:** $100 shared portfolio, equal sleeves, long only, spot, next-open fills, 0.20% + 0.05% costs (stress 0.40% + 0.10%).

## Results (portfolio, $100 start)

| | Untouched net | CAGR | **Max DD** | **Sharpe** | Stress net | Seen-period net (DD) | Gates |
|---|---|---|---|---|---|---|---|
| S1 SMA-200 trend | +$19,302 | 164% | 73.6% | 1.72 | +$18,077 | +$93 (40.2%) | all pass |
| S2 12-week momentum | +$25,931 | 179% | 67.4% | 1.78 | +$24,364 | +$17 (57.9%) | all pass |
| **S3 SMA-200 + vol target 40%** | **+$3,128** | **90%** | **41.7%** | **2.08** | +$2,970 | **+$88 (23.7%)** | **all pass, selected** |
| S4 Turtle 55/20 | +$7,542 | 123% | 58.6% | 1.59 | +$7,116 | +$315 (47.6%) | all pass |
| Buy-and-hold | +$14,412 | 151% | 90.1% | 1.51 | — | +$40 (88.5%) | — |

**What the numbers say:**
- The untouched period was an extraordinary bull market for BTC and ETH (buy-and-hold ×145). **Absolute returns from that period must not be extrapolated.**
- What carries over is the *shape*. Trend rules kept most of the upside while cutting drawdowns, and **S3 roughly halved buy-and-hold's drawdown, with the best Sharpe in both periods**.
- **In 2021–2026** S3 made +88% (about 12% a year) with a 24% maximum drawdown. Buy-and-hold made +40% with an 88% drawdown.

**Secondary markets (pre-2021, each $100, S3):**

| Market | S3 net | S3 max DD | Buy-and-hold net | Buy-and-hold max DD |
|---|---|---|---|---|
| LTC | +$1,088 | 42% | +$5,082 | 94% |
| BCH | +$33 | 49% | −$81 | 98% |
| ETC | +$70 | 61% | +$361 | 77% |
| XLM | +$89 | 32% | +$277 | 77% |

S3 is positive on all four with lower drawdowns, but lags buy-and-hold in strong bull runs, as expected of a trend filter.

## Disclosed post-run correction (does not change the selection)

**What was wrong.** My S3 implementation compared each new target weight with the *last executed target*. A position was therefore never re-sized for price drift. The standard reading of a rebalancing band compares the target with the position's **actual** weight.

**Sensitivity with the actual-weight band:**
- untouched: net +$2,675, Sharpe 2.09, max DD 40.5%;
- seen: +$96.7, max DD 23.9%;
- bootstrap lower bound > 0.

The result is essentially the same. **The forward trial should use the actual-weight band**: it is the correct rebalancing behaviour and what a live implementation would do.

## The < 2% drawdown objective: not realistic at $100

**What it would take.** Holding S3's historical drawdown near 2% requires **4.9% exposure** (actual-weight band, threshold scaled with exposure):

| Period | CAGR | Max DD |
|---|---|---|
| Untouched | **3.4%** | 2.25% |
| Seen | **0.8%** | 1.2% |

**Why it fails here.** At that exposure a $100 portfolio holds at most **$1.64 per asset**. Kraken's minimum orders at today's prices are about **$3.85 (BTC), $3.54 (ETH) and $3.51 (SOL)**, so **the orders could not be placed**.

**Conclusion:** the 2% target is incompatible with a $100 account after costs and minimums. A realistic target for S3 is a drawdown of roughly **25–40%** at full exposure, or smaller exposure with proportionally smaller returns, which needs more capital to clear the order minimums.

## Caveats (why this is "selected for validation", not "proven")

1. **Regime:** 2016–2021 was one long bull market with a deep 2018 bear market inside it. Trend filters are built to sidestep exactly that pattern; a long sideways market would hurt them (whipsaw costs).
2. **Survivorship and asset choice:** BTC and ETH are this decade's survivors, chosen with hindsight. The secondary markets (including the delisting-era BCH and ETC) are the partial check.
3. **Prior exposure:** the seen period and SMA-style rules were examined in earlier rounds (round 3 MA-50, round 7 T2). Only the 2016–2021 test is clean.
4. **Few independent bets:** daily trend rules make few round trips. The weekly bootstrap passed, but the sample of trends is small.
5. **Execution model:** next-open market fills with 0.25% total cost. Spreads in 2016–2017 were wider than today's, which is not modelled beyond the stress scenario.

## Frozen rule for the forward PAPER trial (proposal only; owner approval required)

**Rule:**
- **Markets:** BTC/USD and ETH/USD (SOL optional), equal sleeves.
- **Daily at the UTC close:** for each asset, the target weight = 1{close > SMA(200)} × min(1, 0.40 / σ₃₀), where σ₃₀ is the annualised 30-day realised volatility of daily log returns (√365).
- **Trading:** the trade executes at the next open when |target − actual weight| ≥ 0.10, or when entering or leaving.
- Long only, no leverage, market orders.

**Requirements:**
- **Capital:** at least about $20 per asset sleeve so that partial weights clear Kraken's minimums. With the current $20 wallets, one BTC/ETH pair needs two wallets or one consolidated $40 wallet: an owner decision.
- **Monitoring (no automatic switching):** compare the forward drawdown and the weight path with the backtest. **Stop and review** if the forward drawdown exceeds 30%, or if signals diverge from the reproducible backtest of the same days.

Nothing is implemented in production.

## Verification (2026-11-21, after the owner's review)

### 1. Independent reproduction of corrected S3

`engine/test/select-s3-independent.test.mjs` is a separate implementation that shares **no code** with `src/research/select/` (its own data merge, indicators, execution and accounting). It reproduces the reported corrected-S3 figures **to the cent**:

| | Net | Max DD | Sharpe |
|---|---|---|---|
| Untouched | +$2,675.02 | 40.53% | 2.085 |
| Seen | +$96.70 | 23.85% | 0.627 |
| Stress, untouched | +$2,500.45 | — | — |

The main run reproduces byte-identically from a fresh process.

### 2. Bias and accounting checks

| Check | Result |
|---|---|
| Lookahead | the decision at close i uses bars 0..i only; the trade is at open i+1. Unit tests alter later candles and prove the earlier curve and decisions are unchanged |
| Data | no invalid candles; BTC and SOL have no gaps; ETH pre-2021 has one 3-day gap (kept, not filled) |
| Accounting | equity = cash + coins × close; cash never negative; round-trip nets sum to the final P&L; fees = 0.20% of traded notional |
| Survivorship and asset choice | not removable. Disclosed |

### 3. Costs and minimum orders

- **Fees and slippage:** 0.20% + 0.05% on every fill, and 0.40% + 0.10% in the stress test.
- **A real flaw found:** the original backtester *flagged* orders below Kraken's minimum but still *executed* them.
  - Fixed as an option: such orders are now **skipped**, and a full exit is always allowed.
- **Re-run with today's minimums** (BTC ≈ $3.85, ETH ≈ $3.54) in the trial configuration (BTC + ETH, $50 each):
  - untouched: 0 of 196 orders skipped (results unchanged);
  - 2021–26: 16 of 186 skipped; CAGR 13.66%, max DD 26.3%, Sharpe 0.60.

### 4. Did the trimming fix invalidate the acceptance?

**No.** Corrected S3 passes all seven gates on the untouched period:

| Gate | Result |
|---|---|
| G1 | net +$2,675 and stress +$2,500 |
| G2 | Sharpe 2.09 ≥ buy-and-hold 1.51 |
| G3 | 4 of 5 years positive (2018 negative) |
| G4 | the best year is 39% of the net |
| G5 | neighbours +$1,539 / +$4,338 |
| G6 | seen period +$96.7 |
| G7 | bootstrap lower bound 0.00485 > 0 |

### 5. Can drawdown be cut substantially and still leave meaningful returns?

**Only proportionally.** These are deterministic exposure scalings computed after the results, **not validation**, and no parameter was chosen from them:

| Exposure | Untouched: CAGR / max DD / Sharpe | 2021–26: CAGR / max DD / Sharpe |
|---|---|---|
| 100% | 84.6% / 40.5% / 2.09 | 13.7% / 26.3% / 0.60 |
| 50% | 38.5% / 21.2% / 2.14 | 7.8% / 13.7% / 0.60 |
| 25% | 19.0% / 11.2% / 2.21 | 4.7% / 7.5% / 0.66 |

- Return scales down with drawdown, and Sharpe barely changes. **There is no free lunch.**
- At $100, reduced exposure makes most re-sizes fall below the minimum order (2021–26: 345 of 491 skipped at 50%, 1,216 of 1,315 at 25%).
- **The 2% target is not achievable at $100.**
- Choosing a lower vol target or exposure *now*, on the same data, would be optimisation on the holdout. Any such choice must be fixed **before** the forward trial, and judged only on forward data.

### 6. Validated vs post-test results

| Category | Results |
|---|---|
| **Independently validated** (pre-registered, untouched 2016–21) | S1–S4 as pre-registered: all gates pass; S3 selected |
| **Post-test revision, disclosed** | corrected rebalancing band (S3 actual-weight); skipping sub-minimum orders; the exposure frontier; the trial configuration (BTC+ETH only, $50 sleeves) |
| **Seen data (consistency only)** | everything from 2021-06 on; it was examined in earlier rounds |

**The honest expectation for S3 going forward** is closer to the 2021–26 seen-period figures than to 2016–21: about 13% CAGR, a 25% drawdown and a Sharpe near 0.6. In that period 3 of 6 calendar years were negative and the gains came in 2023–24. **This is not a profitability claim.**
