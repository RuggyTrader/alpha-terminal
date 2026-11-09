# Supervisor: keeps ONE PAPER engine running on this Windows PC (settings: engine\.env) and restarts it 30 s
# after it stops or crashes. Started at sign-in by the scheduled task (deploy\windows-task.ps1), or by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\run-windows-production.ps1
# Duplicates: one supervisor per engine data folder (named mutex; a second one exits at once), and it never
# starts an engine while another engine holds that folder's lock (e.g. a manual `npm start`).
# Logs (plain text): <data folder>\engine.log (the engine; it never writes the secret, only "(set)") and
# <data folder>\supervisor.log (starts, restarts, refusals).
$ErrorActionPreference = "Continue"
$engineDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $engineDir

# Same defaults as src\config.mjs; engine\.env overrides them.
$conf = @{ ENGINE_DATA_DIR = "data"; ENGINE_SYMBOL = "SOLUSD"; ENGINE_INTERVAL_MIN = "5" }
foreach ($line in Get-Content (Join-Path $engineDir ".env") -ErrorAction SilentlyContinue) {
  if ($line -match '^\s*(ENGINE_DATA_DIR|ENGINE_SYMBOL|ENGINE_INTERVAL_MIN)\s*=\s*(.*?)\s*$') { $conf[$Matches[1]] = $Matches[2] }
}
$dataDir = [IO.Path]::GetFullPath((Join-Path $engineDir $conf.ENGINE_DATA_DIR))
New-Item -ItemType Directory -Force $dataDir | Out-Null
$log = Join-Path $dataDir "engine.log"
$supLog = Join-Path $dataDir "supervisor.log"
$lock = Join-Path $dataDir "engine-$($conf.ENGINE_SYMBOL)-$($conf.ENGINE_INTERVAL_MIN)m.lock"
$node = if ($env:ALPHA_NODE) { $env:ALPHA_NODE } else { (Get-Command node -ErrorAction Stop).Source }

function Write-Log($msg) {
  $line = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) [supervisor] $msg"
  Write-Host $line
  try { [IO.File]::AppendAllText($supLog, "$line`r`n") } catch { Write-Host "(could not write to $supLog : $($_.Exception.Message))" }
}

# The engine holding the lock, only if that process really is a node.exe running the engine.
function Get-LockedEngine {
  if (-not (Test-Path $lock)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content $lock -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$id)) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq "node.exe" -and $p.CommandLine -like "*run.mjs*") { return $p }
  return $null
}

$mutexName = "Local\ALPHA-TERMINAL-engine-" + ($dataDir -replace '[^A-Za-z0-9]', '_')
$mutex = New-Object System.Threading.Mutex -ArgumentList $false, $mutexName
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { Write-Log "another supervisor already runs the engine for $dataDir; this one exits"; exit 0 }

Write-Log "started (pid $PID); engine folder $engineDir; data $dataDir"
while ($true) {
  # Keep the logs bounded: above 20 MB a log becomes <name>.1 (replacing the previous one).
  foreach ($f in $log, $supLog) { if ((Test-Path $f) -and (Get-Item $f).Length -gt 20MB) { Move-Item -Force $f "$f.1" } }
  $other = Get-LockedEngine
  if ($other) {
    Write-Log "engine pid $($other.ProcessId) (not started by this supervisor) already runs; not starting another, checking again in 60 s"
    Start-Sleep -Seconds 60
    continue
  }
  # A lock left by a crash (dead process, or its id now reused by another program) is stale.
  if (Test-Path $lock) { Remove-Item -Force $lock -ErrorAction SilentlyContinue }
  # cmd /s strips exactly the outer quotes, so paths with spaces work; output appended as plain text.
  $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -NoNewWindow -PassThru `
    -ArgumentList "/d /s /c `"`"$node`" src\cli\run.mjs >> `"$log`" 2>&1`""
  $null = $p.Handle  # keeps the exit code available
  $p.WaitForExit()
  Write-Log "engine exited (code $($p.ExitCode)); restarting in 30 s"
  Start-Sleep -Seconds 30
}
