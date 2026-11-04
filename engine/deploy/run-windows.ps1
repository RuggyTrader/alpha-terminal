# Runs the PAPER engine on this Windows PC and restarts it if it stops (Ctrl+C to quit).
# Settings: engine\.env (copy from .env.example). State and logs: engine\data\.
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")
New-Item -ItemType Directory -Force data | Out-Null
while ($true) {
  node src/cli/run.mjs 2>&1 | Tee-Object -FilePath data/engine.log -Append
  Write-Host "engine exited; restarting in 10 s (Ctrl+C to stop)"
  Start-Sleep -Seconds 10
}
