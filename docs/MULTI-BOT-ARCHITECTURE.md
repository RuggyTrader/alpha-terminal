# Independent multi-bot architecture (final design, 2026-11-12) — built and tested, NOT deployed

Production is unchanged:
- one engine, release `af924ffa4703` (ALPHA-02, SOLUSD 5m, percent sizing 1% / max $10);
- the legacy `/webhook/dry-run` ledger;
- schema 6.

Everything below is on branch `v1.2.0-cloudflare` and waits for the staged rollout in section 8. Each stage needs its own owner approval.

## 1. Bots

| Bot | Group | Market | TF | Profile | Inputs hash | Registry status | Ledger path |
|---|---|---|---|---|---|---|---|
| ALPHA-01 | SOLANA | KRAKEN:SOLUSD | 1m | `solusd-1m` | `0932a1a0cfac03f9` | PROPOSED | bot |
| ALPHA-02 | SOLANA | KRAKEN:SOLUSD | 5m | `solusd-5m` | `c826d785d58a4a39` | **ACTIVE** (legacy identity) | legacy until stage S1 |
| ALPHA-03 | BITCOIN | KRAKEN:BTCUSD | 1m | `btcusd-1m` | `d828caa44611ad73` | PROPOSED | bot |
| ALPHA-04 | BITCOIN | KRAKEN:BTCUSD | 5m | `btcusd-5m` | `a6336dad6ffaed70` | PROPOSED | bot |
| ALPHA-05/06 | — | ETHUSD | 1m/5m | none | — | DISABLED (ETH inactive) | — |

SOL 5m keeps TP2 `+0.25`. Profiles mirror the owner's TradingView inputs, and unconfirmed fields are marked in each `.env` file.

**Each bot owns:**
- its state and audit files and its lock;
- signal ids `ENG-<id>-…` (ALPHA-02 keeps `ENG-SOLUSD-5-…`);
- the status key `engine_status:<id>`;
- its mirror account;
- its wallet (same id as the bot);
- its rows in `bot_orders`, `bot_positions` and `bot_fills`;
- its risk setting.

## 2. Engine (`engine/src`)

- **`bots.mjs`:** the registry, `registryProblems` gate and `selectBots`. `FleetRunner` (`fleet.mjs`) runs every ACTIVE bot in one process on a shared Kraken `CandleCache`.
- **`config.mjs` `loadBotConfigs`:** builds each bot's config from its own profile only. `STRAT_*` values in the shared `engine.env` are a hard error.
- **Sizing (`sizing.mjs`, mode `dollar`):**
  - qty = riskUSD ÷ stop distance;
  - then reduced to fit the bot's available cash (long cost, or 100% short collateral) plus the 0.20% entry fee;
  - then floored to Kraken's step and minimum. Below the minimum: `BELOW_MIN_QTY`, the signal is skipped and nothing is forced.
- **`runner.mjs` (bot path):** posts `OPEN_LONG` / `OPEN_SHORT` / `CLOSE` to `/webhook/bot-order` with stop, target, riskUSD and `config_hash`. It reads its ledger from `/webhook/bot-ledger`. Its status report carries `strategy_state` (direction, legs, setup bars, pending order, current stop, break-even, trailing) and `bot_risk`.

## 3. Ledger (`worker/src/bot_ledger.ts`, migration 0007, additive)

- **Tables:** `bots`, `allocation_groups`, `bot_settings`, `bot_orders`, `bot_positions` (one OPEN per bot, enforced by a unique index), `bot_fills`, `allocation_events`, and `portfolio_wallets.shortfall_micro`. Legacy tables gain `bot_id`, backfilled to ALPHA-02.
- **Order validation:** HMAC webhook secret, registered ACTIVE bot, matching `config_hash`, entries not paused, no shortfall, affordability. Duplicate `alert_id` values are rejected by unique keys.
- **Close (one atomic D1 batch):**
  1. fill guard;
  2. exit fill and fee;
  3. release cost or collateral;
  4. realized P&L;
  5. any loss beyond the bot's cash goes to `shortfall_micro`, and entries pause;
  6. positive net profit is swept to MAIN, keyed `SWEEP:<trade_id>:OUT/IN`.
- **Fees:** model `ndax-flat-0.20-2026-11-12`, 0.20% of fill notional on every fill.
- **Money is integer micro-USD.** Identity per wallet: available + reserved = net funding + realized − fees.
- **Owner actions** need a session and the passphrase typed again, plus a fresh request id:
  - `/api/paper/allocate`: a group amount split equally between its bots;
  - `/api/paper/bot-risk`: versioned; the engine applies it on its next report;
  - `/api/paper/bot-entries`: pause or resume.
- **Read endpoints:** `/api/dashboard/bots`, `/api/dashboard/allocation-preview`, `/api/dashboard/candles` (Kraken OHLC proxy with a 15 s cache).

## 4. Dashboard

| Page | Responsibility |
|---|---|
| Home | Account hero (funded), **Performance selector** (Funded PAPER / Strategy Mirror / By bot, never added together), pipeline, per-bot pipeline lines |
| Bots | Control center: groups, allocation preview and allocation, per-bot card (state, balances, risk editor, pause, sizing decision, shortfall, mirror kept separate), chart link |
| Bot chart `/bots/:id/chart` | Lightweight Charts 4.2.0 Kraken candles with the recorded entry, stop, target and pending limit; figures only from real quantities |
| Trades / Activity / Performance | Funded records / the event stream / metrics. Activity uses the shared `signalState` and links to `/trades?signal=<id>` |
| ALPHA Assistant | A deterministic, read-only Q&A over `/api/dashboard/bots`, with evidence. No language model, $0 cost |

## 5. Notifications

- Bot fills raise `FUNDED_ENTRY` / `FUNDED_CLOSE` events labelled "ALPHA 01 | SOLUSD 1m".
- Mirror events are labelled with their bot.
- Each bot can be muted through the `muted_bots` preference.
- **Not built yet:** pending-order, break-even and trailing events. They need a `trade_events.kind` CHECK change, a later additive migration.

## 6. Dashboard timeout fix

- **Root cause:** dashboard refreshes made Alpaca subrequests with no timeout, plus an unbounded Kraken Ticker call. A slow upstream held the response past the client's 12 s limit.
- **Fix:** Alpaca fetches time out at 3.5 s and Kraken at 5 s. A failed refresh keeps the last snapshot with its age shown.

## 7. Tests

- `engine/test/fleet.test.mjs`: 27 tests.
- `worker/test/multi_bot.test.mjs`: 12 tests, end to end on a local Worker.
- `worker/test/migrations.test.mjs`: 11 tests.
- `frontend/src/terminal/bots.test.tsx`: 13 tests.
- Plus the full suites (see the release notes).

## 8. Staged rollout — REVISED 2026-11-12 by the technical director (supersedes the table below)

| Stage | Content | Production change |
|---|---|---|
| R1 | Complete the release candidate; fix known errors; full tests | none |
| R2 | External parity (needs TradingView List of Trades + Properties) and research | none |
| R3 | Read-only infrastructure release: dashboard reliability, selector, sync, UI cleanup, bot views, charts, assistant, compatible notifications. **No new funded trading.** Must work on schema 6 with the current engine. | Worker deploy (approval) |
| R4 | Migration rehearsal on a private copy (production export only with approval) | none |
| R5 | All four exact profiles as hypothetical Strategy Mirrors (no wallet money) | engine release (approval) |
| R6 | Selective small funded PAPER experiments, one bot at a time, labelled experiments | per-bot approval |

### Superseded original plan (each stage needs its own owner approval)

| Stage | Change | Verification |
|---|---|---|
| W1 | Deploy the Worker (bot routes inert; schema-tolerant on schema 6) | health, dashboard, legacy dry-run unchanged |
| M1 | Apply migration 0007 after a fresh D1 export and a rehearsal on a copy | schema 7, ALPHA-02 backfill counts, consistency OK |
| E1 | Engine release with the fleet runner, ALPHA-02 only (legacy path) | same signals, same mirror sequence, status `engine_status:ALPHA-02` |
| S1 | Owner allocates SOLANA; ALPHA-02 switches to the bot ledger | first bot order and fill, wallet identity, sweep |
| S2 | Activate ALPHA-01 (SOL 1m) | first report, NOT YET OBSERVED until a real trade |
| B1 | Owner allocates BITCOIN; activate ALPHA-03 and ALPHA-04 | as S2 |

**Rollback at any stage:** set the bots back to PROPOSED (no entries). The tables stay; nothing is deleted.

**Caution from research** (`docs/BACKTEST-2026-11-12-FLEET.md`): at 0.20% per fill, every bot loses money in funded PAPER over the tested windows.
