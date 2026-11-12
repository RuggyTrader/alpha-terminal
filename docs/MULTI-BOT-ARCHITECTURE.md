# Independent multi-bot architecture (development, 2026-11-12, NOT deployed)

ALPHA TERMINAL runs a fleet of genuinely independent bots. Each bot is one strategy instance dedicated to **one market
and one timeframe**. This is not one bot switching between timeframes.

**Permanent rule:** every future market, timeframe or strategy is added as its own identifiable bot. See also
`AGENTS.md` and `docs/MARKET-INTEGRATION-CHECKLIST.md` item 0.

## Status

Nothing here is deployed or activated. Production runs one engine (release `af924ffa4703`, SOLUSD 5m, percent sizing
1% / max $10) against Worker `1b51170c`, on schema 6.

| Part | State |
|---|---|
| Bot registry; fleet runner; per-bot files, ids, ledger ownership and status; capital book; combined backtest | **built and tested** |
| Ledger ownership (migrations 0007 + 0008, Worker code) | **built and tested**, not applied |
| Bots page (read-only cards, per-bot pipeline lines) | **built and tested**, not deployed |
| Start/stop/pause controls, per-bot charts, Home pipeline upgrade, per-bot notifications, ALPHA Assistant | **not built** (stages F2–F5) |
| ALPHA-01 (SOLUSD 1m) | **blocked:** needs the owner's exact 1m TradingView inputs and Strategy Report |
| ALPHA-03…06 (BTC/ETH) | PROPOSED; BTCUSD and ETHUSD are not funded-eligible |

## 1. Bots

`engine/src/bots.mjs`:

| Bot | Market | Timeframe | Profile | Status |
|---|---|---|---|---|
| ALPHA 01 | SOLUSD | 1m | none yet | PROPOSED: awaiting the owner's 1m inputs |
| ALPHA 02 | SOLUSD | 5m | `solusd-5m` | **ACTIVE**: today's production engine (`legacy: true`) |
| ALPHA 03 | BTCUSD | 1m | none | PROPOSED, not funded-eligible |
| ALPHA 04 | BTCUSD | 5m | none | PROPOSED, not funded-eligible |
| ALPHA 05 | ETHUSD | 1m | none | PROPOSED, not funded-eligible |
| ALPHA 06 | ETHUSD | 5m | none | PROPOSED, not funded-eligible |

**What each bot owns:**
- id `ALPHA-NN`, market, timeframe, profile and inputs;
- candle stream and strategy state, saved as `state-<tag>.json`;
- pending orders, positions, exits and stops;
- audit trail `audit-<tag>.jsonl`;
- mirror `mirror-<tag>.json` with its own mirror account;
- signal ids `ENG-<id>-<symbol>-<tf>-…`;
- ledger ownership (`bot_id`), status report `engine_status:<id>` and lock `engine-<tag>.lock`;
- risk policy (riskPct, a hard numeric maxRiskUSD), wallet, optional allocation cap and allocation priority.

**ALPHA-02 keeps today's names** (`SOLUSD-5m`, `ENG-SOLUSD-5-…`, the mirror account `MIRROR-SOLUSD-5m-c826d785d58a4a39`), so
its saved state, pending signals and mirror sequence resume unchanged.

**Registry gate** (`registryProblems`):
- unique ids, file tags and (market, timeframe, profile);
- a verified instrument for every bot;
- an ACTIVE bot needs a profile, and a funded ACTIVE bot needs a funded-eligible market;
- one legacy bot per market;
- hard risk caps.

Production runs **ACTIVE bots only**. The environment can never loosen a bot's risk policy: the registry's riskPct and
maxRiskUSD override `ENGINE_RISK_PCT` and `ENGINE_MAX_RISK_USD`.

## 2. Engine: one process, isolated bots

`ENGINE_BOTS=ALPHA-02` starts `src/cli/run-fleet.mjs`. Without it, `run.mjs` starts the single engine exactly as today.

- **One EngineRunner per bot** (`src/fleet.mjs`). Bots share only the process, a per-round candle cache (one Kraken
  request per market and timeframe per round) and the capital book.
- **Deterministic order:** priority, then id. This is also the capital allocation order.
- **Failure isolation:** an error or a hung poll in one bot is recorded for that bot only; it catches up on its next
  poll, as after a restart. A bot whose poll is still running is never polled twice.
- **Duplicate-instance protection:** one lock per bot, with the same lock name a single engine would use, so a single
  engine and a fleet can never run the same bot at once.
- **Bot identity on the wire:** every signal, ledger query, status report and mirror report carries `bot_id`. The
  single engine sends exactly what it sends today.

## 3. Shared capital, independent execution

**Default policy:** 1% of available allocated equity, at most $10 target risk, fully paid, long-only (the universal
sizing engine), subject to the account-wide limits.

1. **Ledger (authority).** Each accepted fill reserves its full cost in ONE D1 transaction. The wallet's CHECK means it
   can never go below $0; the bot's CHECK `bot_allocation_cap` means it can never hold more than its cap reserved. Two
   bots therefore can never spend the same dollars: the second fill fails atomically with `INSUFFICIENT_PAPER_CAPITAL`
   or `BOT_ALLOCATION_EXCEEDED`, and nothing is committed.
2. **Capital book (engine, `src/capital.mjs`).** A resting entry reserves nothing in the ledger until it fills. The book
   therefore earmarks the cost of other bots' resting long entries on the same wallet: what a bot sizes from = what the
   ledger leaves for it (wallet available, limited by its cap) − the other bots' earmarks. The first bot to place an
   order keeps its earmark; later bots size from what is left, so bots plan against separate dollars and the ledger
   does not have to refuse.
3. **Sizing.** Each bot sizes through `sizePosition` with its market's own instrument rules.
   - If both bots can afford valid positions, both are permitted, as separate positions.
   - If the minimum order makes it impossible, the setup is skipped with the exact code (`NO_CAPITAL`,
     `BELOW_MIN_QTY`, `BELOW_MIN_COST`, `EXPOSURE_LIMIT`…).
   - No capital is created, and no leverage is used.

Dedicated allocations: `bots.allocation_cap_micro` (per bot); `wallet` (shared by default, or a dedicated wallet per bot).

## 4. Strategy Mirrors

Every bot has its own hypothetical mirror:
- its own account `MIRROR-<symbol>-<tf>m-<inputs hash>`, tagged `bot_id` (0007);
- its own sequence and its own historical, catch-up and live categories;
- its own fixed research risk; no capital limit.

Mirror results are never added to PAPER balances. The fleet API and the Bots page carry them in a separate,
labelled field.

## 5. Ledger changes

### Migration 0007 `0007_bots.sql` (additive)

- `bots` table:
  - `bot_id` CHECK `ALPHA-NN`; market, timeframe, profile, wallet;
  - status ACTIVE / PROPOSED / DISABLED;
  - `legacy_default` (at most one per market); `entries_paused`; `allocation_cap_micro`;
  - `reserved_micro`, guarded by CHECKs `bot_reserved_nonnegative` and `bot_allocation_cap`;
  - `risk_pct`, `max_risk_usd`, `priority`;
  - UNIQUE (market, timeframe, profile).
- Registers **only ALPHA-02**. Other bots are inserted only when approved.
- Adds `bot_id` (NOT NULL DEFAULT '') to alerts, orders, paper_positions, paper_fills and trades; `mirror_accounts.bot_id`
  is nullable.
- **Ownership backfill only (no value changes):** `ENG-SOLUSD-5-…` rows and the SOLUSD 5m mirror account become
  ALPHA-02's. In production today that is 6 alerts and 1 mirror account; there are no positions, fills or trades. The
  10 old test/TradingView alerts (SPY, TSLA) stay unowned.
- New UNIQUE index (bot_id, symbol) WHERE OPEN. The old one-per-symbol index **is kept**, so the Worker running today
  and a rollback to it keep working on schema 7. The migration test proves the old upsert still works.

### Migration 0008 `worker/migrations-staged/0008_bots_multi_position.sql`

- Drops the one-per-symbol index.
- **Staged:** it is NOT in `migrations/`, so a plain `wrangler d1 migrations apply` can never apply it by accident.
- Apply only when a second bot on the same market is approved, after the fleet Worker is live.
- After 0008, a pre-fleet Worker must not be redeployed (its upsert targets the dropped index; tested).

### Worker (`worker/src/bots.ts` and the ledger)

- **Owner resolution:**
  - an explicit `bot_id` must be a registered ACTIVE bot of the same market and timeframe;
  - with no `bot_id`, a request belongs to the market's legacy bot (ALPHA-02 for SOLUSD) only if the pre-fleet engine
    made it: a signal with that engine's own id (`ENG-SOLUSD-5-…`), or an engine-only request (ledger view, status)
    whose timeframe matches or is absent;
  - everything else (TradingView alerts, tests) is `''`, exactly the old behaviour;
  - on a schema without the bot registry (before 0007) the owner is `null` and the ledger runs exactly the old SQL.
- **Ownership is enforced everywhere a position is read:** risk (own position = this owner's), portfolio gate, the
  commit (upsert on (bot_id, symbol)), exits (an exit reaches only the owner's own position; otherwise
  `NO_POSITION`), fees, reservations, the ledger view and reconciliation (bot reserved = its open positions).
- **Paused entries:** a paused bot's BUY gets `BOT_ENTRIES_PAUSED`. Its exits are still processed, so pausing never
  abandons a position.
- **Status:** stored per bot (`engine_status:<id>`). The legacy bot also writes the key the dashboard reads today.
- **Read-only fleet API:** `GET /api/dashboard/bots` returns per-bot positions, reservations, realized PAPER P&L, trades,
  win rate, profit factor, drawdown, the latest engine report, and separately the hypothetical mirror results.

## 6. Compatibility

| Combination | Result |
|---|---|
| Today's engine `af924ffa4703` + fleet Worker + schema 7 | Unchanged. Its signals and ledger queries map to ALPHA-02 (`multi_bot` test "pre-fleet engine"); status also goes to the existing key |
| Today's Worker `1b51170c` + schema 7 | Works: the old index is kept (migration test). New rows get owner `''` (see M1 timing below) |
| Fleet Worker + schema 6 (or older) | Works with the old SQL (owner `null`). Proven by the rehearsal suites that run the current Worker on schemas 4 and 6. So the Worker and migration order of W1/M1 does not matter |
| Fleet engine running only ALPHA-02 + fleet Worker | Same files, ids, mirror account and inputs hash as today (`fleet.test` "ALPHA-02's fleet config is the production single-engine config") |
| Fleet engine + pre-0007 Worker | ALPHA-02 works, because the extra `bot_id` fields are ignored. A non-legacy bot would be unowned, so the fleet must not run a second bot before W1 + M1 |
| Pre-fleet Worker + schema 8 | **Not possible** (tested). This is why 0008 is a separate, later step |
| Strategy | Unchanged. `ote.mjs`, `broker.mjs`, `indicators.mjs` and the SOLUSD profile are not modified |

## 7. Tests

| Suite | Result |
|---|---|
| `engine/test/fleet.test.mjs` (new, 18) | registry gate; per-bot config = production config; env cannot loosen risk; `bot_id` on every request; capital earmarks; simulated ledger (separate positions, shared wallet, caps, isolated exits); candle cache; **each bot in the fleet ends byte-identical to running alone on real 1m/5m candles, including through another bot's outage**; combined backtest at $10–$1,000: 0 refusals, wallet never below $0, reconciles |
| `worker/test/multi_bot.test.mjs` (new, 11; real Worker, local D1) | two bots hold separate SOLUSD positions; one bot's exit never touches the other's; shared wallet ($91 + $10 refused + $9 fits, nothing committed); allocation cap (gate and CHECK); paused entries with exits working; owner validation; legacy mapping of today's engine; per-bot status keys; reconciliation; fleet API keeps PAPER and hypothetical separate |
| `worker/test/migrations.test.mjs` (+2) | 0007 changes no value (only ownership); the old upsert still works on schema 7; 0008 is staged outside `migrations/`, drops the index, and breaks the old upsert (why it is separate); constraints |
| `frontend/src/terminal/bots.test.tsx` (new, 5) | state from the bot's own report age; proposed bots never shown active; PAPER and hypothetical separate; missing data stays N/A |
| Full suites | engine, Worker and frontend: see the run record in the release notes for this commit |

## 8. Combined backtest (real Kraken data)

`engine/src/cli/fleet-backtest.mjs`:
- SOLUSD 1m and 5m, 2026-10-29 → 2026-11-12, 14 days;
- 20,099 real 1m candles from Kraken trades, 0 mismatches against Kraken OHLC;
- 4,023 5m candles aggregated from them, 0 mismatches against the independent 150-day 5m file on 3,159 overlapping
  candles.

Method:
- **One chronological order of candle closes:** no lookahead; ties by priority.
- **Funded ledger:** percent sizing through the capital book.
- **Fills:** at the candle close, as the live Worker fills right after the close.
- **Fees:** the cost scenarios are ASSUMPTIONS (Kraken publishes no fee schedule via its API).

**ALPHA-01 uses PLACEHOLDER inputs (the 5m profile).** This only exercises the mechanics; it is not the owner's 1m
strategy and not a recommendation.

| Balance | Bots | Trades | Net, no costs | Net, 0.40% + 0.05% per side | Refused | Peak simultaneous same-symbol positions |
|---|---|---|---|---|---|---|
| $10 | 5m / 1m / both | 23 / 124 / 114 | +$0.24 / +$0.39 / +$0.36 | −$1.66 / −$5.84 / −$5.83 | 0 / 0 / 0 | 1 |
| $100 | 5m / 1m / both | 23 / 124 / 115 | +$2.44 / +$3.86 / +$3.84 | −$16.62 / −$65.79 / −$62.90 | 0 / 0 / 0 | 1 |
| $500 | both | 119 | +$19.36 | −$314.60 | 0 | 2 |
| $1,000 | both | 121 | +$38.79 | −$629.21 | 0 | 2 (0.6 h with two positions) |

- **Shared capital works.** There are 0 ledger refusals in every run (54 runs: 3 cost scenarios × 6 balances × 3 bot
  sets) and the wallet always reconciles.
- **The capital book decides.** Below about $500 one position takes nearly all the wallet (buying-power cap), so the
  other bot's setups are skipped (`NO_CAPITAL`, 46 at $10) rather than refused. From $500 both bots hold positions at
  the same time.
- **Shorts** are skipped (`SHORT_NOT_ALLOWED`) on the long-only ledger: 110 for 5m and 485 for 1m in 14 days.
- **Costs dominate.** With either assumed fee level every combination loses, the 1m bot most. Sizing makes trades
  executable; it does not make the strategy profitable.
- **Mirror (hypothetical, fixed $10):** 5m 58 trades +$160.08 (profit factor 2.21); 1m with the placeholder inputs 289
  trades −$41.26 (profit factor 0.96). That is evidence the 5m inputs should NOT be assumed for 1m: **the owner's 1m
  settings and TradingView report are required before ALPHA-01 can be considered.**

Output: `engine/runs/fleet-2026-11-12/fleet-backtest.json` (local; `engine/data` and `runs` are not committed).

## 9. Staged deployment proposal (each stage a separate approval)

| Stage | What | Rollback |
|---|---|---|
| **W1** | Deploy the fleet Worker (works on schema 6 with the old SQL). Engine unchanged | Worker → `1b51170c` |
| **M1** | Apply 0007, in the minute after a candle while ALPHA-02 is flat with no pending signal. Re-run 0007's ownership UPDATEs (idempotent) and verify: 0 open positions or fills with owner `''` and an `ENG-SOLUSD-5-…` id; bots.reserved = open positions | Worker → `1b51170c` still works on schema 7 (tested). Schema 7 stays; never restore D1 |
| **E1** | Engine release with the fleet code, still `run-single` (no `ENGINE_BOTS`). Identical behaviour; adds nothing but the code | `release.mjs rollback` |
| **E2** | `ENGINE_BOTS=ALPHA-02` (fleet process, one bot). Same files, ids, mirror and inputs hash; verify resume, no warm-up | Remove `ENGINE_BOTS` and restart (single engine resumes the same files) |
| **F1** | Bots page (read-only), with W1 or later | Worker rollback |
| **ALPHA-01** | Needs: owner's 1m inputs + report → profile `solusd-1m` → registry ACTIVE → `INSERT INTO bots` → **M2 (0008)** → `ENGINE_BOTS=ALPHA-01,ALPHA-02`, with an allocation decision (shared, or a cap). Mirror-only first if preferred (funded: false) | Pause entries (`entries_paused=1`, exits keep working), then remove from `ENGINE_BOTS`. After 0008 never redeploy a pre-fleet Worker |
| F2 | Start/stop/pause controls (authenticated, owner passphrase, audit log); pause ≠ stop management | |
| F3 | Home pipeline per bot; per-bot status for every bot | |
| F4 | Per-bot trade charts (1m/5m candles, that bot's levels only) | |
| F5 | Per-bot notifications ("ALPHA 01 \| SOLUSD 1m"), mirror labelled hypothetical; ALPHA Assistant (read-only, evidence links) | |

**Resources (Cloudflare Free).**
- Two bots double the engine's requests, from about 8,700 to about 17,000 a day. That is under the Free plan's 100,000.
- The status heartbeat stays at about 8 ms CPU per request. A 1m bot polls on the same 20-second loop as the 5m bot.
- Fleet API reads are bounded per bot.
