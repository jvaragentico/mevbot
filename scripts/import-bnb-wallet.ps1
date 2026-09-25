param(
  [string]$ExpectedAddress = '0x8041Cc720aBC7DA28B056439aa2932Dbb879c408'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root '.env.bnb.local'
$secureDestination = Join-Path $root '.bnb-key.secure'
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $secureDestination)) {
  if ((Test-Path -LiteralPath $destination) -and (Test-Path -LiteralPath $secureDestination)) {
    & (Join-Path $PSScriptRoot 'finalize-bnb-wallet.ps1') -ExpectedAddress $ExpectedAddress
    return
  }
  throw 'BNB wallet configuration is incomplete. Inspect the two local files before retrying.'
}

$secure = Read-Host 'Enter the BNB wallet private key (input is hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plain -notmatch '^(0x)?[0-9a-fA-F]{64}$') { throw 'Private key must be 32 hexadecimal bytes.' }
  if (-not $plain.StartsWith('0x')) { $plain = '0x' + $plain }
  $env:BNB_WALLET_KEY_IMPORT = $plain
  $derivedAddress = (& node (Join-Path $PSScriptRoot 'address-from-import-env.js')).Trim()
  if ($LASTEXITCODE -ne 0 -or $derivedAddress -ine $ExpectedAddress) {
    throw "Key derives to $derivedAddress, not $ExpectedAddress. Nothing was saved."
  }
  $encrypted = ConvertFrom-SecureString $secure
  $content = @(
    'NETWORK=bnb'
    'BOT_MODE=observe'
    'RPC_URL=https://bsc-dataseed.bnbchain.org'
    "BNB_EXPECTED_EXECUTOR_ADDRESS=$derivedAddress"
    'WETH_ADDRESS=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
  )
  [System.IO.File]::WriteAllLines($destination, $content)
  [System.IO.File]::WriteAllText($secureDestination, $encrypted)
  & (Join-Path $PSScriptRoot 'finalize-bnb-wallet.ps1') -ExpectedAddress $ExpectedAddress
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Item Env:BNB_WALLET_KEY_IMPORT -ErrorAction SilentlyContinue
  $plain = $null
  $secure = $null
}
