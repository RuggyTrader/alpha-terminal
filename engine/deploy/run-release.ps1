# Supervisor for a VERSION-PINNED production engine (layout made by deploy\release.mjs). It is installed into
# <Root>\bin by `release.mjs install-launcher` and started by the scheduled task (windows-task-release.ps1):
#   powershell -NoProfile -ExecutionPolicy Bypass -File <Root>\bin\run-release.ps1 -Root <Root> [-Node <node.exe>] [-Once]
# Before EVERY start it reads <Root>\current and verifies that release (checksums + configuration) with the tool in
# <Root>\bin; it never starts unverified code and never falls back to a development checkout.
# The engine runs from <Root>\releases\<id> with ENGINE_ENV_FILE=<Root>\config\engine.env and
# ENGINE_DATA_DIR=<Root>\data, so settings, secrets, state and logs stay outside the replaceable release.
# Duplicates: one supervisor per root (named mutex) and the engine's own lock file in <Root>\data.
# -Once: verify, run one engine poll (run.mjs --once) and exit (used by tests and by the release runbook).
param([Parameter(Mandatory = $true)][string]$Root, [string]$Node = "", [switch]$Once)
$ErrorActionPreference = "Continue"
$Root = [IO.Path]::GetFullPath($Root)
$bin = Join-Path $Root "bin"
$data = Join-Path $Root "data"
$logs = Join-Path $Root "logs"
$config = Join-Path $Root "config\engine.env"
New-Item -ItemType Directory -Force $data, $logs | Out-Null
$log = Join-Path $logs "engine.log"
$supLog = Join-Path $logs "supervisor.log"
$node = if ($Node) { $Node } elseif ($env:ALPHA_NODE) { $env:ALPHA_NODE } else { (Get-Command node -ErrorAction Stop).Source }

function Write-Log($msg) {
  $line = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) [release-supervisor] $msg"
  Write-Host $line
  try { [IO.File]::AppendAllText($supLog, "$line`r`n") } catch { Write-Host "(could not write to $supLog)" }
}

# The engine holding a lock in <Root>\data, only if that process really is a node.exe running the engine.
function Get-LockedEngine {
  foreach ($lock in Get-ChildItem $data -Filter "engine-*.lock" -ErrorAction SilentlyContinue) {
    $id = 0
    if (-not [int]::TryParse((Get-Content $lock.FullName -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$id)) { continue }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -eq "node.exe" -and $p.CommandLine -like "*run.mjs*") { return $p }
  }
  return $null
}

# Verifies the active release with the installed tool; returns its folder, or $null (logged).
function Get-VerifiedRelease {
  $out = & $node (Join-Path $bin "release.mjs") validate --root $Root 2>&1 | Out-String
  try { $v = $out | ConvertFrom-Json } catch { Write-Log "release check failed to run: $out"; return $null }
  if (-not $v.ok) { Write-Log "active release does not verify; not starting. $($v.problems -join '; ')$($v.error)"; return $null }
  Write-Log "active release $($v.release) commit $($v.commit) ($($v.ref)) verified; profile $($v.config.profile), risk `$$($v.config.riskUSD)"
  return (Join-Path $Root "releases\$($v.release)")
}

$mutexName = "Local\ALPHA-TERMINAL-release-" + ($Root -replace '[^A-Za-z0-9]', '_')
$mutex = New-Object System.Threading.Mutex -ArgumentList $false, $mutexName
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { Write-Log "another supervisor already runs the engine for $Root; this one exits"; exit 0 }

Write-Log "started (pid $PID); root $Root"
while ($true) {
  foreach ($f in $log, $supLog) { if ((Test-Path $f) -and (Get-Item $f).Length -gt 20MB) { Move-Item -Force $f "$f.1" } }
  $other = Get-LockedEngine
  if ($other) {
    Write-Log "engine pid $($other.ProcessId) already holds $data; not starting another"
    if ($Once) { exit 3 }
    Start-Sleep -Seconds 60; continue
  }
  $release = Get-VerifiedRelease
  if (-not $release) { if ($Once) { exit 4 }; Start-Sleep -Seconds 60; continue }
  Get-ChildItem $data -Filter "engine-*.lock" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $env:ENGINE_ENV_FILE = $config
  $env:ENGINE_DATA_DIR = $data
  $engineArgs = if ($Once) { "src\cli\run.mjs --once" } else { "src\cli\run.mjs" }
  Write-Log "starting engine from $release"
  $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -WorkingDirectory $release -NoNewWindow -PassThru `
    -ArgumentList "/d /s /c `"`"$node`" $engineArgs >> `"$log`" 2>&1`""
  $null = $p.Handle
  $p.WaitForExit()
  Write-Log "engine exited (code $($p.ExitCode))"
  if ($Once) { exit $p.ExitCode }
  Write-Log "restarting in 30 s"
  Start-Sleep -Seconds 30
}
