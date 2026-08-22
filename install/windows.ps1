[CmdletBinding()]
param(
  [string]$ApiKey = "",
  [switch]$SkipCodexShim,
  [string]$CodexHome = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$PackageReleaseUrl = "https://github.com/momo-api/momoapi-codex-switch/releases/download/v2.29.1-momo.1/momo-api-momoapi-codex-switch-2.29.1.tgz"
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

function Get-NpmCommand {
  # Prefer the executable shim: npm.ps1 is blocked by some Windows execution policies.
  $nodeDir = Join-Path $env:ProgramFiles "nodejs"
  $npmCmd = Join-Path $nodeDir "npm.cmd"
  if (Test-Path $npmCmd) { return $npmCmd }

  $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($npm) { return $npm.Source }

  throw "npm.cmd was not found with Node.js. Reinstall Node.js LTS, then run this installer again."
}

function Get-OcxCommand([string]$NpmCommand) {
  $prefix = (& $NpmCommand prefix --global).Trim()
  $candidates = @(
    (Join-Path $prefix "momoapi-codex-switch.cmd"),
    (Join-Path $prefix "ocx.cmd"),
    (Join-Path $prefix "ocx")
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

$node = Get-NodeCommand
$npm = Get-NpmCommand
$key = Get-PlaintextKey $ApiKey
if (-not $key) { throw "A MOMO API key is required." }
$previousMomoApiKey = $env:MOMO_API_KEY
$previousCodexHome = $env:CODEX_HOME

$userProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$codexHome = if ($CodexHome.Trim()) { $CodexHome.Trim() } else { Join-Path $userProfile ".codex" }
Write-Step "Using Codex home: $codexHome"
New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
$codexConfig = Join-Path $codexHome "config.toml"
if (-not (Test-Path $codexConfig)) {
  Write-Step "Preparing Codex configuration..."
  [System.IO.File]::WriteAllText($codexConfig, "", [System.Text.UTF8Encoding]::new($false))
}
# Use the Windows profile path for this setup and the background service.
$env:CODEX_HOME = $codexHome
$existingOcx = $null
try {
  $existingOcx = Get-OcxCommand $npm
} catch {
  # First installation: no existing launcher to stop.
}

try {
  Write-Step "Checking MOMO API key..."
  Test-MomoApiKey $key

  if ($existingOcx) {
    Write-Step "Stopping the existing local Switch service..."
    # A stale pre-MOMO install can print a harmless restore warning here. The
    # installer immediately writes the new MOMO routing, so keep that residue
    # out of the beginner-facing installation output.
    & $existingOcx service stop *>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "The previous service did not stop cleanly. Continuing with the runtime update."
    } else {
      Start-Sleep -Seconds 4
    }
  }

  Write-Step "Downloading compact MOMO Switch package (about 3 MB)..."
  Write-Step "Installing the local Switch runtime..."
  # npm 11 can disable dependency install scripts by default. MOMO Switch ships
  # Bun as its local runtime, so explicitly allow that one trusted dependency.
  & $npm install --global --omit=dev --allow-scripts=bun $PackageReleaseUrl
  if ($LASTEXITCODE -ne 0) { throw "npm could not install momoapi-codex-switch." }
  $ocx = Get-OcxCommand $npm

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
  if ($null -eq $previousCodexHome) {
    Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
  } else {
    $env:CODEX_HOME = $previousCodexHome
  }
  $key = ""
}
