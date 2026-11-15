# Stage D completed: four bots, $100 PAPER portfolio, fully automatic (2026-11-15)

**PAPER only.** No real money, no leverage, no broker orders. The original strategy settings are unchanged.

## Production

| Item | Value |
|---|---|
| Engine release | `d9891d96f544` (commit `d9891d96f54490c47bc9284912956dce837b4cfb`), one process, all four bots |
| Worker and website | version `fb7254b6-89ec-4eeb-be93-7ea68d5fbe07` (commit `94ce7bf`; same Worker and website code as `d9891d9`) |
| Scheduled task | *ALPHA TERMINAL Engine*: enabled, S4U (no sign-in needed), boot and logon triggers, restart 999 × 1 min, no time limit |
| PC sleep on AC | never |

## Bots (all ACTIVE, LONG and SHORT, bot ledger, 0.20% per fill, fully collateralised SHORTs)

| Bot | Market | Profile (unchanged) | Wallet |
|---|---|---|---|
| ALPHA-01 | SOLUSD 1m | `solusd-1m` · `0932a1a0cfac03f9` | $20.000000 |
| ALPHA-02 | SOLUSD 5m | `solusd-5m` · `c826d785d58a4a39` | $20.000000 |
| ALPHA-03 | BTCUSD 1m | `btcusd-1m` · `d828caa44611ad73` | $20.000000 |
| ALPHA-04 | BTCUSD 5m | `btcusd-5m` · `a6336dad6ffaed70` | $20.000000 |
| MAIN | | | $19.968321 |
| **Total** | | | **$99.968321** |

**Funding:** exactly $100.00, with no deposit. The −$0.031679 is trade #1 (ALPHA-02, 13 Nov).

**Fleet setup:** one owner confirmation at 20:34:51 UTC, with request `7f04a4ea-…`. It recorded four transfers from MAIN, which are not profit:
- ALPHA-01: $20.00
- ALPHA-02: $10.031679
- ALPHA-03: $20.00
- ALPHA-04: $20.00

## Verified at 20:45 UTC

**Engine**
- Every bot has a fresh heartbeat with ledger check **OK** and no issues.
- Each bot processes its own market and timeframe: ALPHA-01 and ALPHA-03 every minute, ALPHA-02 and ALPHA-04 every 5 minutes.

**Pending orders:** one per bot that is working an order; no duplicates.

| Bot | Order |
|---|---|
| ALPHA-01 | LONG 71.13 |
| ALPHA-02 | LONG 71.09 |
| ALPHA-04 | LONG 64598.1 |

**ALPHA-02's LONG**
- **Not duplicated, not resized by the transfer.** The strategy re-issued it at the 20:30 candle because its stop moved from 70.72 to 70.7194. That is a normal strategy replacement, recorded as REPLACED.
- The new order was sized from the wallet at that moment: 0.279 SOL, $19.86.

**Stuck order:** the 06:45 SHORT left over from the PC outage is closed as **REPLACED**. It was never filled.

**Positions:** no open ledger positions.
- ALPHA-03 holds a position from its warm-up history.
- That position is never sent to the ledger. It closes inside the engine, and ALPHA-03 then trades normally.

## Automation

- **Windows startup:** the boot trigger starts the supervisor without sign-in. It verifies the pinned release and starts all four bots from their saved state. The startup without sign-in was verified on 15 Nov after a power-off.
- **Crash:** the supervisor restarts the engine after 30 s, and the task restarts the supervisor.
- **Internet outage:** candles are fetched again. Anything that closed more than 2 candles ago is never sent as a new entry. Exits are still delivered.
- **After every restart, reconciliation:**
  - an order the ledger holds but the engine no longer works is cancelled;
  - an order carried out of warm-up history is placed for real, as new;
  - positions are compared with the ledger.
- **Graceful stop, start and upgrade, without an administrator** (`bin\release.mjs stop | start | upgrade`):
  - The engine finishes its round, saves and exits; the supervisor does not restart it.
  - A stop request older than 15 minutes is ignored, so a reboot always brings the engine back.
  - Verified on the real production engine three times (20:32, 20:35 and 20:42). Each stop was clean within 4 s, each start took 3–6 s, and the task stayed enabled.

## Two engine defects found and fixed during Stage D

1. **Orphaned pending order after an outage** (`39f4292`): a replaced order is now always cancelled, and reconciliation cancels any order the engine no longer works.
2. **Warm-up order unknown to the ledger** (`d9891d9`): found right after the four-bot start (ALPHA-01 and ALPHA-04). Without the fix, a live fill of such an order would have been refused.

**Tests:**
- Engine: 269/269.
- Website: 229/229.
- Worker: 324/324 on a clean checkout.
- Each fix has a test that fails without it.

## Owner actions in Stage D

1. One administrator stop of the old engine. It was the last one needed; the old engine could not stop gracefully.
2. One passphrase: "Start the full fleet".

## Routine operation from now on

Nothing is required. Open the website to see what the bots have done. Your decisions:
- capital allocation (Bots → Allocate);
- reviewing performance;
- approving strategy improvements.

The emergency stop is in Settings.

## Production website check (21:00 UTC, signed in)

**Correct:**
- **Bots page:** four bots, $20.00 allocated each. Live scans: 1m bots at 20:59, 5m bots at 20:55. Pending orders match the ledger. No per-bot activation or settings controls.
- **Trades:** 3 pending, 0 open, 1 completed (trade #1), 17 rejected or cancelled.
- **Results:** −$0.03, one closed trade.
- **Home:** MAIN $19.97, SOL $40.00, BTC $40.00.
- **ALPHA-04 chart:** real BTCUSD 5m candles. The limit 64598.10, stop 64360.00 and target 65288.28 match the ledger.

**Found wrong:** ALPHA-03 is shown as "Position open" (Home, Bots), and its trailing-stop moves appear in Activity (1 break-even and 3 trailing events since 20:34). That position exists only in the engine (warm-up history); it is not a PAPER trade.

**Fixed (not yet deployed):**
- `d78603b`: badge and phase.
- `54ffd95`: Worker. Stop events are recorded only while the ledger holds the bot's position.
- Tests: website 230/230. Worker: the new test fails without the fix and passes with it.
