# ALPHA TERMINAL — development instructions (permanent)

These rules were updated 2026-11-12 for the multi-bot directive and replace the earlier "1% of equity, no shorts" sizing rule. They apply to every future change.

## Honesty

1. **No fake data.** No invented trades, no fabricated market activity, no misleading profit figures.
   - A figure that cannot be computed from records stays missing ("N/A", "NOT YET OBSERVED").
   - Every number traces to a ledger row, an engine report or a saved Kraken candle.
2. **Hypothetical vs funded.** The Strategy Mirror is hypothetical research: TradingView reference, fixed $10 risk, unlimited buying power, no fees.
   - It is labelled hypothetical everywhere.
   - It is never added to funded PAPER balances, P&L, performance or notifications.
3. **Parity claims need evidence.** Never claim TradingView parity without a side-by-side comparison over the same window. Never invent a reference result that was not supplied (BTC 5m has none).

## Bots

4. **One bot per (market, timeframe, strategy).**
   - Each bot has its own id `ALPHA-NN`, profile, state files, signal ids, wallet, ledger rows, status report and mirror account.
   - Never let one engine switch markets or timeframes. Never merge two bots' positions.
   - Registry: `engine/src/bots.mjs`, with matching rows in the Worker `bots` table.
5. **Exact inputs.** A bot runs only with its own exact profile (`engine/profiles/<symbol>-<tf>.env`) mirroring the TradingView inputs.
   - Never copy inputs from another timeframe or market.
   - Unconfirmed fields are marked as such in the profile.
   - ALPHA-02 keeps its legacy identity and inputs hash `c826d785d58a4a39`.
6. **New bots start PROPOSED.** Activation, allocation and any new market (ETHUSD is inactive) need the owner's approval. Follow `docs/MARKET-INTEGRATION-CHECKLIST.md`.

## Money (PAPER only)

7. **Dollar-risk sizing, capped by capital.**
   - Each bot risks its own editable dollar amount (default $10) through `engine/src/sizing.mjs`.
   - The quantity is reduced, never raised, to fit the bot's available wallet cash and the instrument minimums.
   - Below the minimum the signal is skipped with a code (`BELOW_MIN_QTY`). Nothing is forced.
8. **Independent wallets.**
   - Each bot trades only its own wallet. A crypto group's allocation is split equally between its bots.
   - Money moves only by an authenticated owner action, with a fresh request id and an `allocation_events` row.
9. **Simulated shorts** (`short-fully-collateralised-v1`).
   - Collateral equals 100% of entry notional. No borrowing and no financing are modelled.
   - A loss beyond the bot's cash is recorded as `shortfall_micro`, and entries pause. MAIN never silently covers it.
10. **Fees.** Use Ndax-equivalent 0.20% per fill, on entry and exit, under model id `ndax-flat-0.20-2026-11-12`. Show gross, fees and net separately.
11. **Profit sweep.** Each closed trade's positive realized net profit moves to MAIN, keyed `SWEEP:<trade_id>:OUT/IN` and exactly once. Losses stay in the bot wallet.
12. **Integer micro-USD and reconciliation.**
    - For every wallet: available + reserved = net funding + realized − fees.
    - The sum of all wallets equals the total funding.
    - A mismatch blocks entries and is shown.
13. **Canonical ids, no duplicate financial records.**
    - Every order, fill and position has one id.
    - Duplicate webhooks are rejected by unique keys, never by best-effort checks.
    - Trade history is never deleted or rewritten.

## Strategy restrictions

14. **No extra restrictions.** Do not add filters, caps or disabled sides beyond the strategy's own Pine rules and real constraints (capital, minimums, collateral). Any new restriction needs owner approval. Do not silently disable shorts.

## Product

15. **Shared signal states.** Activity, Trade Signals and notifications use one status mapping (`worker/src/events.ts` `signalState`) and stable ids that link to each other.
16. **Bounded dashboard.**
    - Every outbound fetch on the dashboard path has a timeout.
    - A failed refresh keeps the last snapshot, labelled with its age.
17. **The ALPHA Assistant stays deterministic and read-only.** It has no language model, costs nothing and never acts. It answers only from records, with evidence, or says it does not know.

## Process

18. **Owner approvals.** Each production migration, deployment, engine activation, configuration change and capital transfer needs its own owner approval. Real-money trading stays disabled (`ENABLE_TRADING=false`).
19. **Additive, rehearsed migrations.** Migrations only add. They are rehearsed on a copy before production. Never restore D1 automatically. Never delete backups, mirror state or trade history.
20. **Secrets.** Never print, commit or request secrets: the dashboard passphrase, admin secret, webhook secret, VAPID private key, exchange credentials and DB exports. `engine.env` and backups stay private.
21. **Regression gates before any release:**
    - engine `npm test`, including `sizing-acceptance.test.mjs` and `fleet.test.mjs`;
    - worker `npm test`, including `multi_bot.test.mjs` and `migrations.test.mjs`;
    - frontend `vitest` and `tsc`.
