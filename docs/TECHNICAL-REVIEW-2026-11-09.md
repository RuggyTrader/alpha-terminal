# Technical review: TradingView execution parity and the PAPER execution-cost release (2026-11-09)

Research, inspection and isolated testing only. Nothing was deployed, migrated or restarted in production. No
strategy input, property, risk setting, balance, secret or Windows task was changed. The only production read was
the Windows scheduled task's definition, to see which folder the engine runs from.

Evidence files:

- `docs/research/fill-semantics/fill-semantics.json`: four fill readings, benchmark and 150-day results, and the
  full timeline of every disputed trade.
- `docs/research/fill-semantics/ledger-price-gap.json`: the ledger's fill price vs the strategy's fill price.
- `docs/research/cost-audit/rehearsal.json`: results of the migration, rollback and roll-forward rehearsal.
- Tests: `engine/test/fill-semantics.test.mjs` (3) and `worker/test/cost_audit.test.mjs` (13).

---

## A. TradingView accuracy

### Documented semantics

TradingView's sources are its Pine "Strategies" manual and the Help Center articles "Broker emulator" and
"Detalization and execution".

| Setting | What TradingView documents | Engine |
|---|---|---|
| Order execution delay: **One tick** | Help Center: "Orders are executed on the next tick". Manual: new orders have "a one-tick delay by default", so orders created at a bar's close fill no earlier than "the open of the following bar". This is the *default*; "None" is the alternative (same as `process_orders_on_close`). | Entries and brackets placed at a close are worked from the next bar's open. ✓ |
| Limit order execution: **Requested price** | Help Center: "The order is filled exactly at the requested limit price", in contrast to "Requested price and 1 tick beyond" (fills only when price moves one tick past the limit). This is the *trigger rule*, `backtest_fill_limits_assumption = 0`. | A limit fills when price reaches it. ✓ |
| Gaps | Manual: a level crossed between one bar's close and the next bar's open fills "at the opening price of the bar following the gap"; limits at the price "or a better price", stops at worse prices. | Gap fills at the open. ✓ The Help Center phrase "exactly at the requested limit price" could be read as "never better on a gap"; that reading changes 4 of 579 trades by −$4.89 in total (immaterial). |
| Calculation: on bar close | The script runs once per bar close. `calc_on_order_fills` (default false, not set in the Pine) would re-run it on fills. | ✓ |
| Bar detail: Default, 4 ticks; no Bar Magnifier | Open → high → low → close if the open is nearer the high, otherwise open → low → high → close. "no gaps exist inside each chart bar". | ✓ same rule |
| Pyramiding 0, commission 0, slippage 0 | Defaults; nothing added. | ✓ |
| Margin 0 | "equivalent to *infinite* leverage". The docs do not state that margin calls are disabled. | No capital check. The benchmark reproduces, so no margin call affected it. (This corrects a sentence in `STRATEGY-AUDIT-2026-11-09.md`.) |

Your eight questions:

1. Both the entry and its `strategy.exit` bracket are created in the same script run at a bar's close. The script
   places them again on every bar while the setup is valid.
2. Both are eligible from the next bar's open, because of the documented one-tick delay for new orders.
3. **Can the bracket fill later on the same bar the entry filled?** The docs say nothing either way. The
   evidence (below) says yes.
4. Is an extra delay after the entry fill warranted? No such setting is documented. The "One tick" setting is the
   ordinary delay for new orders, which the engine already models.
5. Gaps fill at the open; see the table.
6. Stop and TP2 along the path: whichever level the assumed path reaches first fills. If both are touched, the
   emulator fills only "the first triggered one" and cancels the other.
7. Re-placing the orders each bar replaces the same order id. It does not restart any delay for a bracket that is
   already working.
8. Not confused: "Order execution delay" is the `process_orders_on_close` switch. "Requested price" is the
   limit-verification switch. Neither is `calc_on_order_fills` or Bar Magnifier.

### Empirical evidence: the benchmark settles question 3

The 69-trade window contains exactly **one same-bar trade**: a long entered and closed at TP2 inside the
2026-10-26 13:35 UTC candle, for +$14.99. A reading that forbids exits on the entry's bar fails the benchmark:
31 winners, +$235.00, profit factor 3.161. So TradingView did fill that bracket on the entry's bar.

| Reading | Benchmark (69 / 32 / PF 3.298 / DD $21.95 / 5 listed trades) | 150 days |
|---|---|---|
| Engine (documented default) | **passes** | 579 trades, +$150.24 |
| Requested price, never better on gaps | passes | +$145.35 (4 trades differ, −$4.89) |
| Extra one-tick delay after the entry fill | passes | −$88.31 (20 trades differ, −$238.55) |
| No exit on the entry's bar | **fails** (31 winners, +$235.00, PF 3.161) | +$51.87 |

All four are summary parity plus 5 listed trades. None is full trade-by-trade parity, because the full TradingView
trade list has never been compared.

### The 20 disputed same-bar stop exits

All 20 follow one pattern. Within the entry bar, **a single path segment crosses the limit entry and then the stop**:

- **The engine** fills the stop at the stop price. That follows the documented "no gaps inside each chart bar":
  price passes through the stop on its way down.
- **The alternative** fills at the segment's far end, which is effectively a jump inside the bar.

| Entry (UTC) | Side | Path of the entry bar | Limit → stop | Engine exit / P&L | Alternative exit / P&L | Difference |
|---|---|---|---|---|---|---|
| 2026-09-04 12:30 | LONG | 104.40 → 104.40 → **100.12** → 101.59 | 103.83 → 103.53 | 103.53 / −$9.88 | 100.12 / −$122.17 | −$112.29 |
| 2026-10-06 09:25 | LONG | 120.28 → 120.38 → **118.89** → 119.10 | 119.99 → 119.65 | 119.65 / −$10.23 | 118.89 / −$33.11 | −$22.88 |
| 2026-10-12 21:40 | LONG | 107.88 → 107.89 → **107.07** → 107.46 | 107.71 → 107.28 | 107.28 / −$10.06 | 107.07 / −$14.97 | −$4.91 |
| …17 more (June–October) | | | | each ≈ −$10 | −$10.4 to −$28.8 | total −$238.55 |

For each of the 20 trades, `fill-semantics.json` holds the bar the order was created on, its eligibility (the
next open), the bracket creation (same run as the entry), the OHLC and assumed path, both exits and the
difference. No intrabar tick beyond the 4-point model is invented.

### Decision: **CONFIRMED**

The existing emulator matches TradingView's documented behaviour:
- next-open eligibility;
- the 4-point path with no gaps inside a bar;
- gap fills at the open;
- exits may fill later on the entry's bar, which the benchmark's same-bar TP2 trade confirms.

The −$88.31 variant corresponds to no documented setting and contradicts the no-gaps-inside-a-bar assumption.
**No correction is recommended.**

One trade record would remove the last doubt, though it isn't required. TradingView's List of trades for the
long entered **2026-10-06 09:25 UTC** should show an exit at **119.65** in the same candle (P&L ≈ −$10.23), not
118.89 (−$33.11). The chart must load history from before about 2026-09-30, and `src/cli/compare-tv.mjs` reads the
export directly.

---

## B. PAPER execution costs (commit `3ff5717`)

### Verified correct (test evidence)

| Item | Result | Evidence |
|---|---|---|
| Maker/taker fee; fee on the simulated execution value | ✓ | `paper_costs.test.mjs` (exact micro-USD); `cost_audit` (3-fill lifecycle) |
| BUY pays more, SELL receives less on taker fills | ✓ | `paper_costs.test.mjs` (94.33 → 94.23567) |
| Partial exit and multiple fills: each fill pays its own fee once; trade fee = sum of fill fees | ✓ | `cost_audit` §3: OPEN maker, REDUCE taker, CLOSE maker; gross − slippage − fees = net within 2 µ$ |
| Gross / net convention | ✓ consistent: wallet realized at execution prices, FEE entries separate, trade `realized_pnl` = net, daily loss = Σ fill realized − Σ fill fees (each counted once) | code review; `cost_audit` dashboard-vs-ledger test |
| Capital check includes the entry fee | ✓ | `paper_costs.test.mjs` (value fits, value + fee does not → refused) |
| Minimum order never traps a close | ✓ | `paper_costs.test.mjs` ($4.95 close accepted) |
| Duplicates and retries, including after a restart, never charge twice | ✓ | `cost_audit` §3 (same id → DUPLICATE before and after restart, books byte-identical) |
| Concurrent BUYs that each fit but not together | ✓ one 200, one 422 INSUFFICIENT_PAPER_CAPITAL, one fill, one FEE row, no overdraft | `cost_audit` §3 |
| Refused fill leaves no partial rows | ✓ wallets, entries, positions, fills, trades identical | `cost_audit` §3 |
| Transfers never become P&L or fees | ✓ | `cost_audit` §3 |
| Reserved capital = Σ open positions' reserve; close releases it fully | ✓ checked from raw rows after every step | `cost_audit` `invariants()` |
| Dashboard totals = raw ledger | ✓ | `cost_audit` §3 |
| Invalid profile → every fill refused; invalid liquidity → 400; missing liquidity (older engine) → TAKER (conservative) | ✓ | `paper_costs.test.mjs` |
| Historical candles never replayed as new fills | ✓ unchanged by this commit: warm-up is never sent; stale entries expire | existing engine tests (live runner, freshness) |

### Migration `0004`

Tested on prior data written by the production code (`cde07af`) on schema 3: one gross trade, one position left
open, 7 entries.

- Every prior entry (id, key, amount), trade, wallet, position and fill is unchanged, as are the indexes (no
  triggers exist). The `wallet → portfolio_wallets` foreign key survives, `foreign_key_check` is clean, the
  AUTOINCREMENT sequence continues, and old trades get no cost record.
- Re-running `wrangler d1 migrations apply`: "No migrations to apply", data identical.
- Re-running the file by hand (on a copy): it fails at "duplicate column name: fees_micro" and leaves
  `portfolio_entries` and its rows intact.
- Recovery: tested locally only. Before running it in production, record a D1 Time Travel restore point
  (`wrangler d1 time-travel info alpha-terminal-db`, free).

### Rollback rehearsal (`cost_audit` §4–5)

| Step | Result |
|---|---|
| New code on migrated data, fee-bearing trades | consistent |
| **Rollback to `cde07af`** | runs; accepts signals, including the new engine's `liquidity` field (200); charges no fees; raw ledger still coherent |
| …its own consistency check | **permanently `ok: false`: "book balance differs from funding + realized P&L"** (the old check doesn't know fees) |
| Roll-forward to the new code | consistent again; every fee counted once |

So **rolling back the code after the first fee is not fully safe**: it works, but shows a permanent accounting
warning, and the old dashboard shows realized P&L without fees.

### Venue assumptions

| | Official (verified 2026-11-09) | Modelled assumption |
|---|---|---|
| Ndax | flat 0.20% on every buy and sell, "no maker/taker split" (ndax.io/fees); minimum "roughly $1 to $5 CAD" | 0.10% taker slippage: an **estimate**, SOL/CAD book not measured. The $5 **USD** minimum is stricter than Ndax's CAD figure (conservative). Applied to Kraken SOLUSD prices: **not Ndax execution evidence**, as the profile's caveat says. |
| Kraken Pro | Tier 1 ($0+ 30-day) 0.40% maker / 0.80% taker; Tier 2 at $2.5K is 0.30/0.60 (kraken.com/pro/fees). SOLUSD `ordermin` 0.05, `costmin` 0.5, tick 0.01 (Kraken public AssetPairs API) | 0.03% taker slippage from one spread observation. The "−0.02% selected pairs" discount is **not confirmed** for SOL/USD (profile says so). |

### Identified risks

1. **The ledger's fill price isn't the strategy's fill price.** The engine sends its signal after the fill candle
   closes, and the Worker fills at the live Kraken price; that was so before this commit too. Measured over the
   579 trades of the 150-day baseline, using candle closes as the proxy:
   - entries: p10–p90 −$4.63 to +$3.74 per trade (on average $0.41 better);
   - TP exits: on average $0.42 better;
   - stop exits: on average **$1.06 worse** (median $0.35).
   - Total: the ledger lands about **$185 worse** than the strategy over 579 trades, against a strategy edge of
     $0.26 per trade.

   Labelling such a fill "MAKER" applies a maker fee at a price a resting limit order would not have received.
   Also, 9 of 579 limit entries (1.6%) were marketable (filled at a gap open), which on a real exchange is a taker
   fill. **The dashboard does not disclose this today.**
2. **The production engine runs from this working tree** (scheduled task `ALPHA TERMINAL Engine` →
   `outputs\alpha-terminal\engine`). Its next restart (sign-in or reboot) loads the committed engine code,
   including `3ff5717`'s `liquidity` field, without any explicit engine deployment. The rehearsal shows the
   production Worker accepts that field, so it's safe today. But engine releases currently happen by accident of
   a restart.
3. **A position open across the deployment.** It closes with only its exit fee and is labelled with the new
   profile (rehearsal: fees $0.057093 = exit only).

---

## C. Recommendations

### Critical (before any deployment)

**C1. Make rollback safe by procedure: never revert the Worker to `cde07af` once a fee exists.**
1. *Problem:* the old consistency check permanently flags fee-bearing books.
2. *Evidence:* `cost_audit` §4: `ok: false`, "book balance differs from funding + realized P&L", which clears
   on roll-forward.
3. *If ignored:* an emergency rollback leaves a permanent accounting warning and a dashboard that understates
   costs.
4. *Solution:* deploy in two stages.
   - First, migration 0004 plus `3ff5717` with `PAPER_COST_PROFILE=none`. No fees are charged, the
     consistency check is fee-aware, and this becomes the rollback target.
   - Then switch the variable to `ndax`.
   - Rollback afterwards = set the profile back to `none` (keeps every recorded fee, readable), not a code revert.
   - Record a D1 Time Travel restore point before the migration.
5. *Risk:* one extra deploy. A fee-free first stage changes nothing for trading.
6. *Files:* `docs/PAPER-EXECUTION-COSTS.md` and the deployment record (procedure only; no code change).
7. *Approval:* owner, as part of deployment authorization.

**C2. Disclose how PAPER fills are priced.**
1. *Problem:* the fill price is the Kraken price after the candle closes, not the strategy's limit, TP or stop
   price, and "MAKER" is a label of the order type, not proof the fill would have rested on the book.
2. *Evidence:* `ledger-price-gap.json` (above); 9/579 marketable entries.
3. *If ignored:* the dashboard can be read as exchange-quality maker fills; the Kraken profile caveat doesn't say
   this at all.
4. *Solution:* add one caveat sentence to every profile, plus the trade-proof note: "Fills are simulated at the
   Kraken price when the signal arrived; maker/taker follows the strategy's order type and is not verified
   against an order book."
5. *Risk:* none (text only).
6. *Files:* `worker/src/costs.ts` (caveat strings), `frontend/src/terminal/pages/TradeProof.tsx`,
   `docs/PAPER-EXECUTION-COSTS.md`.
7. *Approval:* owner (user-facing wording).

### Important

**I1. Separate the production engine from the development tree.**
1. *Problem:* commits change the running engine on its next restart.
2. *Evidence:* the scheduled task's working directory is this checkout.
3. *If ignored:* untested or research engine code can go live after a reboot.
4. *Solution:* run production from a dedicated clone at a tagged commit and update it deliberately.
5. *Risk:* changes the Windows task, which needs your authorization and a planned restart.
6. *Files:* `engine/deploy/windows-task.ps1` (path parameter), the deployment docs.
7. *Approval:* owner.

**I2. Deploy only while SOLUSD is flat.** Avoids a trade labelled with costs for which only the exit was charged.
- *Evidence:* rehearsal `pre_migration_position`.
- *Files:* none (procedure).
- *Approval:* part of deployment.

### Optional

**O1. Optionally price ledger fills at the strategy's fill price, bounded by the live price.** This would remove
the ~$185 / 579-trade divergence. It changes accounting rules; it is not recommended without your approval and
its own test cycle.

**O2. Fix the research helper's same-bar leak.** `runBacktest`'s `longOnly` option lets 7 same-bar shorts through
(from the previous report). Research code only.

**O3. Optionally confirm the 2026-10-06 09:25 trade in TradingView** (section A) for direct trade-level evidence.

---

## D. Deployment verdict: **READY ONLY AFTER SPECIFIC FIXES**

The accounting itself passed every independent invariant on real Workers:
- 13 rehearsal tests: migration, fees, concurrency, retries, partial exits, transfers, rollback, roll-forward;
- plus the existing suites (section E).

No double-counting, negative balance, partial write or duplicate fee was found. Deployment is held back by two
specific items:
- **C1:** the staged deployment and rollback procedure. Without it, a code rollback is demonstrably unsafe.
- **C2:** the fill-pricing disclosure. Without it, the dashboard over-claims what the fills represent.

Both are small and touch no accounting logic. With them in place, plus I2 (flat position) and a Time Travel
restore point, the release is suitable for a controlled PAPER deployment.

## E. Implementation status and tests

No material change was made. Added in this review:
- research CLIs `engine/src/cli/fill-semantics.mjs` and `engine/src/cli/ledger-price-gap.mjs`;
- tests `engine/test/fill-semantics.test.mjs` and `worker/test/cost_audit.test.mjs`;
- evidence files under `docs/research/`;
- this report, plus a one-row correction in `STRATEGY-AUDIT-2026-11-09.md` (margin wording).

| Suite | Result |
|---|---|
| Engine (`npm test`) | 114 / 114 (111 + 3 fill-semantics) |
| Frontend (`vitest run`) | 101 / 101 |
| Worker (`npm test`, all files incl. `cost_audit` and `paper_costs`) | 177 / 177 |

Reproduce:

```
cd engine
node src/cli/fill-semantics.mjs --candles data/SOLUSD-5m-150d.json --out ../docs/research/fill-semantics
node src/cli/ledger-price-gap.mjs --candles data/SOLUSD-5m-150d.json
node --test test/fill-semantics.test.mjs
cd ../worker
node --test test/cost_audit.test.mjs
```

`cost_audit` rebuilds the production Worker from `cde07af` with `git show`, so it needs the full git history.
