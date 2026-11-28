# ALPHA TERMINAL: MFFU research foundation (SIMULATED)

## What this is (and what it is not)

**What it is:** a local, educational simulator that replays the locked OTE strategy through virtual MyFundedFutures-style accounts.

**What it is not:**
* It is not an MFFU account.
* It is not approved by MFFU.
* It is not connected to any platform.

**External execution is DISABLED.** No credentials are requested. No order can leave this computer.

**Limits of the results:**
* A historical simulated pass does not mean a real evaluation would pass.
* The simulated protections are not a guarantee against losses.

## Sources (retrieved 2026-11-27)

`mffu/sources.py` lists every page, with its URL and the date printed on it:
* **MFFU help-centre articles S1 to S16**, including the six pages the owner named. The "EOD drawdown" link given was article 8348565; article 8444599 is the Fair Play page.
* **CME C1 to C3:** the MNQ and MES contract specs and the holiday calendar.

MFFU rules change, so re-verify them before relying on any of this.

## How every rule is recorded

In `mffu/rules.py`, each field of each plan, size and stage is recorded in one of three ways:

* **DOCUMENTED:** cites its source.
* **ASSUMPTION:** a labelled modelling choice, repeated in reports.
* **UNRESOLVED:** missing or contradictory.
  * The simulator refuses to use the field unless the run picks one of the documented candidates explicitly.
  * That choice is stored in every result.

## Contradictions and unresolved rules

There are 11 contradictions (X1 to X11) and a list of facts no page states. Both are in `sources.py` and on the dashboard. The most important:

| Id | Topic | What was found |
|---|---|---|
| X1 | Rapid evaluation drawdown type | EOD in S1 and S9, intraday in S2. Both variants are run. |
| X4 | EOD-trailing breach test | S4: any open-equity dip below the minimum balance fails the account. S12: tested at day end. Both are run for Builder 50k; the stricter reading is the default. |
| X3 | Lock level | S4's examples contradict its own "start + $100" lock. |
| X5 | Builder live lock | $0 vs start + $100. |
| X7, X8 | Contract limits | Pro and Rapid sim-funded limits are unclear. The stricter value is used. |
| — | Day end | MFFU states no day-end time. The CME 17:00 ET session end is used (an ASSUMPTION). |
| — | Automation | S5 allows automated strategies that do not exploit simulated fills. Nothing approves ALPHA TERMINAL, and no API route is documented (S6). |

## Modules (`futures-ote/mffu/`)

| File | Purpose |
|---|---|
| `sources.py` | Source register, contradictions, not-stated list |
| `rules.py` | Plan catalogue with provenance: 15 plan/size combinations. Evaluation for all of them; sim funded and hypothetical live only where the article was read |
| `instruments.py` | MNQ ($2/pt, 0.25 tick = $0.50) and MES ($5/pt, 0.25 tick = $1.25) from CME pages; whole-contract quantity validation; 3rd-Friday 9:30 ET expiry; cost scenarios C1 to C4 (labelled assumptions) |
| `calendar.py` | CME Globex hours (Sun 18:00 to Fri 17:00 ET, daily 17:00 to 18:00 halt); session day; 2026 holiday list and Thanksgiving 2026 equity hours (C3); a T1 news-calendar loader (none bundled) |
| `account.py` | Virtual account: EOD or intraday trailing floor with lock, open-equity breach test, soft daily-loss pause, consistency, minimum days, target, inactivity, simulated payouts (Builder, Rapid, Pro rules as read), Pro static MLL after the first payout |
| `compliance.py` | Deterministic pre-trade gate (see the list below) |
| `execution.py` | Broker-independent contract (`OrderIntent`, `ExecutionAdapter`, `OrderRouter`), with only `MockAdapter` and `PaperSimAdapter`. `NinjaTraderAdapter` and `TradovateAdapter` raise `ExternalExecutionDisabled` on construction |
| `evaluate.py` | `MffuOverlay` for `ote_engine.strategy.run(overlay=...)`: chains evaluation, then sim funded, then hypothetical live, and restarts after each failure, keeping every attempt |
| `store.py` | Atomic state files for restart recovery |
| `dashboard.py` | Snapshot JSON for the dashboard page |

**What the compliance gate checks:**
* external route;
* emergency pause (only the owner can lift it);
* account status (breached, paused, passed, inactive);
* duplicate order ids;
* missing or stale data;
* market closed;
* whole contracts and the contract limit;
* hedging the same underlying;
* a protective stop is required;
* T1 news windows (blocked when no calendar is available);
* worst-case loss against the remaining drawdown and the daily allowance;
* the 2% price-limit rule (a warning when limit levels are unknown).

**Gate guarantees:**
* There is no override argument.
* AI-suggested orders get the same verdict.
* Decisions are bound to the order's digest and can be used once.
* The audit log is always on.

## Engine integration

* **Default unchanged:** `ote_engine.strategy.run()` gained an optional `overlay` argument. It defaults to `None`, which gives exactly the same results as before (all earlier tests pass, and a test checks that a permissive overlay changes nothing).
* **Strategy untouched:** Configuration A's inputs and logic are unchanged.
* **What the overlay can do:**
  * refuse an order at placement;
  * flatten inside a bar at an account threshold (breach or soft pause), priced at the threshold and clamped to the bar;
  * flatten at a bar's close (Builder session end, news window).
* **Counting:** every refusal and every flatten is counted.

## How to run

```powershell
# demo (pipeline check on the free one-week sample; NOT evidence)
.venv\Scripts\python run_mffu.py results\mffu-demo --csv <sample.csv> --demo
# development period on Databento data (after the download)
.venv\Scripts\python run_mffu.py results\mffu --cache <databento cache> --root MNQ
# holdout: refused until results\mffu\dev\MFFU-SUMMARY.json is committed
.venv\Scripts\python run_mffu.py results\mffu --cache <databento cache> --root MNQ --holdout
# MES needs its own download first
.venv\Scripts\python fetch_databento.py <cache> --root MES --estimate
```

**Pre-registered before any result:**
* **9 plan variants**, listed in `CONFIGS` in `run_mffu.py`.
* **4 cost scenarios:** C1 optimistic, C2 base, C3 conservative, C4 stress.
* **Sizing:** 1 contract.
* **Holdout:** the last 12 months.
* **No tuning:** nothing is tuned on these results.

## Current results

**Only the pipeline demo has been run so far:** one sample week of ratio-adjusted MNQ prices. These figures are not evidence. The full historical evaluation needs the Databento MNQ download, which is still waiting on the owner's API key.

**Demo figures (C2 base costs):**
* 76 trades, profit factor 0.79, net −$237;
* no attempt reached a target or breached in one week.

## Remaining integration requirements (all open)

1. **MFFU automation approval:** written confirmation from MFFU that unattended automated execution by ALPHA TERMINAL is allowed, and on which accounts.
2. **Technical route:** MFFU's confirmed platform and API (NinjaTrader, Tradovate or other). No adapter will be written before then.
3. **Owner authorization:** a separate authorization for any external integration.
4. **T1 news calendar:** FOMC, FOMC minutes, Employment Report and CPI release times for the test period. Without it, Rapid and Pro sim-funded stages cannot trade in simulation.
5. **Missing articles:**
   * Rapid 25k, 100k and 150k, and Builder 25k and 150k, sim-funded rules;
   * Rapid live rules;
   * Builder 50k live contract limit;
   * the "qualifying day" definition;
   * MFFU's day-end time.
6. **Cost basis:** broker commissions and CME exchange fees for the chosen route. All costs are currently scenarios.
7. **Historical holiday hours:** detected from data gaps. Only Thanksgiving 2026 hours are documented.
