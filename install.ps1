# PRAANA installer for Windows (PowerShell 5.1+ / PowerShell 7+).
#
#   irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex
#
# From cmd.exe:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex"
#
# Downloads praana-windows-x64.zip from GitHub Releases, verifies SHA256SUMS,
# and installs praana.exe plus praana-natives.node into %USERPROFILE%\.local\bin
# (or -Prefix). Keep both files in the same directory.
#Requires -Version 5.1

[CmdletBinding()]
param(
  [string] $Prefix = "",
  [switch] $PrintTarget,
  [switch] $Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ReleaseBaseDefault = "https://github.com/amitkumardubey/praana/releases/latest/download"
$SidecarName = "praana-natives.node"
$ManifestName = "praana-natives.json"
$ArchiveName = "praana-windows-x64.zip"
$ExeName = "praana.exe"
$TargetStem = "praana-windows-x64"

function Show-Usage {
  @"
Install PRAANA from GitHub Releases (no Bun required).

Usage:
  install.ps1 [-Prefix DIR] [-PrintTarget] [-Help]

Options:
  -Prefix DIR      Install into DIR (default: %USERPROFILE%\.local\bin)
  -PrintTarget     Print archive stem ($TargetStem) and exit
  -Help            Show this help

Environment:
  PRAANA_RELEASE_BASE              Override download base URL (tests / mirrors)
  PRAANA_PROCESSOR_ARCHITECTURE    Override CPU arch detection (tests)
"@
}

function Write-Err([string] $Message) {
  throw $Message
}

function Get-ProcessorArch {
  if ($env:PRAANA_PROCESSOR_ARCHITECTURE) {
    return $env:PRAANA_PROCESSOR_ARCHITECTURE
  }
  if ($env:PROCESSOR_ARCHITEW6432) {
    return $env:PROCESSOR_ARCHITEW6432
  }
  return $env:PROCESSOR_ARCHITECTURE
}

function Assert-SupportedArch {
  $arch = Get-ProcessorArch
  switch ($arch) {
    "AMD64" { return }
    "ARM64" {
      Write-Err "unsupported: Windows ARM64 (not shipped). Use: npm install -g praana"
    }
    "x86" {
      Write-Err "unsupported: 32-bit Windows (not shipped). Use: npm install -g praana"
    }
    default {
      Write-Err "unsupported: architecture '$arch'"
    }
  }
}

function Get-ReleaseBase {
  $base = if ($env:PRAANA_RELEASE_BASE) { $env:PRAANA_RELEASE_BASE } else { $ReleaseBaseDefault }
  return $base.TrimEnd("/")
}

function Test-LocalReleaseBase([string] $Base) {
  return $Base -notmatch '^https?://'
}

function Get-ReleaseFile([string] $Base, [string] $Name, [string] $Dest) {
  if (Test-LocalReleaseBase $Base) {
    $source = Join-Path $Base $Name
    if (-not (Test-Path -LiteralPath $source)) {
      Write-Err "missing local release file: $source"
    }
    Copy-Item -LiteralPath $source -Destination $Dest -Force
    return
  }
  $uri = "$Base/$Name"
  try {
    Invoke-WebRequest -Uri $uri -OutFile $Dest -UseBasicParsing -UserAgent "praana-install"
  } catch {
    Write-Err "failed to download $Name from $Base (no archive on latest release yet?)"
  }
}

function Get-ExpectedSha256([string] $SumsPath, [string] $FileName) {
  $match = Select-String -Path $SumsPath -Pattern "^\s*([0-9a-fA-F]{64})\s{2}$([regex]::Escape($FileName))\s*$"
  if (-not $match) {
    Write-Err "SHA256SUMS has no entry for $FileName"
  }
  return $match.Matches[0].Groups[1].Value.ToLower()
}

function Get-FileSha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Test-PathOnPath([string] $Dir) {
  $normalized = $Dir.TrimEnd('\')
  $parts = $env:PATH -split ';' | ForEach-Object { $_.TrimEnd('\') }
  return $parts -contains $normalized
}

if ($Help) {
  Show-Usage
  exit 0
}

Assert-SupportedArch

if ($PrintTarget) {
  Write-Output $TargetStem
  exit 0
}

$dest = if ($Prefix) {
  $Prefix
} else {
  Join-Path $env:USERPROFILE ".local\bin"
}

$base = Get-ReleaseBase
$tmpdir = Join-Path ([System.IO.Path]::GetTempPath()) ("praana-install-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null

try {
  Write-Host "Downloading $ArchiveName …"
  $sumsPath = Join-Path $tmpdir "SHA256SUMS"
  $archivePath = Join-Path $tmpdir $ArchiveName
  Get-ReleaseFile -Base $base -Name "SHA256SUMS" -Dest $sumsPath
  Get-ReleaseFile -Base $base -Name $ArchiveName -Dest $archivePath

  $expected = Get-ExpectedSha256 -SumsPath $sumsPath -FileName $ArchiveName
  $actual = Get-FileSha256 -Path $archivePath
  if ($expected -ne $actual) {
    Write-Err "checksum mismatch for ${ArchiveName}: expected $expected got $actual"
  }

  $extractDir = Join-Path $tmpdir "extract"
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force

  $exePath = Join-Path $extractDir $ExeName
  $sidecarPath = Join-Path $extractDir $SidecarName
  $manifestPath = Join-Path $extractDir $ManifestName
  if (-not (Test-Path -LiteralPath $exePath)) {
    Write-Err "archive missing $ExeName"
  }
  if (-not (Test-Path -LiteralPath $sidecarPath)) {
    Write-Err "archive missing $SidecarName (native sidecar)"
  }

  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $stage = Join-Path $dest (".praana-install-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Copy-Item -LiteralPath $exePath -Destination (Join-Path $stage $ExeName) -Force
  Copy-Item -LiteralPath $sidecarPath -Destination (Join-Path $stage $SidecarName) -Force
  if (Test-Path -LiteralPath $manifestPath) {
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage $ManifestName) -Force
  }
  Move-Item -LiteralPath (Join-Path $stage $ExeName) -Destination (Join-Path $dest $ExeName) -Force
  Move-Item -LiteralPath (Join-Path $stage $SidecarName) -Destination (Join-Path $dest $SidecarName) -Force
  if (Test-Path -LiteralPath (Join-Path $stage $ManifestName)) {
    Move-Item -LiteralPath (Join-Path $stage $ManifestName) -Destination (Join-Path $dest $ManifestName) -Force
  }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

  Write-Host "Installed $ExeName and $SidecarName to $dest"
  if (-not (Test-PathOnPath $dest)) {
    Write-Host ""
    Write-Host "$dest is not on PATH. Add it (current user), then open a new terminal:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$dest;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  }
  $installedExe = Join-Path $dest $ExeName
  # Expand-Archive does not restore Unix +x; pwsh-on-Linux CI needs it to smoke.
  if ($PSVersionTable.Platform -eq "Unix") {
    & chmod +x $installedExe
  }
  & $installedExe --version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Err "smoke --version failed after install"
  }
  $docOut = & $installedExe doctor 2>&1 | Out-String
  if ($docOut -notmatch "✓ native:") {
    Write-Host $docOut
    Write-Err "doctor did not report native capability"
  }
  if ($docOut -notmatch "✓ search:") {
    Write-Host $docOut
    Write-Err "doctor did not report search capability"
  }
  Write-Host "Run: praana --version"
} finally {
  Remove-Item -LiteralPath $tmpdir -Recurse -Force -ErrorAction SilentlyContinue
}
