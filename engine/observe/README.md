# Local PAPER observation (48 h)

Runs the SOLUSD 5-minute engine (`ENGINE_PROFILE=paper-test`, $5 risk) against a **local development Worker with its
own throwaway D1**, for as long as you leave it running. PAPER only: `ENABLE_TRADING` stays `"false"`, there is no
broker code, nothing is sent to production, and the secrets are generated per run for the local Worker only.

## Before you start

- Keep the PC awake and powered for the whole period: **Settings → System → Power → Screen and sleep → "When plugged
  in, put my device to sleep after: Never"**, and leave it plugged in. A sleeping PC shows up in the report as a gap
  between monitor samples and as candles processed late.
- Windows updates can restart the PC. Pause updates for the period if you can (Settings → Windows Update → Pause).
- Logging off or restarting the PC stops the run. Closing the Claude app should not, but if it does, `status.mjs`
  will show `DOWN`; see "Restart after a stop" below.

## Commands (run from the `alpha-terminal` folder)

Start (creates `engine/observations/<timestamp>/`; refuses if a run is already active or port 8787 is busy):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File engine/observe/start.ps1
```

Quick check, any time:

```bash
node engine/observe/status.mjs
```

Full report so far (also written to `<run>/report.md`):

```bash
node engine/observe/report.mjs
```

Stop after 48 hours (processes end; all logs and data stay):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File engine/observe/stop.ps1
```

Then write the final report for the stopped run:

```bash
node engine/observe/report.mjs --run engine/observations/<timestamp>
```

Run the final report within ~12 hours of stopping: it compares every processed candle with Kraken's OHLC, and
Kraken only serves the last 720 five-minute candles (60 hours).

## What `status.mjs` should show while healthy

- worker `up`, engine `up`, `/health 200`
- dashboard bot `ONLINE`, heartbeat under ~2 minutes old, ledger check `OK`
- last candle no more than ~5–10 minutes old, live candle count rising by 12 per hour
- errors 0, or only occasional `market-data` / `sync` errors that do not repeat (Kraken or network blips)

## What is recorded (in the run folder)

| File | Contents |
| --- | --- |
| `engine-data/audit-SOLUSD-5m.jsonl` | Every processed candle (OHLC, strategy status and events), every signal outcome (accepted / rejected / skipped with code and reason), errors, ledger-check changes, heartbeat result changes, process starts and stops, data-gap re-warms |
| `metrics.jsonl` | Once a minute: CPU % and RAM of the engine and Worker process trees, system free RAM, `/health`, the dashboard's bot state, the engine's last candle, outbox counts and last error |
| `engine.log`, `worker.log`, `monitor.log` | Raw process output |
| `restarts.log` | Every start and exit of each restart loop |
| `d1/` | The local D1: alerts, risk decisions, orders, paper fills, positions and trades |
| `report.md` | Written by `report.mjs` |
| `secrets.env`, `engine.env` | Per-run local test secrets and engine settings (git-ignored; not production's) |

The report checks: missing or repeated candles, candles that differ from Kraken, every signal and its Worker result,
every paper fill and trade in D1, engine-vs-ledger discrepancies, heartbeat and dashboard states, restarts, gaps in
monitoring, and CPU/RAM averages and peaks. It only reports what was recorded; if no trade happened, it says so.

## Restart after a stop

If the PC restarted or the run shows `DOWN`, run `stop.ps1` (it cleans up and marks the run stopped), then
`start.ps1` for a new run. The old run's folder stays for the record. The engine itself is restart-safe (state is
saved after every step), and each loop restarts its process 10 seconds after it exits.

## Dashboard

The local dashboard is at http://127.0.0.1:8787 (build the frontend first with `npm --prefix frontend run build`
if you want the page; the API works without it). Its sign-in passphrase is `DASHBOARD_PASSPHRASE` in
`<run>/secrets.env`, a throwaway value for this local Worker only.
