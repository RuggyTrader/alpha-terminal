# Forward research shadow (research only)

A separate system that evaluates registered candidates on **candles that did not exist when they were registered**.

- **It never submits orders.** Not real orders, and not production PAPER orders.
- **It never touches the funded ledger.** No engine state, bots, `engine.env` or Worker are involved.
- **It is labelled HYPOTHETICAL everywhere.** Its results are never added to funded PAPER balances, P&L or notifications.

| Part | File |
|---|---|
| Append-only candle store; hash-chained audit log | `engine/src/research/forward/store.mjs` |
| Collector: Coinbase public candles + daily Kraken minimums snapshot (no keys) | `engine/src/research/forward/collect.mjs`, `run.mjs collect` |
| Deterministic shadow evaluator | `engine/src/research/forward/shadow.mjs`, `run.mjs evaluate` |
| Frozen registry | `docs/research/forward/registry.json` |
| Tests (store, catch-up equivalence, start_at boundary, minimums, isolation) | `engine/test/forward-shadow.test.mjs` |

## Commands (macOS or Windows; Node 22+)

```bash
cd engine
node src/research/forward/run.mjs collect     # append completed candles + today's minimums snapshot
node src/research/forward/run.mjs evaluate --out ../docs/research/forward/report.json
node src/research/forward/run.mjs verify      # audit hash chain
```

State lives in `engine/data/forward/`, which is gitignored. It holds the candles, the minimum snapshots,
`audit.jsonl` and `report.json`.

## How it avoids future-data leakage

- **Closed candles only.** A candle is stored only after it has closed. Stored candles are **never rewritten**.
  - A later exchange revision is appended as a revision row and reported.
  - The evaluator uses the **first-seen** values.
- **Frozen start.** Each candidate trades only from its frozen `start_at`. That is after its registration time, and the
  registry may not be edited after `start_at`.
- **The round-8 portfolio backtester runs the replay.** Decisions are taken at the bar close and filled at the next
  open. Every fill pays fees and slippage, Kraken minimums apply, and every rejected entry is recorded.
- **A missing minimum excludes the market.** It is never treated as zero.
- **Information audit.** For each decision, the report shows the bar close and when that candle was first collected.

## Always-on is not required (by design)

The candidates use 4h and daily bars, and the exchange keeps history. A collector that runs **once a day**, or after
any downtime, stores the same candles a 24/7 process would have. A test proves this ("a run after downtime stores
exactly what continuous runs would have"). The shadow result is a deterministic replay, so a sleeping laptop loses
nothing. It only delays the report.

**Free, always-on options** (prepared only; **not deployed**, because each needs the owner's decision):

1. **Windows Task Scheduler** on the existing PC: a daily `node src/research/forward/run.mjs collect && ... evaluate`.
   It uses its own folder, not the engine's.
2. **A GitHub Actions scheduled workflow** in this public repository. It is free for public repositories. It would run
   collect and evaluate daily and commit `report.json` to a `research/forward-data` branch.
   - Note: GitHub runner IPs may be rate-limited by the exchanges.
   - Needs the owner to approve adding a workflow with write permission.
3. **A Cloudflare Worker cron** in a *separate* research Worker with its own D1/KV. It must not be the production
   Worker. This needs `wrangler login` and the owner's approval, and must stay inside free-tier limits.

## Registered candidates (`registry.json`, start_at 2026-11-18 00:00 UTC)

| Id | Source | Basket |
|---|---|---|
| RESEARCH-FWD-T1 | R8-T1-240-55-20 (Donchian 55/20, 4h) | 20 untouched markets + BTC, ETH, SOL |
| RESEARCH-FWD-M1 | R8-M1-1440-30 (30-day momentum) | same |
| RESEARCH-FWD-P3 | R8-P3-1440-30-3 (top-3 rotation) | same |

**Registration timing.** All three were registered **before** any round-8 historical result, so the forward sample is
not selected on history. The round-8 historical gate still applies before any PAPER proposal.

**Minimum before any conclusion:** 180 forward days **and** 30 closed trades. Until then the status is
**COLLECTING**, and an early positive number means nothing. The acceptance criteria are in `registry.json`.

**Status on 2026-11-17:** no forward data has been collected. The Mac session that built this had no network access
to the exchange APIs. Collection should start on or soon after 2026-11-18. Thanks to catch-up, starting a few days
late loses nothing.
