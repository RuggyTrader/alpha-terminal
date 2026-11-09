# Small-account position sizing (prepared 2026-11-09, not enabled, not deployed)

## What it does

A second sizing mode for the PAPER engine, `percent`, next to the original `fixed` mode (still the default):

| | `fixed` (current production) | `percent` (small account) |
|---|---|---|
| Risk per trade | website setting in USD (now $10) | `ENGINE_RISK_PCT` of the SOL strategy's **available** ALPHA PAPER balance (default 1%) |
| Quantity | risk ÷ \|entry − stop\| (Pine formula, unchanged) | min(risk ÷ \|entry − stop\|, balance ÷ (entry × 1.005 × 1.004)), rounded **down** to 8 decimals |
| Leverage / margin / borrowing | not controlled by the engine (the Worker refuses orders above the balance) | never: the order never costs more than the balance, after a 0.5% price buffer and the assumed entry fee |
| Shorts | sent and refused by the ledger | never placed (`SHORT_NOT_ALLOWED`) |
| Order-value limit | Worker refuses above $5,000 | engine caps at the Worker's limit (read from the Worker) |
| Kraken minimums | not checked | 0.05 SOL and $0.50 per order (Kraken AssetPairs, 2026-11-09); smaller orders are skipped (`BELOW_MIN_QTY`, `BELOW_MIN_COST`) |
| Balance unknown | n/a | no order (`BALANCE_UNKNOWN`), never guessed |
| Compounding | no | yes: each order is sized from the balance after the previous results |

Entry signals, stop-loss, take-profit, break-even and trailing rules are untouched; in fixed mode the strategy
produces exactly the same trades as before (tested). A skipped order is recorded as an `ORDER_SKIPPED` event (engine
audit log) with its code and exact reason, and shown on the dashboard.

Fees: Kraken's public API returned no fee schedule, so the fee is an **assumption** (`ENGINE_FEE_PCT`, default 0.40%
per side). It is reserved when sizing and used in the backtests below. The ALPHA PAPER ledger itself charges no fee,
so ledger P&L is before fees.

## How engine and Worker agree

- The Worker's read-only ledger view (`/webhook/engine-ledger`) now also returns the strategy balance
  (`available_usd`, `reserved_usd`) and `max_order_notional_usd`: the engine sizes from the same money the Worker's
  risk check uses. It refreshes after every poll.
- The Worker's checks are unchanged (balance, $5,000 order, $10,000 position, $25,000 total, 5 positions, $2,000 daily
  loss, long-only). The engine stays inside them, so entries are not refused; if one ever is (e.g. a sudden price jump
  between the engine's fill and the ledger's live price beyond the 0.5% buffer), the engine drops that position
  (previous fix) and the refusal is recorded.
- The engine's status carries the sizing (mode, %, balance used, dollar risk target and actual, required capital,
  quantity, order value, cap reason, fee estimate, skip reason). The Worker stores it and the dashboard shows it in the
  OTE engine card ("Position sizing").

Tested against a local Worker with a $100 portfolio and $10 in SOL (`worker/test/engine_sync.test.mjs`, "small-account
sizing"): the ledger view reports $10; the real engine's long was accepted with ledger cost ≤ $10, quantity ≥ 0.05 SOL
and the same quantity on both sides; no short was sent; nothing was refused; the close credited SOL with exactly the
realized P&L; the next poll sized from the new balance and the dashboard showed it.

## Your production account (read-only check, 2026-11-09 ~04:14 UTC)

MAIN $90.00, SOL $10.00. The engine's live pending order: long limit $86.78, stop $86.08.

| Model | Quantity | Order value | Dollar risk | Outcome |
|---|---|---|---|---|
| fixed $10 (now) | 14.4451 SOL | $1,253.55 | $10.11 | refused by the Worker (`INSUFFICIENT_PAPER_CAPITAL`) |
| 1%, $10 | 0.1142038 SOL | $9.91 | $0.08 (target $0.10) | fits |
| 1%, $50 | 0.5710190 SOL | $49.55 | $0.40 (target $0.50) | fits |
| 1%, $100 | 1.1420381 SOL | $99.11 | $0.80 (target $1.00) | fits |

The stop is 0.81% from the entry, so a full 1% risk would need 125% of the balance; without leverage the order is
capped at the balance and the actual risk is ~0.8%. Assumed round-trip fees ($0.08 on $10) are about the same size as
the risk. Minimum workable balance at this price: about $4.38 (0.05 SOL).

## Backtest comparison

`node src/cli/compare-sizing.mjs --candles data/SOLUSD-5m-25d.json` (engine/; report in `runs/sizing-compare/`).
Real Kraken SOLUSD 5m candles, 2026-10-19 → 2026-11-07 (5,670 candles, 716 compared with Kraken OHLC, 0 mismatched),
profile `solusd-5m`, the engine's own strategy code. **Past results over 19 days; not a forecast or a promise.**

| Variant | Trades | Gross P&L | Fees | Net P&L | Return | Max drawdown |
|---|---|---|---|---|---|---|
| A. Original fixed $10, unlimited capital, long + short, no fees (TradingView-style) | 69 | +$249.99 | $0 | +$249.99 | n/a | $21.95 |
| A'. Same, 0.40% fee per side | 69 | +$249.99 | $1,913.07 | −$1,663.08 | n/a | $1,663.08 |
| B. Original fixed $10 on a $10 / $50 / $100 balance (ledger rules, 0.40%) | 1 | +$14.99 | $13.44 | +$1.55 | 15.5% / 3.1% / 1.6% | 0 |
| C. 1%, $100, compounding, 0% fee | 30 | +$4.36 | $0 | +$4.36 | +4.36% | 0.44% |
| C. 1%, $100, 0.05% | 30 | +$4.30 | $2.98 | +$1.32 | +1.32% | 1.19% |
| C. 1%, $100, 0.10% | 30 | +$4.25 | $5.88 | −$1.63 | −1.63% | 2.55% |
| C. 1%, $100, 0.25% | 30 | +$4.11 | $14.10 | −$9.99 | −9.99% | 9.99% |
| C. 1%, $100, 0.40% | 30 | +$3.97 | $21.63 | −$17.66 | −17.66% | 17.66% |

$10 and $50 starts give the same percentages as $100 (positions scale with the balance; all orders stay above Kraken's
minimums). In B, 78 of 79 entries were refused (41 insufficient capital, 37 shorts): fixed $10 risk cannot trade a
small account. In C, 135 short setups were skipped (long-only) and nothing was refused.

**Break-even fee:** the strategy's gross edge on this window is about **0.07% of traded value per side** for the
small-account model (0.05% for the original). Any fee above that turns the result negative. The cause is the strategy
itself: its stops are very tight (median ~0.8% from entry), so a round trip at 0.25–0.40% per side costs about as much
as the whole risk. Sizing can make the strategy tradable with $10 and survivable (drawdown ≈ 0.4% without fees), but
it cannot create an edge that the fees remove. Kraken's retail fees (not confirmed by its API here) are, to our
knowledge, well above 0.07%.

## Enabling it (needs your approval; nothing here is enabled)

1. Deploy the Worker and website (the ledger view must return the balance, the dashboard shows the sizing). Until then
   an engine in percent mode places no orders (`BALANCE_UNKNOWN`).
2. In `engine/.env` add `ENGINE_SIZING=percent` (optional: `ENGINE_RISK_PCT=1`, `ENGINE_FEE_PCT=0.4`,
   `ENGINE_PRICE_BUFFER_PCT=0.5`), then restart the engine. Without the line the engine stays on fixed $10.
3. The website's "Risk per trade $10" setting is only used in fixed mode.

Not done: the ALPHA PAPER ledger charges no fees, so live PAPER P&L will look better than real trading would. A ledger
fee model would be a separate change.
