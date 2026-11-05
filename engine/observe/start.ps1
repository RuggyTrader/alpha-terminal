# Starts an isolated local PAPER observation run: a development Worker with its own throwaway D1, the OTE engine
# (ENGINE_PROFILE=paper-test) and a metrics monitor. Each runs in its own restart loop, detached from this window,
# so it keeps running until you call stop.ps1 (or the PC shuts down). Nothing here touches production.
#   powershell -ExecutionPolicy Bypass -File engine\observe\start.ps1 [-Hours 48] [-Port 8787]
param([int]$Hours = 48, [int]$Port = 8787)
$ErrorActionPreference = "Stop"
$engine = Resolve-Path (Join-Path $PSScriptRoot "..")
$worker = Resolve-Path (Join-Path $engine "..\worker")
$obs = Join-Path $engine "observations"
New-Item -ItemType Directory -Force $obs | Out-Null

$current = Join-Path $obs "CURRENT"
if (Test-Path $current) {
  $prev = Get-Content $current
  if (Test-Path (Join-Path $prev "pids.json")) {
    $alive = (Get-Content (Join-Path $prev "pids.json") | ConvertFrom-Json).PSObject.Properties | Where-Object { Get-Process -Id $_.Value -ErrorAction SilentlyContinue }
    if ($alive) { throw "An observation run is already active ($prev). Run stop.ps1 first." }
  }
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already in use." }

$id = Get-Date -Format "yyyyMMdd-HHmmss"
$run = Join-Path $obs $id
New-Item -ItemType Directory -Force $run, (Join-Path $run "d1"), (Join-Path $run "engine-data") | Out-Null

# Throwaway secrets for this local Worker only (not production's).
function New-Secret { -join ((1..36) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) }) }
$wh = New-Secret; $pass = New-Secret; $admin = New-Secret
"WEBHOOK_SECRET=$wh`nDASHBOARD_PASSPHRASE=$pass`nADMIN_SECRET=$admin" | Set-Content -Encoding ascii (Join-Path $run "secrets.env")
@"
ENGINE_PROFILE=paper-test
ENGINE_SYMBOL=SOLUSD
ENGINE_INTERVAL_MIN=5
ENGINE_DATA_DIR=$(Join-Path $run "engine-data")
ENGINE_SYNC=on
ALPHA_API_BASE=http://127.0.0.1:$Port
ALPHA_WEBHOOK_SECRET=$wh
"@ | Set-Content -Encoding ascii (Join-Path $run "engine.env")

Push-Location $worker
& npx.cmd wrangler d1 migrations apply alpha-terminal-db --local --persist-to (Join-Path $run "d1") *> (Join-Path $run "migrations.log")
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "D1 migrations failed; see $run\migrations.log" }

@{ id = $id; started_at = (Get-Date).ToUniversalTime().ToString("o"); planned_hours = $Hours; port = $Port; profile = "paper-test"; symbol = "SOLUSD"; timeframe = "5m"; mode = "PAPER" } |
  ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $run "run.json")

# Launch each loop in its own hidden PowerShell so it keeps running after this window closes.
# (Processes created through WMI were held suspended on this PC, so a plain Start-Process is used.)
function Start-Detached($script, $argLine) {
  $p = Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" $argLine" `
    -WorkingDirectory "$engine" -WindowStyle Hidden -PassThru
  return $p.Id
}
$pids = [ordered]@{}
$pids.worker = Start-Detached (Join-Path $PSScriptRoot "worker-loop.ps1") "-Run `"$run`" -Port $Port"
Start-Sleep -Seconds 20
$pids.engine = Start-Detached (Join-Path $PSScriptRoot "engine-loop.ps1") "-Run `"$run`""
$pids.monitor = Start-Detached (Join-Path $PSScriptRoot "monitor-loop.ps1") "-Run `"$run`""
$pids | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $run "pids.json")
$run | Set-Content -Encoding ascii $current
Write-Host "Observation run $id started (PAPER only). Folder: $run"
Write-Host "Check it with:  node engine\observe\status.mjs"
