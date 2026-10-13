# Install T3 Code from the Yarden-zamir/t3code fork on Windows. See docs/fork.md "Install the fork".
#
#   irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1))) -Join <code>
#
# The script downloads the newest nightly installer from the fork releases and runs it.
# The app updates itself afterwards.
param(
  # The one-time join code from Add machine in the portal. The script puts it on the clipboard.
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
Write-Host "t3 install: running $($asset.name)"
Start-Process -FilePath $installer -Wait
Remove-Item $installer -ErrorAction SilentlyContinue

if ($Join -ne "") {
  Set-Clipboard -Value $Join
  Write-Host "t3 install: the join code is on the clipboard. In T3 Code, open Settings > Machines and paste it."
} else {
  Write-Host "t3 install: next, in T3 Code, open Settings > Machines and paste the join code from the portal."
}
