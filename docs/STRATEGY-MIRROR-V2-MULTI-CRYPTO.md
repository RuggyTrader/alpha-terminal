# Strategy Mirror V2 — multi-crypto (development; NOT deployed)

**Goal.** More chances to observe genuine **live** hypothetical trades, by running the original OTE + PD Array
strategy on three independent 5-minute markets: SOLUSD (existing, unchanged), BTCUSD and ETHUSD (new, mirror-only).
Every BTCUSD/ETHUSD figure is **hypothetical**: unlimited buying power, not executable performance.

**Status:**
- Implemented and tested on `v1.2.0-cloudflare`.
- **Production unchanged:** engine `0db082fbd044` (SOLUSD, funded track plus mirror), Worker `4d3ddcb6`, D1 schema 5.
- **Nothing deployed, no migration**; the V2 Worker needs none.
- No new live monitoring started.
- The rollout (section 9) needs separate approval.

## 1. Design

| | SOLUSD (production, unchanged) | BTCUSD, ETHUSD (new) |
|---|---|---|
| Process | its own pinned engine (`run.mjs` → single market), its own release root and scheduled task | a separate mirror-only process (`run.mjs` with `ENGINE_MARKETS=BTCUSD,ETHUSD`), its own release root, state folder and (later) task |
| Funded track | yes ($10 SOLUSD wallet, refusals as today) | **none** (`ENGINE_FUNDED=off`): no PAPER signal, ledger query, engine status, website setting, transfer or broker order |
| Strategy | `ote.mjs`, profile `solusd-5m` | **the same `ote.mjs` and the same `solusd-5m` inputs** ($10 fixed risk, LONG and SHORT, same swing/leg/entry/stop/TP/BE/trail settings) |
| Kraken data | `SOLUSD` | `XBTUSD` (result key `XXBTZUSD`, tick 0.1), `ETHUSD` (`XETHZUSD`, tick 0.01): verified via AssetPairs; ticks equal `ote.mjs` `SYMBOLS` |
| Mirror account | `MIRROR-SOLUSD-5m-c826d785d58a4a39` | `MIRROR-BTCUSD-5m-<hash>`, `MIRROR-ETHUSD-5m-<hash>` (the inputs hash includes the symbol) |
| Ids, sequence, journal | own | own per market (`MIR-BTCUSD-5-…`, `MIR-ETHUSD-5-…`, each sequence from 1) |
| Files | `state-SOLUSD-5m.json`, `mirror-SOLUSD-5m.json` | `mirror-BTCUSD-5m.json`, `mirror-ETHUSD-5m.json`, `audit-<SYM>-5m.jsonl`, `engine-<SYM>-5m.lock` (no funded state file) |

**Strategy inputs are not tuned for BTC or ETH.** The user's TradingView settings exist for KRAKEN:SOLUSD 5m only, and
changing inputs needs separate approval. So V2 applies the SOLUSD strategy's inputs unchanged, and says so. Whether
the owner would use the same inputs on BTC/ETH charts is **unconfirmed**. No TradingView parity exists for BTC/ETH yet
(no report or export).

**Code changes** (`ote.mjs`, `broker.mjs`, indicators, sizing and profiles unchanged):
- `config.mjs`:
  - `ENGINE_FUNDED` (default `on`);
  - `MIRROR_ONLY_SYMBOLS` = BTCUSD, ETHUSD (refused for a funded engine);
  - `ENGINE_MARKETS` parsing (`marketList`, `loadMarketConfigs`), which refuses SOLUSD (it has its own engine; a second
    SOLUSD mirror would feed the same account), duplicates and unknown symbols;
  - mirror-only needs `ENGINE_MIRROR=on`; website settings are forced off for mirror-only markets.
- `runner.mjs`: `tickMirrorOnly()` fetches the market's candles, steps the mirror and delivers.
  - A market-data error is recorded (state, audit, health report) and never thrown.
  - The funded path is untouched.
- `markets.mjs` (new), `MarketsRunner`:
  - polls markets in turn, with a 1.1 s pause between Kraken calls;
  - each poll is isolated (try/catch, 90 s timeout);
  - a hung poll is never started twice on the same state.
- `cli/run.mjs` → dispatcher. `cli/run-single.mjs` is the previous `run.mjs`, unchanged. `cli/run-markets.mjs` (new)
  is the mirror-only process, with one lock per market. A one-shot run exits naturally (avoids a Windows libuv exit
  assertion).
- **Worker:** `GET /api/dashboard/mirror/overview`, read-only and session-only, with four queries whatever the number
  of markets. It returns one entry per market with health, open position and per-category trades and results, and
  **no total across markets**. The existing routes take `?account=` (already supported). No D1 change.
- **Dashboard:** market selector and one card per market (status, last candle, open position, observation gaps,
  Live/Catch-up/Historical trades and gross, each separate). Trade links carry the market's account. Without the
  overview (older Worker) it falls back to the V1 single-market view.

## 2. Verification of Kraken data (2026-11-11 04:10 UTC, public read-only)

- **AssetPairs:**
  - `XXBTZUSD` (altname XBTUSD): pair decimals 1, tick 0.1, online;
  - `XETHZUSD` (altname ETHUSD): pair decimals 2, tick 0.01, online;
  - `SOLUSD`: tick 0.01.
- **OHLC 5m** for each new market: 720 completed candles (2026-11-08 16:10 → 11-11 04:05), 0 duplicates, unordered,
  off-grid or invalid candles, 0 gaps.
- **Fixtures:** committed as `engine/test/fixtures/BTCUSD-5m-kraken.json` and `ETHUSD-5m-kraken.json`.
- **14-day histories:** rebuilt from Kraken's public trades (resumable chunks) and cross-checked with Kraken's own OHLC
  where they overlap. See section 4.

## 3. Tests

Development only, on isolated temporary databases and committed real Kraken fixtures. Production was not touched.

| Suite | Result |
|---|---|
| Engine `npm test` at the V2 commit `1faf9f1` | **184/184** |
| — `test/markets.test.mjs` (13) | configuration and refusals (3); **SOLUSD byte-identical to the deployed release `0db082f`**: funded state, mirror state, audit trail and every request (1); BTCUSD/ETHUSD live replay = backtest trade by trade, only mirror requests, own ids, accounts and sequences (2); isolation: Kraken failure in one market for 40 polls, a hung poll and its timeout, a real data gap, process restarts, refusals (5); entry point `run.mjs`: the multi-market process with per-market locks, and the unchanged single-market engine (2) |
| Engine `test/markets-backtest.test.mjs` (6, added with this document) | per market: 14-day data integrity and an exact match with Kraken's OHLC (670 overlapping candles each); mirror replay = backtest trade by trade; results pinned (section 4) |
| Worker `npm test` | **238/238**, including `test/mirror_markets.test.mjs` (4): the real `MarketsRunner` (BTCUSD+ETHUSD) plus a SOLUSD mirror deliver to a local Worker; one account per market; each market's trades = its own backtest; every request ≤ 9 D1 queries and ≤ 25 records; overview per market and category with no total; session-only routes; funded books unchanged |
| Frontend `vitest run` and `tsc --noEmit` | **116/116**, typecheck clean, including 3 V2 tests: one card per market, categories separate, no cross-market total; SOLUSD shown first; trade links carry the account |
| Worker bundle (`wrangler deploy --dry-run`, nothing uploaded) | 204.23 KiB; `ENABLE_TRADING=false`, `PAPER_COST_PROFILE=none` |

With the backtest test added, the full engine suite passes **194/194** (2026-11-11 ~05:20 UTC, shared checkout).

## 4. Independent historical backtests (BTCUSD, ETHUSD)

**Hypothetical, independent results.**
- Margin 0; touch fills; gross = TradingView-style with 0% commission.
- Strategy inputs = the SOLUSD settings, unchanged and not tuned for these markets.
- No TradingView reference exists for BTC/ETH.
- 14 days is a small sample.
- SOLUSD's results say nothing about these markets, and these say nothing about future performance.

**Data:** Kraken 5m candles 2026-10-28T00:00Z → 2026-11-11T00:00Z, rebuilt from Kraken's public trade list
(`src/cli/history-chunks.mjs`). Committed as `engine/test/fixtures/<SYM>-5m-14d.rows.json.gz` with SHA-256.

| | BTCUSD (XBTUSD) | ETHUSD |
|---|---|---|
| Candles | 4,023 of 4,032 intervals; 9 intervals without trades (one gap, 2026-10-30 02:25, the same Kraken-wide pause seen on SOLUSD) | same: 4,023 of 4,032, the same 9-interval gap |
| Duplicates, unordered, off-grid, invalid | 0 | 0 |
| vs Kraken's own OHLC candles | 661 compared by the download, 0 mismatched; 670 overlap with the committed OHLC fixture, all equal | 658 compared, 0 mismatched; 670 overlap, all equal |
| Mirror replay = backtest | trade by trade, all 63 | trade by trade, all 57 |
| Closed trades (LONG / SHORT) | **63** (34 / 29) | **57** (30 / 27) |
| Winners | 27 | 23 |
| **Gross P&L** (LONG / SHORT) | **−$2.58** (+$15.35 / −$17.93) | **+$51.18** (+$29.38 / +$21.79) |
| Profit factor | 0.989 | 1.31 |
| Max drawdown (closed trades) | $73.01 | $67.48 |
| Exits: TP2 / SL / trailing / BE / same-candle | 13 / 20 / 24 / 3 / 3 | 9 / 8 / 29 / 4 / 7 |
| Modelled net, Ndax 0.20% + 0.10% slippage (comparison only) | **−$1,940.32** | **−$1,258.79** |
| Modelled net, Kraken Pro Tier 1 0.40/0.80% + 0.03% | −$4,592.55 | −$3,063.26 |
| Largest position notional ($10 risk) | $22,487.51 | $14,420.91 |

The mirror is meant to observe, not to profit:
- Over these 14 days the strategy was about flat on BTCUSD and positive on ETHUSD **before costs**.
- With any modelled exchange costs, both are strongly negative. The stops are tight, so positions are large relative
  to the $10 risk, and fees on the notional dominate. This is the same pattern as on SOLUSD.
- About 4 trades per market per day were completed. Live observation would add roughly 8 BTC/ETH opportunities a day
  to SOLUSD's, while the PC is on.

## 5. Isolation, duplicates and recovery

**Isolation:**
- One market's Kraken failure (40 polls), hang (timeout), real data gap (reset) or a process restart never changes
  another market's processing, state or trades (tested).
- After an outage a market catches up from Kraken's history: trades are `catch_up` and disclosed as an observation
  gap, exactly as for SOLUSD.
- A gap beyond Kraken's 720 candles resets that market only and records an open position as interrupted.

**Duplicates:**
- One lock per market file: a market already run by any engine is refused at start (tested).
- SOLUSD cannot be listed in `ENGINE_MARKETS`.
- Worker idempotency is per account: trade id and sequence, payload hash, conflicts never overwrite. Ids carry the
  symbol and accounts carry the inputs hash, so markets can never collide.

**Recovery (proposal):**
- Stop the multi-market task, or remove `ENGINE_MARKETS`; SOLUSD is unaffected.
- Release rollback in the multi-market root only.
- **Never** delete a `mirror-<SYM>-5m.json` (a new activation is refused for the same account) and never restore D1.

## 6. Resources

| | Measured / estimated | Limit |
|---|---|---|
| Windows process (2 markets) | ~75 MB RSS (Node baseline ~59 MB); warm-up of 2 × 720 candles: 125 ms CPU; per poll for both markets ~2.7 ms CPU (excluding network); state ~10 KB per market | — |
| Kraken public REST | SOLUSD engine 1 call / 20 s plus the multi-market process 2 calls / 20 s, at least 1.1 s apart ≈ 0.15 calls/s | Kraken's documented REST counter: max 15, decay −0.33/s on the lowest tier (≈ 1 call per 3 s sustained). The documentation describes it per API key; public market data is not separately documented, so this is the conservative bound |
| Worker requests | +~600/day (≈ one mirror request per candle per new market; heartbeat every 15 min) on top of ~9,000 (SOLUSD engine) plus the dashboard | 100,000/day (Free) |
| Worker CPU | production mirror requests measured 2–3 ms (Stage C tail); same code path per market | 10 ms/request |
| D1 per mirror request | ≤ 9 queries, ≤ 25 records (tested on every request, all three markets) | 50 queries |
| D1 rows written | ~+700/day for two markets (account upsert per request, a few trade rows) | 100,000/day |
| D1 rows read | overview: 4 queries over the mirror tables per page open (rows read ≈ trades + journal entries); per-market detail as V1 | 5,000,000/day |
| Storage | ~2.5 KB per trade; a few trades/day per market ≈ 10 MB/year for three markets | 500 MB |

## 7. SOLUSD production behaviour is unchanged (evidence)

- **Same inputs, same entry point.** `loadConfig` for the production profile gives `funded: true`, inputs hash
  `c826d785d58a4a39` and website settings on, exactly as deployed. Without `ENGINE_MARKETS`, `run.mjs` runs the
  single-market engine (tested through the real entry point).
- **Byte-identical to the deployed release.** The SOLUSD engine of this branch and the deployed release `0db082f`
  (extracted from git) were run on the same real candles with the same Worker answers. The funded state file, mirror
  state file and audit trail are **byte-identical**, and so is every request sent (`engine/test/markets.test.mjs`).
- **Funded books untouched by the new markets.** In the local-Worker test with all three markets, the funded tables
  were unchanged by BTC/ETH (their only requests are `/webhook/engine-mirror`), and only SOLUSD's own funded signals
  reached the ledger.

## 8. Limitations

- **Hypothetical:** margin 0, touch fills, no liquidity or queue limits; BTC positions at $10 risk can be large
  notionals.
- **Inputs not tuned:** the SOLUSD inputs are applied unchanged to BTC/ETH, and no TradingView reference exists for
  those markets.
- **Costs:** the cost comparison uses the Ndax profile (0.20% flat) for all markets. It is an estimate on Kraken prices.
- **Same PC:** the new process shares the PC's power schedule; nights off become catch-up and observation gaps.
- **Rate limits:** Kraken's public rate limit is not separately documented. The design stays far below the
  documented private-API rate; history downloads (research only) use 1.1 s spacing.
- **Live ticker:** the Worker's comparison reference price for live BTC/ETH trades uses Kraken's public ticker (one
  call per request at most).

## 9. Proposed staged rollout (each stage separately approved; nothing executed)

1. **Review** this implementation and the evidence.
2. **Worker** (no migration). Deploy the V2 Worker (overview route and dashboard) with the same configuration; verify
   as in Stage B. Rollback: `4d3ddcb6` (V1) or earlier. The V1 dashboard keeps working; V2 falls back without the
   overview.
3. **Multi-market engine root.**
   - Prepare a pinned release of the approved commit in a **new root** `%USERPROFILE%\AlphaTerminal\engine-markets`
     with its own `config\engine.env`:
     - `ENGINE_MARKETS=BTCUSD,ETHUSD`, `ENGINE_MIRROR=on`, `ENGINE_PROFILE=solusd-5m`;
     - the same sync settings;
     - `ENGINE_FRESH_START_OK=yes`;
     - `ENGINE_DATA_DIR=%USERPROFILE%\AlphaTerminal\engine-markets-state`.
   - `validate` and a one-shot `selftest`-style run with sync off.
   - The SOLUSD root, task and state are not touched.
4. **Separate scheduled task** "ALPHA TERMINAL Mirror Markets": the same launcher (`run-release.ps1 -Root
   …\engine-markets`) and the same sign-in triggers, created from the SOLUSD task XML with only the action's root
   changed. Start it and verify:
   - two mirror accounts activated, warm-up `historical`;
   - one mirror request per candle per market;
   - CPU and D1 within limits;
   - SOLUSD engine and funded books unchanged.
5. **Monitoring:** first live BTC/ETH hypothetical trades, observation gaps, daily D1 usage. Add TradingView parity for
   BTC/ETH only if the owner supplies reports or exports.

**Not part of V2:** funded trading on BTC/ETH, transfers, fees, risk or strategy changes, real-money trading.
