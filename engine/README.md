# ALPHA TERMINAL OTE engine (PAPER only)

A standalone runner for the OTE + PD Array strategy. It does not need TradingView or webhook alerts. It reads
completed Kraken candles, makes the same decisions as the Pine script, and reports to the existing ALPHA TERMINAL
Worker. It never contacts a broker: there is no order-submission code and no live-trading setting.

```
Kraken completed candles ─► engine (ote.mjs + broker emulator) ─► ALPHA TERMINAL /webhook/dry-run  (signals)
                                                                └► ALPHA TERMINAL /webhook/engine-status (heartbeat)
```

## What it is

| File | Role |
|---|---|
| `src/ote.mjs` | Port of `tradingview/ote_pd_array_strategy.pine` (break-even + trailing-stop version): every input, same order of operations, one run per **completed** bar, no lookahead |
| `src/broker.mjs` | Fill emulator following TradingView's documented broker emulator rules (next-bar working, intrabar path O→H→L→C or O→L→H→C, limit/stop gap rules, bracket exits, `close_all` at the close). No commission or slippage, like the script |
| `src/indicators.mjs` | ATR (Wilder RMA), pivots, lowest/highest, `round_to_mintick`, New York session time |
| `src/kraken.mjs` | Kraken public data: completed OHLC candles (the forming candle is dropped), and history rebuilt from public trades |
| `src/runner.mjs` | Live loop: state saved after every step (atomic), resume exactly after a restart, outbox with deterministic signal ids, heartbeat |
| `src/cli/*.mjs` | `run` (service), `history` (download candles), `backtest`, `compare-tv` (diff against a TradingView export) |

Instruments: **SOLUSD only** for now. Other supported crypto follow after their own validation; MES, MNQ and GOLD
stay disabled until a truthful data feed exists.

## Signals to ALPHA TERMINAL

* Entry fill → `BUY` (long) / `SELL` (short, which ALPHA TERMINAL rejects because short selling is disabled).
  Exit fill (TP2, stop, break-even, trailing, time exit) → `CLOSE`.
* Signal id `ENG-<symbol>-<tf>-<fill bar time>-<action>`: the Worker's duplicate protection plus the outbox make
  re-sends after a crash or restart harmless.
* Every signal ends in a recorded result: `accepted`, `rejected` (with ALPHA TERMINAL's code and message), or
  `skipped`; `historical` and `late` are never sent. 5xx / network errors keep it `pending` and retry it in order.
  A Worker `DUPLICATE` (re-send after a crash) adopts the original result.
* **Each CLOSE is linked to its entry and is sent only if that entry was accepted** into the ALPHA PAPER ledger.
  The CLOSE of a rejected, historical (warm-up) or late entry is recorded as `skipped` (`ENTRY_NOT_IN_LEDGER`)
  with the reason, so it can never act on the ledger.
* **After every poll the engine reads the ledger** (read-only `POST /webhook/engine-ledger`) and compares symbol,
  side, quantity, status and the opening signal with its own position. The position is reported `MIRRORED` only when
  D1 matches; otherwise `DIVERGED` with the differences, `UNVERIFIED` when the ledger could not be read, `PENDING`, or
  `NOT_IN_LEDGER` with the reason. A ledger position opened by the engine that the engine no longer holds is also a
  reconciliation warning. Nothing is corrected automatically. The dashboard card shows it.
* If the engine has to re-warm after a hole in Kraken's data while the ledger holds its position, it sends one
  reconciliation CLOSE (`…-RESYNC-CLOSE`) so the ledger is never left with a position the engine forgot.
* **Freshness is enforced at delivery.** An entry not delivered within `ENGINE_LATE_BARS` candles of its candle close
  (e.g. after an outage) is never sent: it is recorded as `skipped` / `SIGNAL_EXPIRED`, so it cannot fill at a later
  price. If an earlier attempt may have reached ALPHA TERMINAL, its real outcome is read from the ledger first (an
  accepted entry is adopted, not re-sent). Warm-up history is never sent.
* **Exits of accepted entries are still delivered when late** (otherwise the ledger would keep a position the engine
  closed), but only if the ledger still holds exactly that entry's position, never twice (`ALREADY_CLOSED`), and they
  are recorded as delayed ("the ledger closed at the live price N min after the engine's exit"). A CLOSE whose position
  the ledger no longer holds is `skipped` / `LEDGER_NOT_HOLDING_ENTRY`. If the ledger cannot be read, the CLOSE waits.
* The ALPHA PAPER ledger fills at the live Kraken price when the signal arrives (up to one candle after the
  engine's simulated fill). The dashboard's **OTE engine** card shows the engine's own simulated position and P&L;
  the ALPHA PAPER cards show the ledger. They are labelled separately and are not expected to be equal.
* Sizing: with the Pine default `riskUSD = 200` SOLUSD orders are far above ALPHA TERMINAL's $5,000 per-order
  limit and are rejected (truthfully). For integration testing use the **`paper-test` profile**
  (`ENGINE_PROFILE=paper-test`, `profiles/paper-test.env`): it only lowers risk per trade to $5, everything else
  stays at the Pine default, and it is shown on the dashboard. On the 14-day backtest its orders were ~$435–$3,030.
  The strategy defaults and the Worker limits are not changed.

## Run on this Windows PC

```powershell
cd engine
copy .env.example .env      # then edit: ENGINE_SYNC, ALPHA_API_BASE, ALPHA_WEBHOOK_SECRET
node src/cli/run.mjs        # or: powershell -File deploy/run-windows.ps1  (restarts it if it stops)
```

Production (the ALPHA TERMINAL website): settings via `src/cli/sync-setup.mjs`, then start it at every sign-in with
`powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows-task.ps1 install` (also `status`, `stop`,
`uninstall`); it runs `deploy/run-windows-production.ps1`, one supervised engine. See `docs/ENGINE-SYNC-SETUP.md`.

Test against a development Worker first (`cd worker && npx wrangler dev --local`, `ALPHA_API_BASE=http://127.0.0.1:8787`).
Only point it at production once you have decided to.

## Backtest

```bash
node src/cli/history.mjs --symbol SOLUSD --interval 5 --days 14 --out data/SOLUSD-5m-14d.json
node src/cli/backtest.mjs --candles data/SOLUSD-5m-14d.json --out runs/sol-14d
node src/cli/compare-tv.mjs --tv tradingview-trades.csv --engine runs/sol-14d/trades.json --tz UTC
```

`history` rebuilds candles from Kraken's public trades and checks them against Kraken's own OHLC candles where both
exist. For `compare-tv`, export TradingView's Strategy Tester "List of trades" for KRAKEN:SOLUSD 5m over the same
period with the same inputs. TradingView starts the strategy from its whole chart history, so the first trades of a
window can differ while state warms up; compare a window that starts some days after the data begins.

## Strategy Mirror (`ENGINE_MIRROR`, off by default)

`ENGINE_MIRROR=on` runs a second, independent copy of the unchanged strategy (`src/mirror.mjs`) on the same completed
candles. It has its own state file (`mirror-<symbol>-<tf>m.json`), LONG and SHORT, fixed $10 risk and TradingView's
margin-0 property, and is never dropped when the funded ledger refuses an entry. Its trades go to
`/webhook/engine-mirror` and are shown on the dashboard's Strategy Mirror page as **hypothetical**, separately from
funded PAPER. With the mirror off, the funded track is byte-identical (tested). Design, parity and evidence:
`docs/STRATEGY-MIRROR-V1.md`.

## SOLUSD 5m profile, TradingView parity and the website simulator

`profiles/solusd-5m.env` holds the user's TradingView inputs for KRAKEN:SOLUSD 5m (`ENGINE_PROFILE=solusd-5m`).
The Pine defaults and `paper-test` are unchanged. The profile starts at $10 risk per trade and sets
`ENGINE_REMOTE_SETTINGS=on`: the engine then uses the risk per trade applied on the ALPHA TERMINAL website for new
entries only (open positions keep their size), saves it with its state, and confirms the version in its next status
update. Only then does the website show it as Applied.

```bash
node src/cli/history.mjs --symbol SOLUSD --interval 5 --days 25 --out data/SOLUSD-5m-25d.json
node src/cli/parity.mjs --candles data/SOLUSD-5m-25d.json --reference parity/tv-solusd-5m-2026-11-07.json --out runs/parity-solusd-5m
node src/cli/simulate.mjs --candles data/SOLUSD-5m-25d.json --profile solusd-5m --trades-from 2026-10-18 --upload
```

* `parity` compares the engine's trades with the TradingView figures in `parity/` (screenshot values, not a CSV
  export). It also measures how much the start of the history, the pivot tie rule and two fill-emulator options change
  the result, and checks that qty and P&L scale exactly with risk.
* `simulate` builds the cached backtest the website's simulator rescales. `--upload` sends it to
  `<ALPHA_API_BASE>/webhook/engine-backtest` with the engine's webhook secret. It is computed here, never on a Worker
  request.

## VPS later (nothing provisioned)

* `deploy/alpha-engine.service`: systemd unit (`Restart=always`, settings in `/etc/alpha-engine/engine.env`, state in
  `/var/lib/alpha-engine`). Needs Node 22+.
* State and the single-instance lock live in `ENGINE_DATA_DIR`; copy that directory to move a running engine.
* Configuration and the webhook secret are only read from the environment / env file, never from source.

## Tests

`node --test "test/*.test.mjs"` (no network): indicators, emulator rules, determinism, no lookahead, exact resume from
saved state, break-even/trailing invariants, outbox duplicates, outages, rejections and catch-up. The Worker side is
covered by `worker/test/engine_sync.test.mjs` (local Worker + D1).

## Known limitations

* **Not yet compared with TradingView**, and the final SOLUSD 5m settings are still to come. The comparison needs a
  TradingView trade-list export with those settings (see above). No parity is claimed.
* Pivot ties: Pine does not document how equal highs/lows are treated; the engine uses strict on both sides.
  Equal values are common at 0.01 ticks, so this is the first thing to check against the TradingView export.
* Order quantity is not rounded (TradingView may round to the symbol's lot size); P&L scales with quantity.
* Kraken candle data versus TradingView's KRAKEN feed can differ slightly.
