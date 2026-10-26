# Reinstalls the T3 Code desktop app from the newest GitHub Release on Windows.
# It runs no T3 Code code, so it works however broken the installed app is.
# Needs only PowerShell 5.1+.
#
#   irm https://t3.codes/fix.ps1 | iex
#
# Environment:
#   T3CODE_CHANNEL           stable or nightly (default: the installed app's
#                            channel, or stable when none is installed)
#   T3CODE_VERSION           exact version to install (overrides the newest release)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "pingdotgg/t3code"
$baseUrl = if ($env:T3CODE_RELEASE_BASE_URL) { $env:T3CODE_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
$headers = @{ "User-Agent" = "t3-fix" }

function Fail([string] $message) {
  Write-Error "t3 fix: $message"
  exit 1
}
function Step([string] $message) { [Console]::Error.WriteLine("  $message") }

function Find-Install {
  $keys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "T3 Code*" -and $_.InstallLocation } |
    Select-Object -First 1
}

# PROCESSOR_ARCHITEW6432 bypasses WOW64 emulation.
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($rawArch) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "unsupported architecture $rawArch" }
}

[Console]::Error.WriteLine("`n  T3 Code fix: reinstalling the newest desktop app`n")

$install = Find-Install
$channel = $env:T3CODE_CHANNEL
if (-not $channel -and $env:T3CODE_VERSION) {
  $channel = if ($env:T3CODE_VERSION -match "-nightly\.") { "nightly" } else { "stable" }
}
if (-not $channel -and $install) {
  $channel = if ("$($install.DisplayName) $($install.DisplayVersion)" -match "nightly") { "nightly" } else { "stable" }
}
if (-not $channel) {
  $channel = "stable"
  if (-not [Console]::IsInputRedirected -and [Environment]::UserInteractive) {
    do {
      $answer = Read-Host "  No T3 Code desktop app found. Install stable or nightly? [stable]"
      if (-not $answer) { $answer = "stable" }
    } until ($answer -eq "stable" -or $answer -eq "nightly")
    $channel = $answer
  }
}
if ($channel -ne "stable" -and $channel -ne "nightly") { Fail "T3CODE_CHANNEL must be stable or nightly" }

$version = $env:T3CODE_VERSION
if (-not $version) {
  if ($channel -eq "stable") {
    # release.yml marks only plain stable releases latest.
    $release = Invoke-RestMethod -Uri "https://github.com/$repo/releases/latest" -Headers ($headers + @{ "Accept" = "application/json" })
    $tag = ($release | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+$' }).tag_name
  } else {
    $tag = $null
    for ($page = 1; -not $tag -and $page -le 10; $page++) {
      $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100&page=$page" -Headers $headers
      $tag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$' } | Select-Object -First 1).tag_name
      if (-not $releases) { break }
    }
  }
  if (-not $tag) { Fail "could not find a $channel release" }
  $version = $tag.Substring(1)
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("t3-fix-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $asset = "T3-Code-$version-$arch.exe"
  $manifest = if ($channel -eq "stable") { "latest.yml" } else { "nightly.yml" }
  $installer = Join-Path $work $asset
  Step "Downloading $asset..."
  $manifestText = (Invoke-WebRequest -Uri "$baseUrl/v$version/$manifest" -Headers $headers -UseBasicParsing).Content
  if ($manifestText -is [byte[]]) { $manifestText = [Text.Encoding]::UTF8.GetString($manifestText) }
  Invoke-WebRequest -Uri "$baseUrl/v$version/$asset" -Headers $headers -OutFile $installer -UseBasicParsing

  # electron-builder's update manifest records each file's base64 SHA-512.
  $expected = $null
  $url = $null
  foreach ($line in $manifestText -split "`n") {
    if ($line -match '^\s*-\s*url:\s*(\S+)') { $url = $Matches[1] }
    elseif ($line -match '^\s*sha512:\s*(\S+)' -and $url -eq $asset) { $expected = $Matches[1]; break }
  }
  if (-not $expected) { Fail "$asset is not listed in $manifest" }
  $stream = [IO.File]::OpenRead($installer)
  try { $actual = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) }
  finally { $stream.Dispose() }
  if ($actual -ne $expected) { Fail "checksum mismatch for $asset" }

  if ($install) {
    $installDir = $install.InstallLocation.TrimEnd("\")
    $running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith("$installDir\", [StringComparison]::OrdinalIgnoreCase) })
    if ($running.Count -gt 0) {
      Step "Quitting $($install.DisplayName)..."
      $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
      $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
      $running | Where-Object { -not $_.HasExited } | Stop-Process -Force -ErrorAction SilentlyContinue
      $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    }
  }

  Step "Installing T3 Code $version..."
  $process = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "the installer exited with code $($process.ExitCode)" }
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

$install = Find-Install
if ($install) {
  $exe = Get-ChildItem -Path $install.InstallLocation -Filter "T3 Code*.exe" -File | Where-Object { $_.Name -notlike "Uninstall*" } | Select-Object -First 1
  if ($exe) { Start-Process -FilePath $exe.FullName }
}
[Console]::Error.WriteLine("  Reinstalled T3 Code $version`n")
[Console]::Error.WriteLine("  If T3 Code is still broken, run 'npx t3@nightly unfuck' for a guided recovery, or share the logs in ~\.t3\userdata\logs on GitHub or Discord.`n")
