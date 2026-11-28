# Databento: secure setup (do this yourself; never paste the key into a chat)

1. **Create a free account** at https://databento.com/signup.
   * **Do not add a payment method.** An account without one can only spend its free credit ($125 for new accounts), so nothing can be charged.
2. **Get a key.** In the Databento portal, open **API Keys**. Your default key starts with `db-`. Copy it.
3. **Store the key** as a Windows *user* environment variable. In **PowerShell**, paste this one line and press Enter. It asks for the key with hidden input, which is not saved in PowerShell history:

   ```powershell
   $s = Read-Host "Paste Databento API key" -AsSecureString; $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Environment]::SetEnvironmentVariable("DATABENTO_API_KEY", [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p), "User"); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); Remove-Variable s, p
   ```

4. **Check it is set**, without showing it:

   ```powershell
   if ([Environment]::GetEnvironmentVariable("DATABENTO_API_KEY", "User")) { "DATABENTO_API_KEY is set" } else { "missing" }
   ```

5. **Tell Claude "key set".** No restart is needed: the research code reads the user variable from the registry if the running app has not picked it up.

## How the key is handled

* **Where it is read:** only `ote_engine/secret.py` reads it.
  * It is never printed, logged, written to a file or passed on a command line.
  * Error messages have it redacted.
  * Tests check all of this.
* **Where it is stored:** as a normal user environment variable (registry `HKCU\Environment`). It is readable by your Windows account, not by other users.
* **Afterwards:** you can revoke or rotate the key in the Databento portal at any time, for example after the download.

## Expected cost (not a quote)

**Published price:** $70 per GB for CME OHLCV-1m on the usage-based plan. Read on databento.com/pricing on 2026-11-27; OHLCV-1s is the same rate.

**Rough sizes:**
* **MNQ, May 2019 to now:** about 0.2 GB, roughly $15. In the worst case, where every listed contract and spread trades every minute, about 2.3 GB, roughly $160.
* **MES:** about the same again (`--root MES`).

**Within the free credit:** new accounts get $125 of free credit.
* Without a payment method on file, nothing can be charged.
* With the default `--max-cost 5`, the download refuses if the total estimate is above $5. Raise it only up to what you approve.

The exact figure comes from `--estimate`, which asks Databento itself and downloads nothing.

## What the download does

**Request:**
* **Dataset and data:** `GLBX.MDP3`, `ohlcv-1m`, parent symbol `MNQ.FUT` (every MNQ contract, unadjusted prices).
* **Range:** 2019-05-05 to the latest available date.
* **Cost check:** the quote comes first and is saved as `LAST-QUOTE.json` next to the data. The download refuses if the quote is above `--max-cost` (default $5).
* **Cache:** one file per year under `%USERPROFILE%\AlphaTerminal\research\futures-ote\data\databento\`, listed in `MANIFEST.json` with its range and SHA-256.
  * A covered range is never requested again.
  * The current year is topped up later with only the missing range, so nothing is paid for twice.
* **Credit balance:** Databento's API does not report it. Check **Billing** in the portal before approving a quote.

## Runbook (after the key is set)

The code lives in a permanent checkout of the `research/futures` branch: `%USERPROFILE%\AlphaTerminal\research\futures-ote\repo\futures-ote`. Run every step from there, after this setup line:

```powershell
Set-Location "$env:USERPROFILE\AlphaTerminal\research\futures-ote\repo\futures-ote"; $py = "$env:USERPROFILE\AlphaTerminal\research\futures-ote\.venv\Scripts\python.exe"; $cache = "$env:USERPROFILE\AlphaTerminal\research\futures-ote\data\databento"
```

| Step | Command | Cost | What happens |
|---|---|---|---|
| 1. Readiness | `& $py preflight.py $cache` | free, offline | One line per check (packages, locked Configuration A, branch, key present without showing it, disk, T1 calendar, holdout seal) and the next command |
| 2. Exact quote | `& $py fetch_databento.py $cache --estimate` | free | Databento prices every missing range. Nothing is downloaded |
| 3. Owner approval | (you) | | Compare the quote with the free credit shown under Billing, and approve a cap (for example $20) |
| 4. Download | `& $py fetch_databento.py $cache --max-cost 20` | within credit | Refuses if the quote is above the cap |
| 5. Development backtest | `& $py run_full.py $cache results\full` | free, about 15 min | 4 cost scenarios × 3 sizings on everything before the last 12 months |
| 6. Development MFFU replay | `& $py run_mffu.py results\mffu --cache $cache --jobs 2` | free, about 1 h | 10 pre-registered plan variants × 4 cost scenarios |
| 7. Seal the development results | commit `results/full/dev` and `results/mffu/dev` on `research/futures` | | Opens the holdout. Nothing is tuned between steps 5 and 7 |
| 8. Holdout | add `--holdout` to steps 5 and 6 | free | The most recent 12 months, run once |

**Runtime:** these are estimates. The engine ran at about 18 µs per bar per run on a synthetic 15-month rehearsal, scaled here to about 6.5 development years.
* `--jobs N` runs N worker processes. Each loads its own copy of the data, so keep N small while the ALPHA TERMINAL engine is running. `--jobs 2` is a safe start.
* Results are identical for any N (tested).

**Already rehearsed offline** (`tests/test_pipeline_ready.py`, `tests/synthetic_dbn.py`):
* the fetcher against a fake Databento client: the quote downloads nothing, the cap refuses, the cache and the top-up work;
* a synthetic DBN cache through the real reader, rolls and both runners;
* synthetic output is labelled SYNTHETIC and refused under `results/`;
* the holdout stays sealed.

The synthetic fixture is not market data and is never evidence.
