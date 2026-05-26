param(
    [switch]$OpenAccessX,
    [switch]$OpenDashboard,
    [switch]$OpenDiskPrep
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$statusDir = Join-Path $root "data\local-controls"
New-Item -ItemType Directory -Force -Path $statusDir | Out-Null

$garage = Join-Path $root "surfaces\tony-garage\index.html"
$accessX = "C:\Program Files\WindowsApps\SUPSI.AccessX_1.4.0.0_x64__bzz41p7kqy1nr\AccessX.exe"
$dashboard = "http://localhost:8765/dashboard/index-v2.html"
$validation = Join-Path $root "manifests\validation\LOCAL-CONTROLS-LATEST.json"

function Test-Http {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return [pscustomobject]@{ url = $Url; ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300); statusCode = $response.StatusCode }
    }
    catch {
        return [pscustomobject]@{ url = $Url; ok = $false; statusCode = $null; error = $_.Exception.Message }
    }
}

$checks = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    root = $root
    garageExists = (Test-Path $garage)
    accessXPath = $accessX
    accessXExists = (Test-Path $accessX)
    dashboard = (Test-Http $dashboard)
    mcp = (Test-Http "http://127.0.0.1:8787/health")
    lantern = (Test-Http "http://127.0.0.1:5173/api/lantern/health")
}

$checks | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $validation -Encoding UTF8

if ($checks.garageExists) {
    Start-Process -FilePath $garage
}

if ($OpenDashboard) {
    Start-Process -FilePath $dashboard
}

if ($OpenAccessX -and $checks.accessXExists) {
    Start-Process -FilePath $accessX
}

if ($OpenDiskPrep) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "dual-boot\Start-DualBootPrep.ps1") -OpenDiskManagement
}

Write-Output $validation
