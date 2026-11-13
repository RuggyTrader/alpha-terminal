# Research tables — 2026-11-12

RESEARCH. RESEARCH — original profiles unchanged; fee rates other than 0.20% are hypothetical scenarios, not available offers.

Window 2026-11-01T00:00:00.000Z → 2026-11-12T00:00:00.000Z, with real Kraken 1m candles (warm-up from 2026-10-29, which is converged; see parity-convergence). The 5m bots use candles aggregated from 1m. Reference trades are the exact original-profile trades with TradingView semantics, $10 risk and no capital limit.

## 1. Trade economics per bot at the official Ndax 0.20% per fill (reference trades)

| Bot | Side | Trades | Entry notional | Exit notional | Avg notional | Gross | Fees | Net | Avg gross/trade | Avg net/trade | Avg win | Avg loss | Win rate | Avg move % | Median move % | Avg stop % | Avg target % | Avg hold (min) | Break-even fee/fill % | Break-even round trip % | Fees ÷ gross | Fee ÷ planned risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ALPHA-01 | all | 114 | 573585.46 | 573711.33 | 5031.45 | 375.31 | 2294.59 | -1919.29 | 3.29 | -16.84 | 16.14 | -9.39 | 44% | 0.0732 | 0.0000 | 0.2737 | 1.1246 | 28.40 | 0.0327 | 0.0654 | 6.11 | 2.01 |
| ALPHA-01 | LONG | 62 | 305963.58 | 306214.17 | 4934.90 | 250.59 | 1224.36 | -973.77 | 4.04 | -15.71 | 17.51 | -9.26 | 44% | 0.0993 | 0.0000 | 0.2818 | 1.1605 | 30.16 | 0.0409 | 0.0819 | 4.89 | 1.97 |
| ALPHA-01 | SHORT | 52 | 267621.88 | 267497.16 | 5146.57 | 124.72 | 1070.24 | -945.52 | 2.40 | -18.18 | 14.54 | -9.53 | 44% | 0.0421 | 0.0000 | 0.2636 | 1.0802 | 26.31 | 0.0233 | 0.0466 | 8.58 | 2.06 |
| ALPHA-02 | all | 47 | 170686.71 | 170601.07 | 3631.63 | 120.21 | 682.58 | -562.37 | 2.56 | -11.97 | 12.09 | -6.45 | 40% | 0.1034 | 0.0000 | 0.3578 | 0.5188 | 36.60 | 0.0352 | 0.0704 | 5.68 | 1.45 |
| ALPHA-02 | LONG | 18 | 69188.86 | 69206.14 | 3843.83 | 17.28 | 276.79 | -259.51 | 0.96 | -14.42 | 10.59 | -6.61 | 33% | 0.0636 | 0.0000 | 0.3147 | 0.4519 | 27.78 | 0.0125 | 0.0250 | 16.02 | 1.54 |
| ALPHA-02 | SHORT | 29 | 101497.86 | 101394.93 | 3499.93 | 102.93 | 405.79 | -302.86 | 3.55 | -10.44 | 12.79 | -6.33 | 45% | 0.1282 | 0.0000 | 0.3830 | 0.5581 | 42.07 | 0.0507 | 0.1015 | 3.94 | 1.40 |
| ALPHA-03 | all | 94 | 896946.61 | 896900.22 | 9541.99 | 314.60 | 3587.69 | -3273.09 | 3.35 | -34.82 | 15.86 | -9.07 | 48% | 0.0701 | 0.0000 | 0.1820 | 0.7347 | 35.56 | 0.0175 | 0.0351 | 11.40 | 3.82 |
| ALPHA-03 | LONG | 42 | 513226.37 | 513360.48 | 12219.68 | 134.11 | 2053.17 | -1919.07 | 3.19 | -45.69 | 17.09 | -9.53 | 45% | 0.0526 | 0.0000 | 0.1376 | 0.5560 | 35.17 | 0.0131 | 0.0261 | 15.31 | 4.89 |
| ALPHA-03 | SHORT | 52 | 383720.24 | 383539.74 | 7379.24 | 180.50 | 1534.52 | -1354.02 | 3.47 | -26.04 | 14.96 | -8.69 | 50% | 0.0842 | 0.0086 | 0.2179 | 0.8790 | 35.88 | 0.0235 | 0.0470 | 8.50 | 2.95 |
| ALPHA-04 | all | 30 | 140231.39 | 140202.88 | 4674.38 | 179.11 | 560.87 | -381.75 | 5.97 | -12.73 | 16.25 | -6.22 | 53% | 0.1453 | 0.0113 | 0.2840 | 0.8231 | 61.17 | 0.0639 | 0.1277 | 3.13 | 1.87 |
| ALPHA-04 | LONG | 13 | 61764.49 | 61839.79 | 4751.11 | 75.30 | 247.21 | -171.90 | 5.79 | -13.22 | 12.84 | -5.48 | 62% | 0.1242 | 0.0221 | 0.2515 | 0.7289 | 41.54 | 0.0609 | 0.1218 | 3.28 | 1.90 |
| ALPHA-04 | SHORT | 17 | 78466.90 | 78363.09 | 4615.70 | 103.81 | 313.66 | -209.85 | 6.11 | -12.34 | 19.66 | -6.68 | 47% | 0.1614 | 0.0000 | 0.3104 | 0.8997 | 76.18 | 0.0662 | 0.1324 | 3.02 | 1.85 |

## 2. Fee sensitivity (reference trades; rates other than 0.20% are hypothetical research scenarios, not offers)

### ALPHA-01 (SOLUSD 1m)

| Fee per fill | Trades | Gross | Fees | Net | Net PF | Max DD (net) | Net expectancy |
|---|---|---|---|---|---|---|---|
| 0% | 114 | 375.31 | 0.00 | 375.31 | 1.87 | 136.73 | 3.29 |
| 0.01% | 114 | 375.31 | 114.73 | 260.58 | 1.52 | 168.46 | 2.29 |
| 0.02% | 114 | 375.31 | 229.46 | 145.85 | 1.25 | 200.19 | 1.28 |
| 0.05% | 114 | 375.31 | 573.65 | -198.34 | 0.75 | 361.85 | -1.74 |
| 0.1% | 114 | 375.31 | 1147.30 | -771.99 | 0.38 | 799.54 | -6.77 |
| 0.15% | 114 | 375.31 | 1720.95 | -1345.64 | 0.20 | 1347.50 | -11.80 |
| 0.2% | 114 | 375.31 | 2294.59 | -1919.29 | 0.11 | 1919.29 | -16.84 |

### ALPHA-02 (SOLUSD 5m)

| Fee per fill | Trades | Gross | Fees | Net | Net PF | Max DD (net) | Net expectancy |
|---|---|---|---|---|---|---|---|
| 0% | 47 | 120.21 | 0.00 | 120.21 | 2.10 | 21.95 | 2.56 |
| 0.01% | 47 | 120.21 | 34.13 | 86.08 | 1.65 | 34.61 | 1.83 |
| 0.02% | 47 | 120.21 | 68.26 | 51.95 | 1.34 | 49.59 | 1.11 |
| 0.05% | 47 | 120.21 | 170.64 | -50.43 | 0.77 | 98.11 | -1.07 |
| 0.1% | 47 | 120.21 | 341.29 | -221.08 | 0.35 | 225.75 | -4.70 |
| 0.15% | 47 | 120.21 | 511.93 | -391.72 | 0.16 | 391.72 | -8.33 |
| 0.2% | 47 | 120.21 | 682.58 | -562.37 | 0.07 | 562.37 | -11.97 |

### ALPHA-03 (BTCUSD 1m)

| Fee per fill | Trades | Gross | Fees | Net | Net PF | Max DD (net) | Net expectancy |
|---|---|---|---|---|---|---|---|
| 0% | 94 | 314.60 | 0.00 | 314.60 | 1.79 | 59.07 | 3.35 |
| 0.01% | 94 | 314.60 | 179.38 | 135.22 | 1.27 | 93.01 | 1.44 |
| 0.02% | 94 | 314.60 | 358.77 | -44.17 | 0.93 | 151.20 | -0.47 |
| 0.05% | 94 | 314.60 | 896.92 | -582.32 | 0.43 | 582.32 | -6.19 |
| 0.1% | 94 | 314.60 | 1793.85 | -1479.24 | 0.16 | 1479.24 | -15.74 |
| 0.15% | 94 | 314.60 | 2690.77 | -2376.17 | 0.06 | 2376.17 | -25.28 |
| 0.2% | 94 | 314.60 | 3587.69 | -3273.09 | 0.03 | 3273.09 | -34.82 |

### ALPHA-04 (BTCUSD 5m)

| Fee per fill | Trades | Gross | Fees | Net | Net PF | Max DD (net) | Net expectancy |
|---|---|---|---|---|---|---|---|
| 0% | 30 | 179.11 | 0.00 | 179.11 | 3.21 | 21.74 | 5.97 |
| 0.01% | 30 | 179.11 | 28.04 | 151.07 | 2.56 | 26.97 | 5.04 |
| 0.02% | 30 | 179.11 | 56.09 | 123.03 | 2.09 | 34.77 | 4.10 |
| 0.05% | 30 | 179.11 | 140.22 | 38.90 | 1.24 | 58.29 | 1.30 |
| 0.1% | 30 | 179.11 | 280.43 | -101.32 | 0.60 | 134.58 | -3.38 |
| 0.15% | 30 | 179.11 | 420.65 | -241.54 | 0.31 | 241.54 | -8.05 |
| 0.2% | 30 | 179.11 | 560.87 | -381.75 | 0.15 | 381.75 | -12.73 |

## 3. Funded PAPER: each bot ALONE in its own wallet, by allocation (production-style wallet, reduce-to-fit, fees per fill, profit sweep)

Net P&L in USD by per-fill fee (columns). The 0.20% column is the official benchmark; the others are research only.

### ALPHA-01

| Allocation | net @0% | net @0.01% | net @0.02% | net @0.05% | net @0.1% | net @0.15% | net @0.2% | trades @0.20 | fees @0.20 | return @0.20 | max DD @0.20 | PF @0.20 | swept to MAIN @0.20 | skipped @0.20 | reduced-to-fit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| $5 | 0.42 | 0.31 | 0.17 | -0.13 | -0.46 | -0.58 | -0.70 | 44 | 0.80 | -13.91% | 0.71 | 0.16 | 0.14 | BELOW_MIN_QTY:298 | 0 |
| $10 | 0.81 | 0.59 | 0.37 | -0.27 | -1.27 | -2.19 | -3.02 | 114 | 3.66 | -30.25% | 3.02 | 0.14 | 0.48 | BELOW_MIN_QTY:3 | 0 |
| $25 | 2.03 | 1.48 | 0.93 | -0.67 | -3.18 | -5.48 | -7.56 | 114 | 9.15 | -30.25% | 7.56 | 0.14 | 1.19 | BELOW_MIN_QTY:3 | 0 |
| $50 | 4.07 | 2.95 | 1.86 | -1.35 | -6.37 | -10.96 | -15.12 | 114 | 18.30 | -30.25% | 15.12 | 0.14 | 2.38 | BELOW_MIN_QTY:3 | 0 |
| $100 | 8.13 | 5.91 | 3.71 | -2.70 | -12.73 | -21.93 | -30.25 | 114 | 36.60 | -30.25% | 30.25 | 0.14 | 4.77 | BELOW_MIN_QTY:3 | 0 |
| $500 | 40.66 | 29.55 | 18.56 | -13.49 | -63.67 | -109.63 | -151.23 | 114 | 182.99 | -30.25% | 151.23 | 0.14 | 23.85 | BELOW_MIN_QTY:3 | 0 |
| $1000 | 81.32 | 59.09 | 37.13 | -26.99 | -127.33 | -219.26 | -302.46 | 114 | 365.99 | -30.25% | 302.46 | 0.14 | 47.69 | BELOW_MIN_QTY:3 | 0 |

Slippage/spread scenarios at 0.20% (research): net by slippage per side.

| Allocation | slip 0%/side | slip 0.02%/side | slip 0.05%/side | slip 0.1%/side |
|---|---|---|---|---|
| $5 | -0.70 | -0.68 | -0.75 | -0.79 |
| $10 | -3.02 | -3.33 | -3.78 | -4.45 |
| $25 | -7.56 | -8.34 | -9.44 | -11.13 |
| $50 | -15.12 | -16.67 | -18.88 | -22.26 |
| $100 | -30.25 | -33.35 | -37.76 | -44.52 |
| $500 | -151.23 | -166.74 | -188.82 | -222.58 |
| $1000 | -302.46 | -333.48 | -377.64 | -445.15 |

### ALPHA-02

| Allocation | net @0% | net @0.01% | net @0.02% | net @0.05% | net @0.1% | net @0.15% | net @0.2% | trades @0.20 | fees @0.20 | return @0.20 | max DD @0.20 | PF @0.20 | swept to MAIN @0.20 | skipped @0.20 | reduced-to-fit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| $5 | 0.33 | 0.28 | 0.24 | 0.10 | -0.13 | -0.35 | -0.50 | 44 | 0.82 | -10.08% | 0.51 | 0.20 | 0.13 | BELOW_MIN_QTY:17 | 0 |
| $10 | 0.66 | 0.56 | 0.47 | 0.19 | -0.26 | -0.70 | -1.12 | 47 | 1.73 | -11.20% | 1.14 | 0.18 | 0.25 | BELOW_MIN_QTY:1 | 0 |
| $25 | 1.64 | 1.41 | 1.18 | 0.48 | -0.65 | -1.74 | -2.80 | 47 | 4.33 | -11.20% | 2.85 | 0.18 | 0.63 | BELOW_MIN_QTY:1 | 0 |
| $50 | 3.28 | 2.82 | 2.35 | 0.97 | -1.29 | -3.48 | -5.60 | 47 | 8.67 | -11.20% | 5.70 | 0.18 | 1.25 | BELOW_MIN_QTY:1 | 0 |
| $100 | 6.57 | 5.63 | 4.70 | 1.93 | -2.59 | -6.97 | -11.20 | 47 | 17.34 | -11.20% | 11.41 | 0.18 | 2.50 | BELOW_MIN_QTY:1 | 0 |
| $500 | 32.83 | 28.16 | 23.51 | 9.67 | -12.93 | -34.85 | -56.01 | 47 | 86.68 | -11.20% | 57.05 | 0.18 | 12.51 | BELOW_MIN_QTY:1 | 0 |
| $1000 | 63.67 | 54.41 | 45.18 | 17.75 | -27.09 | -70.59 | -112.62 | 47 | 172.67 | -11.26% | 114.71 | 0.18 | 24.41 | BELOW_MIN_QTY:1 | 0 |

Slippage/spread scenarios at 0.20% (research): net by slippage per side.

| Allocation | slip 0%/side | slip 0.02%/side | slip 0.05%/side | slip 0.1%/side |
|---|---|---|---|---|
| $5 | -0.50 | -0.55 | -0.61 | -0.69 |
| $10 | -1.12 | -1.29 | -1.53 | -1.92 |
| $25 | -2.80 | -3.21 | -3.82 | -4.80 |
| $50 | -5.60 | -6.43 | -7.64 | -9.60 |
| $100 | -11.20 | -12.85 | -15.28 | -19.19 |
| $500 | -56.01 | -64.26 | -76.39 | -95.97 |
| $1000 | -112.62 | -129.02 | -153.16 | -192.13 |

### ALPHA-03

| Allocation | net @0% | net @0.01% | net @0.02% | net @0.05% | net @0.1% | net @0.15% | net @0.2% | trades @0.20 | fees @0.20 | return @0.20 | max DD @0.20 | PF @0.20 | swept to MAIN @0.20 | skipped @0.20 | reduced-to-fit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| $5 | 0.31 | 0.22 | 0.12 | -0.14 | -0.38 | -0.55 | -0.58 | 30 | 0.56 | -11.69% | 0.58 | 0.00 | 0.00 | BELOW_MIN_QTY:280 | 0 |
| $10 | 0.62 | 0.43 | 0.25 | -0.30 | -1.16 | -1.96 | -2.70 | 96 | 3.26 | -27.01% | 2.70 | 0.08 | 0.24 | BELOW_MIN_QTY:3 | 0 |
| $25 | 1.56 | 1.09 | 0.62 | -0.74 | -2.90 | -4.91 | -6.75 | 96 | 8.14 | -27.01% | 6.75 | 0.08 | 0.59 | BELOW_MIN_QTY:3 | 0 |
| $50 | 3.12 | 2.17 | 1.24 | -1.48 | -5.80 | -9.82 | -13.50 | 96 | 16.29 | -27.01% | 13.50 | 0.08 | 1.18 | BELOW_MIN_QTY:3 | 0 |
| $100 | 6.23 | 4.35 | 2.49 | -2.97 | -11.61 | -19.64 | -27.01 | 96 | 32.58 | -27.01% | 27.01 | 0.08 | 2.36 | BELOW_MIN_QTY:3 | 0 |
| $500 | 31.15 | 21.74 | 12.44 | -14.83 | -58.03 | -98.19 | -135.04 | 96 | 162.89 | -27.01% | 135.04 | 0.08 | 11.82 | BELOW_MIN_QTY:3 | 0 |
| $1000 | 62.31 | 43.49 | 24.88 | -29.67 | -116.06 | -196.37 | -270.08 | 96 | 325.77 | -27.01% | 270.08 | 0.08 | 23.64 | BELOW_MIN_QTY:3 | 0 |

Slippage/spread scenarios at 0.20% (research): net by slippage per side.

| Allocation | slip 0%/side | slip 0.02%/side | slip 0.05%/side | slip 0.1%/side |
|---|---|---|---|---|
| $5 | -0.58 | -0.57 | -0.59 | -0.57 |
| $10 | -2.70 | -2.98 | -3.37 | -3.98 |
| $25 | -6.75 | -7.44 | -8.43 | -9.94 |
| $50 | -13.50 | -14.89 | -16.86 | -19.89 |
| $100 | -27.01 | -29.78 | -33.71 | -39.77 |
| $500 | -135.04 | -148.88 | -168.56 | -198.87 |
| $1000 | -270.08 | -297.76 | -337.11 | -397.73 |

### ALPHA-04

| Allocation | net @0% | net @0.01% | net @0.02% | net @0.05% | net @0.1% | net @0.15% | net @0.2% | trades @0.20 | fees @0.20 | return @0.20 | max DD @0.20 | PF @0.20 | swept to MAIN @0.20 | skipped @0.20 | reduced-to-fit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| $5 | 0.10 | 0.07 | 0.04 | -0.05 | -0.19 | -0.31 | -0.44 | 28 | 0.53 | -8.79% | 0.44 | 0.12 | 0.06 | BELOW_MIN_QTY:6 | 0 |
| $10 | 0.19 | 0.14 | 0.08 | -0.10 | -0.39 | -0.67 | -0.94 | 30 | 1.13 | -9.42% | 0.94 | 0.11 | 0.12 | – | 0 |
| $25 | 0.49 | 0.34 | 0.19 | -0.25 | -0.97 | -1.67 | -2.35 | 30 | 2.82 | -9.42% | 2.35 | 0.11 | 0.30 | – | 0 |
| $50 | 0.97 | 0.68 | 0.38 | -0.50 | -1.93 | -3.34 | -4.71 | 30 | 5.63 | -9.42% | 4.71 | 0.11 | 0.59 | – | 0 |
| $100 | 1.94 | 1.35 | 0.76 | -0.99 | -3.86 | -6.68 | -9.42 | 30 | 11.27 | -9.42% | 9.42 | 0.11 | 1.18 | – | 0 |
| $500 | 9.72 | 6.76 | 3.81 | -4.96 | -19.32 | -33.38 | -47.10 | 30 | 56.33 | -9.42% | 47.10 | 0.11 | 5.91 | – | 0 |
| $1000 | 19.43 | 13.52 | 7.62 | -9.92 | -38.64 | -66.76 | -94.20 | 30 | 112.66 | -9.42% | 94.20 | 0.11 | 11.82 | – | 0 |

Slippage/spread scenarios at 0.20% (research): net by slippage per side.

| Allocation | slip 0%/side | slip 0.02%/side | slip 0.05%/side | slip 0.1%/side |
|---|---|---|---|---|
| $5 | -0.44 | -0.49 | -0.54 | -0.55 |
| $10 | -0.94 | -1.05 | -1.21 | -1.47 |
| $25 | -2.35 | -2.63 | -3.03 | -3.68 |
| $50 | -4.71 | -5.25 | -6.05 | -7.35 |
| $100 | -9.42 | -10.50 | -12.10 | -14.71 |
| $500 | -47.10 | -52.50 | -60.50 | -73.55 |
| $1000 | -94.20 | -105.01 | -121.00 | -147.09 |

## 4. Combined fleet (all four bots at once, equal allocation per bot, 0.20% per fill)

| Per bot | Slippage/side | Combined net | Fees | Swept to MAIN | MAIN at end | Peak concurrent | Reconciles | ALPHA-01 net (L/S) | ALPHA-02 net (L/S) | ALPHA-03 net (L/S) | ALPHA-04 net (L/S) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| $5 | 0% | -2.22 | 2.71 | 0.32 | 0.32 | 4 | true | -0.70 (28/16) | -0.50 (16/28) | -0.58 (16/14) | -0.44 (12/16) |
| $5 | 0.05% | -2.48 | 2.31 | 0.20 | 0.20 | 4 | true | -0.75 (22/15) | -0.61 (15/22) | -0.59 (13/11) | -0.54 (12/15) |
| $10 | 0% | -7.79 | 9.78 | 1.08 | 1.08 | 4 | true | -3.02 (62/52) | -1.12 (18/29) | -2.70 (42/54) | -0.94 (13/17) |
| $10 | 0.05% | -9.89 | 9.44 | 0.71 | 0.71 | 4 | true | -3.78 (62/52) | -1.53 (18/29) | -3.37 (42/54) | -1.21 (13/17) |
| $25 | 0% | -19.47 | 24.44 | 2.70 | 2.70 | 4 | true | -7.56 (62/52) | -2.80 (18/29) | -6.75 (42/54) | -2.35 (13/17) |
| $25 | 0.05% | -24.71 | 23.59 | 1.78 | 1.78 | 4 | true | -9.44 (62/52) | -3.82 (18/29) | -8.43 (42/54) | -3.03 (13/17) |
| $50 | 0% | -38.94 | 48.89 | 5.41 | 5.41 | 4 | true | -15.12 (62/52) | -5.60 (18/29) | -13.50 (42/54) | -4.71 (13/17) |
| $50 | 0.05% | -49.43 | 47.19 | 3.57 | 3.57 | 4 | true | -18.88 (62/52) | -7.64 (18/29) | -16.86 (42/54) | -6.05 (13/17) |
| $100 | 0% | -77.88 | 97.78 | 10.82 | 10.82 | 4 | true | -30.25 (62/52) | -11.20 (18/29) | -27.01 (42/54) | -9.42 (13/17) |
| $100 | 0.05% | -98.85 | 94.38 | 7.13 | 7.13 | 4 | true | -37.76 (62/52) | -15.28 (18/29) | -33.71 (42/54) | -12.10 (13/17) |
| $500 | 0% | -389.38 | 488.89 | 54.08 | 54.08 | 4 | true | -151.23 (62/52) | -56.01 (18/29) | -135.04 (42/54) | -47.10 (13/17) |
| $500 | 0.05% | -494.27 | 471.88 | 35.65 | 35.65 | 4 | true | -188.82 (62/52) | -76.39 (18/29) | -168.56 (42/54) | -60.50 (13/17) |
| $1000 | 0% | -779.37 | 977.10 | 107.56 | 107.56 | 4 | true | -302.46 (62/52) | -112.62 (18/29) | -270.08 (42/54) | -94.20 (13/17) |
| $1000 | 0.05% | -988.91 | 943.18 | 70.94 | 70.94 | 4 | true | -377.64 (62/52) | -153.16 (18/29) | -337.11 (42/54) | -121.00 (13/17) |

## 5. ALPHA-02 SOL 5m, 150 days: exact break-even commission

Window 2026-06-12T00:00:00.000Z → 2026-11-08T23:55:00.000Z.

| Side | Trades | Gross | Entry notional | Exit notional | Break-even fee per fill | Break-even round trip |
|---|---|---|---|---|---|---|
| all | 579 | 150.24 | 2043897.11 | 2044208.82 | 0.0037% | 0.0074% |
| LONG | 308 | 230.97 | 1062148.93 | 1062379.90 | 0.0109% | 0.0217% |
| SHORT | 271 | -80.73 | 981748.18 | 981828.92 | -0.0041% | -0.0082% |

| Fee per fill | Net | Net PF | Max DD |
|---|---|---|---|
| 0% | 150.24 | 1.08 | 225.97 |
| 0.01% | -258.57 | 0.88 | 480.88 |
| 0.02% | -667.38 | 0.73 | 817.39 |
| 0.05% | -1893.81 | 0.44 | 1894.42 |
| 0.1% | -3937.87 | 0.20 | 3937.87 |
| 0.15% | -5981.92 | 0.10 | 5981.92 |
| 0.2% | -8025.97 | 0.05 | 8025.97 |

## 6. RESEARCH variants (separate ids; the original profiles are unchanged)

IS = in-sample, OOS = out-of-sample. A variant is chosen on IS only; OOS is reported, never used to choose.

### solusd-5m (5m) — data 2026-06-12T00:00:00.000Z → 2026-11-08T23:55:00.000Z

IS 2026-06-12T00:00:00.000Z → 2026-09-20T00:00:00.000Z · OOS 2026-09-20T00:00:00.000Z → 2026-11-08T23:55:00.000Z

| Variant | IS trades | IS gross (0%) | IS net @0.20 | OOS trades | OOS gross (0%) | OOS net @0.20 | OOS break-even fee/fill | Verdict |
|---|---|---|---|---|---|---|---|---|
| RESEARCH-ORIG | 394 | -112.01 | -5866.67 | 185 | 262.25 | -2159.30 | 0.0217% | control (original) |
| RESEARCH-TF15 | 107 | -85.01 | -916.54 | 59 | -89.57 | -510.97 | -0.0425% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-TF30 | 50 | -9.86 | -256.92 | 33 | -40.38 | -199.65 | -0.0507% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOBE | 384 | -178.25 | -5721.27 | 186 | 231.87 | -2200.00 | 0.0191% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOTRAIL | 372 | -219.68 | -5558.53 | 177 | 246.41 | -2085.75 | 0.0211% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOBE-NOTRAIL | 351 | -403.55 | -5389.77 | 173 | 86.08 | -2173.71 | 0.0076% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-LATEBE | 386 | -92.05 | -5713.23 | 186 | 280.94 | -2148.50 | 0.0231% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINTP-0.6 | 121 | 93.29 | -742.41 | 67 | 31.70 | -463.37 | 0.0128% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINTP-1.0 | 34 | 96.55 | -60.45 | 13 | 15.79 | -42.83 | 0.0539% | INSUFFICIENT SAMPLE (34 in-sample / 13 out-of-sample trades): no conclusion |
| RESEARCH-MINSTOP-0.5 | 77 | 181.93 | -261.32 | 35 | 23.60 | -189.45 | 0.0222% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |

| Month | Change % | Mean bar range % | Trend | Volatility | Original gross | Original net @0.20 |
|---|---|---|---|---|---|---|
| 2026-06 | 10.02 | 0.2585 | TRENDING | HIGH | 1.73 | -598.38 |
| 2026-07 | -1.06 | 0.1750 | RANGING | LOW | -84.58 | -2358.35 |
| 2026-08 | 41.58 | 0.1959 | TRENDING | LOW | 27.35 | -2137.05 |
| 2026-09 | 14.58 | 0.2339 | TRENDING | HIGH | -78.27 | -1223.21 |
| 2026-10 | -19.27 | 0.2060 | TRENDING | LOW | 176.05 | -1234.74 |
| 2026-11 | -9.31 | 0.2200 | RANGING | LOW | 107.96 | -474.23 |

### btcusd-5m (5m) — data 2026-09-11T00:00:00.000Z → 2026-11-11T23:55:00.000Z

IS 2026-09-11T00:00:00.000Z → 2026-11-04T00:00:00.000Z · OOS 2026-11-04T00:00:00.000Z → 2026-11-11T23:55:00.000Z

| Variant | IS trades | IS gross (0%) | IS net @0.20 | OOS trades | OOS gross (0%) | OOS net @0.20 | OOS break-even fee/fill | Verdict |
|---|---|---|---|---|---|---|---|---|
| RESEARCH-ORIG | 105 | 352.55 | -2064.81 | 22 | 121.26 | -252.88 | 0.0648% | control (original) |
| RESEARCH-TF15 | 33 | -134.25 | -489.21 | 3 | -1.64 | -33.15 | -0.0104% | INSUFFICIENT SAMPLE (33 in-sample / 3 out-of-sample trades): no conclusion |
| RESEARCH-TF30 | 14 | -2.95 | -92.31 | 3 | 2.05 | -24.93 | 0.0152% | INSUFFICIENT SAMPLE (14 in-sample / 3 out-of-sample trades): no conclusion |
| RESEARCH-NOBE | 104 | 363.87 | -1997.51 | 22 | 120.67 | -253.47 | 0.0645% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOTRAIL | 91 | 333.76 | -1724.12 | 18 | 55.92 | -232.16 | 0.0388% | INSUFFICIENT SAMPLE (91 in-sample / 18 out-of-sample trades): no conclusion |
| RESEARCH-NOBE-NOTRAIL | 82 | 271.72 | -1477.41 | 13 | -13.06 | -206.76 | -0.0135% | INSUFFICIENT SAMPLE (82 in-sample / 13 out-of-sample trades): no conclusion |
| RESEARCH-LATEBE | 105 | 381.53 | -2035.88 | 22 | 120.67 | -253.47 | 0.0645% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINTP-0.6 | 57 | 273.56 | -432.08 | 14 | -11.12 | -173.84 | -0.0137% | INSUFFICIENT SAMPLE (57 in-sample / 14 out-of-sample trades): no conclusion |
| RESEARCH-MINTP-1.0 | 26 | 101.74 | -126.21 | 6 | 5.16 | -41.86 | 0.0219% | INSUFFICIENT SAMPLE (26 in-sample / 6 out-of-sample trades): no conclusion |
| RESEARCH-MINSTOP-0.5 | 10 | 21.58 | -44.40 | 3 | 9.67 | -8.86 | 0.1044% | INSUFFICIENT SAMPLE (10 in-sample / 3 out-of-sample trades): no conclusion |

| Month | Change % | Mean bar range % | Trend | Volatility | Original gross | Original net @0.20 |
|---|---|---|---|---|---|---|
| 2026-09 | 9.17 | 0.1307 | RANGING | LOW | 114.42 | -781.58 |
| 2026-10 | -7.33 | 0.1159 | RANGING | LOW | 180.27 | -1154.35 |
| 2026-11 | -4.53 | 0.1398 | RANGING | HIGH | 179.11 | -381.75 |

### btcusd-1m (1m) — data 2026-09-11T00:00:00.000Z → 2026-11-11T23:59:00.000Z

IS 2026-09-11T00:00:00.000Z → 2026-11-04T00:00:00.000Z · OOS 2026-11-04T00:00:00.000Z → 2026-11-11T23:59:00.000Z

| Variant | IS trades | IS gross (0%) | IS net @0.20 | OOS trades | OOS gross (0%) | OOS net @0.20 | OOS break-even fee/fill | Verdict |
|---|---|---|---|---|---|---|---|---|
| RESEARCH-ORIG | 476 | -169.42 | -20534.81 | 68 | 189.59 | -2346.77 | 0.0149% | control (original) |
| RESEARCH-TF15 | 28 | 51.39 | -201.90 | 2 | 47.77 | 29.93 | 0.5356% | INSUFFICIENT SAMPLE (28 in-sample / 2 out-of-sample trades): no conclusion |
| RESEARCH-TF30 | 12 | 101.39 | 50.40 | 4 | -29.18 | -54.29 | -0.2325% | INSUFFICIENT SAMPLE (12 in-sample / 4 out-of-sample trades): no conclusion |
| RESEARCH-NOBE | 472 | -83.80 | -20421.39 | 68 | 179.66 | -2356.68 | 0.0142% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOTRAIL | 334 | -192.77 | -12455.64 | 33 | 62.49 | -601.12 | 0.0188% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOBE-NOTRAIL | 266 | -201.68 | -9245.37 | 12 | 81.09 | -163.08 | 0.0664% | INSUFFICIENT SAMPLE (266 in-sample / 12 out-of-sample trades): no conclusion |
| RESEARCH-LATEBE | 472 | -166.65 | -20416.99 | 68 | 181.51 | -2354.82 | 0.0143% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINTP-0.6 | 178 | 11.16 | -3241.11 | 36 | 143.92 | -444.54 | 0.0489% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINTP-1.0 | 60 | 37.07 | -659.81 | 19 | 25.11 | -200.75 | 0.0222% | INSUFFICIENT SAMPLE (60 in-sample / 19 out-of-sample trades): no conclusion |
| RESEARCH-MINSTOP-0.5 | 9 | 44.10 | -13.18 | 4 | 54.25 | 28.52 | 0.4216% | INSUFFICIENT SAMPLE (9 in-sample / 4 out-of-sample trades): no conclusion |

| Month | Change % | Mean bar range % | Trend | Volatility | Original gross | Original net @0.20 |
|---|---|---|---|---|---|---|
| 2026-09 | 9.17 | 0.0475 | RANGING | LOW | -60.88 | -7846.57 |
| 2026-10 | -7.33 | 0.0418 | RANGING | LOW | -233.56 | -11761.92 |
| 2026-11 | -4.53 | 0.0514 | RANGING | HIGH | 314.60 | -3273.09 |

### solusd-1m (1m) — data 2026-10-01T00:00:00.000Z → 2026-11-11T23:59:00.000Z

IS 2026-10-01T00:00:00.000Z → 2026-10-28T00:00:00.000Z · OOS 2026-10-28T00:00:00.000Z → 2026-11-11T23:59:00.000Z

| Variant | IS trades | IS gross (0%) | IS net @0.20 | OOS trades | OOS gross (0%) | OOS net @0.20 | OOS break-even fee/fill | Verdict |
|---|---|---|---|---|---|---|---|---|
| RESEARCH-ORIG | 292 | -377.47 | -7679.04 | 142 | 486.59 | -2483.67 | 0.0328% | control (original) |
| RESEARCH-TF15 | 18 | -17.18 | -120.03 | 8 | 8.06 | -32.07 | 0.0402% | INSUFFICIENT SAMPLE (18 in-sample / 8 out-of-sample trades): no conclusion |
| RESEARCH-TF30 | 11 | -59.26 | -99.29 | 3 | -10.22 | -17.17 | -0.2941% | INSUFFICIENT SAMPLE (11 in-sample / 3 out-of-sample trades): no conclusion |
| RESEARCH-NOBE | 292 | -421.26 | -7722.93 | 141 | 345.60 | -2625.31 | 0.0233% | NOT BETTER IN-SAMPLE |
| RESEARCH-NOTRAIL | 237 | -379.43 | -6280.00 | 127 | 458.95 | -2189.28 | 0.0347% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-NOBE-NOTRAIL | 178 | -349.31 | -4616.43 | 92 | 248.46 | -1540.10 | 0.0278% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-LATEBE | 292 | -418.37 | -7720.04 | 141 | 350.75 | -2620.16 | 0.0236% | NOT BETTER IN-SAMPLE |
| RESEARCH-MINTP-0.6 | 181 | -261.02 | -3290.96 | 103 | 454.98 | -1088.45 | 0.0590% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINTP-1.0 | 91 | -228.56 | -1329.82 | 64 | 262.70 | -466.62 | 0.0720% | IMPROVES IN-SAMPLE ONLY (mostly by trading less): still loses out-of-sample at 0.20% |
| RESEARCH-MINSTOP-0.5 | 9 | -35.52 | -87.58 | 11 | -33.37 | -102.26 | -0.0969% | INSUFFICIENT SAMPLE (9 in-sample / 11 out-of-sample trades): no conclusion |

| Month | Change % | Mean bar range % | Trend | Volatility | Original gross | Original net @0.20 |
|---|---|---|---|---|---|---|
| 2026-10 | -19.27 | 0.0768 | TRENDING | LOW | -266.18 | -8243.42 |
| 2026-11 | -12.72 | 0.0878 | TRENDING | LOW | 375.31 | -1919.29 |
