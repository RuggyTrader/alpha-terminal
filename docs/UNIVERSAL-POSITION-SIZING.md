# Universal position sizing (permanent product requirement, 2026-11-12)

**Every funded PAPER strategy, on every market, sizes its orders from the actual available equity of its own strategy
wallet.** This is a permanent architectural rule, not an experiment. It applies to:
- SOLUSD, BTCUSD, ETHUSD;
- every future cryptocurrency, stock or other instrument;
- every timeframe and every strategy.

It is enforced by code and by a regression gate.

The **Strategy Mirror is the only exception**. It is hypothetical research that keeps the original strategy's
configured risk and fill assumptions (fixed $10, unlimited buying power). Its positions, balances, risk, records,
performance and notifications stay separate from the funded account.

## 1. One shared sizing engine

`engine/src/sizing.mjs` → `sizePosition()` is the **only** code that computes a funded order quantity. The strategy
(`ote.mjs`) calls it through `sizeOrder()`, and backtests and the live runner use the same call.

**Inputs:**
- **Instrument:** the registry entry for the market (section 3).
- **Available equity:** the strategy wallet's available capital, already net of reserved capital, read from the
  Worker's ledger view.
- **Order prices:** entry, stop and side.
- **Policy:** target risk %, maximum risk $, fee reserve %, price buffer %, optional minimum stop %; shorts are
  never allowed for funded PAPER.
- **Worker risk limits:** order value, position exposure, total exposure and number of open positions.
- **Existing exposure:** this market's open position cost, the account's open cost and the open-position count.
- **Price freshness (optional):** the age of the entry price and its limit.

**Output:** either an affordable, valid quantity, or `ok: false` with a documented `code`, the exact `reason`, and a
plain-language `explanation` taken from `OUTCOMES`.

**Formula:**

```
risk target  = min(available equity × 1%, maximum risk)           never raised
risk qty     = risk target ÷ (|entry − stop| × multiplier)
spend limit  = min(available equity, order-value limit, position-exposure room, total-exposure room)   fully paid
cash qty     = spend limit ÷ (entry × multiplier × (1 + 0.5% buffer) × (1 + 0.4% fee reserve))
quantity     = min(risk qty, cash qty), rounded DOWN to the instrument's quantity step
```

The quantity is **never increased**, neither to reach the target risk nor to reach a venue minimum. If the result is
below the minimum quantity or minimum value, the trade is not taken, with the reason.

## 2. Default risk policy (funded PAPER)

| Setting | Default | Where |
|---|---|---|
| Sizing mode | `percent` for every funded engine that trades against the PAPER ledger (`ENGINE_SYNC=on`) | `config.mjs` |
| Target risk | 1% of available strategy equity (`ENGINE_RISK_PCT`) | |
| Maximum risk | the strategy's risk setting, **$10** today (`ENGINE_MAX_RISK_USD=setting`; or a number; or `off`) | website setting, confirmed back |
| Leverage / borrowing / shorts | none | |
| Fee reserve / price buffer | 0.40% / 0.50% (assumption; Kraken publishes no fee schedule via its public API) | `ENGINE_FEE_PCT`, `ENGINE_PRICE_BUFFER_PCT` |

| Equity | Target risk |
|---|---|
| $10 | $0.10 |
| $100 | $1 |
| $500 | $5 |
| $1,000 | $10 |
| $5,000 | **$10**, the cap, unless the owner changes the risk setting |

The actual risk is lower whenever buying power or instrument rules require it: the outcome is `REDUCED_TO_FIT`.

**Fixed-dollar sizing is refused for funded engines.** It is the Pine formula, risking $X regardless of equity, and
was the root cause of trades worth thousands being sent from a $10 wallet. A funded engine with `ENGINE_SIZING=fixed`
does not start unless `ENGINE_SIZING_FIXED_REASON` records a research reason, and the dashboard then shows it in
amber. Without a ledger (`ENGINE_SYNC=off`, local research), `fixed` stays the default.

## 3. Instrument registry

`engine/src/instruments.mjs` holds the trading rules of each market:
- provider and pair mapping;
- asset class;
- tick size, quantity step and precision;
- minimum quantity and minimum order value;
- fractional eligibility and contract multiplier;
- margin (none: fully paid), shortability (no), trading hours;
- fee model (stated as an assumption where the provider publishes none);
- order types;
- **the verification source and date**.

| Market | Tick | Quantity step | Minimum quantity | Minimum value | Funded |
|---|---|---|---|---|---|
| SOLUSD (Kraken SOLUSD) | 0.01 | 1e-8 | 0.05 | $0.50 | **yes** |
| BTCUSD (Kraken XXBTZUSD) | 0.1 | 1e-8 | 0.00006 | $0.50 | no: Strategy Mirror only, not approved |
| ETHUSD (Kraken XETHZUSD) | 0.01 | 1e-8 | 0.002 | $0.50 | no: Strategy Mirror only, not approved |

All values come from Kraken's public AssetPairs, read 2026-11-12 01:00:29 UTC; SOLUSD was also checked on 2026-11-09.

- **Funded list:** the engine's funded markets (`ENGINE_SYMBOLS`) come only from this registry, and only for entries
  that are both verified and approved.
- **Markets without verified rules:** any market without a verified entry is refused, e.g. stocks, MES/MNQ futures
  and gold, which also lack a truthful data feed. It is never sized with another market's rules: `NO_INSTRUMENT_SPEC`,
  with no SOLUSD fallback.
- **Small accounts:** some instruments cannot be traded with a small account at all:
  - **non-fractional stocks:** one share must be affordable, and the risk must allow at least one share;
  - **futures:** one contract is the price × the multiplier, e.g. ×5 on an index future at 6,000 ≈ $30,000.

  The engine says so (`BELOW_MIN_QTY`, with the capital needed) instead of rounding up or pretending.

## 4. Several markets and capital protection

- **Wallets:** each funded market sizes from its own strategy wallet (`portfolio_wallets`, keyed by symbol).
  Available capital is already net of reserved capital, and the Worker's ledger view also reports open exposure and
  every limit.
- **Re-check at fill:** the Worker re-checks buying power at the live price, atomically, before committing a fill
  (`INSUFFICIENT_PAPER_CAPITAL`). A wallet can never go negative, and capital cannot be promised twice.
- **Competing candidates:** when several candidates compete for one wallet in the same poll, `allocateCapital()`
  decides deterministically, using only information known at signal time:
  1. the earliest signal candle;
  2. then the registry priority (SOLUSD 1, BTCUSD 2, ETHUSD 3);
  3. then the symbol;
  4. then the id.

  Each accepted order's full cost (with buffer and fee reserve) is deducted before the next is sized. Future outcomes
  are never used.
- **Limits:** account-wide and per-market limits (order value $5,000, position $10,000, total $25,000, 5 positions)
  are applied in sizing and enforced again by the Worker.
- **Duplicates:** signal ids and the ledger's per-alert idempotency are unchanged.

## 5. Exits and short signals

- A funded **exit** (`CLOSE`) is sent only for an entry the ledger accepted, and only while the ledger still holds the
  position that entry opened. Otherwise it is recorded as skipped (`ENTRY_NOT_IN_LEDGER`, `LEDGER_NOT_HOLDING_ENTRY`)
  and never sent.
- **Fixed sizing:** the production `SELL … NO_POSITION` rejections were **short entries**, not orphan exits. The
  strategy allows shorts, and fixed sizing sent them to the long-only ledger.
- **Percent sizing:** shorts are skipped before anything is sent (`SHORT_NOT_ALLOWED`). Earlier rejections stay in the
  history.

## 6. Dashboard and explanations

Each market's engine reports:
- sizing mode;
- available capital;
- target risk % and maximum risk;
- calculated risk and actual stop risk;
- quantity and estimated position cost;
- the binding buying-power cap (equity, order limit, position or total exposure);
- minimum quantity, minimum value and the minimum order cost;
- three checks (minimum quantity, minimum value, buying power);
- the outcome (`FULL_RISK` or `REDUCED_TO_FIT`) or the skip code, with the exact reason and the plain-language
  explanation.

The Worker passes these through unchanged (`worker/src/engine_status.ts`), and the dashboard shows them in the
engine card's "Position sizing" panel.

**ALPHA Assistant.** No assistant exists in the code yet. When one is added, it must answer only from these stored
fields and quote `OUTCOMES`. For example:
- "This trade was reduced to fit your available equity" is `REDUCED_TO_FIT`.
- "This trade cannot be taken because the smallest permitted order is larger than what your equity and risk allow"
  is `BELOW_MIN_QTY`.

It must never invent a quantity or a reason.

## 7. Regression gate (mandatory)

`engine/test/sizing-acceptance.test.mjs` runs on every market in the registry automatically.

**Registry:** every entry is complete and verified. Markets don't reuse SOLUSD's rules. Unknown markets are refused.

**Balance matrix ($10, $25, $50, $100, $500, $1,000, $5,000):**
- the target is 1%, capped at $10;
- the cost, including headroom, fits the equity, and the order-value limit holds;
- the actual risk is never above the target;
- the quantity is on the instrument's step and meets the venue minimums;
- every outcome is documented.

**Instrument types (TEST specs):**
- whole-share instruments are refused below one share and never rounded up;
- fractional stocks trade from $10;
- contracts are unaffordable up to $5,000.

**Edge cases:** tight stops, insufficient capital, stale prices, shorts, unknown balance, the open-position count,
exposure room, and fee and buffer headroom.

**Simultaneous signals:** allocation is deterministic regardless of input order, the same capital is never promised
twice, and capital never goes negative.

**Real setups:** 30 days of real SOLUSD setups at every balance. Trades complete, nothing would be refused by the
ledger, and every skip is documented.

**Strategy Mirror:** stays fixed $10, with the same quantities as the fixed-risk replay.

**The gate itself:**
- no engine file computes a quantity outside `sizing.mjs`, except the Pine fixed formula in `ote.mjs`;
- every funded market defaults to percent sizing against the ledger;
- fixed sizing needs a recorded reason;
- no shipped profile sets fixed sizing;
- every funded market needs a real-price fixture in the suite.

The Worker integration (`worker/test/engine_sync.test.mjs`, small-account sizing) also proves end to end that a $10
SOLUSD wallet's long entry and exit are accepted by the real Worker code, with no refusal.

## 8. Adding a market or strategy

Follow `docs/MARKET-INTEGRATION-CHECKLIST.md`. A market stays unavailable for funded execution until every item
passes.
