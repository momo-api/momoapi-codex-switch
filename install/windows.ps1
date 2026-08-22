[CmdletBinding()]
param(
  [string]$ApiKey = "",
  [switch]$SkipCodexShim,
  [switch]$InstallCodexCli,
  [string]$CodexHome = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$PackageReleaseUrl = "https://momoapi.us/install/packages/momoapi-codex-switch-2.29.13.tgz"
$PackageSha256 = "17cb476588a4092c31b4f709151d1aff95ffbb67ea4a2e75f508406c89b3cb6f"
$NpmRegistry = if ($env:MOMO_NPM_REGISTRY) { $env:MOMO_NPM_REGISTRY.TrimEnd("/") } else { "https://registry.npmmirror.com" }
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

function Get-CodexCommand([string]$NpmCommand) {
  $codex = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($codex) { return $codex.Source }

  $prefix = (& $NpmCommand prefix --global).Trim()
  foreach ($candidate in @((Join-Path $prefix "codex.cmd"), (Join-Path $prefix "codex"))) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Ensure-CodexCli([string]$NpmCommand, [bool]$AllowInstall) {
  $codex = Get-CodexCommand $NpmCommand
  if ($codex) { return $codex }

  if (-not $AllowInstall) {
    Write-Step "Codex CLI was not found. Skipping its download; the existing Codex App can use this setup."
    Write-Step "To install the CLI separately, re-run with -InstallCodexCli."
    return $null
  }

  Write-Step "Installing the official Codex CLI..."
  & $NpmCommand install --global --registry $NpmRegistry @openai/codex
  if ($LASTEXITCODE -ne 0) { throw "Codex CLI installation failed. Re-run the installer after checking your network." }

  $codex = Get-CodexCommand $NpmCommand
  if (-not $codex) { throw "Codex CLI installed but its launcher was not found. Open a new PowerShell window and run the installer again." }
  return $codex
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

function Test-LocalSwitchReady {
  try {
    $main = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:10100/healthz" -TimeoutSec 2
    $codex = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:10101/v1/models" -TimeoutSec 2
    return $main.StatusCode -eq 200 -and $codex.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Install-MomoSwitchPackage([string]$NpmCommand) {
  $packagePath = Join-Path ([System.IO.Path]::GetTempPath()) "momoapi-codex-switch-$([Guid]::NewGuid().ToString('N')).tgz"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $PackageReleaseUrl -OutFile $packagePath -TimeoutSec 120
    $actualSha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $PackageSha256.ToLowerInvariant()) {
      throw "MOMO Switch package integrity check failed. Expected $PackageSha256 but received $actualSha256."
    }

    & $NpmCommand install --global --omit=dev --allow-scripts=bun --registry $NpmRegistry $packagePath
    if ($LASTEXITCODE -ne 0) { throw "npm could not install momoapi-codex-switch." }
  } finally {
    Remove-Item -LiteralPath $packagePath -Force -ErrorAction SilentlyContinue
  }
}

function Start-LocalSwitchFallback([string]$OcxCommand, [string]$OpenCodexHome) {
  # Windows Sandbox and locked-down work accounts can register a scheduled task
  # without ever launching its child. Keep the install usable in that case: Codex's
  # on-demand shim will start this same local runtime on later launches.
  New-Item -ItemType Directory -Force -Path $OpenCodexHome | Out-Null
  $fallbackLog = Join-Path $OpenCodexHome "installer-fallback.log"
  $fallbackErrorLog = Join-Path $OpenCodexHome "installer-fallback.error.log"
  Start-Process -FilePath $OcxCommand -ArgumentList @("start", "--port", "10100") `
    -WorkingDirectory $OpenCodexHome -WindowStyle Hidden `
    -RedirectStandardOutput $fallbackLog -RedirectStandardError $fallbackErrorLog

  $deadline = (Get-Date).AddSeconds(20)
  do {
    if (Test-LocalSwitchReady) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return $false
}

function Get-MomoStartupFallbackPath {
  $startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  if (-not $startup) {
    throw "Windows could not locate this user's Startup folder."
  }
  return (Join-Path $startup "MOMOAPI Proxy.vbs")
}

function Install-MomoStartupFallback([string]$OcxCommand) {
  $startupEntry = Get-MomoStartupFallbackPath
  $command = ('"{0}" start --port 10100' -f $OcxCommand).Replace('"', '""')
  $vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "$command", 0, False
"@
  [System.IO.File]::WriteAllText($startupEntry, $vbs, [System.Text.UTF8Encoding]::new($false))
  return $startupEntry
}

function Remove-MomoStartupFallback {
  $startupEntry = Get-MomoStartupFallbackPath
  Remove-Item -LiteralPath $startupEntry -Force -ErrorAction SilentlyContinue
}

function Repair-MomoSwitchService([string]$OcxCommand) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $OcxCommand service repair *>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousPreference
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
$opencodexHome = if ($env:OPENCODEX_HOME) { $env:OPENCODEX_HOME } else { Join-Path $userProfile ".opencodex" }
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
    # Older releases can stop their service successfully, then return a nonzero
    # status only because restoring an already-user-managed Codex config failed.
    # Treat that as an upgrade warning, not an installation blocker.
    $stopErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      & $existingOcx service stop *>$null
      $stopExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $stopErrorActionPreference
    }
    if ($stopExitCode -ne 0) {
      Write-Warning "The previous Switch reported a cleanup warning. Continuing with the runtime update."
    }
    Start-Sleep -Seconds 4
  }

  Write-Step "Downloading MOMO-hosted Switch package (about 4 MB)..."
  Write-Step "Installing the local Switch runtime..."
  # npm 11 can disable dependency install scripts by default. MOMO Switch ships
  # Bun as its local runtime, so explicitly allow that one trusted dependency.
  Install-MomoSwitchPackage $npm
  $ocx = Get-OcxCommand $npm
  $null = Ensure-CodexCli $npm $InstallCodexCli.IsPresent

  # Keep the key out of PowerShell command history and process arguments.
  $env:MOMO_API_KEY = $key
  Write-Step "Configuring MOMO model routes..."
  # MOMO setup owns the local routes and publishes short model names. It never
  # needs an OpenAI account, API key, or account-pool credential.
  & $ocx momo setup --set-default
  if ($LASTEXITCODE -ne 0) { throw "MOMO route configuration failed." }

  Write-Step "Starting the local Switch service..."
  $serviceReady = $false
  if ($existingOcx) {
    # An existing scheduled task is already registered. Repair refreshes its assets
    # and starts it without trying to create the task again or requesting UAC.
    $serviceReady = Repair-MomoSwitchService $ocx
  }
  if (-not $serviceReady) {
    & $ocx service install
    $serviceReady = $LASTEXITCODE -eq 0
  }
  if ($serviceReady) {
    Remove-MomoStartupFallback
  } else {
    Write-Warning "Task Scheduler could not register the Switch. Registering a per-user startup fallback instead."
    $startupEntry = Install-MomoStartupFallback $ocx
    if (-not (Start-LocalSwitchFallback $ocx $opencodexHome)) {
      throw "Local Switch service installation failed. See $(Join-Path $opencodexHome 'service.log'), $(Join-Path $opencodexHome 'installer-fallback.log'), and $(Join-Path $opencodexHome 'installer-fallback.error.log')."
    }
    Write-Step "Local Switch is ready and will start when this user signs in: $startupEntry"
  }

  Write-Step "Syncing the MOMO model catalog to Codex..."
  & $ocx sync
  if ($LASTEXITCODE -ne 0) { throw "Codex model catalog sync failed." }

  if (-not $SkipCodexShim) {
    Write-Step "Installing the Codex on-demand startup shim..."
    & $ocx codex-shim install
    if ($LASTEXITCODE -ne 0) { throw "Codex startup shim installation failed." }
  }

  Write-Step "Running diagnostics..."
  & $ocx doctor
  if ($LASTEXITCODE -ne 0) { throw "Installation completed, but diagnostics reported a problem." }

  Write-Host ""
  Write-Host "MOMO Codex Switch is ready. Restart Codex, then select a routed MOMO model in /model."
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
