# Trade intelligence and UX release candidate — 2026-11-13 (branch `v1.2.0-cloudflare`; development only)

**Production is unchanged:**

| Component | Version | Schema |
|---|---|---|
| Worker | `1b51170c` (Stage N5, commit `af924ff`) | 6 |
| Engine | release `af924ffa4703` | — |

Nothing in this document has been deployed.

**Status meanings:**

| Status | Meaning |
|---|---|
| **Impl** | Implemented in code |
| **Test** | Covered by automated tests |
| **Rehearsed** | Exercised on a local Worker with a fresh D1 (`worker/tools/*`) |
| **Deployed** | Running in production |
| **Observed** | Seen in production |

## What changed

| Area | Status | Notes |
|---|---|---|
| **Investigation of production trade #1** | Done (read-only) | `docs/TRADE-1-INVESTIGATION-2026-11-13.md` |
| **Recorded trade plan + exit reason** (engine `tradeplan.mjs` → signal payload → Worker `trade_story.ts`) | Impl · Test · Rehearsed | Works on schema 6, no migration. Needs an **engine release** for future trades to carry it |
| **Trade cards** (progressive disclosure: result, why entered, why exited, plan, actions) | Impl · Test · Rehearsed | `components/TradeStoryCard.tsx`. Legacy and bot ledgers |
| **Proof pages**: story summary + "Ask ALPHA" at the top; all ids and evidence kept below | Impl · Test · Rehearsed | Legacy `/trades/:id`, bot `/bots/trade/:id` |
| **Contextual assistant**: "Ask ALPHA about this trade" with the exact trade | Impl · Test · Rehearsed | `tradeAssistant.ts`. Read-only, deterministic, $0. Says "not recorded" when evidence is missing |
| **Charts**: scanning / developing setup / pending (with recorded reason, age, validity) / open (stop changes) / completed (from the trade proof) | Impl · Test (overlay logic) · Rehearsed | Every bot has a chart, including on schema 6. Fit trade levels, full screen, reset, pinch/drag/crosshair (Lightweight Charts) |
| **Home**: hero follows the selected scope (Funded / Mirror / By bot), return shown once; Capital overview; positions include bot positions; legacy pipeline only without a fleet registry; Markets moved to the Engine page | Impl · Test · Rehearsed | `pages/Home.tsx`, `WalletOverview.tsx` |
| **Plain-language refusal reasons** (code kept) | Impl · Test | `humanReason()` |
| **Lifecycle notifications** (pending, cancel, break-even, trailing) | Impl · Test (earlier) | Need migration 0007 (`trade_events` rebuild) |
| **Bot ledger** (wallets, shorts, sweep, reduce-to-fit) | Impl · Test (earlier) | Needs migration 0007, approval stage R4 |

## Demo evidence

Files: `docs/demo/2026-11-13/`, labelled DEMO / HISTORICAL REPLAY.

- **Setup:** an isolated local Worker and a fresh D1. Candles are **recorded Kraken candles** (real prices and timestamps). Orders are **synthetic DEMO orders** sent through the Worker's real routes, with plans in the engine's format.
- **Recorded lifecycle (`INDEX.json`):**
  1. ALPHA-01 SOL 1m pending LONG limit at 82.93 (stop 82.67, TP2 83.98, FVG + OB, score 2).
  2. Filled: 0.5 SOL, fee $0.0829.
  3. Stop moved to break-even.
  4. TP2 reached: gross +$0.525, fees $0.167, net +$0.358, **$0.358 swept to MAIN**.
  5. A losing ALPHA-03 BTC SHORT, stopped out: net −$0.385, nothing swept.
  6. An open ALPHA-04 BTC SHORT, collateral $44.36.
  7. An **unaffordable order refused**: `INSUFFICIENT_BOT_CAPITAL`, ALPHA-03 has $99.61. It was triggered with a synthetic out-of-range reference price, labelled in the tool and drawn on no chart.
- **Screenshots:** 35, covering Home in all three scopes, bots, the pending chart, open LONG and SHORT charts, the completed-trade card and chart, the proof page, "Ask ALPHA", filters, performance, activity, the risk editor and the stale/offline state.
  - Width 402 px, light and dark.
  - **No horizontal overflow** on any of them.
- **Not produced:** a screen recording. The ordered screenshots are the walk-through.

## Measurements (LOCAL, not production)

- `worker/tools/measure-dashboard.mjs`, 40 requests per endpoint, 180 seeded bot trades.
- The machine was slower today than on 12 Nov, so the **previous commit `f7f2728` was measured alongside on the same machine**.

| Endpoint | This release: median · p95 · D1 statements · rows read | `f7f2728`, same machine, same time |
|---|---|---|
| `/api/dashboard` | 82.8 ms · 113.2 ms · 24 · 1,017 | 91.3 ms · 108.4 ms · 24 · 1,017 |
| `/api/dashboard/bots` | 110.5 · 139.8 · 33 · 379 | 121.9 · 154.3 · 33 · 379 |
| `/api/dashboard/bot-trades?bot=` | 49.3 · 63.7 · **7 · 460** | 39.1 · 64.7 · 6 · 260 |
| `/api/dashboard/events` | 35.0 · 61.7 · 6 · 1,085 | 42.7 · 112 · 6 · 1,085 |

- **No regression on the dashboard.**
- **Measured cost of the trade stories:** one more D1 statement and +200 rows read on `bot-trades`.
- **Not measured:** production CPU and latency (needs Stage 3).

## Compatibility with production (schema 6)

`worker/tools/schema6-compat.mjs` runs this Worker against D1 migrated only to 0006 and passes **11 of 11**:
- every dashboard route returns 200;
- `bot-trade` returns 404;
- the bot-order routes return a clean **409 `BOT_LEDGER_NOT_INSTALLED`**, never a 5xx;
- the legacy engine heartbeat works with the new fields.

The Worker test suite also covers the legacy dry-run path storing and returning plans.

## Recommended first deployment (needs the owner's approval)

**Stage 2 — compatible dashboard release:** Worker + frontend at the commit of this release.
- **No migration**; production schema 6 stays.
- **No engine change.**
- **Delivers:** trade cards and proof story, contextual assistant, charts for every bot and trade (including the 13 Nov trade, shown as "not recorded" for the plan), the Home scope/capital/position cleanup, dashboard reliability (bounded optional Alpaca), and refusal explanations.
- **Bot-ledger features:** inert and labelled as such on schema 6.
- **Rollback:** redeploy Worker version `1b51170c`.

**Stage 2b — engine release (separate approval):** the same engine with plan/exit recording, so new trades explain themselves.
- Trading decisions are byte-identical; the existing release byte-identity tests pass with only the plan metadata stripped.

**Stages R4 onward:** unchanged. A migration rehearsal on a private production copy needs the export approval.
