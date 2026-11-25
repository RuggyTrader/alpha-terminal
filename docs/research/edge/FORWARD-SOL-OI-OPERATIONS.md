# Forward SOL OI reversal collector: operations (started 2026-11-25 22:34 UTC)

**READ-ONLY research collector, approved by the owner on 2026-11-25.**
* No wallet, keys, signing, PAPER trades or real trades.
* It does not touch the four bots, S3, P1, the ALPHA TERMINAL Engine task, production, the Worker or D1.
* Rules: `FORWARD-SOL-OI-PREREGISTRATION.md` (e0e2e68).
* Code: `engine/src/research/edge/forward/` (ca708a4).

## Configuration (verified before the start)

| Item | Value |
|---|---|
| Scheduled task | `ALPHA TERMINAL SOL OI Forward Observation (read-only)`, user-level (interactive) |
| Schedule | Every 5 minutes from 22:34 UTC (about 4 minutes past each 5-minute mark), for 365 days |
| Command | `conhost.exe --headless %USERPROFILE%\AlphaTerminal\research\sol-oi-forward\run.cmd` → `node --max-old-space-size=128 collect.mjs data` |
| Limits | Execution time limit 2 min; a new run is ignored while one is running (`IgnoreNew`); priority 7 (below normal); a lock file stops concurrent runs (stale after 10 min, logged) |
| Storage | `%USERPROFILE%\AlphaTerminal\research\sol-oi-forward\data\` (separate folder, not in Git) |
| Network (guarded, read-only) | **Binance:** `GET fapi.binance.com/fapi/v1/klines` and `GET /futures/data/openInterestHist`. **Jupiter:** `GET perps-api.jup.ag/v2/market-stats` (only at qualifying events). **Solana:** `getMultipleAccounts` (once a day). **GitHub:** IDL `GET` (once a day). Anything else is refused by the code. |

## Measured resource impact

| | Bootstrap run | Normal run |
|---|---|---|
| Time | 2.0 s | 0.44 s |
| Memory | | about 61 MB RSS (13 MB heap) |
| Requests | about 8 (once) | 2 Binance requests (candles requested at most 200 per page) |

* **Daily extras:** one Solana RPC read and one IDL fetch.
* **Disk:** state about 390 KB (rewritten atomically each run); logs about 50 MB a year.
* **Validation:** the core reproduces the research result exactly on 2022–26 data (499 events, +48.4 bps).

## Data files

All in `data/`.

| File | Contents |
|---|---|
| `hours.jsonl` | every hour boundary evaluated, with its classification and decision time |
| `events.jsonl` | strong moves (all groups); qualifying ones carry the primary / LATE flags, detection time, entry time, the data used, the Jupiter mark price and the borrow rate |
| `outcomes.jsonl` | 4 h outcomes (RESOLVED or UNRESOLVED), with the net under all three cost scenarios |
| `obs-YYYY-MM.jsonl` | raw fetched rows with fetch times |
| `gaps.jsonl` | periods without runs, and candle gaps |
| `errors.jsonl` | API failures, stale locks |
| `runs.jsonl` | every run |
| `alerts.log` | 6+ consecutive failures, or data lag over 30 min |
| `status.json` | counts and health only, **no returns** |

## Operating

**Status (counts only):**
```powershell
Get-Content "$env:USERPROFILE\AlphaTerminal\research\sol-oi-forward\data\status.json"
```

**Evaluation.** It computes returns only after the gate (≥ 60 primary events and ≥ 40 clusters):
```powershell
node "$env:USERPROFILE\AlphaTerminal\research\sol-oi-forward\evaluate.mjs" "$env:USERPROFILE\AlphaTerminal\research\sol-oi-forward\data"
```

**Stop (owner decision):**
```powershell
Disable-ScheduledTask -TaskName "ALPHA TERMINAL SOL OI Forward Observation (read-only)"
```

**Expected milestone.** The research rate was about 105 qualifying events a year (499 over 4.75 years), so 60 primary events take roughly **7 months (around late June 2027)**. That is longer if the PC is off at event times, because late events don't count.
