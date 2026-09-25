param(
  [string]$ExpectedAddress = '0x8041Cc720aBC7DA28B056439aa2932Dbb879c408'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root '.env.bnb.local'
$secureDestination = Join-Path $root '.bnb-key.secure'
if (-not (Test-Path -LiteralPath $destination) -or -not (Test-Path -LiteralPath $secureDestination)) {
  throw 'Both BNB wallet configuration files must exist. Run scripts/import-bnb-wallet.ps1 first.'
}

$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
if (-not (Test-Path -LiteralPath $icacls)) { throw 'Windows icacls.exe was not found.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($path in @($destination, $secureDestination)) {
  & $icacls $path /inheritance:r /grant:r "${identity}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to $path" }
}

$secure = ((Get-Content -LiteralPath $secureDestination -Raw).Trim() | ConvertTo-SecureString)
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:BNB_WALLET_KEY_IMPORT = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $derivedAddress = (& node (Join-Path $PSScriptRoot 'address-from-import-env.js')).Trim()
  if ($LASTEXITCODE -ne 0 -or $derivedAddress -ine $ExpectedAddress) {
    throw "Encrypted key derives to $derivedAddress, not $ExpectedAddress."
  }
  Write-Host "BNB wallet key verified for $derivedAddress; local files restricted to $identity."
} finally {
  Remove-Item Env:BNB_WALLET_KEY_IMPORT -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $secure = $null
}
