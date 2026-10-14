# Install T3 Code from the Yarden-zamir/t3code fork on Windows. See docs/fork.md "Install the fork".
#
#   irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1))) -Join <code>
#
# The script downloads the newest nightly installer from the fork releases and runs it.
# The app updates itself afterwards.
param(
  # The one-time join code from Add machine in the portal. The app joins with it when it starts.
  [string]$Join = ""
)

$ErrorActionPreference = "Stop"
$repo = "Yarden-zamir/t3code"

# The API lists releases newest first and includes pre-releases. GitHub "latest" skips them.
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=20" `
  -Headers @{ Accept = "application/vnd.github+json" }
$asset = $releases |
  ForEach-Object { $_.assets } |
  Where-Object { $_.name -like "*-x64.exe" } |
  Select-Object -First 1
if ($null -eq $asset) {
  throw "No Windows release found. Open https://github.com/$repo/releases"
}

$installer = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
Write-Host "t3 install: downloading $($asset.browser_download_url)"
# The progress bar of Invoke-WebRequest makes large downloads very slow in Windows PowerShell.
$ProgressPreference = "SilentlyContinue"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
# MM-211: the app server joins the machine map with this file at its next start, then deletes it.
if ($Join -ne "") {
  $t3Home = if ($env:T3CODE_HOME) { $env:T3CODE_HOME } else { Join-Path $env:USERPROFILE ".t3" }
  $userdata = Join-Path $t3Home "userdata"
  New-Item -ItemType Directory -Force -Path $userdata | Out-Null
  Set-Content -Path (Join-Path $userdata "machine-map-join-code") -Value $Join -NoNewline
}
Write-Host "t3 install: running $($asset.name)"
Start-Process -FilePath $installer -Wait
Remove-Item $installer -ErrorAction SilentlyContinue

if ($Join -ne "") {
  Write-Host "t3 install: T3 Code joins the machine map when it starts. If it was open already, quit it and open it again."
  Write-Host "t3 install: if it does not join within 10 minutes, open Settings > Machines and paste $Join"
} else {
  Write-Host "t3 install: next, in T3 Code, open Settings > Machines and paste the join code from the portal."
}
