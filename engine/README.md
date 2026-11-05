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
* The engine's open position is reported with its ledger link: `MIRRORED` (also in the ALPHA PAPER ledger),
  `PENDING`, or `NOT_IN_LEDGER` with the reason. The dashboard card shows it.
* If the engine has to re-warm after a hole in Kraken's data while the ledger holds its position, it sends one
  reconciliation CLOSE (`…-RESYNC-CLOSE`) so the ledger is never left with a position the engine forgot.
* Warm-up history and fills from candles that closed more than `ENGINE_LATE_BARS` intervals ago (catch-up after
  downtime) are recorded but **not** sent: the Worker fills at the live price, so a stale signal would mislead.
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
