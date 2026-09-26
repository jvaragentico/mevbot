param([switch]$KeepSupervisor)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
if (-not $KeepSupervisor) {
  @{ at = (Get-Date).ToUniversalTime().ToString('o'); reason = 'manual stop' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data 'bnb-manual-stop.json')
  $supervisorFile = Join-Path $data 'bnb-supervisor.json'
  if (Test-Path -LiteralPath $supervisorFile) {
    $savedSupervisor = Get-Content -LiteralPath $supervisorFile -Raw | ConvertFrom-Json
    $supervisor = Get-Process -Id $savedSupervisor.supervisorPid -ErrorAction SilentlyContinue
    if ($supervisor -and $supervisor.ProcessName -match '^(powershell|pwsh)$' -and [Math]::Abs(($supervisor.StartTime.ToUniversalTime() - ([datetimeoffset]$savedSupervisor.startedAt).UtcDateTime).TotalSeconds) -lt 2) {
      Stop-Process -Id $supervisor.Id -Force
    }
    Remove-Item -LiteralPath $supervisorFile -ErrorAction SilentlyContinue
  }
}
$pidFile = Join-Path $root 'data\bnb-processes.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No locally launched BNB processes were recorded.'; exit 0 }
$processes = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
foreach ($entry in @(@{ id = $processes.botPid; startedAt = $processes.botStartedAt; script = 'src/bnb-bot.js' }, @{ id = $processes.dashboardPid; startedAt = $processes.dashboardStartedAt; script = 'src/bnb-dashboard.js' })) {
  $id = $entry.id
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') {
    if ($entry.startedAt) {
      if ([Math]::Abs(($process.StartTime.ToUniversalTime() - ([datetimeoffset]$entry.startedAt).UtcDateTime).TotalSeconds) -ge 2) { continue }
    } else {
      $details = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
      if (-not $details.CommandLine.Contains($entry.script)) { continue }
    }
    Stop-Process -Id $id -Force
  }
}
Remove-Item -LiteralPath $pidFile
Write-Host 'Stopped locally launched BNB bot and dashboard.'
