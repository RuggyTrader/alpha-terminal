# Research round 4: hybrid OTE (pre-registration, written before any round-4 result)

**Owner's direction (2026-11-16):** keep OTE, Fibonacci retracements and PD Arrays as the core. Moving averages and volatility are used **only as market filters**. OTE zones remain the entry mechanism, PD Arrays provide confluence, and the stops and targets are structural or Fibonacci.

## The OTE core (unchanged code, `engine/src/ote.mjs`)

**Structure:**
- Swings are confirmed by pivots with `swingLen` bars on each side, which introduces no lookahead: a pivot is known only `swingLen` bars after it formed.
- A leg is used only when it is at least `minLegATR` × ATR long.

**Entry and exit:**
- **Entry:** a limit at the 0.705 retracement (OTE zone 0.618–0.786).
- **Confluence:** FVG, order-block and rejection-block PD Arrays inside the zone (`minScore`).
- **Protective stop:** at the swing origin ± `slBuf` × ATR.
- **Target:** the Fibonacci extension `tp2Ext`.
- **Management:** break-even and a trailing stop, as in the originals.

**Base settings on every timeframe:** the original 5m profiles (`solusd-5m` for SOL, `btcusd-5m` for BTC and ETH). The only changes are the candidate's own predefined changes; there is no other tuning.

## Filters (research only)

Filters are added as a gate function on the strategy state, never as an input, so production settings hashes are unaffected. A filter is evaluated with completed data only: the previous completed daily or higher-timeframe candle.

| Filter | LONG allowed when | SHORT allowed when |
|---|---|---|
| **R (H6 regime)** | BTC daily close > SMA200 **and** BTC 30-day realised volatility < its 1-year median | BTC daily close < SMA200 **and** volatility < median |
| **T (higher-timeframe trend)** | higher-timeframe close > EMA50 of that timeframe | higher-timeframe close < EMA50 |

## Candidates

| # | Candidate | Entry timeframe | Filter | Predefined variations |
|---|---|---|---|---|
| C0 | Original OTE (baseline) | 5m, 15m, 1h, 4h | none | — |
| C1 | OTE + H6 regime | 5m | R | — |
| C2 | OTE + higher-timeframe trend | 5m | T (1h) | — |
| C3 | Lower-timeframe OTE with 4h confirmation | 15m and 1h | T (4h) | — |
| C4 | 4h OTE with daily confirmation | 4h | T (1d) | — |
| C5 | Wider Fibonacci targets | best-supported of C3/C4 by development only | its filter | `tp2Ext` ∈ {−0.618, −1.0, −1.618} |
| C6 | Volatility-adjusted stop + fee-aware reward | as C5 | its filter | `slBuf` ∈ {0.5, 1.0}; `minNetRR` ∈ {1.0, 1.5} |
| C7 | Stricter PD-Array confluence | as C5 | its filter | `minScore` ∈ {2, 3} |

**LONG and SHORT** are run and reported **separately** for every candidate.

**Markets:** BTC, SOL and ETH.

## Data

Coinbase Exchange public candles, 5m, 15m and 1h (4h and daily built from them), 2021-06 → 2026-11, with the same provenance and gap reporting as rounds 2–3.

## Execution and costs (production model)

**Fills and orders:**
- The production fleet backtest (`runFleetBacktest`, `fillModel: "strategy"`): limit fills by TradingView's intrabar rules, stops at the stop or a worse gap open.
- **Strict acceptance timing:** `entryDelayBars: 1`. An order can fill only on a bar that starts after its acceptance.

**Sizing:**
- $100 per strategy (and $50 / $20 variants);
- dollar risk 2% of the wallet, reduced to fit;
- Kraken minimums (BTC 0.00006, SOL 0.05, ETH 0.002);
- no leverage.

**Costs:** fee 0.20% and 0.40% per fill; slippage 0.05%.

**SHORT positions:**
- fully collateralised PAPER shorts;
- an **estimated real-short borrowing cost** of 0.02% per 4 hours held is reported alongside, because a real spot short needs margin or derivatives.

## Periods

| Use | Data |
|---|---|
| Development (selection only) | BTC + SOL, 2021-07 → 2024-06 |
| Validation (gate) | BTC + SOL, 2024-07 → 2026-11 (seen in rounds 2–3 for other strategy families) |
| ETH | run once per candidate. ETH data was examined in round 3 (H1–H6), so it is **not untouched**, but no OTE setting was ever chosen on it. It is reported as a secondary check, not proof |
| Untouched evidence | only a forward PAPER trial |

## Acceptance (unchanged)

A candidate needs all of the following:
- positive net after 0.20% + 0.05% **and** after 0.40% + 0.05% in development, validation and the ETH check;
- profit factor above 1;
- all predefined neighbours positive in development;
- at least 30 validation trades per market;
- better return ÷ drawdown than buy and hold, the simple 200-day trend rule and H6 in validation.

**Compared against:**
- the original OTE (C0);
- Candidate B;
- H6;
- cash;
- buy and hold.

**Reported:**
- net and gross, fees, trades;
- profit factor, expectancy with its bootstrap 95% interval;
- maximum drawdown and exposure;
- regime split;
- parameter robustness.

**Failures:** every failed candidate goes into `docs/research/FAILED-CANDIDATES.md`.
