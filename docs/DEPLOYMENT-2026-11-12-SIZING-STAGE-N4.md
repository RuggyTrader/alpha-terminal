# Stage N4 — combined engine release: affordable funded sizing + mirror ENTRY records (2026-11-12)

**Outcome:** activated and verified.
- **Release:** engine **`af924ffa4703`** (commit `af924ffa4703ffc677c3f81dd5ee7eb7178e067d`), active since the controlled
  restart at **2026-11-12 04:51:14 UTC**.
- **Process:** PID **8428**, one chain: conhost 33716 → supervisor 32704 → cmd 24284 → node 8428.
- **Result:** funded SOLUSD PAPER now sizes with **1% of available equity, a hard $10 maximum target risk**, fully paid,
  long-only. The Strategy Mirror keeps its fixed $10 risk and its LONG/SHORT behaviour. Mirror ENTRY records are on.

**Unchanged:** Worker `1b51170c`; D1 schema 6; the SOLUSD wallet ($10) and MAIN ($90); no capital added; the strategy and
its inputs; costs `none`; trading disabled; BTC/ETH and Multi-Crypto V2 inactive.

## 1. Preflight (04:45–04:50 UTC)

| Check | Result |
|---|---|
| Worker | `1b51170c-4f9d-41c0-8284-fa8ab61eac81` at 100% |
| Engine | `current` = `0db082fbd044` (files verified), PID 15952; launcher `6b70cc9` verified |
| D1 | schema 6; "No migrations to apply"; wallets reconcile: MAIN $90, SOLUSD $10, ETHUSD/BTCUSD/HYPEUSD/KAITOUSD $0 |
| Funded ledger | 3 entries, 0 FEE, 0 fills, 0 trades, 0 open positions; alerts 16, orders 4, risk decisions 14; risk SOLUSD v1 $10 APPLIED |
| Mirror | 11 trades, seq 1–11 contiguous (last contiguous = max seen = engine last = 11), 0 conflicts, journal $15.474502 |
| Engine state | flat, no resting order, 49 signals, 0 pending, ledger check OK, `lastError` null, inputs `c826d785d58a4a39`, sizing **fixed** |
| Notifications | 1 subscription (iPhone / iPad, updated 04:37:12), 6 trade events, 2 deliveries `sent`, cursors `push_planned=6` |
| Fresh candles | on time (04:40 candle processed 04:45:05) |
| Safety | PAPER; `ENABLE_TRADING=false`; `PAPER_COST_PROFILE=none`; no `ENGINE_MARKETS` (BTC/ETH off) |

## 2. Release `af924ffa4703`

- **Clean checkout:** detached worktree at the exact commit, `core.autocrlf false`, 0 changes.
- **Prepared:** `release.mjs prepare` → **18 files**. Every file is **byte-identical to the rehearsed copy**.
- **Compared with `0db082fbd044`:**
  - **new:** `cli/run-markets.mjs`, `cli/run-single.mjs`, `instruments.mjs`, `markets.mjs`;
  - **changed:** `cli/run.mjs`, `config.mjs`, `mirror.mjs`, `runner.mjs`, `sizing.mjs`, `ote.mjs`.
- **Strategy unchanged.** Ignoring line endings, the ONLY `ote.mjs` difference is the sizing-symbol line in
  `createState`. `broker.mjs`, `indicators.mjs`, `kraken.mjs`, `sync_check.mjs` and `profiles/solusd-5m.env` are
  byte-identical.

## 3. Backups and configuration

- **Private backups** (outside git), `%USERPROFILE%\AlphaTerminal\backups\engine-state-before-N4-2026-11-12T04-47-58Z\`:
  - `engine.env.before-N4`, state, mirror and audit at 04:47:58;
  - the **at-stop snapshot** taken after the old processes had exited: `*.at-stop.*`, last candle 04:45, 1,625 candles,
    0 pending, mirror seq 11, outbox 0.
  - Every file parses (JSON / JSONL), so no partially written state; `SHA256SUMS` verified (7 files).
- **`engine.env`:** the diff against the backup is exactly the four approved lines:
  ```
  ENGINE_SIZING=percent
  ENGINE_RISK_PCT=1
  ENGINE_MAX_RISK_USD=10
  ENGINE_MIRROR_EVENTS=on
  ```
  No duplicate keys. Loading it with the new release gives: percent, `riskPct 1`, **`maxRisk 10` (numeric, not
  "setting")**, symbol SOLUSD, `mirrorEvents true`, funded true, no markets list.
- **`validate`:** ok; profile solusd-5m; risk 10; long and short on; sizing percent; inputs `c826d785d58a4a39`; production
  Worker endpoint; state resumable (last candle 04:40, 1,624 candles).
- **`selftest`:** ok. Throwaway state, sync off; 720 real Kraken candles; mirror activated after warm-up; the same strategy
  status as the live engine; release unchanged.

## 4. Controlled restart (right after the 04:45 candle and its ledger check)

1. **04:50:05:** 04:45 candle processed; **04:50:46** ledger check.
2. **04:50:51:** `activate --release af924ffa4703`; previous = `0db082fbd044`.
3. **04:50:52:** `schtasks /End`, then `taskkill /PID 26120 /T /F`. Terminated 15952, 20960 and 26120.
4. **04:50:56:** confirmed none of 21696 / 26120 / 20960 / 15952 remained; `status`: engine not running. The lock file
   still named the dead PID 15952 (a stale lock, which the engine takes over only when that PID is not alive).
5. **04:51:13:** `schtasks /Run`. Exactly **one** chain: conhost 33716 → supervisor 32704 → cmd 24284 → node **8428**.
   The lock now holds 8428. The only other node process (2928) is an unrelated desktop runtime that predates the
   restart.
6. **Supervisor log:** "active release af924ffa4703 … verified; profile solusd-5m, risk $10; state … (last candle
   2026-11-12T04:45:00Z)". The engine log shows the secret only as `(set)`.

## 5. State resumption

| | At stop | After restart |
|---|---|---|
| Audit | — | `process_start` pid 8428 **`resumed: true`**, ledger check OK 04:51:15, heartbeat ok |
| `startedAt` / `warmedUpAt` | 2026-11-09T01:28:50.662Z | **same** (no reset, no warm-up) |
| Resets | 0 | 0 |
| Last candle / candles | 04:45 / 1,625 | 04:45 / 1,625, then 04:50 → 1,626 on schedule |
| Signals / pending | 49 / 0 | 49 / 0 |
| Funded sizing | fixed | **percent, riskPct 1, maxRiskUSD 10**, capital **$10** (ledger), limits $5,000 / $10,000 / $25,000 / 5, exposure 0 |
| Mirror | seq 11, delivered 11, outbox 0, activated 2026-11-11T03:41:08.916Z | **same** account, seq 11, sizing **fixed**, risk $10 |
| Inputs hash | `c826d785d58a4a39` | same |

## 6. Funded and mirror reconciliation (D1, row-level SHA-256)

- **D1 at 04:57:49** compared with the preflight snapshot (04:47:00): every table is identical except `mirror_accounts`, whose
  row advanced with live candles (1,021 → 1,023).
- Wallets reconcile; the risk setting is identical; no schema object changed; 0 FEE.
- The mirror still has 11 trades, seq 1–11, 0 conflicts, journal $15.474502.
- The funded ledger is still empty of fills, because no long setup has filled yet (section 7).

## 7. First affordable funded trade — **NOT YET OBSERVED**

- **No qualifying SOLUSD LONG has filled since activation.** None was forced.
- **The setups so far were SHORT:**
  - **05:00:** setup 83.35 → 82.75, short limit 83.17, stop 83.37.
  - **05:40:** extended to 82.57, limit 83.12.
- The funded track skipped both **before sending anything**: `ORDER_SKIPPED SHORT_NOT_ALLOWED` ("funded PAPER is
  long-only"), capital $10, no alert, no refusal.
- The mirror placed the same short at its fixed $10 risk. It filled at the 06:20 candle (section 8).
- **Observation summary, 04:51–06:25 UTC:**
  - 19 candles since the restart, 0 late, 0 errors, every ledger check OK, 0 resets;
  - 49 signals, 0 pending;
  - funded status "Waiting for OTE tap" at 06:20. No funded fill: there was no long fill and shorts are skipped.
- **The dashboard confirms the live configuration:** `mode percent`, `risk_pct 1`, `max_risk_usd 10`, `capital_usd 10`,
  `symbol SOLUSD`.
- What remains to verify on the first long: actual capital, quantity ≥ 0.05 SOL sized from it, cost and price buffer,
  actual stop risk, the Worker's buying-power check, the accepted entry, the reservation and reconciliation, the exit,
  the realized PAPER P&L, and no duplicate or orphan exit. The exact checklist is in the N4 proposal §6 step 7.

## 8. Notifications

- `ENGINE_MIRROR_EVENTS=on` is active. **The first genuine live mirror ENTRY is recorded exactly once:**
  - **Fill:** the mirror's SHORT filled on the 06:20 candle; mirror seq 11 → **12**, delivered, outbox 0.
  - **ENTRY record:** `mirror_open_events` #1, `MIR-SOLUSD-5-2026-11-12T06:20:00Z-SHORT:ENTRY`, seq 12, SHORT
    40.75874105 SOL @ 83.12, classification **live**.
  - **Event:** `trade_events` #7 `MIRROR_ENTRY`, ref `MIR-SOLUSD-5-2026-11-12T06:20:00Z-SHORT`, live, created
    06:25:02.270 (about 5 s after the candle was processed).
  - **Push:** `push_deliveries` #3 for subscription 1, status **`sent`**, 1 attempt, 06:25:02.415. Cursors:
    `mirror_open_events=1`, `push_planned=7`.
  - **Not yet confirmed:** that the iPhone displayed it (owner to confirm).
  - It is labelled hypothetical (Strategy Mirror), not a funded PAPER entry.
- **Delivery status can only show push-service acceptance** (`sent` = Apple's push service accepted it). Actual
  receipt on the iPhone can only be confirmed by the owner.
- Historical and catch-up floods stay disabled: event cursors start at the current end, and only `live` events notify.

## 9. Health and resources

- **Candles:** every candle since the restart was processed on time; 0 `step failed`; ledger checks OK; `lastError`
  null.
- **Worker** (`wrangler tail`, 04:57–05:07, 67 requests): 0 errors, 0 exceptions.

  | Endpoint | CPU median | CPU maximum |
  |---|---|---|
  | `engine-status` | 6 ms | **8 ms** |
  | `engine-ledger` | 2 ms | 2 ms |
  | `engine-mirror` | 7 ms | 7 ms |

  `engine-status` is below N5's 13 ms peak; the N5 CPU watch item has not recurred. The owner's dashboard was viewed
  during the window, also with no errors.

## 10. Known limitations

1. **Stale "last sizing" on the dashboard.** The sizing panel's last-order block still shows the old fixed-mode SHORT
   (12.21 SOL, `current: false`, "from an earlier candle") under the new `1% OF EQUITY · MAX $10` heading. It was saved
   by the old release. It is replaced at the next sized long; skipped shorts do not replace it. Production state was not
   edited to clear it.
2. **N5 wording issues** (fixed-mode sentence, "Accepted for sizing.") remain until the next frontend change.

## 11. TradingView follow-up

- The 14:20 UTC trade was taken by the mirror (seq 11) and refused by the funded account (fixed sizing, $2,578 vs $10).
- **Correction to the 14:50 explanation:**
  - The first divergence was at the **14:25 candle**. `abandonPosition()` (unchanged strategy code) reset the funded
    engine to flat (`dir = 0`) after the 14:25:05 refusal.
  - On that candle the 14:00 high of 84.70 was confirmed as a swing high. The flat funded engine opened a new leg
    83.52 → 84.70 (limit 83.87 at 14:40, filled 14:50).
  - The mirror and TradingView were still in the 14:20 trade (`triggered`), so the pivot only updated `lastHigh`.
  - After their 14:35 exit the pivot had already been confirmed, and new legs are only created on the bar where a pivot
    is confirmed. So they went to "Waiting for a swing".
  - The 14:50 trade is therefore funded-only. TradingView should not show it.
- With affordable sizing, longs are no longer refused, so this divergence no longer arises for longs. Funded shorts stay
  skipped (long-only ledger), a disclosed difference from TradingView.
- **Full external parity is NOT claimed.** The owner's current TradingView List of Trades row for that trade has not been
  compared yet.

## 12. Rollback (not used)

| Problem | Action |
|---|---|
| Entry records | `ENGINE_MIRROR_EVENTS=off`, restart the same release (rehearsed D1) |
| Engine release | `release.mjs rollback --root R` (→ `0db082fbd044`), restart with the fail-safe rules of N4 proposal §10.2: keep `ENGINE_SIZING=percent`, `ENGINE_RISK_PCT=1`; no SOLUSD wallet above $1,000; never fixed sizing |
| Worker | unchanged in N4 |

Never restore D1; never discard trade records.
