# PREPARED, NOT INSTALLED: the scheduled task for the version-pinned production engine (see docs/RELEASE-RUNBOOK.md).
# It replaces the current task's action, which runs engine\deploy\run-windows-production.ps1 from the development
# checkout, with <Root>\bin\run-release.ps1 -Root <Root>. Triggers and settings are the same as windows-task.ps1:
# at sign-in plus a 3-minute fallback, conhost --headless, runs as you, no administrator rights, no other changes.
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\deploy\windows-task-release.ps1 show -Root <Root>
#       (prints the task it WOULD register; changes nothing)
#   ... install -Root <Root>   (registers it; ONLY with the owner's separate approval, after the runbook's steps)
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet("show", "install")][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$TaskName = "ALPHA TERMINAL Engine",
  [string]$Node = ""
)
$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath($Root)
$launcher = Join-Path $Root "bin\run-release.ps1"
$node = if ($Node) { $Node } else { (Get-Command node -ErrorAction Stop).Source }
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "--headless `"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Root `"$Root`" -Node `"$node`""

$plan = [ordered]@{
  task = $TaskName; execute = $conhost; arguments = $arguments; working_directory = $Root
  triggers = @("AtLogOn (current user)", "AtLogOn (current user) + PT3M"); multiple_instances = "Parallel (the launcher's mutex keeps one)"
  launcher_present = (Test-Path $launcher); release_active = (Test-Path (Join-Path $Root "current"))
}
if ($Action -eq "show") { $plan | ConvertTo-Json; exit 0 }

# install: refuses unless the pinned layout is complete and the active release verifies.
if (-not (Test-Path $launcher)) { throw "no launcher at $launcher (run release.mjs install-launcher first)" }
$v = & $node (Join-Path $Root "bin\release.mjs") validate --root $Root | Out-String | ConvertFrom-Json
if (-not $v.ok) { throw "the active release does not verify: $($v.problems -join '; ')$($v.error)" }
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $Root
$t1 = New-ScheduledTaskTrigger -AtLogOn -User $user
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $user; $t2.Delay = "PT3M"
# Same settings as windows-task.ps1 (the task installed today); only the action differs.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances Parallel
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $principal -Force `
  -Description "ALPHA TERMINAL PAPER engine, pinned release from $Root. PAPER only, no broker orders." | Out-Null
Write-Host "registered '$TaskName' for the pinned release $($v.release) ($($v.commit)); it starts at the next sign-in"
