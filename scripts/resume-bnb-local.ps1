param([switch]$Live)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stopFile = Join-Path $root 'data\bnb-manual-stop.json'
$task = Get-ScheduledTask -TaskName 'Mevbot BNB local supervisor' -ErrorAction SilentlyContinue
if (-not $task) { throw 'Install the current-user supervisor first with scripts/install-bnb-startup.ps1 -Live.' }
$expectedMode = if ($Live) { ' -Live' } else { '' }
$isLive = $task.Actions.Arguments -match '(?:^|\s)-Live(?:\s|$)'
if ($isLive -ne [bool]$Live) { throw 'Requested mode differs from the installed task. Reinstall the task in the requested mode first.' }
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
Start-ScheduledTask -TaskName 'Mevbot BNB local supervisor'
Write-Host 'Local supervisor resumed. Dashboard: http://127.0.0.1:8788/'
