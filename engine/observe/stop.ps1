# Stops the active observation run (all three loops and their children). Logs and data stay in the run folder.
$obs = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "observations"
$current = Join-Path $obs "CURRENT"
if (-not (Test-Path $current)) { Write-Host "No active observation run."; exit 0 }
$run = Get-Content $current
$pids = Get-Content (Join-Path $run "pids.json") | ConvertFrom-Json
foreach ($p in $pids.PSObject.Properties) {
  # Only a process that is really this run's loop: Windows reuses PIDs (e.g. after a reboot).
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Value)" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -like "*$($p.Name)-loop.ps1*" -and $proc.CommandLine -like "*$run*") {
    taskkill /PID $p.Value /T /F | Out-Null; Write-Host "stopped $($p.Name) ($($p.Value))"
  } else { Write-Host "$($p.Name) ($($p.Value)) is not running (PID not ours or gone)" }
}
$runInfo = Get-Content (Join-Path $run "run.json") | ConvertFrom-Json
$runInfo | Add-Member -NotePropertyName stopped_at -NotePropertyValue (Get-Date).ToUniversalTime().ToString("o") -Force
$runInfo | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $run "run.json")
Remove-Item $current
Write-Host "Observation run stopped. Results: node engine\observe\report.mjs --run `"$run`""
