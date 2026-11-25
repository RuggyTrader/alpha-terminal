# Jupiter Perps PAPER engine: architecture, operation and dashboard integration

**PAPER only.**
* There is no wallet, key or signer.
* No code path sends, signs or executes a transaction; `LIVE_EXECUTION_ENABLED` is a constant `false`.
* All network access goes through `guardedFetch`, which allows only:
  * GET requests to the Perps API's `market-stats` endpoint;
  * GET requests to Binance public market data;
  * the Solana JSON-RPC read methods `getMultipleAccounts` and `getAccountInfo`;
  * fetching the IDL file from GitHub.

## Modules

**Strategy layer**
* **`strategies.mjs`:** pure signal functions for A and B. They know nothing about the venue or the account.
* **`strategies-independent.mjs`:** a separately written implementation, used only for cross-checking.

**Risk layer**
* **`risk.mjs`:** the independent risk manager.
  * **Input:** a target exposure.
  * **Output:** an approved plan (OPEN / INCREASE / DECREASE / CLOSE / NONE), or a refusal.
  * **Enforces:**
    * the leverage cap and the 1.1× minimum;
    * the $10 minimum collateral;
    * fee and gas reservation;
    * the duplicate guard;
    * shutdown;
    * one position per asset;
    * no martingale.

**Execution and accounting**
* **`costs.mjs`:** Jupiter fee, borrow and liquidation math, taken from the program's reference code.
* **`ledger.mjs`:** shared execution and accounting (isolated margin). Used by **both** the backtester and the PAPER engine.
* **`backtest.mjs`:** `stepHour`, the shared hour step.
* **`adapter.mjs`:**
  * builds Jupiter requests in the shapes of the official CLI client (`POST /v2/positions/increase`, `/v2/positions/decrease`, `/v2/tpsl`), validates them, and never sends them;
  * provides simulated position views using the Perps API's field names;
  * reads market data (read-only).

**Data, persistence and display**
* **`onchain.mjs`:** a read-only snapshot of the pool and custody parameters (fees, borrow rates, leverage limits, permissions).
* **`store.mjs`:**
  * an append-only audit journal plus an atomic snapshot;
  * crash recovery: an uncommitted tick is marked ROLLED_BACK and re-processed deterministically, because the PRNG state is persisted.
* **`dashboard.mjs`:** the feed `alpha-terminal.jupiter-paper.v1` (JSON) plus a self-contained HTML view.

**Change separation.** A change to the adapter or ledger cannot silently change a signal: signals come only from `strategies.mjs`. The PAPER-vs-backtest parity test fails if the two execution paths diverge.

## One tick (`paper-engine.mjs`)

1. **Ingest.** New closed 1-hour candles (Binance substitute), Jupiter `market-stats` mark prices, and the on-chain parameters once a day.
2. **For each new closed hour, run `stepHour`:**
   * keeper fills at the open (delay slippage; expiry and retry);
   * borrow accrual;
   * a gap through liquidation;
   * stop-loss (may fail and is retried);
   * liquidation;
   * marks and drawdown;
   * the $75 shutdown;
   * the decision at the close, via signals and then the risk manager.
3. **Adapter.** Every decision becomes a validated Jupiter-shaped request with an idempotency key. Its status history is tracked through PENDING, EXECUTED, EXPIRED_RETRYING, SUPERSEDED, REJECTED and REJECTED_VALIDATION. Stop changes produce a TP/SL request.
4. **Reconciliation.**
   * ledger identities;
   * every pending ledger request has a live request record;
   * position views match the ledger.
5. **Health.**
   * data lag;
   * Jupiter mark vs the substitute price (bps);
   * on-chain borrow rate vs the cost model (an alert if above 2×);
   * errors;
   * crash recovery.
6. **Output.** Write `dashboard.json` and `dashboard.html`, journal the tick, then commit the snapshot.

## Running (observation mode; no strategy qualified)

```powershell
node engine/src/research/jupiter/paper-engine.mjs "$env:USERPROFILE\AlphaTerminal\research\jupiter\paper-observation"
```

* The engine is **not scheduled**: no Windows task was created.
* `--candidate "A long_flat 1.1"` would make it paper-trade a candidate, but **no candidate qualified**. The flag exists only for tests and for a future, separately approved candidate.
* A candidate run is always labelled "NOT a qualified candidate" on the dashboard.

## Dashboard integration (prepared, not deployed)

**Feed.** `dashboard.json` (schema `alpha-terminal.jupiter-paper.v1`) contains:
* `status`;
* `equity` (now, high, max drawdown, distance to the $75 shutdown, cash);
* `pnl` (realized, unrealized, total, `verified` = reconciliation result);
* `fees`;
* `counts`;
* `positions`, with: leverage, entry, mark, liquidation price, stop, borrow, value, approved maximum leverage;
* `risk` (approved level, gross notional, gross leverage, collateral in use, pending requests);
* `trades` (last 50);
* `marks` (Jupiter);
* `health`.

**Local view.** `dashboard.html` is a self-contained page (light/dark, mobile-safe tables) for local viewing.

**Proposed Command Center integration** (requires separate approval; nothing changed):
1. A read-only "Jupiter PAPER" card in the Command Center that renders the feed's equity, positions and health. It is clearly labelled PAPER / substitute prices.
2. The feed is uploaded as a static JSON asset, or served by a new **read-only** Worker route (`GET /api/jupiter-paper`) reading a KV key written by a separate upload step. There is no D1 table and no write path from the Worker.
3. The production Worker, D1, the four bots, S3 and P1 are untouched until that is approved.
