# Jupiter Perps research tables (generated from results-dev.json and results-holdout.json)

## Pre-registered checks

| Candidate | Q1 DD<15 % & no shutdown | Q2 CAGR | Q3 no liquidation | Q4 P(−25 %/91 d)<5 % | Q5 breadth | Passes |
|---|---|---|---|---|---|---|
| A long_flat L1.1 | FAIL | FAIL | pass | pass | pass | **no** |
| A long_flat L2 | FAIL | FAIL | pass | FAIL | pass | **no** |
| A long_flat L3 | FAIL | FAIL | pass | FAIL | pass | **no** |
| A long_flat L5 | FAIL | FAIL | pass | FAIL | pass | **no** |
| A long_short L1.1 | FAIL | FAIL | pass | pass | FAIL | **no** |
| A long_short L2 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| A long_short L3 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| A long_short L5 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_flat L1.1 | FAIL | FAIL | pass | FAIL | pass | **no** |
| B long_flat L2 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_flat L3 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_flat L5 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_short L1.1 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_short L2 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_short L3 | FAIL | FAIL | pass | FAIL | FAIL | **no** |
| B long_short L5 | FAIL | FAIL | pass | FAIL | FAIL | **no** |

**Pick: NONE QUALIFIES**

## DEV-2 (2018-04..2026-09), conservative costs, with DEV-3 and base-cost context

| Candidate | CAGR | Max DD | $75 shutdown | DEV-3 CAGR / shutdown | Base-cost CAGR / DD | Trades | Win % | PF | Borrow $ | Open+close $ | P(−25 % in 91 d) | Holdout end $ / DD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A long_flat L1.1 | 4.06 % | 57.79 % | no | -5.89 % / 2022-09 | 19.73 % / 45.02 % | 144 | 24.31 | 1.05 | 75.69 | 18.64 | 0.0 % | 88 / 13.89 % |
| A long_flat L2 | 8.94 % | 78.51 % | no | -5.9 % / 2022-07 | 33.43 % / 65.17 % | 165 | 24.24 | 1.07 | 186.77 | 45.27 | 6.7 % | 75.87 / 27.75 % |
| A long_flat L3 | -3.17 % | 43.09 % | 2019-04-15T17 | -5.93 % / 2022-06 | 41.3 % / 79.69 % | 18 | 11.11 | 0.33 | 4.66 | 2.16 | 20.5 % | 74.39 / 30.82 % (shutdown) |
| A long_flat L5 | -3.1 % | 50.49 % | 2019-02-25T00 | -6.06 % / 2022-04 | 39.05 % / 94.19 % | 13 | 23.08 | 0.43 | 6.18 | 2.54 | 46.8 % | 69.97 / 38.16 % (shutdown) |
| A long_short L1.1 | -3.39 % | 29.98 % | 2019-04-13T00 | -6.01 % / 2022-11 | 10.25 % / 51.53 % | 24 | 12.5 | 0.37 | 1.97 | 1.66 | 1.4 % | 102.74 / 16.55 % |
| A long_short L2 | -4.06 % | 42.84 % | 2019-02-24T14 | -6.35 % / 2022-05 | 17.02 % / 69.87 % | 28 | 17.86 | 0.52 | 3.7 | 2.86 | 14.7 % | 75.39 / 28.79 % (shutdown) |
| A long_short L3 | -3.2 % | 32.1 % | 2018-04-25T10 | -5.85 % / 2022-09 | -3.48 % / 51.12 % | 8 | 12.5 | 0.03 | 0.59 | 0.82 | 26.7 % | 74.53 / 30.71 % (shutdown) |
| A long_short L5 | -4.46 % | 42.36 % | 2018-04-12T11 | -6.16 % / 2022-04 | -4.06 % / 40.92 % | 3 | 0 | 0 | 0.71 | 0.78 | 9.9 % | 73.67 / 34.89 % (shutdown) |
| B long_flat L1.1 | -3.48 % | 32.82 % | 2019-02-24T14 | -6.1 % / 2022-07 | 17.86 % / 63.04 % | 13 | 7.69 | 0.03 | 2.22 | 1.06 | 8.7 % | 89.33 / 12.78 % |
| B long_flat L2 | -3.4 % | 37.04 % | 2018-10-11T23 | -5.82 % / 2022-06 | -3.48 % / 38.3 % | 6 | 16.67 | 0.06 | 2.51 | 0.92 | 19.5 % | 81.8 / 22.34 % |
| B long_flat L3 | -3.41 % | 41.75 % | 2018-09-17T15 | -5.98 % / 2022-02 | -3.41 % / 44.14 % | 5 | 20 | 0.1 | 3.09 | 1.20 | 37.8 % | 71.01 / 29 % (shutdown) |
| B long_flat L5 | -3.56 % | 49.95 % | 2018-09-06T00 | -5.73 % / 2022-02 | -3.23 % / 50.17 % | 4 | 25 | 0.16 | 4.5 | 1.58 | 9.4 % | 75.25 / 26.08 % (shutdown) |
| B long_short L1.1 | -3.39 % | 26.44 % | 2018-06-03T08 | -6.18 % / 2022-11 | -3.28 % / 26.41 % | 7 | 0 | 0 | 0.92 | 0.48 | 8.1 % | 113.16 / 12.78 % |
| B long_short L2 | -3.4 % | 27.65 % | 2018-04-13T12 | -5.98 % / 2022-11 | -3.29 % / 28.31 % | 2 | 0 | 0 | 0.19 | 0.26 | 6.4 % | 121.7 / 22.34 % |
| B long_short L3 | -2.98 % | 30.91 % | 2018-04-12T11 | -6.16 % / 2022-05 | -2.79 % / 30.53 % | 2 | 0 | 0 | 0.24 | 0.40 | 5.5 % | 71.01 / 29 % (shutdown) |
| B long_short L5 | -5.05 % | 40.25 % | 2018-04-12T11 | -6.53 % / 2022-04 | -4.74 % / 39.13 % | 2 | 0 | 0 | 0.41 | 0.66 | 6.8 % | 75.25 / 26.08 % (shutdown) |

## Rolling net returns, DEV-2 conservative, research mode without the shutdown: median / worst (%)

| Candidate | 7 days | 14 days | 30 days | 91 days |
|---|---|---|---|---|
| A long_flat L1.1 | 0 / -12.55 | 0 / -15.01 | -1.07 / -18.78 | -3.36 / -23.29 |
| A long_flat L2 | 0 / -21.14 | -0.3 / -22.14 | -2.03 / -28.39 | -6.17 / -37.37 |
| A long_flat L3 | 0 / -28.89 | 0 / -30.75 | -2.38 / -36.43 | -6.91 / -49.23 |
| A long_flat L5 | 0 / -46.49 | 0 / -47.93 | -3.83 / -56.24 | -11.73 / -68.68 |
| A long_short L1.1 | 0 / -14.99 | 0 / -18.47 | -0.58 / -22.53 | -3.26 / -26.96 |
| A long_short L2 | 0 / -31.11 | 0 / -35.43 | 0 / -42.73 | 0 / -48.06 |
| A long_short L3 | 0 / -28.24 | 0 / -29.89 | 0 / -40.27 | 0 / -57.14 |
| A long_short L5 | 0 / -40.8 | 0 / -43.08 | 0 / -51.7 | 0 / -69.12 |
| B long_flat L1.1 | 0 / -32.85 | 0 / -35.11 | -0.21 / -35.35 | -4.14 / -45.93 |
| B long_flat L2 | 0 / -53.58 | 0 / -53.94 | -0.18 / -53.94 | -6.8 / -67.08 |
| B long_flat L3 | 0 / -56.56 | 0 / -59.55 | -0.12 / -61.41 | -10.77 / -73.27 |
| B long_flat L5 | 0 / -44.34 | 0 / -39.5 | 0 / -48.28 | 0 / -72.55 |
| B long_short L1.1 | 0 / -26.42 | 0 / -27.66 | 0 / -35.4 | 0 / -42.76 |
| B long_short L2 | 0 / -27.19 | 0 / -31.13 | 0 / -36.43 | 0 / -55.87 |
| B long_short L3 | 0 / -44.39 | 0 / -49.49 | 0 / -49.49 | 0 / -63.21 |
| B long_short L5 | 0 / -44.35 | 0 / -44.73 | 0 / -48.57 | 0 / -67.02 |

## Per-asset CAGR, DEV-2 conservative (each asset alone, one-third sleeve)

| Candidate | BTC | ETH | SOL |
|---|---|---|---|
| A long_flat L1.1 | -0.43 % | 1.17 % | 1.57 % |
| A long_flat L2 | 1.12 % | 4.36 % | 6.05 % |
| A long_flat L3 | 4.28 % | 8.23 % | 8.9 % |
| A long_flat L5 | -3.54 % | 12.45 % | 9.73 % |
| A long_short L1.1 | -3.37 % | -3.37 % | 0.62 % |
| A long_short L2 | -3.61 % | -3.35 % | -3.3 % |
| A long_short L3 | -3.39 % | -3.4 % | -3.54 % |
| A long_short L5 | -3.4 % | -3.27 % | -2.86 % |
| B long_flat L1.1 | -0.45 % | 1.28 % | 5.6 % |
| B long_flat L2 | -3.43 % | -2.96 % | 12.63 % |
| B long_flat L3 | -3.35 % | -3.26 % | 16.95 % |
| B long_flat L5 | -3.13 % | -3.34 % | 23.47 % |
| B long_short L1.1 | -3.41 % | -3.42 % | 0 % |
| B long_short L2 | -3.98 % | -3.36 % | 2.23 % |
| B long_short L3 | -3.34 % | -3.34 % | 7.25 % |
| B long_short L5 | -3.37 % | -3.35 % | -3.44 % |

## Shutdown overshoot

The $75 shutdown triggered in 66 of 96 DEV runs. Lowest equity reached: $64.34. Runs that ended below $75: 44.
Liquidations in all DEV runs: 0. Stops fired: 440; stop failures (retried): 22. Decisions skipped by the $10 minimum collateral: 31824.
