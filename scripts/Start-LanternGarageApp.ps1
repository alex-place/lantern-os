param(
    [int]$Port = 4177
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$app = Join-Path $root "apps\lantern-garage"
$healthUrl = "http://127.0.0.1:$Port/api/health"
$appUrl = "http://127.0.0.1:$Port"

if (-not (Test-Path (Join-Path $app "server.js"))) {
    throw "Lantern Garage app not found at $app"
}

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($health.StatusCode -eq 200 -and $health.Content -match "lantern-garage") {
        Write-Host "Lantern Garage is already running: $appUrl"
        return
    }
}
catch {
    # No healthy Lantern Garage answered; continue into the foreground server.
}

$env:LANTERN_GARAGE_PORT = [string]$Port
Set-Location -LiteralPath $app
Write-Host "Starting Lantern Garage: $appUrl"
node server.js
