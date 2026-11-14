# Production diagnosis — 2026-11-14 (read-only; nothing in production was changed)

**Evidence sources:**
- Windows event log and Task Scheduler on the engine host (MATT_PC, this PC).
- The production engine's audit trail and state: `%USERPROFILE%\AlphaTerminal\engine-state\`, logs in `engine-prod\logs\`.
- `wrangler deployments list`.
- Read-only `SELECT`s on production D1.
- The live site (`/`, `/health`, `/sw.js`).
- `git fetch` of every branch.
- The extracted refusal list: `docs/diagnosis/short-refusals-2026-11-14.json`.

## Answers to the owner's 25 questions

### Deployment and engine state

1. **Why the website doesn't show the requested UI:** it was never deployed.
   - Production still runs **Worker version `1b51170c` (commit `af924ff`, deployed 12 Nov 03:30 UTC)**.
   - Every change since (multi-bot, trade cards, charts, Home cleanup, assistant) exists only on branches; each production step was waiting for owner approval.
   - **Not a cache issue:** `/sw.js` has no fetch handler and no cache. The live page loads `index-BMS-_qKf.js` from the `af924ff` build.
2. **Frontend:** the `af924ff` build, served by the same Worker (assets `index-BMS-_qKf.js` / `index-C6MCDGJh.css`).
3. **Worker:** `1b51170c-4f9d-41c0-8284-fa8ab61eac81`, at `https://alpha-terminal-api.mattledger787.workers.dev`.
4. **Database schema:** **6** (`app_meta.schema_version`). There are no bot-ledger tables, so production has **no SHORT accounting**.
5. **Engine:** release **`af924ffa4703`**, verified by the supervisor. It runs on **this Windows PC** (MATT_PC), started by the scheduled task "ALPHA TERMINAL Engine" through `engine-prod\bin\run-release.ps1`. It is a single bot: ALPHA-02 SOLUSD 5m, percent sizing (1%, max $10).
6. **Running now?** Yes. Started at boot, 14 Nov 01:42 Toronto (06:42 UTC). One instance; a duplicate supervisor exited by design.
7. **Last completed candle processed:** 14 Nov 21:55 UTC, processed 22:00:25 UTC. Heartbeat is current in D1.

### The trading gap

8. **Why Trades stop at 12 Nov:**
   - **Only one funded trade has ever executed**: trade #1, LONG SOLUSD, opened 13 Nov 00:35 UTC = **12 Nov 19:35 Toronto**, −$0.03.
   - No funded trade has executed since. The website is not hiding newer trades.
9. **Did genuine signals occur on 13–14 Nov?** Yes. From the engine audit:

   | Day (UTC) | Setups | Orders placed | Fills |
   |---|---|---|---|
   | 13 Nov | 6 LONG, 6 SHORT | 5 LONG | 2 |
   | 14 Nov | 1 LONG, 10 SHORT | 1 LONG | 0 |

   - **Every SHORT was refused**: 25 since 12 Nov, all `SHORT_NOT_ALLOWED`.
10. **Did PAPER executions occur?**
    - 13 Nov 00:35 UTC: one LONG executed (trade #1).
    - 13 Nov 15:00 UTC: a second LONG filled in the strategy, but the engine was **offline**. It was processed 12 h late and correctly not sent (`SIGNAL_EXPIRED`, 724 min late), so it couldn't fill at a stale price.
11. **Records missing from the website?** No. D1 has 1 trade, and the 13 Nov BUY/CLOSE alerts, both accepted. Nothing newer exists to show.
12. **Synchronization failure?** Not for the trade that exists: it appears once, everywhere. The perceived desync is real but comes from three other things:
    - (a) the Mirror records SHORTs that funded refuses;
    - (b) the engine was offline about 23.5 h;
    - (c) the old UI labels the Alpaca broker route's kill switch as "engine STOPPED" (`/health` `engine.state = STOPPED`, unchanged since 31 Oct).

### SHORT trades

13. **Why SHORTs are refused:**
    - **(A) A legacy long-only execution path.** The production engine's sizing policy has `allowShort: false`, so `sizePosition` refuses `SHORT_NOT_ALLOWED` before sending anything (`engine/src/sizing.mjs`, release `af924ff`). The legacy ledger (`paper_positions`, schema 6) is long-only.
    - **(B) An ambiguous SELL.** Before 12 Nov 05:00, the older release sent SHORT entries as `SELL`; the production Worker treats every SELL as closing a LONG, so it rejected them with `NO_POSITION` ("no open long position in SOLUSD"). Evidence: `ENG-SOLUSD-5-2026-11-11T05:30:00Z-SELL` (42.89 SOL) and `…07:55:00Z-SELL` (27.17 SOL).
    - **(O) Schema 6** has no SHORT accounting.
    - **(P) The deployed engine and Worker are outdated** relative to the development fix.
    - Not the causes:
      - (F) Alpaca is not on this path;
      - (H)–(K) collateral, sizing, fees and capital never ran for SHORTs;
      - (C) the profile allows shorts (`STRAT_ALLOW_SHORT=true`).
14. **Legitimate vs implementation problem:** **all 25 refusals are implementation and deployment limitations**, not risk decisions. Each had $10 (later $9.97) of capital and a planned limit and stop (listed in the JSON). The same SHORTs appear in the Mirror; for example 12 Nov had 3 SHORTs, +$15.69 hypothetical gross.
15. **Does the production route support SHORTs?** **No.**
16. **Does the internal ledger support fully collateralized SHORTs?** **Yes, in development** (bot ledger, migration 0007, `worker/src/bot_ledger.ts`, tested end to end), but **not in production**.

### Routes and data

17. **Is Alpaca used?** **No**, for the strategy engine.
    - The engine sends to `/webhook/dry-run`, the internal ALPHA PAPER ledger in D1.
    - Alpaca is configured only for the separate `/webhook` broker route, which has been STOPPED by its kill switch since 31 Oct.
    - Alpaca crypto does not support short selling either.
18. **Mirror vs actual PAPER:**
    - The Strategy Mirror is a parallel **hypothetical** record of every strategy trade: $10 fixed risk, unlimited buying power, no fees.
    - Funded PAPER is what the ledger actually executed.
    - When funded refuses (every SHORT), the Mirror still records the trade. That is exactly the "trades stay hypothetical" effect the owner sees.
19. **Are valid setups only evaluated hypothetically?** SHORTs: **yes, in effect.** LONGs are submitted; one executed and one expired while the engine was offline.
20. **Authoritative history:** the D1 ALPHA PAPER ledger: `trades`, `paper_positions`, `paper_fills` on schema 6. After migration 0007, also `bot_positions` / `bot_fills`. **The Mirror is never authoritative.**
21. **Why the chart is missing:** the chart pages exist only in undeployed code. Also, the production engine does not record planned entry, stop and target in D1 (its plan exists only in the local audit file). The plan-recording engine change is undeployed too.
22. **Features that exist but are undeployed:**
    - multi-bot fleet;
    - SHORT ledger;
    - explicit OPEN_LONG / OPEN_SHORT / CLOSE;
    - trade cards and stories;
    - charts for every bot and trade;
    - Home, Trades, Activity and Performance changes;
    - lifecycle notifications;
    - the contextual assistant;
    - dashboard reliability fixes;
    - plan recording.
23. **Genuinely incomplete:**
    - Settings reorganisation into the six owner sections;
    - demoting the Strategy Mirror to a Research area;
    - durable pending orders on the Worker (today pending orders live in engine state; the ledger fills at the reference price when the signal arrives);
    - an explicit LONG↔SHORT reversal path;
    - partial exits (the strategy has none: Pine uses a single TP2/stop exit);
    - a fleet-level signal→outcome reconciliation view;
    - 360 px verification of the final UI;
    - engine host resilience (next item).
24. **Production changes required:**
    1. Worker + frontend (final release).
    2. Migration 0007 (adds the bot ledger; one lossless `trade_events` rebuild).
    3. Engine release with the fleet runner, explicit actions and plan recording.
    4. Switch ALPHA-02 to the bot ledger (stage S1).
    5. Allocate SOL capital to the bot wallets (owner).
    6. Activate further bots one at a time (owner).
    7. Engine host: start at Windows **startup**, not only at **logon** (owner).
25. **Safe sequence:** see `docs/RELEASE-FINAL-PLAN.md`.

## Why the engine stopped (13–14 Nov)

The engine runs on this PC, and the scheduled task's only triggers are **"at log on"** (MATT_PC\hujhj, interactive):

| Time (Toronto) | Event | Engine |
|---|---|---|
| 12 Nov 22:36 | PC powered off by the user (event 1074) | stops; last live candle 13 Nov 03:30 UTC |
| 13 Nov 15:15 | PC started; Windows Update restart at 15:16 | **not started**: no logon before shutdown |
| 13 Nov 17:14 | Powered off | — |
| 13 Nov 22:06 | Started; logon | engine started 22:08 and caught up 280 candles |
| 14 Nov 01:40 | Restart | engine back at 01:42 |

- **Offline:** 13 Nov 03:35 UTC → 14 Nov 03:08 UTC, about 23.5 hours, so no live trading.
- **Fix:** the owner changes the task to start at **system startup** and run **whether the user is logged on or not**. This needs the Windows password stored with the task, so the owner does it. Steps are in the plan.
- The PC must also stay on and awake; it is the only engine host. Moving the engine to an always-on host needs separate approval.
