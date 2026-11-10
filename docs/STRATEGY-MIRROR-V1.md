# Strategy Mirror V1 (development; not deployed, not active in production)

**What it is.** An independent, hypothetical copy of the original TradingView OTE + PD Array strategy. It runs on the same
completed Kraken SOLUSD 5m candles as the funded PAPER track. It records the strategy's own TradingView-style fills,
LONG and SHORT, with fixed $10 risk and TradingView's margin-0 property (unlimited buying power).

Its purpose is to **measure the original strategy**: it does not create profits, and nothing it records is executable.

Every mirror figure carries the label:

> **Hypothetical — unlimited buying power, not executable performance**

**Status:**
- Implemented and tested on `v1.2.0-cloudflare`. Nothing in production has changed.
- Production still runs the pinned engine `6b70cc9` with the mirror code absent, Worker `e941387e`, and D1 schema 4.
- Migration `0005` has not been applied to production.
- Rollout needs a separate owner approval (section 9).

## 1. Two independent tracks

| | Track A — funded PAPER (unchanged) | Track B — Strategy Mirror (new) |
|---|---|---|
| Strategy | `ote.mjs` `onBar`, solusd-5m inputs | the same code, the same inputs, its own state object |
| Candles | completed Kraken candles, each once | the same candles, each once |
| Sizing | fixed $10 (or the configured mode) | always fixed $10 ÷ stop distance (Pine) |
| Fill rule | TradingView emulator (+ optional `ENGINE_LIMIT_THROUGH_TICKS`) | the documented TradingView emulator (parity baseline) |
| Capital / margin | funded balance, long only, $5,000 order limit | margin 0: no buying-power check, no liquidation |
| A refused entry | the engine drops its position (no trade) | **never affects the mirror** |
| State file | `state-SOLUSD-5m.json` | `mirror-SOLUSD-5m.json` |
| Ids | `ENG-SOLUSD-5-<candle>-<BUY/SELL/CLOSE>` | `MIR-SOLUSD-5-<entry candle>-<LONG/SHORT>`, plus a sequence number |
| Worker endpoint | `/webhook/dry-run` (funded ledger) | `/webhook/engine-mirror` (mirror tables only) |
| D1 tables | `portfolio_*`, `paper_*`, `trades`, `alerts`, `orders`, … | `mirror_accounts`, `mirror_trades`, `mirror_entries` |
| Costs | `PAPER_COST_PROFILE` (production: `none`) | comparison estimate only (Ndax profile), never charged |

The mirror is **off by default**: `ENGINE_MIRROR=off`. Turning it on is the activation.

## 2. How it works

**Engine** (`engine/src/mirror.mjs`, `engine/src/runner.mjs`):
1. Each poll fetches candles from whichever track is further behind.
   - The funded track still processes only the candles after its own last one, so its behaviour is byte-identical
     (tested).
   - A new mirror warms up on Kraken's last 720 candles.
2. `mirrorStep` feeds one candle to the mirror's own strategy state.
   - Repeated or out-of-order candles are ignored and counted.
   - Before each candle it notes the bracket attached to the pending entry, so every trade records its initial stop
     and TP2.
3. Each closed trade becomes one record, keyed by the strategy's own label:
   - entry/exit time and price, exit kind, result, exit R;
   - gross P&L, risk, notional, inferred maker/taker;
   - the entry and exit candles (OHLC);
   - processing times, classification, and a sequence number.
4. **Activation** is set once, at the end of the first (warm-up) batch. Classification is by the entry candle:
   - `historical`: closed before activation (warm-up replay);
   - `catch_up`: after activation, but processed late (outage, catch-up, re-warm);
   - `live`: after activation, processed on time.
5. **A data gap** the strategy cannot bridge starts a fresh warm-up. Any open hypothetical position is recorded as a
   `POSITION_INTERRUPTED` event: no exit and no P&L are invented, and the event is shown on the dashboard.
6. **Delivery** is an ordered outbox, up to 25 records per request, sent after the funded track's own delivery, only
   when there are records, a new candle, or a 15-minute health report.
   - A network error, timeout or 5xx keeps records pending.
   - A lost reply becomes a `duplicate` on the retry.
   - A refused record (conflict, invalid) is kept with the Worker's code, audited as `mirror_divergence` and
     reported. It is never dropped silently.
   - Mirror errors never stop or change the funded track.

**Worker** (`worker/src/mirror.ts`, migration `0005_strategy_mirror.sql`):
- **Authentication:** `WEBHOOK_SECRET`, compared in constant time. The secret is never stored or logged.
- **Strict validation:**
  - the id format matches the account, entry time and side;
  - candle-grid times;
  - prices inside their candles;
  - gross = (exit − entry) × qty × side;
  - notional = qty × entry;
  - stop/TP2 on the correct sides;
  - known enums;
  - `processed_at` after the exit candle closed (no lookahead).
- **Idempotency:** records are unique by `(account, trade_id)` and `(account, seq)`. A payload hash is stored.
  - A retry with the same content is a `duplicate`.
  - Different content under the same id or sequence is a `conflict`. It is counted and never overwritten.
- **Atomicity:** each trade and its journal entry are written in one D1 batch.
- **Sequence gaps** are detected (contiguous mark vs highest seen) and reported.
- **Activation is set once.** A different activation for the same account is refused (`ACTIVATION_CONFLICT`).
- **Reference price:** for live trades, the Kraken price when the trade is received is stored separately, for
  comparison only. It never replaces the strategy's prices.
- **Dashboard API** (session-protected, read-only):
  - `/api/dashboard/mirror`: summary by category, health, reconciliation, open position, activity, interruptions;
  - `/api/dashboard/mirror/trades?category=`;
  - `/api/dashboard/mirror/trade?id=`: proof with candles, journal entry and checks.

**Dashboard** (`frontend/src/terminal/pages/Mirror.tsx`, reached from the Engine page): a hypothetical banner, health
and reconciliation, and separate tabs for Live / Catch-up / Historical. Each category shows:
- gross P&L, modelled net P&L, trades, LONG/SHORT;
- win rate, profit factor, max drawdown;
- an equity curve;
- margin and capital;
- the cost comparison.

The page also shows the open hypothetical position, a trade list and a per-trade proof page. The categories are never
summed, and nothing is added to funded figures.

## 3. Margin, capital and costs

- **Reporting baseline:** $10,000 per category (`mirror_accounts.reporting_equity_usd`). It is a reporting number,
  not capital.
- **Reported:**
  - notional (median and largest) and the fixed $10 stop risk;
  - implied leverage (notional ÷ hypothetical equity before the trade);
  - margin needed at 1×, 5× and 10×;
  - lowest equity and a negative-equity warning (never capped);
  - liquidation-risk counts.
- **Liquidation model** (report only): isolated margin, no maintenance buffer. A trade is flagged at a leverage when
  its realized loss is at least the initial margin. Intrabar adverse excursion is not modelled. No mirror position is
  ever liquidated.
- **Costs:**
  - The gross baseline stays fee-free (TradingView commission 0%).
  - The comparison uses `costs.ts` profiles (default `ndax`). Maker/taker is inferred: limit entry and TP2 = maker;
    stops and time exits = taker plus slippage.
  - Costs are never deducted from any balance. `PAPER_COST_PROFILE=none` is unchanged.

## 4. Historical parity (acceptance A)

**Internal parity (engine), trade by trade.** Mirror vs the verified Model A replay (`runBacktest`), over the
150-day dataset:
- the data: 43,188 Kraken candles, 2026-06-12 to 2026-11-09, committed as
  `engine/test/fixtures/SOLUSD-5m-150d.rows.json.gz` with a SHA-256 of the rows;
- each trade compared on side, quantity, entry/exit time and price, exit kind, result and P&L.

| | Model A (STRATEGY-AUDIT §3) | Mirror |
|---|---|---|
| Closed trades | 579 | **579** |
| Gross P&L | +$150.24 | **+$150.24** |
| Longs / shorts | 308 / 271 | **308 / 271** |
| Long / short P&L | +$230.97 / −$80.73 | **+$230.97 / −$80.73** |
| Profit factor / max DD / winners | 1.076 / $225.97 / 217 | **1.076 / $225.97 / 217** |
| Exits (SL / trail / TP2 / same-candle / BE) | 121 / 261 / 127 / 23 / 47 | **identical** |
| Trades that differ | — | **0 of 579** |

- Every fill lies inside its candle.
- Every trade has its initial stop and TP2.
- Risk is $10 within one tick of rounding.
- The 23 same-candle trades have equal entry and exit candles.

**Through the Worker:** the 579 records stored and summarised by the API give the same figures. The cost comparison
equals Model B (Ndax): **−$9,594.13**, computed independently by the research code.

**External TradingView evidence (benchmark window 2026-10-19 to 2026-11-07).**
- The mirror reproduces the TradingView Strategy Report: 69 trades, 32 winners, PF 3.298, max DD $21.95, net $249.98.
- Every trade listed in the report matches at its trade number.
- The report is **screenshots (summary plus listed trades), not a CSV export**.
- A complete external trade-by-trade TradingView parity claim therefore still needs the "List of trades" export for
  the same window. **Internal parity is complete; external parity is verified only for the summary and the listed
  trades.**

## 5. Funded-account isolation (acceptance B)

- **Engine:** the same scenario was run with the mirror off and on, with some funded entries accepted and others
  refused. These are byte-identical:
  - the funded state file;
  - every dry-run and ledger request;
  - every engine-status heartbeat;
  - the funded audit trail (`engine/test/mirror.test.mjs`).
- **Worker:**
  - All 11 funded tables are byte-identical after storing 579 + mirror records, duplicates, conflicts and invalid
    records: wallets, entries, positions, fills, trades, alerts, orders, risk decisions, strategy settings, activity
    and engine state.
  - Production-style refusals are unchanged (`NO_POSITION`, `INSUFFICIENT_PAPER_CAPITAL`, `MAX_ORDER_NOTIONAL`).
  - MAIN $90 / SOLUSD $10, consistency OK, limits unchanged, 0 FEE rows.
- **End to end:** the real engine runner, with the mirror on, against a local Worker. The real Worker refused the
  funded entries, the mirror recorded every trade, and the funded books were unchanged.

## 6. Reliability (acceptance C)

Tested in `engine/test/mirror.test.mjs` and `worker/test/mirror.test.mjs`:

| Case | Result |
|---|---|
| Engine restarted 5 times while a mirror position was open | identical to an uninterrupted run |
| Worker down (503), timeouts, reply lost after storing | each record stored exactly once, in order, nothing lost; a lost reply is a duplicate, not a divergence |
| Duplicate delivery | `duplicate`; no second row |
| Conflict (changed content or reused sequence) | refused, counted, kept by the engine and audited, never overwritten |
| Sequence gap | detected (`missing`), health `DIVERGED` |
| Repeated and out-of-order candles | ignored and counted; trades identical |
| Feed re-sending old candles | both tracks skip them; trades identical |
| Catch-up after a 30-hour outage (history available) | trades labelled `catch_up`, none lost; funded entries expire as before |
| Real data gap with an open position | fresh warm-up; `POSITION_INTERRUPTED` recorded; no invented exit |
| Same-candle entry and exit | recorded (23 in 150 days) |
| LONG and SHORT over time | 308 / 271 in 150 days |
| Funded refusal while the mirror is open | the mirror kept its position while the funded track had dropped its own |
| No double counting | ids unique, sequence contiguous, journal total = trades' gross, reconciliation OK |
| No lookahead | trades closed by candle n are identical with or without later candles; the Worker refuses a record processed before its exit candle closed |

## 7. Rollback compatibility

- On schema 5 with mirror rows, the deployed Worker (`e941387e` = `8b188c8`) and the fee-compatible rollback Worker
  (`c5bb67e`) both run with consistency OK and identical books.
- On those Workers the mirror endpoint answers 404, so an engine with the mirror on keeps its records pending until
  a mirror-capable Worker is back. Nothing is lost.
- Migration 0005 is additive. No rollback needs a D1 restore.

## 8. Limitations and risks

- **Hypothetical by construction.**
  - Limit orders fill when touched, with no queue position and no liquidity limit. Margin 0 means infinite leverage.
  - A stricter "trade through" fill rule turned the 150-day result from +$150.24 to −$114.87.
  - With modelled costs, the strategy loses heavily (−$9,594 Ndax over 150 days).
  - The mirror never shows any of this as profit, and never adds it to funded results.
- **The reporting baseline is a choice.** On $100 the same trades go below zero (the dashboard shows it, uncapped).
- **Live observation starts at activation.** The production mirror will have **no live trades yet** after a rollout.
  Warm-up trades are labelled historical.
- **Data gaps longer than Kraken's 720-candle window** interrupt a position (recorded, not invented).
- **Same-candle ordering** follows TradingView's documented OHLC path (bar magnifier off). With the magnifier on,
  TradingView can differ.
- **The risk follows the strategy's risk input.** A website risk change applies to both tracks' new entries, and each
  trade records its own risk.
- **Cost estimates** apply venue fees to Kraken prices. Maker/taker is inferred, not verified against an order book.
- **External TradingView parity is partial** (section 4) until a CSV export is supplied.
- **Worker TypeScript** is bundled and tested at runtime. There is no separate `tsc` for the Worker package (as
  before).

## 8a. Production observation that this addresses (read-only, 2026-11-10)

- The pinned production engine (release `6b70cc97c579`) was not running from **03:46 to 20:21 UTC**. The PC was
  powered off at 03:46 (clean shutdown) and the engine restarted at the next sign-in. Evidence:
  `STRATEGY-MIRROR-READINESS-AUDIT-2026-11-10.md` section 5.
- It resumed from its saved state with no reset and caught up 197 candles from Kraken history, with no gap and no
  duplicate.
- Three real strategy entries in that window (05:45 SELL, 07:30 SELL, 08:00 BUY) were correctly **expired, not
  sent** (`SIGNAL_EXPIRED`), as the funded track must do.
- With the mirror on, those trades would have been recorded as `catch_up` (not live), so the strategy's own record
  would have no hole.
- Nothing in production was changed while observing this.

## 9. Proposed production rollout (each step needs separate owner approval)

1. **Review** this implementation and the evidence.
2. **D1:** take a Time Travel bookmark and a full export, then apply additive migration `0005` (the deployed Worker
   ignores the new tables).
3. **Worker:** deploy the mirror-capable Worker, keeping `PAPER_COST_PROFILE=none`. Its rollback target stays
   `39b41f96` (`c5bb67e`).
4. **Engine:**
   - prepare a new pinned release from the approved commit and validate it;
   - switch with the release tooling (`activate`), which restarts the engine with the same state folder;
   - set `ENGINE_MIRROR=on` in the engine config.

   The first poll warms the mirror up on Kraken's last 720 candles (historical) and activates it.
5. **Verify:**
   - the funded track is unchanged (state, refusals, heartbeat, ledger check OK);
   - mirror health OK, sequence contiguous, reconciliation OK;
   - live trades appear only after activation.
6. **Monitor:** compare mirror trades with TradingView's List of Trades over a common window. Ask the owner for a CSV
   export to complete external parity.

Not part of this: Ndax fees, funding changes, strategy or risk changes, and real-money trading.

## 10. Test evidence (development, isolated temporary databases; production untouched)

| Suite | Result |
|---|---|
| Engine `npm test` (includes the new `test/mirror.test.mjs`: 150-day parity, benchmark, live runner, isolation, reliability) | **157/157** |
| Worker `npm test` (includes the new `test/mirror.test.mjs` with the real engine end to end, plus `migrations.test.mjs` for 0005, and rollback to `8b188c8` and `c5bb67e`) | **223/223** |
| Frontend `vitest run` (includes the new `src/terminal/mirror.test.tsx`) and `tsc --noEmit` | **112/112**, typecheck clean |
| Worker bundle (`wrangler deploy --dry-run`, nothing uploaded) | builds; `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none` |

The tests that rehearse the already-deployed 0004 release (`cost_audit`, `deploy_rehearsal`, `rollback_release`,
`paper_fidelity_probe`) now apply the migrations and run the Worker exactly as committed at `8b188c8`
(`test/lib/worker-at.mjs`). Otherwise the new 0005 in the development folder would have been applied too.

**Local preview** (`docs/screenshots/strategy-mirror-local-preview-1..6.jpg`, phone width):
- a local dev Worker on a throwaway database;
- the real engine runner, with the mirror on, replaying the committed real Kraken fixture (2026-11-01 to 11-03) on a
  simulated clock.

**These are not production data.**
