param([switch]$Live)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$pidFile = Join-Path $data 'bnb-processes.json'
$stopFile = Join-Path $data 'bnb-manual-stop.json'
if (-not (Test-Path -LiteralPath (Join-Path $data 'bnb-routes.json'))) { throw 'Run npm run scan-bnb-routes first.' }
if (Test-Path -LiteralPath $pidFile) {
  $old = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  $running = @($old.botPid, $old.dashboardPid) | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
  if ($running.Count -gt 0) { throw 'BNB processes are already running. Use scripts/stop-bnb-local.ps1 first.' }
  Remove-Item -LiteralPath $pidFile
}
if ($Live -and -not (Test-Path -LiteralPath (Join-Path $root '.bnb-key.secure'))) { throw 'Import the BNB wallet locally first.' }
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
$node = (Get-Command node -ErrorAction Stop).Source
$env:BNB_BOT_MODE = if ($Live) { 'live' } else { 'observe' }
$botOut = Join-Path $data 'bnb-bot.out.log'
$botErr = Join-Path $data 'bnb-bot.err.log'
$dashboardOut = Join-Path $data 'bnb-dashboard.out.log'
$dashboardErr = Join-Path $data 'bnb-dashboard.err.log'
if ($Live) {
  $secure = ((Get-Content -LiteralPath (Join-Path $root '.bnb-key.secure') -Raw).Trim() | ConvertTo-SecureString)
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:EXECUTOR_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $bot = Start-Process -FilePath $node -ArgumentList 'src/bnb-bot.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $botOut -RedirectStandardError $botErr -PassThru
  } finally {
    Remove-Item Env:EXECUTOR_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure = $null
  }
} else {
  $bot = Start-Process -FilePath $node -ArgumentList 'src/bnb-bot.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $botOut -RedirectStandardError $botErr -PassThru
}
$dashboard = Start-Process -FilePath $node -ArgumentList 'src/bnb-dashboard.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $dashboardOut -RedirectStandardError $dashboardErr -PassThru
@{ botPid = $bot.Id; dashboardPid = $dashboard.Id; botStartedAt = $bot.StartTime.ToUniversalTime().ToString('o'); dashboardStartedAt = $dashboard.StartTime.ToUniversalTime().ToString('o'); mode = $env:BNB_BOT_MODE; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile
Remove-Item Env:BNB_BOT_MODE -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (-not (Get-Process -Id $bot.Id -ErrorAction SilentlyContinue) -or -not (Get-Process -Id $dashboard.Id -ErrorAction SilentlyContinue)) {
  throw "A process exited during startup. Read $botErr and $dashboardErr"
}
$modeLabel = if ($Live) { 'live' } else { 'observe' }
Write-Host "BNB bot running in $modeLabel mode. Dashboard: http://127.0.0.1:8788/"
Write-Host "Bot PID $($bot.Id); dashboard PID $($dashboard.Id). Logs: $data"
