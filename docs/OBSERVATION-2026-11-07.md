# Observation 20261107-130946: SOLUSD 5m, PAPER, 24-hour validation

**Result: PASS (reliability).** 26 h 20 m of continuous evidence, no downtime, no missing or repeated candles, no
price differences against Kraken, no restarts, one transient network error that cost nothing, and a complete PAPER
trade whose quantity matched the engine. The caveats below (fill prices, long-only, order limit, unfunded portfolio)
concern what the PAPER ledger models, not reliability, and are reported rather than counted as a pass.

The run was planned for 48 h. On 2026-11-08 the success criterion was reduced to 24 h. The run's own `report.md`
still says "Planned duration covered: NO (26.3 of 48 h)" because it measures against the 48 h written into
`run.json` at start; that file and the run data were not edited.

## Run

| | |
|---|---|
| Folder | `engine/observations/20261107-130946/` (git-ignored; holds per-run test secrets) |
| Profile | `solusd-5m`, risk $10 per trade (settings v1, engine confirmed at 18:10:10 UTC) |
| Started | 2026-11-07 18:09:50 UTC (Worker), engine 18:10:10 UTC |
| Stopped | 2026-11-08 20:30:34 UTC with `engine/observe/stop.ps1` (all three loops ended; port 8787 freed) |
| Observed span | 26 h 20 m, all of it counted: no gap anywhere (below) |
| Environment | Local `wrangler dev` Worker with its own throwaway D1; no production, no broker order |

## Evidence

**Uptime and gaps.** 1,581 monitor samples, one a minute; the largest interval between samples was 61 s (a gap is
>150 s). Engine started once, Worker started once, 0 loop exits, 0 restarts. Windows logged no shutdown, sleep,
hibernate or power loss between start and stop (System log events 41/42/107/109/1074/6006/6008). One "system time
changed" event at 09:30:37 UTC was a time sync with a 0 ms change. **Downtime: none. Successful hours: 26 h 20 m.**

**Candles.** 316 live completed candles, 2026-11-07 18:10 to 2026-11-08 20:25 UTC: 0 missing, 0 processed twice.
Every one was compared with Kraken's public OHLC fetched after stopping: 316 of 316 present, 0 OHLC differences.
Each candle was processed 5.1–11.0 s after it closed (median 5.2 s; none over 30 s).

**Errors and recovery.** One engine error: `market-data: fetch failed` at 2026-11-08 14:25:56 UTC, between candles.
The next candle (14:25) was processed on time at 14:30:05; nothing was missed or re-warmed. Worker `/health` 200
in 1,581 of 1,581 samples (median 11 ms, max 178 ms).

**CPU and RAM** (process trees; CPU % of one core). Engine: avg 0.1%, max 0.3%; RAM avg 96 MB, max 160 MB,
67 MB at the end (no growth). Local Worker (`workerd`): avg 3.4%, max 6.3%; RAM avg 527 MB, max 813 MB, 557 MB at
the end. The PC's free memory fell to 225–935 MB in 9 samples between 05:57 and 06:33 UTC (other software); the
run was unaffected (all candles on time, `/health` 200).

**Strategy and PAPER signals.** The engine traded 8 times (5 shorts, 3 longs; engine P&L +$2.39 at $10 risk) and
finalised 16 signals, none pending at stop:

| Outcome | Count | Detail |
|---|---|---|
| SELL rejected `NO_POSITION` | 5 | ALPHA PAPER is long-only (short selling disabled) |
| BUY rejected `MAX_ORDER_NOTIONAL` | 2 | $6,196.81 and $5,376.21 orders against the $5,000 limit (tight stops at $10 risk) |
| BUY accepted | 1 | 2026-11-08 13:45 candle, 37.84004565 SOL |
| CLOSE accepted | 1 | 14:20 candle; position closed |
| CLOSE skipped `ENTRY_NOT_IN_LEDGER` | 7 | exits of the 7 refused entries; never sent |

D1 agrees: 9 alerts (2 dry-run, 7 rejected), 2 orders (`dry_run_accepted`, no broker id), 2 fills, 1 position
(closed), 1 ALPHA PAPER trade. The engine's ledger check was `OK` throughout and the report found no engine-vs-ledger
discrepancy.

**Complete PAPER trade.** LONG 37.84004565 SOL. Engine: filled at its limit 89.14, stopped at 89.02, −$4.54.
Ledger: 89.11 → 89.01 (Kraken's price when each signal arrived, 5 s after the candle), −$3.78. Same quantity;
prices and P&L differ by design, because the ledger fills at the live reference price, not at the strategy's
limit or stop.

**Dashboard state.** ONLINE in all 1,581 samples, heartbeat never older than 27 s; the engine was alive in every
sample, so ONLINE was correct each time. STALE and OFFLINE did not occur live. After stopping, a throwaway Worker on
a copy of the run's D1 reported the stopped engine as described in "Post-stop dashboard check" below, and the sync
test sets the heartbeat age to 15 min and 2 h and checks STALE and OFFLINE.

**Portfolio.** The PAPER portfolio was not funded during the run (all wallets $0), so the trade used the
unfunded path, with no wallet reservation. Wallet reserve/release was therefore not exercised live. It is covered by
an isolated test (`worker/test/engine_sync.test.mjs`, "funded ALPHA PAPER portfolio"). There, the real engine
replays real Kraken SOLUSD 5m candles into a local Worker with $5,000 in SOL. The BUY reserves qty × fill price
from SOL, and the CLOSE releases it and credits the ledger P&L. Balances equal the sum of their history entries at
each step, and the dashboard's consistency check passes.

## Post-stop dashboard check

Throwaway Worker on a copy of the run's D1 (originals untouched), last heartbeat 20:30:25 UTC. The Worker rule is:
ONLINE within 12 min (two candles + 2 min), STALE within 30 min, then OFFLINE.

| Checked at (UTC) | Heartbeat age | Dashboard |
|---|---|---|
| 20:34:08 | 3 min 43 s | ONLINE (correct: within 12 min) |
| 20:38:05 | 7 min 40 s | ONLINE (correct) |
| 20:43:17 | 12 min 52 s | STALE (correct: past 12 min) |
| 21:01:09 | 30 min 44 s | OFFLINE (correct: past 30 min) |

## Preservation

Both observation folders (this run and `20261104-193730`) were hashed with SHA-256 after stopping (76 files). The
analysis used read-only queries on copies. `report.md` was rewritten by `report.mjs --run` as designed; nothing
else in either folder was changed.

## What this does not show

- PAPER results equal to the strategy's: 5 of 8 trades were shorts and 2 of 3 longs exceeded the $5,000 order
  limit, so 1 of 8 engine trades reached the ledger.
- Behaviour across a PC shutdown: none happened during this run (the earlier run ended at one).
- Anything about production: everything ran locally.
