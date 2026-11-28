# ALPHA TERMINAL: MFFU research foundation (SIMULATED)

## What this is (and what it is not)

**What it is:** a local, educational simulator that replays the locked OTE strategy (Configuration A, 1 contract) through virtual MyFundedFutures-style accounts.

**What it is not:**
* It is not an MFFU account.
* It is not approved by MFFU.
* It is not connected to any platform.

**External execution is DISABLED.** No credentials are requested. No order can leave this computer.

**Limits of the results:**
* A historical simulated pass does not mean a real evaluation would pass.
* The simulated protections are not a guarantee against losses.

## Sources (all read 2026-11-27)

`mffu/sources.py` lists every page, with its URL and the date printed on it:
* **MFFU help-centre articles S1 to S30:** every plan size of Builder, Rapid, Rapid EOD, Rapid EOD with DLL and Pro; drawdown; consistency; news; Core Rules "Permitted Times to Trade"; inactivity; payouts; hedging.
* **CME C1 to C3:** the MNQ and MES contract specs and the holiday calendar.
* **Federal Reserve F1 and F2, and BLS B1 and B2:** the news calendar.

MFFU rules change, so re-verify them before relying on any of this.

## How every rule is recorded

In `mffu/rules.py`, each field of each plan, size and stage is recorded in one of three ways:

* **DOCUMENTED:** cites its source.
* **ASSUMPTION:** a labelled modelling choice, repeated in reports.
* **UNRESOLVED:** missing or contradictory.
  * The simulator refuses to use the field unless the run picks one of the documented candidates explicitly.
  * That choice is stored in every result.

## Session rules (S17, MFFU Core Rules)

* **Trading hours:** orders may be placed from the 6:00 PM ET Globex open until 4:10 PM ET. The compliance gate refuses orders that would be live between 4:10 and 6:00 PM (`OUTSIDE_MFFU_TRADING_HOURS`).
* **4:10 PM flatten:** open positions are closed at 4:10 PM ET on every plan and stage (`ACCT_SESSION_END`).
* **Holiday half days:** MFFU does not auto-close, and the trader must be flat before the close. The simulator flattens at the last bar of the session.
* **"EST" in MFFU's text:** read as New York wall-clock time. A literal EST 4:10 PM in summer would fall after the CME close.

## T1 news calendar (`mffu/t1_calendar.py`)

**Events:** MFFU's Tier 1 list is FOMC statement, FOMC minutes, Employment Report and CPI (S7). Both the text and MFFU's own 2026 calendar image confirm it.

**Window:** no positions or orders from 2 minutes before to 2 minutes after the release.

**Where it applies:**
* Restricted: Rapid, Rapid EOD and Pro sim funded.
* Allowed: all evaluations and Builder.
* Live accounts: not addressed, so the stricter reading is used.

**Coverage:** 314 releases from 2019-01-01 to 2026-11-27, each read from the release itself.

| Event | Count | Source |
|---|---|---|
| FOMC statements | 65 | Federal Reserve press releases ("For release at ... EST/EDT"); includes the 2020 unscheduled meetings |
| FOMC minutes | 63 | Federal Reserve "Minutes of the FOMC" press releases. The 2:00 p.m. sentence inside the minutes is the desk directive and is not used |
| CPI | 93 | BLS archived releases ("embargoed until 8:30 a.m."), as actually released. The 2025 appropriations lapse is included: September CPI came out on 2025-10-24 and October 2025 was never published |
| Employment Report | 93 | BLS archived releases, as actually released |

**Time zones and DST:**
* Every time is New York wall-clock time.
* Tests check each printed EST/EDT label against the date's daylight-saving state.
* Tests also check each BLS file-name date against the release date.

**MFFU's own 2026 list differs from the official record (X12):**
* MFFU puts the January Employment Report on Feb 6 and CPI on Feb 11. The actual releases were Feb 11 and Feb 13.
* MFFU's list omits the Oct 28 FOMC statement.
* The default (`union`) blocks both sources' times.

**Missing coverage:** outside the coverage period, stages that prohibit T1 news are blocked. Nothing is ever assumed news-free.

## Contradictions: status

| Id | Topic | Status | How it is handled |
|---|---|---|---|
| X1 | Rapid evaluation drawdown type | VARIANTS | Plan articles say EOD; S2 says intraday. Both are run |
| X2 | Rapid EOD minimum days | RESOLVED | 4 days (plan articles) |
| X3 | EOD lock level | RESOLVED | +$100 once the balance high reaches start + MLL + $100 (S18) |
| X4 | EOD breach test (intraday vs end of day) | VARIANTS | Both are run for Builder 50k; intraday is the default |
| X5 | Builder 25k/50k live lock ($0 vs $100) | VARIANTS | Explicit choice required |
| X6 | Intraday trailing lock | RESOLVED | $100 (all Rapid plan articles) |
| X7 | Pro sim contract limits | VARIANTS | Stricter micro count by default |
| X8 | Rapid 50k sim scaling | VARIANTS | Stricter 20 micros by default |
| X9 | News scope | RESOLVED | See the T1 section above |
| X10 | Consistency denominator | OPEN | Literal definition (total profit) used |
| X11 | 2% price-limit example | OPEN | Reported as unverified, not enforced |
| X12 | MFFU 2026 image vs official times | VARIANTS | Union by default |
| X13 | Rapid EOD 25k live | OPEN | Rapid live table (S23) used |

## Execution accuracy (tests)

* **Rolls:** each contract is traded only while it is front month by the previous day's volume, and never past its last trading time (9:30 AM ET on the 3rd Friday).
* **Ticks:** every fill, including account-forced exits, is on the 0.25 tick.
* **Quantities:** whole contracts only. The "whole" sizing floors and never rounds up.
* **Commission:** 2 × per side × contracts.
* **Stop slippage:** ticks × tick value × contracts.
* **Ledger identity:** net = gross − commission.
* **Drawdown:**
  * EOD floor moves only at day end and locks;
  * intraday floor uses unrealized peaks;
  * open-equity breach is checked;
  * the soft daily-loss pause is not a breach.

## Data (still needed for any real result)

**Requirement:** genuine Databento GLBX.MDP3 `ohlcv-1m` data, unadjusted and per contract, for MNQ (and MES for the second instrument).

**Status:** the API key is not configured yet, so no exact quote and no download has happened. Setup steps and the runbook are in `DATABENTO-SETUP.md`. The whole pipeline after the key has been rehearsed offline on a synthetic DBN fixture (`tests/test_pipeline_ready.py`).

**Published usage price (read 2026-11-27):** $70 per GB for CME OHLCV-1m (OHLCV-1s is also $70/GB).

**Rough size, not a quote:** an OHLCV record is 56 bytes uncompressed. MNQ 2019-05 to 2026-11 is about 1,950 sessions.

| Case | Assumption | Records | Size | Cost |
|---|---|---|---|---|
| Typical | about 2,000 records a day across the front month, next month and spreads | about 4 million | about 0.22 GB | about $15 |
| Worst case | every listed MNQ outright and spread trading every minute | — | about 2.3 GB | about $160 |

**Exact quote:** `fetch_databento.py --estimate` asks Databento for the exact cost before anything is requested. The download refuses if the estimate is above `--max-cost`. Databento gives $125 of free credit to new accounts.

**Free alternatives:** no free, account-free source of multi-year, per-contract, unadjusted 1-minute MNQ data was found. The one-week free sample used in the demo is ratio-adjusted and is never used as evidence.

## Dashboard

**Location:** "Research · MFFU (simulated)", at `/research/mffu`, linked from Settings.

**Browser check:** verified in an authenticated local browser session against a fully local Worker (`wrangler dev --local`, local D1 and a generated test passphrase).

**What the check confirmed:**
* All 20 result rows match the recorded run files.
* Every row is labelled SIMULATED, and DEMO, NOT EVIDENCE while only demo data exists.
* No horizontal scroll at phone width.
* External execution shows DISABLED.

## How to run

```powershell
.venv\Scripts\python run_mffu.py results\mffu --cache <databento cache> --root MNQ            # development period
.venv\Scripts\python run_mffu.py results\mffu --cache <databento cache> --root MNQ --holdout  # refused until dev summary is committed
```

The full sequence, from readiness check to holdout, is the runbook in `DATABENTO-SETUP.md`. `preflight.py` checks readiness offline.

**Options:**
* `--news union|official|mffu_image|none` selects the T1 calendar variant.
* `--jobs N` runs the pre-registered runs in N processes. Output is identical to `--jobs 1`.
* The plan variants are pre-registered in `CONFIGS` (10 variants) and run under 4 cost scenarios.

## Remaining integration requirements (all open)

1. **MFFU automation approval:** written confirmation that unattended automated execution by ALPHA TERMINAL is allowed, and on which accounts.
2. **Technical route:** MFFU's confirmed platform and API. No adapter exists beyond local mock and paper adapters.
3. **Owner authorization:** a separate authorization for any external integration.
4. **Historical data:** the Databento key, then the estimate, then a download within free credit.
5. **News calendar after 2026-11-27:** extend `t1_calendar.py` from the official releases.
6. **Cost basis:** broker commissions and CME fees for the chosen route. All costs are currently scenarios.
