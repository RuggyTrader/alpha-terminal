# Candidate B forward trial and strict fill timing: implementation, tests and deployment plans (2026-11-15)

**Nothing here is deployed.** Both pieces wait for the owner's approval. The four production bots, their settings, capital and history are untouched.

## 1. Candidate B: exact implementation (branch `feature/btc-trend-trial`)

**Frozen settings** (`worker/src/trial/ma50.ts`, `PARAMS`, `Object.freeze`; stored verbatim with the account):

| Setting | Value |
|---|---|
| Market | Kraken BTCUSD (XBTUSD), daily candles |
| Direction | LONG only (no SHORT, no borrowing, no leverage) |
| Entry | Completed daily close above the 50-day SMA, while flat |
| Signal exit | Completed daily close below the 50-day SMA |
| Protective stop | Entry fill − 3 × ATR(14) of the signal day (Wilder ATR, seeded as in the research code) |
| Trailing stop | 3 × ATR below the best daily close since entry; raised at closes only, **never lowered** (also enforced by the table: `stop >= initial_stop`) |
| Risk per trade | 2% of the account's current cash equity ÷ stop distance; capped by cash |
| Costs | 0.20% fee per fill; 0.05% slippage per fill |
| Minimum order | 0.00006 BTC and $0.50 |
| Starting balance | $100, an isolated research account |

**Venue change found:** Kraken's minimum BTC order is now **0.00006 BTC** (AssetPairs, 15 Nov). It was 0.00005 BTC when we verified it on 12 Nov.
- The trial uses the current value.
- The production instrument table still says 0.00005. That is harmless at today's prices, because $20 BTC orders are about 0.0003 BTC. Updating it is a separate, owner-approved change.

**Where it runs.** The Worker's scheduled job runs every minute (`worker/src/trial/trial.ts`), always online and independent of the engine PC. This reuses the existing Worker, D1 database, Kraken market-data access, owner authentication and website. It is not a separate application.

| Step | What happens |
|---|---|
| Daily close (00:00 UTC + 1 min) | Validate the completed Kraken daily candle (positive prices, consistent OHLC, continuous days). Raise the trailing stop if warranted. Exit or entry signal → a **market order accepted by the ledger at that moment** |
| Market order fill | At the **open of the first Kraken 1-minute candle that starts at or after acceptance**, plus slippage, plus the fee. Never the daily open, which happened before the order existed |
| Stop | A simulated stop-market order, checked on every completed 1-minute candle. Low reaches the stop → fill at the stop, or at the open if the candle gapped below it (worse), minus slippage |
| Outage replay | Missed minutes are replayed in order from Kraken history: 1m (about 12 h), then 15m (7.5 days), then 60m (30 days). The fill records its candle interval and how late it was recorded |
| Missed daily closes | Only the latest completed day can trade. Older signals are recorded as `MISSED_SIGNAL`, never back-dated |
| Every run | Idempotent (order and position state guards), locked against overlap, stateless between runs (all state in D1) |
| Idle minutes | Read-only: two D1 reads, no write, no market-data request |

**Timestamps recorded:**
- signal (`signal_candle_t`);
- submission (`created_at`) and acceptance (`accepted_at`);
- fill candle (`fill_candle_t`, `fill_interval_min`) and fill time (`filled_at`);
- when the fill was recorded (`recorded_at`, `recorded_late_min`).

## 2. Research-to-engine parity (`worker/test/trial_parity.test.mjs`)

**What is compared:** the trial module's replay against the research backtest (`engine/src/research/r2.mjs`), on **real BTC daily candles** (committed fixture, Coinbase 2021-06 → 2026-11), in development, validation, final test and all periods.

**Result:** identical trades (entry and exit times, prices, quantities, gross, fees, net) and final equity, to 1e-9. The reported round-2 figures (+21.10, +13.43, +4.12) are reproduced exactly.

**What parity covers:** the decision logic. Live execution then differs deliberately and conservatively: minute-level fills after acceptance instead of the daily open, and minute-level stop checks instead of the daily low.

## 3. Market and stop execution tests (`worker/test/trial_exec.test.mjs`, 15 tests)

- **Activation:** nothing is decided at activation; the first decision is the first daily close after it.
- **Market BUY:** accepted at 00:01:30. The 00:00 and 00:01 candles began earlier, so it **fills at the 00:02 open + 0.05%**, not the daily open. 2% risk, 3×ATR stop, no leverage, cash accounting exact.
- **Stops:**
  - the stop fills at stop − slippage;
  - a **gap below the stop fills at the (worse) open**;
  - the trailing stop rises after a higher close and is **never lowered**; each raise is recorded; the database refuses a stop below the initial one.
- **Signal exit:** a market SELL fills at the first candle after acceptance.
- **Order too small:** an entry below Kraken's minimum is cancelled with the reason, never forced.

## 4. State recovery and outage tests (same file + `worker/test/trial_integration.test.mjs`)

- **20-hour outage with an open position:**
  - the stop hit during the outage is found on 15-minute history;
  - it is filled at the stop, with interval 15;
  - it is recorded about 16.5 hours late, with a `FILL_RECORDED_LATE` event.
- **Daily closes missed:** only the latest trades; older signals become `MISSED_SIGNAL`.
- **Restart:** stateless between runs; a repeated run changes nothing (idempotent).
- **Overlapping run:** refused by the lock.
- **Market data unavailable:** nothing advances past unchecked time; the next run catches up.
- **Isolation:** every SQL statement of the trial touches only `trial_*` tables.
- **In a real local Worker:**
  - the scheduled job is idle before activation;
  - activation **requires the passphrase** and is idempotent;
  - the scheduled job starts the trial;
  - **portfolio wallets, entries, bots and positions are byte-identical** before and after;
  - the report requires a session.

**Limitations of simulated stops:**
- **Not an exchange order.** The stop is a simulated stop-market order held by our ledger and evaluated on Kraken's 1-minute candles. A real order could fill worse in a fast market (thin order book, larger slippage than 0.05%).
- **The PC being off no longer matters for this trial.** The Worker runs in Cloudflare, so a PC power-off does not stop stop-monitoring.
- **Cloudflare outages or delays:** cron runs can be delayed. Stops are then evaluated retroactively from history. Market orders are never back-dated; they fill after their real acceptance time.
- **Long Kraken outage:** after more than about 12 hours, only coarser candles exist. A coarse candle can show a stop hit that a 1-minute view would time differently. The fill records the interval.

## 5. Isolated forward PAPER account (migration `0008_trial.sql`, purely additive)

**Tables:** `trial_accounts`, `trial_orders`, `trial_positions`, `trial_stop_changes`, `trial_equity`, `trial_events`. No existing table changes.

**Separation from the portfolio:**
- The $100 is the research account's **starting balance**, not a deposit, transfer or allocation.
- The portfolio's MAIN, bots, wallets, P&L and funding never see it.
- The website shows it only in its own panel on Results, labelled "a separate research account; not part of your portfolio, its P&L or its funding".

**Reported:**
- equity and net;
- gross, fees and slippage assumption;
- completed trades, win rate, profit factor, average net with a bootstrap 95% interval;
- maximum drawdown (daily closes), average hold, longest losing streak, time in cash;
- open position with its stop and its actual risk;
- benchmarks: cash, buy and hold BTC from the start, and the historical backtest, labelled "not forward results";
- the evidence milestone ("N of 30 completed trades").

## 6. Operating costs

| Item | Estimate |
|---|---|
| Scheduled invocations | 1,440 per day (about 15,300 per day in total with today's 13,800; free limit 100,000) |
| D1 when flat | 2 reads per minute, 0 writes (about 2,900 reads per day) |
| D1 in a position | about 5 reads + 2–3 writes per minute (≤ 7,200 reads, ≤ 4,300 writes per day; free limits 5,000,000 / 100,000) |
| Kraken public API | 1 request per minute only while a position or order needs watching; otherwise 1 per day |
| Money | $0 on the current free plans; no change to the engine PC |

## 7. Trial deployment and activation plan (needs the owner's approval)

1. Approve the trial branch (`feature/btc-trend-trial`). Its full regression suites run on a clean checkout before any step.
2. Merge it into the release branch.
3. Take a D1 time-travel bookmark. Apply migration `0008` to production (additive only), then verify every existing table and row count is unchanged.
4. Deploy the Worker with `versions upload` + `versions deploy`, then **`wrangler triggers deploy`** to register the one-minute schedule (a version deploy alone does not apply triggers).
5. Verify:
   - the trial report shows `PROPOSED`;
   - the scheduled job runs idle (no events, no writes);
   - portfolio wallets and funding are unchanged ($100.000000).
6. **Owner:** Results → "Start the trial" → passphrase (once).
7. Verify `TRIAL_STARTED`. The first decision is the next 00:00 UTC close; expect about one trade a month.

**Rollback:** remove the schedule (`wrangler triggers deploy` with no crons) and mark the account `STOPPED` (owner-approved). The `trial_*` tables stay for the record. Nothing else is affected.

## 8. Strict fill timing: review (branch `review/strict-fill-timing`)

**The rule, identical in both places:** a fill's candle must **start at or after the moment this ledger accepted the order**.
- **Worker** (`STRICT_FILL_TIMING=true`): it checks `received_at` as well as `placed_at`.
- **Engine** (`ENGINE_STRICT_FILL=on`):
  - it uses the ledger's own `received_at`, returned with the order;
  - an order not yet accepted cannot fill;
  - a replaced order loses its old acceptance;
  - an order accepted before the switch **adopts its acceptance time from the ledger** (otherwise it would never fill).

**Off:** with both settings off, behaviour and saved state are byte-identical to production.

**Tests:**
- **Engine:** 282/282, including:
  - end to end against a strict ledger stub, with no refusal across a restart, replacements and expiries;
  - **an upgrade with an order pending**, which adopts its acceptance time and still fills;
  - unit tests of the acceptance rule.
- **Worker:** an integration test with the flag on. A candle that opened before acceptance is refused (`FILL_BEFORE_ORDER`) and the next candle fills; existing records are never re-evaluated.
- **Full suites:** run on clean checkouts.

**Effect on the original four strategies** (Aug–Nov backtest):
- 2–4% fewer fills (the ones on the candle already open at acceptance);
- net changes by −$0.01 to +$0.28;
- existing trades and records are unchanged.

## 9. Strict fill timing: release plan (needs the owner's approval)

The order matters, so that no genuine fill is ever refused during the switch:

1. Merge `review/strict-fill-timing` into the release branch.
2. Deploy the Worker **without** the flag. The only change is `received_at` in the engine's ledger read (additive).
3. Engine:
   - add `ENGINE_STRICT_FILL=on` to `engine.env`;
   - run `bin\release.mjs upgrade` to the merged commit (graceful, no administrator, about 4 s).
   - The engine now fills only on candles at or after acceptance. The ledger is still lenient, so nothing can be refused.
4. Observe at least 24 hours. Check in D1 that every new fill's candle starts at or after its order's `received_at`, and that ledger checks stay OK.
5. Set `STRICT_FILL_TIMING: "true"` in the Worker vars and deploy. Both now enforce the rule.

**Rollback:** reverse order. Remove the Worker var and redeploy, then set the engine flag off and run a graceful restart.
