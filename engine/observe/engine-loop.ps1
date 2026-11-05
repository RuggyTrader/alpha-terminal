# Keeps the PAPER engine running for an observation run (settings in <run>\engine.env).
param([string]$Run)
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
$env:ENGINE_ENV_FILE = Join-Path $Run "engine.env"
while ($true) {
  "$((Get-Date).ToUniversalTime().ToString('o')) engine start" | Add-Content (Join-Path $Run "restarts.log")
  & node src/cli/run.mjs *>> (Join-Path $Run "engine.log")
  "$((Get-Date).ToUniversalTime().ToString('o')) engine exited ($LASTEXITCODE); restarting in 10 s" | Add-Content (Join-Path $Run "restarts.log")
  Start-Sleep -Seconds 10
}
