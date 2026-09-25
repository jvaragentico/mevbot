$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'data\bnb-processes.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No locally launched BNB processes were recorded.'; exit 0 }
$processes = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
foreach ($id in @($processes.botPid, $processes.dashboardPid)) {
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -match '^node') { Stop-Process -Id $id -Force }
}
Remove-Item -LiteralPath $pidFile
Write-Host 'Stopped locally launched BNB bot and dashboard.'
