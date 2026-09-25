param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('deploy', 'prepare')]
  [string]$Task,
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$securePath = Join-Path $root '.bnb-key.secure'
if (-not (Test-Path -LiteralPath $securePath)) { throw 'Run scripts/import-bnb-wallet.ps1 first.' }
$secure = ((Get-Content -LiteralPath $securePath -Raw).Trim() | ConvertTo-SecureString)
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:EXECUTOR_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  Push-Location $root
  try {
    if ($Task -eq 'deploy') {
      if ($Execute) { & node 'scripts/deploy-bnb.js' '--execute' }
      else { & node 'scripts/deploy-bnb.js' }
    } elseif ($Execute) {
      & node 'scripts/prepare-bnb-wallet.js' '--execute'
    } else {
      & node 'scripts/prepare-bnb-wallet.js'
    }
    if ($LASTEXITCODE -ne 0) { throw "$Task exited with code $LASTEXITCODE" }
  } finally { Pop-Location }
} finally {
  Remove-Item Env:EXECUTOR_KEY -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $secure = $null
}
