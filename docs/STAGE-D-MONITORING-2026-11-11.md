# Strategy Mirror V1 — Stage D monitoring report (2026-11-11)

**Read-only monitoring of production.** No deploy, migration, D1 write, engine restart, task, configuration, balance,
risk or fee change was made, and no trade was forced.

**Headline:**
- The **first genuine live hypothetical trade was observed and verified**: `MIR-SOLUSD-5-2026-11-11T04:15:00Z-LONG`,
  seq 7.
- The funded PAPER account refused the same signal, as designed, and its balances did not change.

## 1. Production versions

| Component | Version / state |
|---|---|
| Engine | pinned release `0db082fbd044` = `0db082fbd0449bf47ac610e74055916c72282412` (manifest verified); previous `6b70cc97c579` kept for rollback |
| Engine configuration | `ENGINE_MIRROR=on`, `ENGINE_PROFILE=solusd-5m`, sync on, poll 20 s, late bars 2. `validate`: ok, `mirror: true`, fixed $10 risk, long and short on, inputs hash `c826d785d58a4a39`, `state.resumable: true` |
| Worker | `4d3ddcb6-08a3-472d-8f99-81ff8b317ae2` at 100%; `/health` ok, PAPER, database connected, `enable_trading:false` |
| D1 | schema 5. Production's last applied migration is `0005_strategy_mirror.sql` (see §12 for 0006) |
| Execution costs | `PAPER_COST_PROFILE=none` (funded); the mirror's Ndax figures are a comparison only |

## 2. Monitoring coverage (exact)

| Item | Value |
|---|---|
| Evidence period | 2026-11-11 **03:41:08 UTC** (mirror activation) to **04:59:31 UTC** (last tailed request): 1 h 18 min |
| Active monitoring | 04:03:50–04:40:36 per-candle snapshots of both tracks; Worker tail 04:04:10–04:59:31 (376 requests); production reads at 04:02, 04:41, 04:45 |
| Engine online | the whole period: one chain since 03:41:08 (conhost 21696 → PowerShell 26120 → cmd 20960 → node 15952) |
| PC off | **0 hours** in the period: no power, boot or shutdown events after activation; last boot 2026-11-10T20:11:40Z |
| Live candles observed (both tracks) | **13** (03:40 → 04:40, each processed 5–17 s after its close), counted at 04:45 |
| Trades | historical **6**, live **1**, catch-up **0** |
| First genuine live trade | **verified** (§7) |

This is a short window. It does not show behaviour across a PC power-off, which is still to be observed (§14).
Continuous unattended monitoring is not running: the monitor and tail were tied to this session.

## 3. Funded engine health

| Check | At activation | At 04:45 |
|---|---|---|
| Started / warmed up | 2026-11-09T01:28:50Z | same (no warm-up) |
| Resets | 0 | 0 |
| Candles processed / last | 1,323 / 03:35 | 1,336 / 04:40 |
| Signals / duplicates / pending | 42 / 0 / 0 | **43** / 0 / 0 (+1 = the refused BUY below) |
| Refused entries (dropped) | 6 | **7** (the same BUY) |
| Position | none (a resting order) | none ("Waiting for a swing") |
| Ledger check | OK | OK 04:45:05 |
| Errors | none | none |
| Risk setting | v1 $10 | v1 $10 |

The only non-candle engine events since activation are the start-up ones and the BUY:
- `process_start` (resumed), `mirror_created`, `mirror_activated`, `ledger_check` OK, `heartbeat` ok;
- `signal` rejected and `entry_dropped` (both `INSUFFICIENT_PAPER_CAPITAL`, 04:20:05).

No error or reset.

## 4. Mirror account health

| Check | Result (engine and Worker agree) |
|---|---|
| Account | `MIRROR-SOLUSD-5m-c826d785d58a4a39`, activated `2026-11-11T03:41:08.916Z` (once) |
| Candles | 733 (720 warm-up + 13 live), last 04:40, `late: false` |
| Sequence | engine `seq` 7; Worker `last_contiguous_seq` 7 = `max_seq_seen` 7 = `engine_last_seq` 7; missing 0 |
| Conflicts / refused / pending | 0 / 0 / 0 (outbox empty after every candle) |
| Resets / interruptions / observation gaps / skipped candles | 0 / 0 / none / 0 |
| Open hypothetical position | none (closed at 04:35); the Worker's `open_position_json` is null as well |
| Errors | none |

## 5. Candle continuity

13 consecutive 5-minute candles (03:40–04:40) were processed by both tracks:
- no gap, no duplicate, no re-processed candle;
- each processed 5.2–17.0 s after its close.

The mirror's candle count grew in step: 720 at activation → 733.

## 6. Trade counts (never added together)

| Category | Trades | LONG / SHORT | Gross P&L | Est. fees | Est. slippage | Modelled net (Ndax comparison) |
|---|---|---|---|---|---|---|
| Historical (warm-up replay) | 6 | 1 / 5 | +$29.36 | $57.03 | $8.57 | −$36.24 |
| **Live** | **1** | 1 / 0 | **+$2.24** | $7.43 | $1.86 | **−$7.05** |
| Catch-up | 0 | — | — | — | — | — |

The 6 historical records are **unchanged**: their payload hashes are identical to Stage C, and so are their totals.

## 7. First genuine live hypothetical trade — VERIFIED

| Field | Value | Check |
|---|---|---|
| Id / seq | `MIR-SOLUSD-5-2026-11-11T04:15:00Z-LONG` / **7** | unique; contiguous after 6 |
| Classification | **`live`** | the entry candle closed 04:20:00, after activation; processed 04:20:05 (`exit_late` 0) |
| Direction | LONG | the strategy's `OTE Long` order, pending since before 04:00 in both tracks (limit 82.93, stop 82.48, TP2 83.60) |
| Entry | candle **04:15** (O 83.11 H 83.11 L 82.78 C 82.79); price **82.93** | open-high-low path; the buy limit fills at its own price on the way down; inside the candle |
| Quantity / risk | 22.398377 SOL; `risk_usd` 10 | = $10 ÷ the strategy's unrounded stop distance; $10.08 at the tick-rounded levels (82.93 − 82.48), within one tick |
| Stop / TP2 | 82.48 / 83.60 | initial bracket of the order |
| Exit | candle **04:35** (O 83.09 H 83.13 L 83.00 C 83.01); price **83.03** | trailing stop (moved up while in trade), triggered on the way down; inside the candle |
| Exit reason | `TRAILING_SL` (`exit_kind` SL), exit R +0.224 | the strategy's own label |
| Gross P&L | **+$2.2398** | (83.03 − 82.93) × 22.398377 |
| Est. fees | $7.4308 (maker entry 0.20% + taker exit 0.20% on the slipped price) | recomputed by hand: equal |
| Est. slippage | $1.8597 (0.10% on the taker exit) | recomputed: equal |
| Net modelled | **−$7.0506** | gross − fees − slippage |
| Reference price | Kraken **83.01** at receipt (04:40:04), stored separately | **not used as the fill price** (fill 83.03) |
| Source candles | `entry_candle_json` and `exit_candle_json` stored; both prices within their OHLC | `provenance_complete` 1 |
| Provenance | engine release `0db082fbd044`, inputs `c826d785d58a4a39`, profile `solusd-5m`, payload hash `f71f4768…828b` | — |
| Mirror journal | `PNL:…04:15:00Z-LONG`, +2.23983767628362, `live` | equals the trade's gross |
| Funded response to the same signal | alert 11 `ENG-SOLUSD-5-2026-11-11T04:15:00Z-BUY`, qty 22.39837676 → **HTTP 422 `INSUFFICIENT_PAPER_CAPITAL`** ("Estimated $1854.36 exceeds SOLUSD PAPER balance available $10"); risk decision 9 (reference 82.79); engine `entry_dropped` | the funded track behaves exactly as before; no fill |
| Effect on funded balances | none | MAIN $90.00, SOLUSD $10.00 |

The trade was delivered in one request at 04:40:04 (HTTP 200).

## 8. Sequence and ledger reconciliation

- **Mirror:**
  - 7 trades, 7 distinct ids, sequence 1–7 contiguous;
  - 7 journal entries totalling **31.603816**, equal to the trades' gross 31.603816;
  - 0 entry/trade mismatches, 0 interruptions.
- **Funded:**
  - every wallet = the sum of its entries = funding + realized − fees;
  - available + reserved $100 = funding $100;
  - 0 FEE entries, 0 fills, 0 trades, 0 open positions;
  - risk v1 $10.

## 9. Funded-account isolation

Compared with the Stage C post-activation fingerprint (row-level SHA-256 of every table):

| Table | Change | Explanation |
|---|---|---|
| `alerts` | 10 → 11 | the refused BUY (§7): normal funded activity |
| `risk_decisions` | 8 → 9 | the same refusal |
| `activity_events` | 0 → 2 | the same signal's "Alert accepted" and "Risk rejected · INSUFFICIENT_PAPER_CAPITAL" log rows |
| `auth_sessions` | 3 → 4 | one dashboard sign-in (`POST /auth/login` 200 in the tail); not ledger data |
| `mirror_trades`, `mirror_entries`, `mirror_accounts` | 6 → 7, 6 → 7, heartbeat fields | the live trade |
| **Every other table** (`portfolio_wallets`, `portfolio_entries`, `paper_positions`, `paper_fills`, `trades`, `orders`, `strategy_settings`, `engine_state`, `backtest_results`, `app_meta` without the heartbeat, `d1_migrations`) | **byte-identical** | — |

- Wallet reconciliation, risk setting and schema definitions are identical.
- No mirror trade entered a funded table, and no mirror cost was deducted.
- The funded long-only and capital refusals behave as before.
- No restart or reset was caused by mirror processing.

## 10. Cloudflare usage (production evidence)

Worker tail, 04:04:10–04:59:31 UTC, 376 requests:

| Route | Requests | Status | CPU median / p90 / max | > 10 ms | Exceptions |
|---|---|---|---|---|---|
| `POST /webhook/engine-status` | 166 | 200 | 1 / 2 / 4 ms | 0 | 0 |
| `POST /webhook/engine-ledger` | 166 | 200 | 1 / 1 / 4 ms | 0 | 0 |
| **`POST /webhook/engine-mirror`** | **11** (one per candle) | 200 | **2 / 5 / 6 ms** | **0** | 0 |
| `GET /api/dashboard` | 21 | 200 | 7 / 15 / 20 ms | **6** | 0 |
| `POST /webhook/dry-run` | 1 | 422 (the refusal) | 14 ms | 1 | 0 |
| other (session, login, performance, backtest, health) | 11 | 200 / 401 (session check before login) | ≤ 5 ms | 0 | 0 |

- **Mirror:**
  - one request per candle, far below the 10 ms CPU limit;
  - deliveries carried ≤ 1 record each in this window (the cap is 25);
  - no retries and no authentication failures.
- **Observation (not caused by the mirror):** the existing funded dashboard route `/api/dashboard` (polled every 7 s
  while the dashboard is open) went above 10 ms CPU in 6 of 21 requests, max 20 ms. The one funded `dry-run` took
  14 ms.
  - All of them succeeded. Workers Free tolerates occasional overruns, but sustained ones can fail with error 1102.
  - Worth optimising separately (§15).
- **D1, 24 hours** (at 04:41):
  - 6,699 read and 1,526 write queries;
  - 10,323 rows read, 1,588 rows written;
  - size 262,144 bytes.
  - That is about 0.2% of the 5 M rows-read and 1.6% of the 100 k rows-written free quotas.

## 11. Dashboard

The protected dashboard needs the owner's sign-in, which was not requested or used here. The data behind it was
checked in D1 (sections 6–8).

**Pending owner confirmation** on Engine → Strategy Mirror:
- the hypothetical banner;
- health OK and reconciled; sequence 7 of 7; no observation gaps;
- Historical **6** (+$29.36 gross; −$36.24 modelled net, labelled "Estimates only");
- **Live 1** (+$2.24 gross; −$7.05 modelled net); Catch-up 0;
- no combined mirror and funded total;
- no open hypothetical position;
- the trade proof for `MIR-SOLUSD-5-2026-11-11T04:15:00Z-LONG` showing both candles, the separate reference price
  83.01 and three "Verified" checks.

The tail shows one sign-in and 21 `/api/dashboard` loads during the window, but no `/api/dashboard/mirror` request, so
the Strategy Mirror page itself was not opened then.

## 12. Errors, warnings and observation gaps

- **Errors:** none from the engine, Worker or D1 (0 exceptions, every engine request 200).
- **Observation gaps:** none (the PC stayed on).
- **Warnings:**
  1. `/api/dashboard` CPU above 10 ms on 6 requests (§10).
  2. In the shared development checkout, `wrangler d1 migrations list` shows `0006_events_and_push.sql` as pending.
     That file belongs to another session's separately approved work (Stage N1). The other session announced the
     production migration 0006 for about 05:20–05:23 UTC, **after this report's window**, with a D1 export that may
     briefly fail one engine heartbeat. It is a schema change, not funded or mirror data. It was not applied or
     touched by this monitoring.

## 13. Recovery actions

**None.** No critical condition occurred, and no rollback, mirror disable or restart was needed.

## 14. Remaining limitations

- **Short coverage:** 1 h 18 min, 13 live candles, 1 live trade. Longer behaviour is not yet shown.
- **Power-off and catch-up not yet observed in production.** The PC has been powered off most nights. The next
  power-off and sign-in should show:
  - both tracks resuming;
  - late candles classified `catch_up` and disclosed as an observation gap;
  - stale funded entries expired.

  This is tested in development, but not yet seen live.
- **No unattended monitoring mechanism exists.** Continuous checks need an approved scheduled job.
- **External TradingView parity is partial** (summary plus 5 listed trades). A CSV export is still needed.
- **The dashboard view** awaits the owner's confirmation.
- **Mirror results are hypothetical:** margin 0 and touch fills. With modelled costs both categories are negative.

## 15. Recommendation for the next milestone

1. **Continue observation** across at least one PC power-off and sign-in, to verify `catch_up` classification and the
   observation-gap disclosure in production. Ask the owner to confirm the Strategy Mirror page and the trade proof of
   seq 7.
2. **Reduce `/api/dashboard` CPU** (it reached 20 ms against the 10 ms free guideline) before adding load. This is a
   development task with its own approval.
3. **Get a TradingView "List of trades" CSV** for a common window, to complete external parity.

No new development or deployment milestone has been started by this report.
