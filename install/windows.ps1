[CmdletBinding()]
param(
  [string]$ApiKey = "",
  [switch]$SkipCodexShim
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepositoryArchive = "https://github.com/momo-api/momoapi-codex-switch/archive/refs/heads/main.zip"
$ApiBaseUrl = "https://momoapi.us/v1"

function Write-Step([string]$Message) {
  Write-Host "[momoapi-codex-switch] $Message"
}

function Get-NodeCommand {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      throw "Node.js 18+ is required. Install it from https://nodejs.org/, then run this installer again."
    }

    Write-Step "Installing Node.js LTS with winget..."
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      throw "Node.js installation failed. Install Node.js 18+ from https://nodejs.org/, then run this installer again."
    }

    $nodeDir = Join-Path $env:ProgramFiles "nodejs"
    if (Test-Path (Join-Path $nodeDir "node.exe")) {
      $env:Path = "$nodeDir;$env:Path"
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
  }

  if (-not $node) {
    throw "Node.js was installed but is not available in this shell. Open a new PowerShell window and run the installer again."
  }

  $major = [int]((& $node.Source --version).Trim().TrimStart("v").Split(".")[0])
  if ($major -lt 18) {
    throw "Node.js 18+ is required; found $(& $node.Source --version). Update Node.js and run the installer again."
  }
  return $node
}

function Get-OcxCommand {
  $prefix = (& npm prefix --global).Trim()
  $candidates = @(
    (Join-Path $prefix "ocx.cmd"),
    (Join-Path $prefix "ocx"),
    (Join-Path $prefix "momoapi-codex-switch.cmd")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw "momoapi-codex-switch installed, but its ocx launcher was not found."
}

function Get-PlaintextKey([string]$SuppliedKey) {
  if ($SuppliedKey.Trim()) { return $SuppliedKey.Trim() }
  $secure = Read-Host "Enter your MOMO API key" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Test-MomoApiKey([string]$Key) {
  try {
    $result = Invoke-RestMethod -Method Get -Uri "$ApiBaseUrl/models" -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 30
  } catch {
    throw "MOMO API key validation failed. Check the key and network connection."
  }
  if (-not $result.data) {
    throw "MOMO API key validation returned an unexpected model catalog."
  }
}

function Expand-ZipArchive([string]$ArchivePath, [string]$DestinationPath) {
  # WDAG and some locked-down Windows images cannot auto-load
  # Microsoft.PowerShell.Archive, so avoid Expand-Archive entirely.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $DestinationPath)
}

$node = Get-NodeCommand
$key = Get-PlaintextKey $ApiKey
if (-not $key) { throw "A MOMO API key is required." }
$previousMomoApiKey = $env:MOMO_API_KEY

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
New-Item -ItemType Directory -Force -Path $codexHome | Out-Null

$workDir = Join-Path $env:TEMP "momoapi-codex-switch-install-$PID"
$archivePath = Join-Path $workDir "source.zip"

try {
  Write-Step "Checking MOMO API key..."
  Test-MomoApiKey $key

  Write-Step "Downloading MOMO Codex Switch..."
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  Invoke-WebRequest -Uri $RepositoryArchive -OutFile $archivePath
  Expand-ZipArchive -ArchivePath $archivePath -DestinationPath $workDir
  $source = Get-ChildItem -LiteralPath $workDir -Directory | Where-Object { $_.Name -like "momoapi-codex-switch-*" } | Select-Object -First 1
  if (-not $source) { throw "Downloaded MOMO Codex Switch archive has an unexpected layout." }

  Write-Step "Installing local Switch runtime..."
  & npm install --global --omit=dev $source.FullName
  if ($LASTEXITCODE -ne 0) { throw "npm could not install momoapi-codex-switch." }
  $ocx = Get-OcxCommand

  # Keep the key out of PowerShell command history and process arguments.
  $env:MOMO_API_KEY = $key
  Write-Step "Configuring MOMO model routes..."
  & $ocx momo setup --set-default
  if ($LASTEXITCODE -ne 0) { throw "MOMO route configuration failed." }

  Write-Step "Starting the local Switch service..."
  & $ocx service install
  if ($LASTEXITCODE -ne 0) { throw "Local Switch service installation failed." }

  Write-Step "Syncing the MOMO model catalog to Codex..."
  & $ocx sync
  if ($LASTEXITCODE -ne 0) { throw "Codex model catalog sync failed." }

  if (-not $SkipCodexShim) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if ($codex) {
      Write-Step "Installing the Codex on-demand startup shim..."
      & $ocx codex-shim install
      if ($LASTEXITCODE -ne 0) { throw "Codex startup shim installation failed." }
    } else {
      Write-Warning "Codex CLI was not found. The Switch is configured, but install Codex CLI before using it."
    }
  }

  Write-Step "Running diagnostics..."
  & $ocx doctor
  if ($LASTEXITCODE -ne 0) { throw "Installation completed, but diagnostics reported a problem." }

  Write-Host ""
  Write-Host "MOMO Codex Switch is ready. Restart Codex, then use /model to choose a MOMO model."
} finally {
  if ($null -eq $previousMomoApiKey) {
    Remove-Item Env:MOMO_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:MOMO_API_KEY = $previousMomoApiKey
  }
  $key = ""
  if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
}
