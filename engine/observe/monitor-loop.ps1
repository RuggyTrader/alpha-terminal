# Keeps the observation monitor running (one metrics sample per minute into <run>\metrics.jsonl).
param([string]$Run)
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
while ($true) {
  & node observe/monitor.mjs --run "$Run" *>> (Join-Path $Run "monitor.log")
  "$((Get-Date).ToUniversalTime().ToString('o')) monitor exited ($LASTEXITCODE); restarting in 10 s" | Add-Content (Join-Path $Run "restarts.log")
  Start-Sleep -Seconds 10
}
