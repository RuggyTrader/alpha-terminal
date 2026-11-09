# Per-user scheduled task that starts the PAPER engine supervisor (run-windows-production.ps1) at sign-in.
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\windows-task.ps1 install    (and starts it now)
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\windows-task.ps1 status
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\windows-task.ps1 stop       (until next sign-in)
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\windows-task.ps1 uninstall
# Runs as you, no administrator rights, hidden window, only while you are signed in. It changes nothing else
# (no power, firewall or security settings). The task holds no secret: the engine reads engine\.env itself.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet("install", "status", "stop", "uninstall")][string]$Action,
  [string]$TaskName = "ALPHA TERMINAL Engine"
)
$ErrorActionPreference = "Stop"
$engineDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runner = Join-Path $PSScriptRoot "run-windows-production.ps1"

# Same defaults as src\config.mjs; engine\.env overrides them.
$conf = @{ ENGINE_DATA_DIR = "data"; ENGINE_SYMBOL = "SOLUSD"; ENGINE_INTERVAL_MIN = "5" }
foreach ($line in Get-Content (Join-Path $engineDir ".env") -ErrorAction SilentlyContinue) {
  if ($line -match '^\s*(ENGINE_DATA_DIR|ENGINE_SYMBOL|ENGINE_INTERVAL_MIN)\s*=\s*(.*?)\s*$') { $conf[$Matches[1]] = $Matches[2] }
}
$dataDir = [IO.Path]::GetFullPath((Join-Path $engineDir $conf.ENGINE_DATA_DIR))
$lock = Join-Path $dataDir "engine-$($conf.ENGINE_SYMBOL)-$($conf.ENGINE_INTERVAL_MIN)m.lock"
$log = Join-Path $dataDir "engine.log"

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
# Supervisors of THIS engine folder (by script path) and the engine holding THIS data folder's lock.
function Get-Supervisors { @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like "*$runner*" }) }
function Get-Engine {
  if (-not (Test-Path $lock)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content $lock -Raw -ErrorAction SilentlyContinue).Trim(), [ref]$id)) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq "node.exe" -and $p.CommandLine -like "*run.mjs*") { return $p }
  return $null
}

function Stop-All {
  # Collect first: once the task stops, its children no longer have a living parent to find them by.
  $sup = @(Get-Supervisors)
  $cmd = @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $sup.ProcessId -contains $_.ParentProcessId })
  $eng = Get-Engine
  if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  # Supervisors first (so nothing restarts the engine), then the engine. A hard stop is safe: the engine saves its
  # state atomically after every step and a re-sent signal is recognised as a duplicate.
  foreach ($p in @($sup) + @($cmd)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($eng) { Stop-Process -Id $eng.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $left = @(Get-Supervisors) + @(Get-Engine | Where-Object { $_ })
  if ($left.Count) { throw "still running: pid $($left.ProcessId -join ', ')" }
}

switch ($Action) {
  "install" {
    if (-not (Test-Path (Join-Path $engineDir ".env"))) { throw "engine\.env not found; nothing installed" }
    $running = @(Get-Supervisors) + @(Get-Engine | Where-Object { $_ })
    if ($running.Count) {
      Write-Host "Not installed: an engine is already running (pid $($running.ProcessId -join ', ')). Stop it first (Ctrl+C in its window), then run install again."
      exit 1
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"`$env:ALPHA_NODE='$node'; & '$runner'`""
    $act = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arg -WorkingDirectory $engineDir
    $trig = New-ScheduledTaskTrigger -AtLogOn -User $me
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $prin = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trig -Settings $set -Principal $prin -Force `
      -Description "ALPHA TERMINAL PAPER engine ($($conf.ENGINE_SYMBOL) $($conf.ENGINE_INTERVAL_MIN)m, Kraken candles). PAPER only, no broker orders." | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Installed '$TaskName' (starts at every sign-in) and started it. Node: $node"
    for ($i = 0; $i -lt 30 -and -not (Get-Engine); $i++) { Start-Sleep -Seconds 2 }
    $e = Get-Engine
    if ($e) { Write-Host "Engine running: pid $($e.ProcessId)" } else { Write-Host "Engine not running yet; check: windows-task.ps1 status" }
  }
  "status" {
    $t = Get-Task
    if ($t) {
      $i = Get-ScheduledTaskInfo -TaskName $TaskName
      Write-Host "Task '$TaskName': $($t.State); last run $($i.LastRunTime); last result $($i.LastTaskResult)"
    } else { Write-Host "Task '$TaskName': not installed" }
    $sup = @(Get-Supervisors)
    Write-Host "Supervisor: $(if ($sup.Count) { "running (pid $($sup.ProcessId -join ', '))" } else { 'not running' })"
    $e = Get-Engine
    Write-Host "Engine: $(if ($e) { "running (pid $($e.ProcessId), started $($e.CreationDate))" } else { 'not running' })"
    $stateFile = Join-Path $dataDir "state-$($conf.ENGINE_SYMBOL)-$($conf.ENGINE_INTERVAL_MIN)m.json"
    if (Test-Path $stateFile) {
      $s = Get-Content $stateFile -Raw | ConvertFrom-Json
      Write-Host "Last poll $($s.lastPollAt); last candle $($s.lastCandle.t) close $($s.lastCandle.close); ledger check $($s.ledgerCheck.status); last error $(if ($s.lastError) { $s.lastError.message } else { 'none' })"
    }
    foreach ($f in (Join-Path $dataDir "supervisor.log"), $log) {
      if (Test-Path $f) { Write-Host "$f, last lines:"; Get-Content $f -Tail 3 | ForEach-Object { if ($_.Length -gt 200) { $_.Substring(0, 200) + '...' } else { $_ } } }
    }
  }
  "stop" { Stop-All; Write-Host "Stopped. It starts again at the next sign-in, or now with: Start-ScheduledTask -TaskName '$TaskName'" }
  "uninstall" {
    Stop-All
    if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Write-Host "Removed '$TaskName'." } else { Write-Host "'$TaskName' was not installed." }
  }
}
