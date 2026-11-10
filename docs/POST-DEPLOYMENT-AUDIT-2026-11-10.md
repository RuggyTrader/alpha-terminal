# Post-deployment monitoring and PAPER execution audit (2026-11-10)

**Scope.** Read-only production checks, plus isolated local tests. Nothing in production was changed:
- no deploy, no D1 write, no engine restart, no task change;
- no balance, risk, strategy, secret or cost-profile change;
- no signal sent.

The recommendation in section 6 is a design only. Nothing is implemented.

## Summary

1. **Production is healthy.**
   - Monitoring covers **02:06–03:30 UTC, about 1 h 24 min**. That is not "several hours"; longer stability is not
     yet shown.
   - The engine processed every candle once, with no gaps or restarts.
   - The ledger is unchanged and reconciles, with 0 FEE rows and no duplicates.
2. **No signal has reached the Worker since the deploy, so post-deploy PAPER execution is unverified.**
   - A SHORT limit order was placed at 03:00 UTC and was still unfilled at 03:25.
3. **Since the live engine started (2026-11-09 01:28 UTC), it has never delivered a signal.**
   - All 10 rows in `alerts` are manual tests from 2026-10-31.
   - The engine's 39 recorded signals are 36 warm-up replays (never sent by design) and 3 live signals skipped as
     `SIGNAL_EXPIRED` after a processing gap.
4. **Even when signals arrive, the funded ledger will refuse almost all of them.** Shown with the deployed Worker
   code on production-shaped data, using real engine signal sizes:
   - shorts → `NO_POSITION`;
   - longs → `INSUFFICIENT_PAPER_CAPITAL`, because a $10-risk trade needs about $3,000 of buying power and SOLUSD
     holds $10;
   - the largest longs → `MAX_ORDER_NOTIONAL` (above $5,000).

   The engine then drops its own position. This is designed behaviour, not a malfunction: a funded, long-only,
   $10 account cannot hold the strategy's positions.
5. **Recommendation: an isolated "strategy mirror" PAPER account** with TradingView's margin-0 semantics, kept apart
   from the funded ledger and never summed with it (section 6). It needs owner approval in stages. The first stage
   is development only.

---

## 1. Post-deployment stability (Objective 1)

Window: deploy at **2026-11-10 02:06:07 UTC**, last observation **03:29:52 UTC**.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Pinned engine release | ✅ `6b70cc97c579`, files and launcher verified; PID 15976 (started 00:36:04 UTC), not restarted; task "ALPHA TERMINAL Engine" Running | `release.mjs status`, process list |
| 2 | Every candle processed once | ✅ 16 candles, 02:05 → 03:20 (candle open times), 0 gaps, 0 duplicates; each processed 5.2–5.4 s after close | `audit-SOLUSD-5m.jsonl`, `engine.log` (16 normal lines, nothing else) |
| 3 | No gaps, duplicate signals, unexpected warm-ups or crashes | ✅ 0 warm-up candles, 0 `process_start`/`error` entries since the deploy; `state-check`: 39 signals, 0 duplicate ids, 0 pending, resets 0 | audit, `state-check` |
| 4 | Worker health and version | ✅ `e941387e-0942-4320-b0dd-454235095c4b` at 100%; `/health` ok, PAPER, database connected, `enable_trading:false` | `deployments status`, `/health` |
| 5 | Schema | ✅ 4 | D1 |
| 6 | Wallets reconcile | ✅ MAIN $90.00, SOLUSD $10.00, others $0; reserved $0, realized $0, fees $0. Available + reserved ($100) = funding + realized − fees ($100) = sum of all entry changes ($100) | D1 |
| 7 | No duplicate fills or unexpected transactions | ✅ 0 fills, 0 trades, 0 open positions; entries 3, alerts 10 (last 2026-10-31), orders 4, risk decisions 8: all unchanged | D1 |
| 8 | Zero FEE entries | ✅ 0 FEE entries; wallet `fees_micro` all 0 | D1 |
| 9 | Risk controls unchanged | ✅ live Worker variables equal the deployment record:<br>- `ENABLE_TRADING` false, `SHORT_SELLING_ENABLED` false, `PAPER_COST_PROFILE` none;<br>- `MAX_ORDER_QTY` 10, `MAX_ORDER_NOTIONAL` 5000, `MAX_FUTURES_ORDER_NOTIONAL` 75000;<br>- `MAX_POSITION_EXPOSURE` 10000, `MAX_TOTAL_EXPOSURE` 25000, `MAX_OPEN_POSITIONS` 5, `DAILY_LOSS_LIMIT` 2000.<br>Strategy risk: SOLUSD v1 $10, not compounding, APPLIED (D1 and engine state) | `versions view`, D1, `state-check` |
| 10 | No new Worker authentication or API errors | ⚠️ **Partly verifiable.** No new `alerts`, `orders`, `risk_decisions` or `activity_events` rows; the engine's ledger check stayed OK (last 03:26:07 UTC, kept in its state file).<br>Wrong-secret requests are **not** stored in D1 (the deliberate wrong-secret probe at 02:06 left no row). Cloudflare request logs can only be followed live (`wrangler tail`), not read afterwards. Authentication errors from other clients can therefore be neither ruled out nor confirmed for this window | D1, engine state |

Corrections to the deployment record:
- The engine's **ledger check does run at every poll**. It is written to the audit log only when its result changes,
  which is why the audit showed only the 00:36 entry. The last result, at 03:26:07 UTC, was OK.
- The heartbeat is written at engine start only.

Earlier (not in this window): 84 engine `error` entries on 2026-11-09 between 18:33 and 21:39 UTC (82 Kraken timeouts,
1 Kraken HTTP 500, 1 fetch failure). There have been none since.

## 2. Signals since the deploy (Objective 2)

| Time (UTC) | Event | Status |
|---|---|---|
| 03:00 candle (processed 03:05:05) | `SETUP` short (leg 86.67 → 85.77) and `ORDER_PLACED` SELL limit **86.40**, stop **86.69**, TP2 **86.00**, qty **35.61067391** SOL, score 2 | still "ORDER PLACED – waiting fill" at the 03:20 candle; the high was 86.14 at most, so the limit was not reached |

- An order that has not filled is not a signal. Nothing was sent, and D1 has no new rows.
- **The first post-deploy signal has not happened, so post-deploy signal handling remains unverified in production.**

If this order fills, the code and the isolated probe (section 7) predict the following:
- the engine sends `SELL 35.61067391` with id `ENG-SOLUSD-5-<bar>-SELL`;
- the Worker answers **HTTP 422 `NO_POSITION`** ("no open long position in SOLUSD"): there is no long to sell, and
  shorts are not allowed;
- the engine records the item as `rejected` and writes `entry_dropped`;
- the engine leaves its simulated short at once, with no exit, no trade and no P&L (`runner.mjs`, header and flush);
- nothing is written to the ledger, so there is no fill to check for `fee_micro`.

## 3. Why PAPER trades are not executing (Objective 3)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Is the strategy generating valid entries? | **Yes.**<br>- 21 entries in the engine's 26-hour history (warm-up included): 10 BUY, 11 SELL.<br>- One SHORT order is live now.<br>- Over 150 days the identical logic gives 579 trades (~3.9 a day), and its trades match TradingView's benchmark | engine state, audit; `STRATEGY-AUDIT-2026-11-09.md`, `TECHNICAL-REVIEW-2026-11-09.md` (parity CONFIRMED) |
| 2 | Are signals reaching the Worker? | **None has, yet.**<br>- 36 of 39 recorded signals came from the warm-up replay of history. Those are never sent, by design: the Worker would fill them at today's price.<br>- 3 live entries (2026-11-09 12:35 SELL, 13:35 BUY, 14:15 SELL) were processed at 18:33 UTC, 4–6 h after their candles, after a processing gap. They were skipped as `SIGNAL_EXPIRED`, because delivery is only allowed within `ENGINE_LATE_BARS` = 2 candles.<br>- All 10 `alerts` rows are 2026-10-31 manual tests | engine state outbox, D1 `alerts` |
| 3 | Does `ENABLE_TRADING=false` still allow PAPER processing? | **Yes.**<br>- The engine posts to `/webhook/dry-run`, which simulates against the D1 ledger and never contacts a broker.<br>- `ENABLE_TRADING` only blocks the real-broker path.<br>- Production accepted dry-run test orders on 2026-10-31 (`DRY_RUN_ACCEPTED`) with `ENABLE_TRADING` false and the Worker's `engine_state` STOPPED. The probe repeats this on the deployed code | D1 `alerts` 6–7, probe |
| 4 | Would the Worker accept them? | **Almost never.** On production-shaped data (MAIN $90, SOLUSD $10, costs none):<br>- the live SHORT (SELL 35.61) → `NO_POSITION`;<br>- a real long (BUY 30.53) → `INSUFFICIENT_PAPER_CAPITAL` ("Estimated $2,842.33 exceeds … $10");<br>- the smallest real long (8.02) → `INSUFFICIENT_PAPER_CAPITAL` ($746.74);<br>- the largest (87.36) → `MAX_ORDER_NOTIONAL` ($8,134.09 > $5,000).<br>All are HTTP 422, so the engine treats them as final.<br>`MAX_ORDER_QTY` (10) does **not** apply to these crypto orders (an earlier assumption, now corrected by the probe) | `test/paper_fidelity_probe.test.mjs` |
| 5 | Buying power for a $10-risk trade | Quantity is $10 ÷ stop distance, and stops are very tight (median $0.26, about 0.3% of price):<br>- engine's 21 recorded entries: median **$3,357**, range $704–$7,777, median 37.8 SOL;<br>- 150-day Model A: 10th percentile ~$1,500, median $3,077, largest $15,061 | engine state; `STRATEGY-AUDIT` §3 |
| 6 | Can $10 support it? | **No.** $10 buys about 0.11 SOL. At a $0.26 stop that risks about $0.03, not $10.<br>Model C: with $10 or $100, **0 of 624** signals execute (297 short, 327 capital). Even with $10,000, 329 are refused (266 short, 10 capital, 53 order limit) | `STRATEGY-AUDIT` §3 Model C |
| 7 | Shorts? | **Long only.**<br>- `SHORT_SELLING_ENABLED=false`.<br>- The ledger treats SELL as reducing a long. A SELL with no long is `NO_POSITION`.<br>- 271 of Model A's 579 trades (47%) are shorts | config, probe, `STRATEGY-AUDIT` |
| 8 | Fill-model differences | - **TradingView and the engine:** a resting limit fills *at the limit price* when a candle trades through it; stops and targets fill at their levels, inside the candle (parity confirmed).<br>- **Funded ledger:** every fill uses the Kraken reference price *when the Worker processes the signal*, about 5 s after the candle closes. That is not the limit, stop or target price.<br>- Consequences: entry prices differ from TradingView. A trade that enters and exits in the same candle (23 of 579) would be sent as entry and exit together and priced at nearly the same live price, so its P&L would be ≈ $0 instead of TradingView's result (from the code; never observed in production).<br>- A stricter "fills only when traded through" assumption changes the 150-day result from +$150.24 to −$114.87 before costs | `TECHNICAL-REVIEW` §A, `STRATEGY-AUDIT` §3, fill disclosure |
| 9 | What prevents reproduction | In order of impact:<br>(a) no leverage and a $10 balance, against ~$3,000 positions;<br>(b) no shorts (47% of trades);<br>(c) the $5,000 order limit (largest longs);<br>(d) fills at the live reference price instead of the strategy's prices;<br>(e) a refused entry makes the engine drop its position, so the engine's live record also diverges from TradingView (later setups change);<br>(f) any processing gap over 2 candles expires entries;<br>(g) fees, when enabled, make the strategy strongly negative (Model B, Ndax: −$9,594 over 150 days), so a faithful mirror must report gross and net separately | all above |
| 10 | What would improve fidelity without changing the strategy | Record the strategy's own trades, at its own prices, in a separate account that has TradingView's margin-0 semantics and allows shorts (section 6). Changing sizing, adding leverage to the funded ledger, or funding SOLUSD with thousands of PAPER dollars would either change the strategy ($10 risk) or still leave out 47% of its trades | — |

## 4. Funded PAPER vs TradingView

| | TradingView (strategy properties) | Funded ALPHA PAPER ledger |
|---|---|---|
| Capital | initial capital is a reporting number; margin 0 = "infinite leverage" | real PAPER balance per strategy (SOLUSD $10) |
| Sizing | $10 ÷ stop distance, any size | same quantity requested; refused if the balance cannot pay |
| Direction | long and short | long only |
| Fill price | limit / stop / target price inside the candle | Kraken reference price at processing time |
| Limits | none | $5,000 per order, exposure limits |
| Fees | 0% (as configured) | none (`PAPER_COST_PROFILE=none`); a profile can be enabled later |
| What it measures | the strategy's hypothetical performance | what a real, unleveraged spot account of that size could have executed |

These two answer different questions. Neither is wrong, but they must never be added together or presented as the same
thing.

## 5. Dashboard (Objective 5)

| Check | Result |
|---|---|
| Public `/health` | ✅ PAPER, database connected, `enable_trading:false` |
| Dashboard page | ✅ HTTP 200 |
| `/api/dashboard` without login | ✅ HTTP 401 (authentication still enforced) |
| Settings → Execution costs = "No execution costs"; fill-pricing disclosure visible; Portfolio consistency OK | **Pending owner verification**: these need the dashboard passphrase, which was not requested or used.<br>The same deployed code on production-shaped data shows `costs.profile = none`, the disclosure text and `consistency.ok = true` (`deploy_rehearsal`, `paper_fidelity_probe`). The ledger identity above matches |

## 6. Recommendation: an isolated strategy-mirror account (design only, not implemented)

### Options compared

| Option | Keeps strategy and $10 risk | Shorts | Matches TradingView | Touches funded ledger | Verdict |
|---|---|---|---|---|---|
| A. Fund SOLUSD with ~$10k PAPER | yes | no | no (47% missing, $5k limit, live prices) | yes (balances) | insufficient |
| B. Percent / small-account sizing (`SMALL-ACCOUNT-SIZING.md`) | **no** (changes risk) | no | no | no | different strategy |
| C. Leverage and shorts inside the funded ledger | yes | yes | partly (still live prices) | **yes**: new collateral rules in the real books | risky; mixes theory into the funded ledger |
| D. Engine-only report (engine keeps its own trade list) | yes | yes | yes | no | simple, but not auditable in the dashboard |
| **E. Isolated strategy-mirror account (D1, additive), fed by the engine** | **yes** | **yes** | **yes**: same trades as Model A | **no** | **recommended** |

### How E works

1. **Two tracks in the engine, one candle feed.**
   - The engine runs a second, independent copy of the same strategy state, the *mirror track*. It is never dropped
     when the funded ledger refuses an entry. That is exactly Model A, the TradingView-equivalent replay.
   - The existing *funded track* is unchanged: it sends signals to `/webhook/dry-run`, drops refused entries, and
     goes on as today.
   - Both tracks see only completed candles, so there is no lookahead. The strategy code (`ote.mjs`) and its inputs
     are untouched.
2. **What the mirror records.**
   - Each mirror trade is recorded only once it is complete. It carries its entry and exit times, side and qty
     ($10 ÷ stop distance), and the entry, stop, TP2 and exit prices *as the strategy fills them* (limit at limit,
     stop at stop, same-candle rules as confirmed in the parity review).
   - It also stores the exit reason (TP2 / SL / trail / BE / time) and the Kraken reference price at processing
     time, for comparison only.
   - The mirror may process late candles after an outage, because its prices come from candles, not the live
     market. Every trade is labelled with how late it was processed.
3. **Transport and storage.**
   - A new endpoint `/webhook/engine-mirror`, authenticated with the existing webhook secret and idempotent by trade
     id.
   - Additive migration `0005` with new tables only: `mirror_accounts`, `mirror_trades`, `mirror_entries`.
   - It does not touch `portfolio_*`, `paper_*`, `trades` or `alerts`. The current and rollback Workers ignore the
     new tables.
4. **Buying power and margin.**
   - TradingView's properties are margin 0, so the mirror applies **no buying-power check** and never refuses a
     trade. This is the only way to reproduce the strategy exactly.
   - Its "capital" is a reporting baseline chosen by the owner, for example $10,000. The 150-day path never falls
     below $9,846 from $10,000, but goes negative from $100.
   - Every trade also reports its notional, the implied leverage (notional ÷ equity) and the margin it would need at
     reference levels such as 1×, 5× and 10×.
5. **Liquidation assumptions.**
   - None are applied, because TradingView simulates none at margin 0.
   - A **report-only** check flags any trade whose mark-to-market loss would have breached an owner-chosen
     maintenance margin. Trades are never changed.
6. **Fees.**
   - Gross P&L is primary, matching TradingView's 0% commission.
   - A net column applies a selected cost profile with the existing cost code (`costs.ts`). It is computed, never
     deducted from any funded balance.
   - It defaults to "none", so it adds no fee until the owner approves a profile.
7. **Reconciliation.**
   - The mirror's equity always equals baseline + realized gross P&L − modelled fees, checked like the funded
     ledger's identity.
   - Engine and mirror positions must match at every poll; a mismatch is reported as DIVERGED.
   - A **parity job** compares mirror trades with a TradingView "List of Trades" export for the same window, using
     the existing parity tooling.
8. **Reporting.** Three separate, labelled sections, never summed:
   - "Backtest (historical)";
   - "Strategy mirror – hypothetical fills, margin 0, not executable";
   - "Funded PAPER ledger – executable, long-only, balance-limited".

   Each shows its own trade count, gross, modelled costs and net.

### Risks and limitations

- **Mirror results are hypothetical.**
  - They assume a resting limit fills when touched; the stricter rule turns +$150 into −$115 over 150 days.
  - They have no queue position, no liquidity limit and infinite leverage.
  - They must never be shown as profits or added to funded results.
- **With costs the strategy loses heavily** (Model B). Gross-only reporting would look much better than any real
  execution, so the net column and its label are essential.
- **Small baselines go negative.** That has to be shown as it is, not clipped.
- **Shipping the mirror needs a new engine release and an engine restart,** plus migration 0005 and a Worker deploy.
  Each is a separate production approval under the release runbook.
- **The funded track keeps refusing nearly everything** at $10. Changing that is a funding or strategy decision,
  not a fidelity fix.
- **Processing gaps:** the mirror can catch up, but only if Kraken still serves those candles (720-candle window,
  about 60 hours).

## 7. Tests (Objective 6)

| Suite | Result |
|---|---|
| New `worker/test/paper_fidelity_probe.test.mjs` (isolated local D1, port 8806; the Worker code deployed as `e941387e`; real engine signal sizes) | **8/8**. Setup equals production (schema 4, costs none, trading off, $90/$10, consistent); the 4 real entries refused with the codes in §3.4, HTTP 422, books untouched; DUPLICATE with the original code; a 0.1 SOL order the balance can pay for fills with `fee_micro 0`, `cost_profile none`, gross = net, consistent |
| Worker `npm test` (full) | **209/209** (the 201 from the deployment plus the 8 probe tests) |
| Engine `npm test` (full; includes the refused-entry → `entry_dropped` tests and TradingView parity) | **137/137** |

All of these run on temporary local databases; production was not used.

## 8. Next proposed task (needs owner approval)

**"Strategy mirror, development only."** Implement option E on the development branch, without deploying:
- the engine's mirror track;
- additive migration `0005`;
- the `/webhook/engine-mirror` endpoint;
- a labelled dashboard section.

Acceptance:
- the mirror replay of the 150-day data reproduces Model A exactly: 579 trades, +$150.24 gross;
- the October 19 – November 7 TradingView benchmark matches trade by trade;
- the funded track's behaviour and books are byte-identical to today;
- rollback compatibility is shown;
- all suites pass.

Production rollout (new engine release, 0005, Worker deploy) would be a later, separate approval. Funding changes,
cost profiles and real-money trading are not part of it.
