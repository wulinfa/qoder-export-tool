# download_node.ps1 - download portable node.exe into .\node\ (one-time, first run)
# ASCII-only output to avoid console codepage issues.
$ErrorActionPreference = 'Stop'

$arch = 'win-x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'win-arm64' }

$ver = 'v22.22.2'
$url = "https://nodejs.org/dist/$ver/$arch/node.exe"
$dstDir = Join-Path $PSScriptRoot '..\node'
$dst = Join-Path $dstDir 'node.exe'

if (Test-Path $dst) {
    Write-Host "node.exe already exists: $dst"
    exit 0
}

Write-Host "Downloading $url ..."
try {
    # TLS 1.2 for older PowerShell
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\node_download.exe" -UseBasicParsing
} catch {
    Write-Host "Download failed: $($_.Exception.Message)"
    Write-Host "Please install Node.js manually from https://nodejs.org"
    exit 1
}

New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Move-Item -Force "$env:TEMP\node_download.exe" $dst
Write-Host "Saved: $dst"
exit 0
