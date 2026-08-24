[CmdletBinding()]
param(
  [string]$CodexHome = "",
  [string]$OpencodexHome = "",
  [switch]$DeepScan,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
  if (-not $Json) { Write-Host "[momoapi-codex-history] $Message" }
}

function Add-UniquePath {
  param(
    [ref]$List,
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try {
    $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path.Trim()))
  } catch {
    $full = $Path.Trim()
  }
  if (-not ($List.Value -contains $full)) {
    $List.Value += $full
  }
}

function Convert-TomlStringLiteral([string]$Raw) {
  if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
  $trimmed = $Raw.Trim()
  if ($trimmed.StartsWith('"')) {
    try { return ($trimmed | ConvertFrom-Json) } catch { return $trimmed.Trim('"') }
  }
  if ($trimmed.StartsWith("'")) {
    return $trimmed.Substring(1, [Math]::Max(0, $trimmed.Length - 2)).Replace("''", "'")
  }
  return $trimmed
}

function Read-RootTomlString {
  param(
    [string]$ConfigPath,
    [string]$Key
  )

  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  $pattern = '^\s*' + [regex]::Escape($Key) + '\s*=\s*("(?:\\.|[^"])*"|''(?:''''|[^''])*'')'
  foreach ($line in ([System.IO.File]::ReadLines($ConfigPath))) {
    if ($line -match '^\s*\[') { break }
    if ($line -match $pattern) { return Convert-TomlStringLiteral $Matches[1] }
  }
  return $null
}

function Resolve-UserPath {
  param(
    [string]$Raw,
    [string]$RelativeBase
  )

  if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
  $expanded = [Environment]::ExpandEnvironmentVariables($Raw.Trim())
  if ($expanded -eq "~") { $expanded = $env:USERPROFILE }
  elseif ($expanded.StartsWith("~\") -or $expanded.StartsWith("~/")) {
    $expanded = Join-Path $env:USERPROFILE $expanded.Substring(2)
  }
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return [System.IO.Path]::GetFullPath($expanded)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $RelativeBase $expanded))
}

function Get-BackupManifestPath {
  param(
    [string]$StateDbPath,
    [string]$ConfigDir
  )

  try {
    $resolved = [System.IO.Path]::GetFullPath($StateDbPath)
    if ($IsWindows -or $env:OS -eq "Windows_NT") { $resolved = $resolved.ToLowerInvariant() }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($resolved)
      $hash = $sha.ComputeHash($bytes)
    } finally {
      $sha.Dispose()
    }
    $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
    return Join-Path $ConfigDir ("codex-history-backup-" + $hex.Substring(0, 16) + ".json")
  } catch {
    return $null
  }
}

function Get-ManifestEntryCount([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $manifest = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ($manifest.entries) { return @($manifest.entries.PSObject.Properties).Count }
  } catch {
    return $null
  }
  return $null
}

function Invoke-SqliteSummary([string]$DbPath) {
  $sqlite = Get-Command sqlite3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sqlite) { return $null }
  try {
    $threadCount = (& $sqlite.Source $DbPath "select count(*) from threads;" 2>$null | Select-Object -First 1)
    $providers = (& $sqlite.Source $DbPath "select coalesce(model_provider,'<null>') || '=' || count(*) from threads group by model_provider order by model_provider;" 2>$null)
    return [ordered]@{
      threadCount = if ($threadCount -match '^\d+$') { [int]$threadCount } else { $null }
      providers = @($providers)
    }
  } catch {
    return $null
  }
}

$profileRoot = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$effectiveOpencodexHome = if ($OpencodexHome.Trim()) {
  Resolve-UserPath $OpencodexHome.Trim() (Get-Location).Path
} elseif ($env:OPENCODEX_HOME) {
  Resolve-UserPath $env:OPENCODEX_HOME (Get-Location).Path
} else {
  Join-Path $profileRoot ".opencodex"
}

$homes = @()
Add-UniquePath ([ref]$homes) $CodexHome
Add-UniquePath ([ref]$homes) $env:CODEX_HOME
Add-UniquePath ([ref]$homes) ([Environment]::GetEnvironmentVariable("CODEX_HOME", "User"))
Add-UniquePath ([ref]$homes) ([Environment]::GetEnvironmentVariable("CODEX_HOME", "Machine"))
Add-UniquePath ([ref]$homes) (Join-Path $profileRoot ".codex")
# Common symptom when a log renderer hides the backslash before .codex; include it so
# the diagnostic proves whether such a sibling directory was accidentally created.
Add-UniquePath ([ref]$homes) ($profileRoot + ".codex")
Add-UniquePath ([ref]$homes) (Join-Path $env:APPDATA "Codex")
Add-UniquePath ([ref]$homes) (Join-Path $env:LOCALAPPDATA "Codex")

if ($DeepScan -and (Test-Path -LiteralPath $profileRoot)) {
  try {
    Get-ChildItem -LiteralPath $profileRoot -Force -Directory -Recurse -Depth 4 -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq ".codex" } |
      ForEach-Object { Add-UniquePath ([ref]$homes) $_.FullName }
  } catch {
    # DeepScan is best-effort only.
  }
}

$sqliteHomeEnv = if ($env:CODEX_SQLITE_HOME) { $env:CODEX_SQLITE_HOME } else { [Environment]::GetEnvironmentVariable("CODEX_SQLITE_HOME", "User") }
$rows = @()
foreach ($codexHomeCandidate in $homes) {
  if ([string]::IsNullOrWhiteSpace($codexHomeCandidate)) { continue }
  $configPath = Join-Path $codexHomeCandidate "config.toml"
  $provider = Read-RootTomlString $configPath "model_provider"
  $sqliteHomeRaw = Read-RootTomlString $configPath "sqlite_home"
  $sqliteHomeSource = "default-codex-home"
  if ([string]::IsNullOrWhiteSpace($sqliteHomeRaw) -and -not [string]::IsNullOrWhiteSpace($sqliteHomeEnv)) {
    $sqliteHomeRaw = $sqliteHomeEnv
    $sqliteHomeSource = "CODEX_SQLITE_HOME"
  } elseif (-not [string]::IsNullOrWhiteSpace($sqliteHomeRaw)) {
    $sqliteHomeSource = "config.toml sqlite_home"
  }

  $sqliteHome = if ([string]::IsNullOrWhiteSpace($sqliteHomeRaw)) { $codexHomeCandidate } else { Resolve-UserPath $sqliteHomeRaw (Get-Location).Path }
  $dbPath = Join-Path $sqliteHome "state_5.sqlite"
  $dbItem = Get-Item -LiteralPath $dbPath -ErrorAction SilentlyContinue
  $backupPath = Get-BackupManifestPath $dbPath $effectiveOpencodexHome
  $manifestEntries = if ($backupPath) { Get-ManifestEntryCount $backupPath } else { $null }
  $sqliteSummary = if ($dbItem) { Invoke-SqliteSummary $dbPath } else { $null }

  $rows += [pscustomobject][ordered]@{
    codexHome = $codexHomeCandidate
    configPath = $configPath
    configExists = [bool](Test-Path -LiteralPath $configPath)
    rootModelProvider = $provider
    sqliteHome = $sqliteHome
    sqliteHomeSource = $sqliteHomeSource
    stateDb = $dbPath
    stateDbExists = [bool]$dbItem
    stateDbSizeBytes = if ($dbItem) { $dbItem.Length } else { $null }
    stateDbLastWriteTime = if ($dbItem) { $dbItem.LastWriteTime.ToString("s") } else { $null }
    walExists = [bool](Test-Path -LiteralPath ($dbPath + "-wal"))
    shmExists = [bool](Test-Path -LiteralPath ($dbPath + "-shm"))
    backupManifest = $backupPath
    backupManifestExists = if ($backupPath) { [bool](Test-Path -LiteralPath $backupPath) } else { $false }
    backupEntries = $manifestEntries
    sqliteSummary = $sqliteSummary
  }
}

if ($DeepScan -and (Test-Path -LiteralPath $profileRoot)) {
  try {
    $knownDbs = @($rows | ForEach-Object { $_.stateDb })
    Get-ChildItem -LiteralPath $profileRoot -Force -Recurse -File -Filter "state_5.sqlite" -Depth 6 -ErrorAction SilentlyContinue |
      Where-Object { $knownDbs -notcontains $_.FullName } |
      ForEach-Object {
        $backupPath = Get-BackupManifestPath $_.FullName $effectiveOpencodexHome
        $rows += [pscustomobject][ordered]@{
          codexHome = $null
          configPath = $null
          configExists = $false
          rootModelProvider = $null
          sqliteHome = Split-Path -Parent $_.FullName
          sqliteHomeSource = "deep-scan"
          stateDb = $_.FullName
          stateDbExists = $true
          stateDbSizeBytes = $_.Length
          stateDbLastWriteTime = $_.LastWriteTime.ToString("s")
          walExists = [bool](Test-Path -LiteralPath ($_.FullName + "-wal"))
          shmExists = [bool](Test-Path -LiteralPath ($_.FullName + "-shm"))
          backupManifest = $backupPath
          backupManifestExists = if ($backupPath) { [bool](Test-Path -LiteralPath $backupPath) } else { $false }
          backupEntries = if ($backupPath) { Get-ManifestEntryCount $backupPath } else { $null }
          sqliteSummary = Invoke-SqliteSummary $_.FullName
        }
      }
  } catch {
    # Best-effort only.
  }
}

$existingDbs = @($rows | Where-Object { $_.stateDbExists } | Sort-Object @{ Expression = "stateDbLastWriteTime"; Descending = $true }, @{ Expression = "stateDbSizeBytes"; Descending = $true })
$recommendations = @()
if ($existingDbs.Count -eq 0) {
  $recommendations += "No state_5.sqlite was found in the usual Codex homes. Re-run with -DeepScan or check whether Codex used another Windows account/WSL home."
} else {
  $recommendations += "Newest visible Codex history DB: $($existingDbs[0].stateDb)"
  $providers = @($existingDbs | Where-Object { $_.sqliteSummary -and $_.sqliteSummary.providers } | ForEach-Object { $_.sqliteSummary.providers } | Where-Object { $_ -like "opencodex=*" })
  if ($providers.Count -gt 0) {
    $recommendations += "Some history rows are tagged opencodex. If old sessions disappeared after switching proxy, close Codex and run: ocx recover-history --legacy-openai"
  }
  $differentHomes = @($existingDbs | Select-Object -ExpandProperty sqliteHome -Unique)
  if ($differentHomes.Count -gt 1) {
    $recommendations += "Multiple SQLite homes were found. Codex is probably reading a different history DB after the switch; compare stateDb paths above before copying anything."
  }
  $recommendations += "To test native visibility without deleting proxy config, close Codex, run: ocx restore ; then restart Codex. Switch back with: ocx restore back"
}

$report = [ordered]@{
  generatedAt = (Get-Date).ToString("s")
  profileRoot = $profileRoot
  opencodexHome = $effectiveOpencodexHome
  codexHomeEnv = $env:CODEX_HOME
  codexSqliteHomeEnv = $env:CODEX_SQLITE_HOME
  sqlite3Available = [bool](Get-Command sqlite3 -CommandType Application -ErrorAction SilentlyContinue)
  homes = $rows
  recommendations = $recommendations
}

if ($Json) {
  $report | ConvertTo-Json -Depth 20
  exit 0
}

Write-Step "Scanned Codex homes and state databases. No files were modified."
Write-Host ""
Write-Host "Environment"
Write-Host "  USERPROFILE:        $profileRoot"
Write-Host "  CODEX_HOME:         $env:CODEX_HOME"
Write-Host "  CODEX_SQLITE_HOME:  $env:CODEX_SQLITE_HOME"
Write-Host "  OPENCODEX_HOME:     $effectiveOpencodexHome"
Write-Host "  sqlite3 available:  $($report.sqlite3Available)"
Write-Host ""
Write-Host "Candidate history databases"
$rows | Sort-Object @{ Expression = "stateDbExists"; Descending = $true }, @{ Expression = "stateDbLastWriteTime"; Descending = $true } |
  Select-Object codexHome, rootModelProvider, sqliteHomeSource, stateDbExists, stateDbSizeBytes, stateDbLastWriteTime, stateDb, backupManifestExists, backupEntries |
  Format-Table -AutoSize -Wrap
Write-Host ""
Write-Host "Recommendations"
foreach ($item in $recommendations) { Write-Host "  - $item" }
