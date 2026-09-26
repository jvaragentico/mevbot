param([switch]$Live, [switch]$Resume)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$stopFile = Join-Path $data 'bnb-manual-stop.json'
$supervisorFile = Join-Path $data 'bnb-supervisor.json'
$pidFile = Join-Path $data 'bnb-processes.json'
$digest = [Security.Cryptography.SHA256]::Create()
$name = [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Replace('-', '').Substring(0, 20)
$digest.Dispose()
$mutex = New-Object Threading.Mutex($false, "Local\MevbotBNB-$name")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'The local BNB supervisor is already running.' }
  if ($Resume -and (Test-Path -LiteralPath $stopFile)) { Remove-Item -LiteralPath $stopFile }
  if (Test-Path -LiteralPath $stopFile) { Write-Host 'Manual stop is active; run with -Resume to restart.'; exit 0 }
  @{ supervisorPid = $PID; startedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'); mode = $(if ($Live) { 'live' } else { 'observe' }) } | ConvertTo-Json | Set-Content -LiteralPath $supervisorFile
  $failures = 0
  while (-not (Test-Path -LiteralPath $stopFile)) {
    try {
      $healthy = $false
      if (Test-Path -LiteralPath $pidFile) {
        $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $bot = Get-Process -Id $saved.botPid -ErrorAction SilentlyContinue
        $dashboard = Get-Process -Id $saved.dashboardPid -ErrorAction SilentlyContinue
        $healthy = $bot -and $dashboard -and $bot.ProcessName -eq 'node' -and $dashboard.ProcessName -eq 'node' -and $saved.mode -eq $(if ($Live) { 'live' } else { 'observe' })
        if ($healthy -and $saved.botStartedAt) { $healthy = [Math]::Abs(($bot.StartTime.ToUniversalTime() - ([datetimeoffset]$saved.botStartedAt).UtcDateTime).TotalSeconds) -lt 2 }
        if ($healthy -and $saved.dashboardStartedAt) { $healthy = [Math]::Abs(($dashboard.StartTime.ToUniversalTime() - ([datetimeoffset]$saved.dashboardStartedAt).UtcDateTime).TotalSeconds) -lt 2 }
      }
      if (-not $healthy) {
        & (Join-Path $PSScriptRoot 'stop-bnb-local.ps1') -KeepSupervisor
        if (Test-Path -LiteralPath $stopFile) { break }
        & (Join-Path $PSScriptRoot 'start-bnb-local.ps1') -Live:$Live
        @{ at = (Get-Date).ToUniversalTime().ToString('o'); event = 'processes_restarted' } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $data 'bnb-supervisor-events.jsonl')
      }
      $failures = 0
    } catch {
      $failures++
      # Do not record command lines, environment variables, or key material.
      @{ at = (Get-Date).ToUniversalTime().ToString('o'); event = 'restart_failed'; consecutiveFailures = $failures } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $data 'bnb-supervisor-events.jsonl')
    }
    Start-Sleep -Seconds ([Math]::Min(300, 30 * [Math]::Max(1, $failures)))
  }
} finally {
  if ($locked) {
    if (Test-Path -LiteralPath $supervisorFile) { Remove-Item -LiteralPath $supervisorFile }
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
