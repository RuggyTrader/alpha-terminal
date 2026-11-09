# ALPHA PAPER execution costs

Status: implemented and tested in development only. **Not deployed.** Production still runs Worker version
`2cd0119d` (commit `cde07af`) with no cost accounting. Deploying needs migration `0004` on the production D1 and
the owner's explicit authorization.

Everything here is a simulation. ALPHA PAPER never sends an order to Ndax, Kraken, Alpaca or any other venue.

## What changes

Without costs, every ALPHA PAPER fill executed at the Kraken reference price and paid nothing. With a cost profile:

| | Before | With a cost profile |
|---|---|---|
| Fill price | Kraken reference price | Reference price; on a **taker** fill, moved against the trade by the profile's slippage |
| Fee | none | maker or taker fee on every fill, booked as its own `FEE` ledger entry |
| Minimum order | none | BUYs and partial SELLs below the venue minimum are refused (`BELOW_MIN_ORDER`) |
| Capital check | value ≤ available | value **+ entry fee** ≤ available (`INSUFFICIENT_PAPER_CAPITAL`) |
| Trade P&L | gross | `realized_pnl` is **net**; `gross_pnl`, `fees_usd`, `slippage_usd` and `cost_profile` are recorded beside it |
| Coin balance | moves by gross P&L | moves by net P&L (realized at execution prices, minus fees) |

## Profiles (`PAPER_COST_PROFILE` in `worker/wrangler.jsonc`)

| Profile | Maker | Taker | Taker slippage | Minimum | Fee source |
|---|---|---|---|---|---|
| `none` | 0 | 0 | 0 | none | gross simulation (the old behaviour) |
| `ndax` (default in `wrangler.jsonc`) | 0.20% | 0.20% | 0.10% **estimate** | $5 order value | ndax.io/fees, read 2026-11-09: flat 0.20% on every buy and sell |
| `kraken_pro_t1` | 0.40% | 0.80% | 0.03% | 0.05 SOL and $0.50 | kraken.com/pro/fees, read 2026-11-09: Tier 1 spot |

- **Ndax caveat.** The engine trades on Kraken SOLUSD prices. The `ndax` profile applies Ndax's fee schedule to
  those prices. It is **not** a verified Ndax SOL/CAD execution: Ndax is a different market with a CAD quote, and its
  liquidity was never measured. The 0.10% slippage is an estimate, labelled as one on the dashboard. The dashboard
  shows this caveat in Settings → Execution costs.
- **Kraken slippage.** 0.03% comes from a measured SOLUSD spread of $0.02 (0.023%) on 2026-11-09. A possible 0.02%
  "selected pairs" discount was not confirmed for SOL/USD, so it is not applied.
- **Unknown profile.** An unknown name refuses every fill with `COST_PROFILE_INVALID`. Nothing is ever filled at an
  assumed cost.

Switching profile is a configuration change plus a Worker deploy. It applies only to fills made after the change.
Fills already recorded keep the profile they were made with.

## Maker or taker

The engine labels every signal with `liquidity` (`engine/src/runner.mjs`, `liquidityFor`):

- **maker:** the limit entry (`Limit @ 0.705`) and the take-profit. These are resting limit orders, so they fill at
  the reference price with no slippage.
- **taker:** stop-loss, break-even and trailing stops, time exits, reconciliation closes and market entries. These
  are also used for any signal that does not say (older outbox items, manual or Pine webhooks). They execute
  `slippage%` worse than the reference price: a BUY pays more and a SELL receives less.

An invalid label is refused (`INVALID_LIQUIDITY`).

**Conservative limit fills** are an optional engine setting, `ENGINE_LIMIT_THROUGH_TICKS` (default `0`). With it set,
a resting limit order fills only once price trades that many ticks through it, rather than on a touch. At `0` the
TradingView emulator rule is unchanged. The setting is off in production, and changing it would change which trades
happen, so turning it on needs approval.

## Formulas (`worker/src/costs.ts`)

```
taker execution price = reference × (1 + slip)  for a BUY,  reference × (1 − slip)  for a SELL   (rounded to 8 dp)
maker execution price = reference
fee                   = execution price × qty × multiplier × fee rate                            (micro-USD, rounded)
slippage cost         = |execution − reference| × qty × multiplier                                (micro-USD, rounded)

position realized     = (exit execution − entry execution) × qty         (includes slippage)
trade gross_pnl       = position realized + slippage                     (what the trade made at reference prices)
trade realized_pnl    = position realized − fees                         (NET)
```

The ledger identity, which every dashboard read checks (`consistency`):

```
available + reserved = net funding + realized P&L − fees
```

Each fill's fee is debited from the strategy balance in the **same D1 batch** as the fill. It is written as one
`portfolio_entries` row with `kind = 'FEE'` and `entry_key = 'FEE:<client order id>'`. That key is UNIQUE, so a
retried or replayed fill can never be charged twice. `CHECK (available_micro >= 0)` makes a fee that cannot be paid
fail the whole fill, so a balance cannot go negative.

### Worked example (Ndax, real Kraken closes from the engine fixture)

| Step | Reference | Execution | Value | Fee | Slippage |
|---|---|---|---|---|---|
| BUY 0.5, maker | 95.25 | 95.25 | 47.625 | 0.09525 | 0 |
| CLOSE 0.5, taker (stop) | 94.33 | 94.23567 | 47.117835 | 0.094236 | 0.047165 |

Gross −$0.46, slippage −$0.047165, fees −$0.189486, **net −$0.696651**. The SOLUSD balance moves by −$0.696651.
This exact case runs in `worker/test/paper_costs.test.mjs`.

## What this does to PAPER results

On the `ndax` profile:

- A limit entry with a take-profit exit costs **0.40% of notional** per round trip.
- A limit entry with a stop exit costs **0.40% plus 0.10% slippage**, about **0.50%**.

On `kraken_pro_t1` the same round trips cost about 0.80% and 1.23%.

At $10 risk, the notional per trade is risk ÷ stop distance. With a stop 0.5% away, that is about $2,000. Each
round trip then costs about $8–10 on Ndax: close to the whole $10 risk. A 1R take-profit win keeps about $2 of its
$10, and a 1R stop-loss costs about 2R. For tight-stop strategies like this one, fees are a large share of the
result. The 2026-11-09 research (`docs/STRATEGY-RESEARCH-2026-11-09.md`) measured this over 150 days. A separate,
corrected study requested by the owner (both directions, fixed $10 risk) is in progress in a different research
session; its findings are not reflected here.

## Unchanged

- **Existing trades and balances.** Migration `0004` rebuilds `portfolio_entries` to allow `FEE`, and copies every
  row unchanged (same ids, keys and amounts). It adds new columns with `NULL`/`0` defaults. Trades closed before cost
  accounting keep their gross `realized_pnl` and show "recorded before cost accounting". Nothing is recomputed
  retroactively. `worker/test/migrations.test.mjs` checks this row by row.
- **The TradingView-style backtest** in Portfolio → Historical simulator (models A and B) stays a **gross reference**
  with no fees and no slippage, and is labelled that way. Only the ALPHA PAPER ledger (C) charges costs, so on the
  same trades C will trail A and B.
- **Everything else.** The strategy, its inputs, the $10 risk, the long-only ledger, the risk limits, the Windows
  startup task and `ENABLE_TRADING=false` are all unchanged.

## Dashboard

- **Trade card and trade proof:** gross, slippage, fees and net. Each fill shows reference vs execution price,
  maker/taker, fee and slippage. The proof recomputes net = sells − buys − fees from the fills and checks it against
  the recorded P&L.
- **Performance:** an "Execution costs" block with gross, slippage, fees and net over the selected range. The equity
  curve is net.
- **Portfolio and Settings:** realized before fees, simulated fees paid, and net realized. Settings → Execution costs
  shows the active profile, fee and slippage sources, minimums and the Ndax caveat.

## Tests

| Suite | Covers |
|---|---|
| `worker/test/paper_costs.test.mjs` (port 8801) | Ndax and Kraken lifecycles, maker vs taker, FEE entries, duplicates before and after a restart, minimum orders, a fee-inclusive capital check, closes never blocked, invalid profile and invalid liquidity, dashboard/performance/trade-proof fields, identity and consistency |
| `worker/test/migrations.test.mjs` | `0004` keeps every existing row; FEE allowed; negative balances still impossible |
| `engine/test/costs.test.mjs` | liquidity labels; every live signal carries one; `ENGINE_LIMIT_THROUGH_TICKS` validation and application |
| `frontend/src/terminal/costs.test.tsx` | gross/fees/slippage/net display, sub-cent cost formatting, trade-proof net check, Settings profile and caveat |

The other Worker suites run with `PAPER_COST_PROFILE=none`, so their gross assertions still hold.

## Deploying (not done; needs authorization)

1. Back up the production D1, then apply `0004_paper_execution_costs.sql` (`wrangler d1 migrations apply alpha-terminal-db --remote`).
2. Confirm `PAPER_COST_PROFILE` is the intended profile (`ndax` in `wrangler.jsonc`; use `none` to stay gross).
3. Deploy the Worker. The production engine needs no restart: older engine builds send no `liquidity`, so their
   signals are treated as taker fills (the conservative case) until the engine is updated.
4. Check the dashboard consistency (`consistency.ok`), the `schema_version` = 4, and one PAPER fill's proof.
   Rollback: redeploy `2cd0119d`. The extra columns are ignored by the older Worker and balances stay correct. Once
   any fee has been charged, though, the older Worker's consistency check (which has no fee term) shows a warning
   equal to the fees paid. A rollback after fees exist therefore needs that warning explained, or a later redeploy.
