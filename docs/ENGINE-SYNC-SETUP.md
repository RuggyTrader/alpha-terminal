# ALPHA PAPER without Alpaca, and secure engine sync (prepared 2026-11-08)

Deployed 2026-11-09 as `b1c87441` (see the deployment record); engine connected below.

## What changed

**ALPHA PAPER no longer depends on Alpaca.** The dry-run webhook (`/webhook/dry-run`, used by the engine and by
TradingView alerts) used to fetch Alpaca's `/v2/account` before every signal and refused everything when that
failed. That is why production answered `BROKER_AUTH_FAILED`. Now its risk account comes from D1:

| Risk input | Before | Now (dry-run webhook) |
|---|---|---|
| Positions, exposure | ALPHA PAPER ledger | unchanged |
| Account active / not blocked | Alpaca account | the ledger (always active; D1 unreadable → 503, nothing approved) |
| Buying power | Alpaca non-marginable buying power | the symbol's strategy balance, available funds; unfunded = $0 |
| Daily loss | Alpaca equity − last equity | ALPHA PAPER P&L realized since 00:00 UTC + open unrealized at the last mark |
| Shorting | Alpaca flag | never (the ledger is long-only; `SHORT_SELLING_ENABLED` stays false) |

Unknown is refused, never assumed: a missing balance row or an open position whose last mark failed gives
`ACCOUNT_DATA_UNAVAILABLE`. Order notional ($5,000), position exposure ($10,000), total exposure ($25,000),
open positions (5) and the daily loss limit ($2,000) are enforced as before. CLOSE and position-reducing SELL
are never blocked by account checks.

**Behaviour change:** before, a BUY with an unfunded portfolio was accepted without any balance. Now an unfunded
strategy balance is $0, so the BUY is rejected `INSUFFICIENT_PAPER_CAPITAL` until you allocate PAPER capital to
it (Portfolio page: Add PAPER capital, then Transfer to SOL). Every strategy-balance BUY now reserves its position
value; the portfolio gate stays as a second check.

**Alpaca stays optional.** `/api/risk/preview`, the broker panel on the dashboard and the PAPER execution path (still
disabled, `ENABLE_TRADING=false`) use Alpaca PAPER exactly as before when keys are set. No new broker request
exists anywhere. `/health` now reports `alpha_paper_account: "D1"`.

Code: `worker/src/trade_core.ts` (`RiskAccount`, `alpacaRiskAccount`, the ledger branch of `runRiskEvaluation`),
`worker/src/paper_ledger.ts` (`ledgerAccount`), `worker/src/portfolio.ts` (reserve and gate for every strategy
balance), `worker/src/index.ts` (`/health` field). No migration.

## Tests (isolated local Workers, no Alpaca keys)

Every Worker test now starts its Worker with blank `ALPACA_KEY`/`ALPACA_SECRET`, so none of them can reach Alpaca:
`paper_ledger`, `pine_pipeline` (real Kraken prices), `portfolio` (incl. concurrent fills), `engine_sync` (the
real engine replaying real Kraken candles: funded trade, restart, forced resend, outage, STALE/OFFLINE) and two new
files:

- `paper_account.test.mjs`: real Kraken SOLUSD closes from 2026-11-05 (95.11 at 14:20, 90.37 at 15:20 UTC). BUY
  10 SOL on a $5,000 SOL balance, a failed mark blocks new entries, CLOSE returns the −$47.40 loss to the SOL
  balance, then the daily loss limit (set to $25 in this test Worker only) refuses the next BUY, and a missing
  balance row is refused.
- `sync_setup.test.mjs`: the setup tool below against a local Worker.

## Secure secret setup (you run this; it changes production)

`engine/src/cli/sync-setup.mjs` handles the secret so it never appears on screen, in a command line, in logs or in
git. It is generated in the process (32 random bytes), passed to `wrangler secret put WEBHOOK_SECRET` on stdin, and
written only to `engine/.env` (git-ignored).

**Who uses the current secret?** Production D1 shows 10 webhook alerts, all manual tests (SPY/TSLA, strategy
"TEST"/"RISK-TEST") on 2026-10-31 03:18–04:22 UTC, none since, and no engine heartbeat ever. Requests with a wrong
secret are not stored, and a TradingView alert that never fired leaves no trace, so check TradingView → Alerts for
any alert whose webhook URL is `alpha-terminal-api.mattledger787.workers.dev`. If one exists, its message must get
the new secret after rotation (or delete it).

Order (from `engine/`):

1. **Deploy this Worker first** (needs your authorization). Until then `check` fails on "Worker computes ALPHA
   PAPER risk from D1", and every engine signal would still be refused for the broken Alpaca keys.
2. `node src/cli/sync-setup.mjs rotate --confirm-no-other-clients`. This stores the new secret in Cloudflare and
   `engine/.env` (`ENGINE_SYNC` stays off), then runs the checks. Cloudflare publishes a new Worker version with
   the same code when a secret changes.
3. `node src/cli/sync-setup.mjs check`. Every line must be PASS: profile `solusd-5m`, risk $10, no engine running,
   PAPER with trading disabled, D1 account, secret accepted, engine and ledger positions match.
4. `node src/cli/sync-setup.mjs enable`. This sets `ENGINE_SYNC=on` only if every check passes.
5. Fund the SOL balance on the website (e.g. $5,000 PAPER: at $10 risk the historical positions were up to ~$8,400,
   and orders above the $5,000 limit are refused anyway).
6. `node src/cli/run.mjs --once`: one engine, warm-up, first heartbeat. The dashboard should show ONLINE and the
   SOL risk "Applied (engine confirmed) $10.00 · v1". Then `npm start` for continuous running.

The engine keeps its saved state in `engine/data/production` (empty now, so it starts flat), its lock file
prevents a second instance, and every signal id is unique, so a resend never applies twice.

`check` compares the engine's saved state with the production ledger (`engine/src/sync_check.mjs`) and fails
closed. Both flat passes. A held position passes only when symbol, direction, quantity (8 decimals), open status
and opening alert id all agree, and the engine's own record of that entry was accepted. A matching id with any
other difference fails. So does a position on one side only: the engine would send an unmatched CLOSE, or
production would hold a position the engine never closes. An unreachable, unreadable or incomplete ledger answer
fails, as does an unreadable or malformed state file. Tests: `engine/test/sync_check.test.mjs` (30 cases) and
`worker/test/sync_setup.test.mjs` (against a real open position in a local Worker).

## Rollback assessment

- No schema change; production D1 stays on migration 0003.
- Rehearsed locally: this code opened a funded position, the production version `361c030` then closed it
  (reservation released, P&L credited) and opened/closed another; this code again: consistency check OK.
  Rolling back is therefore safe with or without open funded positions between these two versions.
- After a rollback, production again needs Alpaca for every signal, so with the current keys every signal is
  refused (`BROKER_AUTH_FAILED`) until rolled forward or valid PAPER keys are set.
- After any rollback or redeploy, run `node src/cli/sync-setup.mjs check`; if the secret is no longer accepted,
  stop the engine and run `rotate` again.
- Command: `npx wrangler rollback a1ab344a-388e-4840-956f-d19a3db9f1ce` (from `worker/`).

## Not changed

Strategy settings and the `solusd-5m` profile, risk limits, `ENABLE_TRADING=false`, short selling disabled, the
Cloudflare plan. Nothing was deployed and no secret was changed.

## Connected 2026-11-09 ~01:30 UTC

Production code unchanged (`a8b06db`); no redeploy. No TradingView, no Alpaca in the engine path.

- Before: `/health` PAPER, `enable_trading: false`, `alpha_paper_account: "D1"`; production version `b1c87441`.
  The current secret had no other client: D1 still held only the 10 manual test alerts of 2026-10-31, and the owner
  confirmed no TradingView alert targets the Worker.
- `sync-setup rotate --confirm-no-other-clients`: new 256-bit `WEBHOOK_SECRET` in Cloudflare and `engine/.env` only
  (git-ignored, never printed). The secret change published Worker version **`8077719f-c6fb-45a8-82ba-9260f78f12a3`**
  (same code as `b1c87441`).
- `sync-setup enable`: all 9 checks PASS (profile `solusd-5m` SOLUSD 5m, $10 risk, website setting confirmation on,
  https address, no engine running, PAPER with trading disabled, D1 account, secret accepted, both flat), then
  `ENGINE_SYNC=on`.
- Backtest: `simulate.mjs --candles data/SOLUSD-5m-25d.json --profile solusd-5m --history-from 2026-10-19T00:00:00Z
  --upload`, byte-identical (apart from the timestamp) to the verified run: hash `38a207c76ff23287`, 69 trades,
  5,670 real Kraken candles (716 compared with Kraken OHLC, 0 mismatched). Stored only in `backtest_results`; after
  the upload production still had 0 fills, 0 positions, 0 portfolio entries, the same 10 alerts, all wallets $0.
- `run.mjs --once`: 720 Kraken candles of warm-up; its 36 historical signals are recorded locally and never sent;
  engine flat; ledger check OK; website risk v1 $10 → **APPLIED** (engine confirmed).
- Continuous engine: `engine/deploy/run-windows-production.ps1` (first run from a terminal; see below; log
  `engine/data/production/engine.log`). Dashboard: OTE engine ONLINE, last candle within the last poll; SOL page
  "Applied (engine confirmed) $10.00 · v1", simulator showing the backtest above.
- "ENGINE STOPPED" under System mode is the separate live-execution route (`/webhook`), which stays stopped; the
  engine uses `/webhook/dry-run`. The home page's top card still shows the optional Alpaca PAPER broker (N/A).

**Until the SOL balance is funded every engine BUY is refused (`INSUFFICIENT_PAPER_CAPITAL`)**, so no production
PAPER position can open; a refused entry never produces a CLOSE. Each refused signal is listed under alerts. Funding
the SOL balance on the Portfolio page is what authorizes PAPER trading. From then on, the engine opens and closes
positions there by itself.

### Running at every sign-in (owner installs)

Two scripts in `engine/deploy/` (reviewed and tested 2026-11-09):

- `run-windows-production.ps1`, the supervisor. It reads only `ENGINE_DATA_DIR`, `ENGINE_SYMBOL` and
  `ENGINE_INTERVAL_MIN` from `engine/.env`; the engine itself loads the rest, including the secret, which never
  appears on a command line, in the task or in a log (the engine logs `"webhookSecret":"(set)"`). It runs one engine
  and restarts it 30 s after any exit or crash. Duplicates: one supervisor per data folder (a named mutex; a second
  one logs a refusal and exits), and it never starts an engine while another live engine holds the folder's lock
  (e.g. a manual `npm start`); a lock left by a crash, even one whose process id Windows has reused, is removed.
  Logs in `engine/data/production/`: `engine.log` (engine output) and `supervisor.log` (starts, restarts, refusals),
  each rotated at 20 MB. All git-ignored.
- `windows-task.ps1 install | status | stop | uninstall` manages the per-user scheduled task "ALPHA TERMINAL Engine":
  triggers at your sign-in and 3 minutes later (see the 2026-11-09 fix below), runs as you with limited rights and a
  hidden console (`conhost --headless`), only while you are signed in, restarted by Task Scheduler if it fails to start. `install` refuses while any engine
  for this folder is running and records the full path of `node.exe` (rerun `install` after moving Node). `stop`
  ends the supervisor first, then the engine (a hard stop is safe: state is saved atomically after every step and a
  re-sent signal is recognised as a duplicate). `uninstall` stops and removes the task. Nothing else on the PC is
  changed (no power, firewall or security settings, no administrator rights).

Tested on an isolated copy of the engine (sync off, its own data folder, real Kraken candles, nothing sent to the
website): the supervisor starts exactly one engine; a second supervisor refuses; a killed engine is restarted; `stop`
leaves nothing running; a stale lock with a reused process id does not block a start; beside a manually started
engine the supervisor waits instead of starting a second; `install` refuses while an engine runs. With a temporary
task "ALPHA TERMINAL Engine TEST": install (sign-in trigger, your account, limited, IgnoreNew), status, a second
start request (still one supervisor), stop, start again, uninstall (task removed). Not exercised: an actual
sign-out/sign-in.

### 2026-11-09: task launch held suspended (fixed)

The owner's installed task launched `powershell.exe` twice (20:56 and 21:34 local) and the process stayed
created-suspended: one thread in the Suspended wait state, 0 CPU, no `supervisor.log` line, so no engine ran. The
Task Scheduler history and Defender logs are empty, and a test task with the same launch on an isolated engine copy
started normally (also with Windows Terminal open), so the exact trigger is not proven. The likely mechanism is
Windows 11's console handoff to the default terminal (Windows Terminal: the console program is created suspended
until the terminal attaches it).

Changes in `windows-task.ps1` (the engine, its settings and data are unchanged):
- The task runs `conhost.exe --headless powershell.exe -File run-windows-production.ps1 -Node <node.exe>`: PowerShell
  gets its own invisible console, so there is no handoff to suspend it.
- A second sign-in trigger 3 minutes later, with parallel instances allowed. A stuck first launch never takes the
  supervisor's mutex, so the second one starts the engine; when the first is running, the second exits at once.
  Still one supervisor and one engine per data folder.
- `install -NoStart` registers or updates the task without starting it (allowed while an engine runs; the task takes
  over at the next sign-in). `status` reports a supervisor whose threads are all suspended as SUSPENDED, and shows
  whether the task uses the fixed launch.

Tested on the isolated copy with a temporary task (removed afterwards): both triggers registered (delay none and
PT3M), Parallel; the supervisor ran normally (27 threads, not suspended); two extra start requests left one
supervisor and one engine (the extra one logged "another supervisor already runs" and exited); a killed engine was
restarted; `stop` left nothing running; `install` refused beside a running engine and `install -NoStart` registered
without touching it; `uninstall` removed the task. The production engine was not touched. A real sign-in is still
the only full test of the sign-in triggers.

The PC must be on, signed in and awake. After sleep the engine catches up on the missed Kraken candles: entries from
them expire unsent (`SIGNAL_EXPIRED`), exits of positions already in the ledger are still sent.
