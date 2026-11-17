# Engine outage protection (2026-11-17)

**Problem.** On 16 Nov the engine's PC lost power for **700 minutes**:
- Nobody was alerted.
- Any open PAPER position would have had no stop management for that whole time.
- The engine's own health monitor runs on the same PC, so it cannot report its own power cut.

## Part 1: detection and alerts (built, tested, NOT deployed)

**Where it runs:** `worker/src/outage.ts`, called by the Worker's existing **one-minute cron on Cloudflare**, so the alert path does not depend on the engine's PC.

**Episodes:** one row per episode in a new table (migration `0009_engine_outages.sql`, purely additive).

| Condition | Rule | Meaning |
|---|---|---|
| `ENGINE_OFFLINE` | no engine report for > max(10 min, 3 candles): 10 min for the 1m and 5m bots | the engine is down; **stops and exits are not managed** |
| `MARKET_DATA_STALE` | the engine reports, but its last candle is older than 3 candles + 3 min | the exchange feed or a catch-up is behind; the engine is up |
| Paused bot that keeps reporting | **no alert** | pausing stops entries, not the engine. This is what tells an *offline engine* apart from a *stopped strategy* |

**Alerts:**
- One push notification per device per minute, listing every affected bot by display name (e.g. "engine offline (all bots)" for a PC outage).
- **No repeats** while the outage lasts, and **one** "back to normal" notice when it clears.
- Episodes are recorded even when no device is enabled (`alert_devices = 0`) and are readable through `recentOutages()`.

**Safety:**
- It reads `bots`, `app_meta` heartbeats and push subscriptions, and writes **only** its own table.
- No order, ledger row, pause or strict-fill setting is touched.
- Before migration 0009 is applied it does nothing.

**Tests** (`worker/test/outage.test.mjs`, 7):
- thresholds;
- a healthy fleet including the two engine-paused bots: no alert;
- a whole-PC outage: one message per device, no repeat, one recovery notice;
- stale candles kept distinct from offline;
- no devices;
- no migration: a no-op;
- **the migration is purely additive**: the schema of 0001–0008 is byte-identical, with no DROP, ALTER or DML.

The migration guard test is updated to 0001–0009.

**Note on numbering:**
- The earlier activity-history index candidate (branch `candidate/activity-index`) also used the number 0009.
- It is not needed until about 5,000 events and will be renumbered 0010 when it is applied.

### Deploying Part 1 (needs the owner's approval: a production migration)

1. Take a D1 export and a time-travel bookmark:
   `wrangler d1 time-travel info alpha-terminal-db`.
2. Apply the migration:
   `node node_modules/wrangler/bin/wrangler.js d1 migrations apply alpha-terminal-db --remote`
3. Deploy the Worker, merged with the live release as for the read-batching deploy.
4. **Verify (read-only):**
   - `SELECT * FROM engine_outages` stays empty while healthy;
   - a test notification still works;
   - the engine and ledger are unchanged.
5. **Rollback:**
   - redeploy the previous Worker version; the table is simply unused;
   - the table itself is harmless and may stay.

## Part 2: protective stops while the engine is offline (design only, NOT built)

**Feasibility.** The current PAPER infrastructure could support it.
- `bot_positions` stores each open position's `stop`.
- The Worker already refreshes marks from Kraken's public ticker (`refreshMarks`).
- The bot ledger already closes positions at the live price (`CLOSE`).

**What it would take:**

1. **Worker (order behaviour, needs authorization).**
   - In the same cron, for a bot in an open `ENGINE_OFFLINE` episode with an open position whose fresh mark has crossed its stop: close it through the existing ledger close path.
   - It would be recorded with a reason such as `WORKER_PROTECTIVE_STOP`, at the **live mark, never the stop price**. A gap fills worse, as the backtests assume.
   - Fee 0.20%; idempotent by a deterministic order id.
2. **Engine (order handling, needs authorization).**
   - Today, after restart the engine would report the divergence "the ledger has no open position; the engine holds …" and hold new entries until its strategy exits on its own. Its own exit would be safely skipped (`LEDGER_NOT_HOLDING_ENTRY`).
   - It needs a rule to **adopt a ledger close it did not send**: drop the strategy position when the ledger shows the entry closed with `WORKER_PROTECTIVE_STOP`.
   - This must be covered by fault-injection tests:
     - engine down, stop crossed, restart;
     - engine restarts while the Worker is closing;
     - a duplicate close;
     - the engine's own exit racing the Worker's.

**Risks:**
- **Two writers:** the Worker and the engine must never both close a position.
  - The ledger's single-OPEN-position constraint and idempotent order ids prevent double closes.
  - The race still needs explicit tests.
- **Mark quality:** the Worker sees a one-minute ticker, not candles. A stop could be triggered by a brief wick the engine's bar logic would also see, or miss one it would not. In both cases the fill is at the real live price.
- **Scope:** PAPER only. No real-money path exists or is added.

**Recommendation:**
1. Deploy Part 1 first; alerting has no trading effect.
2. Decide on Part 2 separately, after Part 1 has been observed.
