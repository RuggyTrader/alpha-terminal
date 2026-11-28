# ALPHA TERMINAL MFFU research on QuantConnect Cloud (SIMULATED, free tier)

The historical MNQ backtest runs inside QuantConnect Cloud on QuantConnect's own futures data. Databento is not used.

* **Strategy:** the locked OTE strategy (Configuration A) through the MFFU account simulator and T1 news calendar, unchanged.
* **Data:** each MNQ contract's own raw (unadjusted) 1-minute trade bars.
* **Execution:** nothing is traded. There is no brokerage, no order and no live deployment, and external execution stays DISABLED.
* **Exported:** only summary results leave QuantConnect.
* **Cost:** free tier only. No subscription and no data purchase.

## Why it is built this way (QuantConnect limits, read 2026-11-28)

| Limit (free tier) | Consequence here |
|---|---|
| 25 files per project, 32 KB per file | The code is flattened into 22 files, the largest 24 KB (`qc/build_bundle.py`). With `research.ipynb` that is 23 |
| LEAN CLI and REST API need a paid tier | Files are pasted into the web IDE (`qc/copy_to_quantconnect.ps1` puts them on the clipboard one by one) |
| Object Store needs a paid tier | Results are written to the backtest log instead |
| 10 KB of logs per backtest, 3 MB per day | Results are compressed, checksummed `ATQC1` lines. The runs are split so each backtest's result fits (see the plan below) |
| 200 backtests a day, 12 hours each, 1 node | 15 backtests in total (1 coverage, 7 development, 7 holdout), one at a time |
| Terms 2.6: no export of market data "by any means", including logs and statistics; summary results of your own backtests may be exported | The bars never leave the backtest. Logged: performance statistics, roll dates, coverage dates and data-quality counts. Not logged: prices, volumes or trade fill prices |

## Why the results are valid

* **Splitting:** each MFFU plan variant (and each cost scenario) is an independent simulation. Splitting them across backtests therefore gives exactly the same numbers as one big run. Runs are never split in time: the virtual account chain runs uninterrupted over the whole period.
* **Rolls:** the front contract is chosen each session day from the previous day's volume. It rolls forward only and never trades past 9:30 ET on the 3rd Friday. Every roll segment warms up its indicators on 10 days of the same contract's bars, as in the local reference.
* **Same code as locally:** the cloud runs the same engine, MFFU simulator, news calendar and pre-registered variants (`mffu/experiments.py`). `tests/test_qc.py` feeds the cloud code (through a stand-in for the QuantConnect API) and the local reference the same synthetic bars and checks the results are identical.
* **Integrity checks in the cloud:** every run checks three things before it starts and stops if any fails:
  * the SHA-256 of all its files (a paste error stops it);
  * Configuration A;
  * an engine self-test fingerprint, so a different Python or pandas version in the cloud cannot silently change results.
* **Holdout seal:**
  * Development runs end the day before `HOLDOUT_START` and never load the last 12 months.
  * Holdout runs refuse to start until the development results are imported and committed, and their SHA-256 is set in `qc/at_config.py`.
  * `qc/qc_import.py` checks the same seal again locally.
* **Import checks:** `qc/qc_import.py` rejects any payload that:
  * is incomplete or fails its checksum;
  * came from a different code bundle;
  * placed orders;
  * did not verify its own files;
  * used other boundaries than the frozen ones.

## One-time setup in QuantConnect (you do this; about 15 minutes)

1. **Open the project.** Sign in at quantconnect.com, open **Algorithm Lab**, and open the project **Casual Yellow Dolphin**. It should be a Python project. Leave `research.ipynb`; delete any other `.py` files except `main.py`.
2. **Put the files in.** In PowerShell, from this folder, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\AlphaTerminal\research\futures-ote\repo\futures-ote\qc\copy_to_quantconnect.ps1"
   ```

   For each file it names:
   * create a file with exactly that name in the project (in `main.py`'s case, open it);
   * select all of its contents, paste and save;
   * press Enter in PowerShell for the next file.

   There are 22 files.
3. **Add three project parameters.** In the Project panel, under **Parameters**, use **Add New Parameter**:

   | Name | Value |
   |---|---|
   | `mode` | `coverage` |
   | `period` | `dev` |
   | `jobs` | `-` |

## Backtest 1: coverage (verifies the data before anything else)

1. **Run it:** with `mode = coverage`, click **Backtest**.
2. **Save the log:** when it finishes, open the **Logs** tab and download the log, or select it all, copy it and save it as a text file. Put it in `%USERPROFILE%\AlphaTerminal\research\futures-ote\qc-logs\` (any name, e.g. `00-coverage.txt`).
3. **Tell Claude.** I run `qc/qc_import.py` on the log, which reports:
   * the first and last MNQ bar QuantConnect has, and every contract's first and last bar and session-day count;
   * the front-contract segments, and whether the self-test and file check passed in the cloud.
4. **Freeze the boundaries.** I then write the proposed `DATA_END` and `HOLDOUT_START` into `qc/at_config.py`, rebuild and commit. You re-paste the two changed files:

   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\AlphaTerminal\research\futures-ote\repo\futures-ote\qc\copy_to_quantconnect.ps1" -Only at_config.py,at_build.py
   ```

**If the coverage run stops with an error:**

| Error | Meaning |
|---|---|
| "Project files differ" | A paste error |
| "self-test differs" | QuantConnect's Python environment computes differently. Nothing is wrong with the data, but results would not be comparable |
| No MNQ bars | The free tier does not provide this data |

Send me the error text in every case; nothing is changed to work around it.

## Backtests 2–8: development period (everything before the last 12 months)

Set the parameters, click **Backtest**, and save each log. Use `period = dev` for all of them.

| # | `mode` | `jobs` |
|---|---|---|
| 2 | `full` | `S0_none,S1_optimistic` |
| 3 | `full` | `S2_base,S3_conservative` |
| 4 | `mffu` | `builder-50k,builder-50k-eodbreach` |
| 5 | `mffu` | `builder-50k-addon,builder-100k` |
| 6 | `mffu` | `rapid-50k-evalEOD,rapid-50k-evalIntraday` |
| 7 | `mffu` | `rapid-eod-50k,rapid-eod-dll-50k` |
| 8 | `mffu` | `pro-50k,pro-50k-one-day` |

**What each backtest covers:**
* Each `mffu` backtest runs two pre-registered plan variants, each under all 4 cost scenarios (C1 to C4).
* Each `full` backtest runs 2 cost scenarios × 3 sizings.

**Result size:** on synthetic data a two-variant result encodes to about 3.3 KB and a two-scenario grid result to about 2.5 KB, against a 9,000-character budget.

**If the log says TOO_LARGE:** the result did not fit the 10 KB log limit. Split the backtest:
* one variant per backtest (e.g. `builder-50k`);
* or one scenario per backtest (e.g. `builder-50k:C2_base`, or `S2_base` for `full`).

The importer accepts any split.

**Import:** I import the logs, and the importer reports what is still missing. When all 52 runs are in (40 MFFU, 12 cost and sizing), it writes `results/qc/dev/` and the dashboard snapshot. You review the results, then I commit them and set `DEV_RESULTS_SHA256`. You re-paste the two changed files, as after the coverage run.

## Backtests 9–15: holdout (the most recent 12 months, run once)

* **Same 7 backtests** as the development table, with `period = holdout`.
* **Importer checks:** each holdout payload is checked against the committed development results.
* **Changes between periods:** nothing in the strategy, the plan variants or the costs may change. They are fixed and hashed.

## Results in the dashboard

`qc_import.py --publish` copies the complete snapshot to `frontend/public/research/mffu-dashboard.json`, on the research branch only.

**On the page:**
* The "Research · MFFU (simulated)" page shows it labelled SIMULATED, with external execution DISABLED.
* Results are marked as computed in QuantConnect Cloud from genuine MNQ data.

**Not changed:** nothing is deployed and production is not touched.

## Files

| File | Purpose |
|---|---|
| `qc/main.py` | The QuantConnect algorithm: parameters, data subscription, integrity checks, result log |
| `qc/at_stream.py` | Streaming rolls and segments, jobs, result codec, self-test, source hashing |
| `qc/at_config.py` | Frozen boundaries (`DATA_END`, `HOLDOUT_START`, `DEV_RESULTS_SHA256`) |
| `qc/build_bundle.py` | Builds `qc/cloud/` (the files to paste) and `at_build.py` (hashes, self-test fingerprint) |
| `qc/cloud/` | Generated. Exactly what goes into QuantConnect; a test fails if it is out of date |
| `qc/copy_to_quantconnect.ps1` | Puts each file on the clipboard in turn |
| `qc/qc_import.py` | Verifies logs and assembles `results/qc/<period>/` and the dashboard snapshot |
| `tests/test_qc.py` | Equivalence with the local reference, limits, seal, integrity and import (synthetic data only) |

## Local tests

```powershell
Set-Location "$env:USERPROFILE\AlphaTerminal\research\futures-ote\repo\futures-ote"; & "$env:USERPROFILE\AlphaTerminal\research\futures-ote\.venv\Scripts\python.exe" -B -m pytest -q
```

## Not verified yet (needs the coverage backtest)

* **Data:** whether the free tier serves MNQ minute data for the whole 2019 to 2026 period, and from which date.
* **Environment:** whether QuantConnect's Python environment reproduces the local self-test fingerprint, and whether it exposes project files so the cloud can verify their hashes. If it cannot, the importer refuses the results; I will tell you rather than relax the check.
* **Runtime:** how long each backtest takes in the cloud. Locally the engine runs at about 18 µs per bar per run.
