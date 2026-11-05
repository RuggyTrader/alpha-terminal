# Keeps the local development Worker (own D1, throwaway secrets) running for an observation run.
param([string]$Run, [int]$Port = 8787)
$worker = Resolve-Path (Join-Path $PSScriptRoot "..\..\worker")
$s = @{}; Get-Content (Join-Path $Run "secrets.env") | ForEach-Object { $k, $v = $_ -split "=", 2; $s[$k] = $v }
Set-Location $worker
while ($true) {
  "$((Get-Date).ToUniversalTime().ToString('o')) worker start" | Add-Content (Join-Path $Run "restarts.log")
  & npx.cmd wrangler dev --local --port $Port --inspector-port ($Port + 600) --ip 127.0.0.1 --persist-to (Join-Path $Run "d1") `
    --var "WEBHOOK_SECRET:$($s.WEBHOOK_SECRET)" --var "DASHBOARD_PASSPHRASE:$($s.DASHBOARD_PASSPHRASE)" --var "ADMIN_SECRET:$($s.ADMIN_SECRET)" *>> (Join-Path $Run "worker.log")
  "$((Get-Date).ToUniversalTime().ToString('o')) worker exited ($LASTEXITCODE); restarting in 10 s" | Add-Content (Join-Path $Run "restarts.log")
  Start-Sleep -Seconds 10
}
