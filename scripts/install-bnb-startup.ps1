param([switch]$Live)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $PSScriptRoot 'supervise-bnb-local.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
if ($Live) { $arguments += ' -Live' }
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Mevbot BNB local supervisor' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Run the local MEV bot and dashboard as the current Windows user; honor manual, wallet-loss and receipt-target stops.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Mevbot BNB local supervisor'
Write-Host 'Installed local BNB supervisor at Windows sign-in. Manual stops are preserved across sign-ins.'
