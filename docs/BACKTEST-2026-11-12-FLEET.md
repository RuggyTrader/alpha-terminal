# Fleet backtest — 2026-11-12

These are research results, not live trades. Every figure is computed from Kraken candles saved in `engine/data/`, which match Kraken OHLC with 0 mismatches. The figures run through the engine's own `onBar` code path. Nothing is invented. The raw outputs are `engine/runs/fleet-parity-2026-11/fleet-backtest.json` and `engine/runs/alpha02-sol5m-150d.json`. The `runs/` folder is git-ignored, so reproduce them with the commands below.

```
node src/cli/fleet-backtest.mjs --sol1 data/SOLUSD-1m-14d.json --btc1 data/BTCUSD-1m-11d.json --from 2026-11-01T00:00:00Z --to 2026-11-12T00:00:00Z --out runs/fleet-parity-2026-11
node src/cli/long-run.mjs   # ALPHA-02, SOL 5m, 150 days
```

Each bot uses its exact profile (`engine/profiles/*.env`) and $10 dollar risk. The 5m candles are aggregated from 1m.

## 1. Parity with TradingView (reference mirror: no fees, unlimited buying power)

| Bot | Ours: trades (L/S) · gross · PF · max DD | TradingView screenshot | Verdict |
|---|---|---|---|
| ALPHA-01 SOL 1m | 122 (65/56) · +$356.15 · 1.856 · $85.46 | +$382.50 · 2.033 · $61.80 | Close but **not exact**: −$26.35 gross |
| ALPHA-02 SOL 5m | 43 (18/25) · +$71.50 · 1.471 · $35.05 | no Nov 1–12 screenshot supplied | n/a |
| ALPHA-03 BTC 1m | 97 (45/52) · +$117.60 · 1.264 · $84.60 | +$374.65 · 1.945 · $67.21 | **Parity NOT achieved** |
| ALPHA-04 BTC 5m | 28 (13/15) · +$144.81 · 3.043 · $19.09 | not supplied (not invented) | n/a |

Known causes, not yet resolved:

- **BTC 1m:** our candle file starts at 2026-11-01 00:00, so it has no warm-up history before the window. TradingView computes on years of history, so pivots and open setups on 1 Nov differ.
- **BTC 1m:** the exact TradingView date range is not visible on the screenshot.
- **BTC 1m:** some BTC profile fields are documented as unverified in `btcusd-1m.env`.
- **SOL 1m:** the remaining gap is in the same direction: our data has 3 days of warm-up while TradingView has full history.

Next step: fetch BTC 1m candles from 2026-10-25 for warm-up, then get the owner's confirmation of the exact TradingView window and of the unverified fields.

## 2. Fees decide the outcome

Ndax's flat 0.20% per fill (0.40% per round trip) costs more than the strategy's average gross edge, on every bot and every timeframe tested:

| Bot | Mirror gross | Modelled net after 0.20%/fill |
|---|---|---|
| ALPHA-01 | +$356.15 | −$2,036.95 |
| ALPHA-02 | +$71.50 | −$546.13 |
| ALPHA-03 | +$117.60 | −$3,725.10 |
| ALPHA-04 | +$144.81 | −$358.34 |

The reason is position size. A $10 risk on a tight 1m stop means a notional of thousands of dollars. Over 150 days ALPHA-02's average notional was $3,454, which costs about $13.80 in fees per round trip against a $10 risk.

**Longer period, ALPHA-02 SOL 5m, 2026-06-12 → 2026-11-08 (43,188 candles):**
- 542 trades (287 L / 255 S), win rate 38%.
- Gross +$266.20, PF 1.122, max drawdown $232.16.
- Modelled fees $7,488.36, modelled net **−$7,222.16**.
- Monthly gross: Jun +8.29, Jul −85.74, Aug +101.85, Sep −23.53, Oct +156.90, Nov (to the 8th) +108.42.

No long 1m history exists locally; Kraken OHLC serves only 720 candles.

## 3. Funded PAPER (own wallet, $10 dollar risk capped by capital, Ndax 0.20%/fill, net profit swept to MAIN)

The table shows combined results for all four bots, 2026-11-01 → 11-12, with an equal allocation per bot. "Slip" means 0.05% adverse slippage per side.

| Per-bot allocation | Combined net | Fees | Swept to MAIN | Net with slip |
|---|---|---|---|---|
| $5 | −$2.35 | $2.49 | $0.23 | −$2.49 |
| $10 | −$8.45 | $9.72 | $0.94 | −$10.48 |
| $25 | −$21.11 | $24.30 | $2.34 | −$26.20 |
| $50 | −$42.23 | $48.61 | $4.68 | −$52.40 |
| $100 | −$84.46 | $97.21 | $9.35 | −$104.80 |
| $500 | −$422.28 | $486.07 | $46.77 | −$523.98 |
| $1,000 | −$845.14 | $971.47 | $92.95 | −$1,048.32 |

- **Every run reconciles:** wallet identity holds, and the sum of wallets plus MAIN equals the funding.
- **Profit is still swept on losing books:** net-positive trades are swept even when the bot is net negative overall, so MAIN receives profit while the bot wallet shrinks. This is the designed rule ("positive realized net profit swept to MAIN"), and the owner should know about it.
- **At $5 per bot, most signals are skipped** with `BELOW_MIN_QTY`: SOL 1m 310, BTC 1m 280. The bot cannot afford Kraken's minimum quantity at the stop distance.
- **ALPHA-01 has one `INSUFFICIENT_BOT_CAPITAL` refusal** at every size.
- **Funded gross is far below mirror gross,** for example $55.71 against $356.15 for ALPHA-01 at $1,000. Funded quantity is capped by the wallet: the full $10 risk would need a notional above the allocation. The same trades are taken, but they are smaller.
- **Concurrency:** up to all 4 bots held positions at once. Opposing positions on the same symbol occurred on 1,239 candle closes, allowed because each bot is independent.

## 4. What this means

- The engine, ledger, shorts, sweep and reconciliation behave as designed.
- At Ndax-equivalent fees the strategy loses money in funded PAPER for every bot and every allocation tested, and the loss scales with capital.
- This is an honest research finding, not a defect to hide. It argues against moving more PAPER capital until fee-aware settings are decided by the owner. Examples: higher timeframe only, wider minimum stop, or a minimum target-to-fee ratio. **No such filter has been added**, because the directive forbids extra restrictions without owner approval.
