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

**Estimate first:**
```powershell
& "$env:USERPROFILE\AlphaTerminal\research\futures-ote\.venv\Scripts\python.exe" fetch_databento.py "$env:USERPROFILE\AlphaTerminal\research\futures-ote\data\databento" --estimate
```

**Request:**
* **Dataset and data:** `GLBX.MDP3`, `ohlcv-1m`, parent symbol `MNQ.FUT` (every MNQ contract, unadjusted prices).
* **Range:** 2019-05-05 to the latest available date.
* **Cost check:** the estimate comes first. The download refuses if the estimate is above `--max-cost` (default $5).
* **Cache:** one file per year, cached under `%USERPROFILE%\AlphaTerminal\research\futures-ote\data\databento\`. A cached year is never requested again.
