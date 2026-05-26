param(
    [int]$Port = 4177
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$app = Join-Path $root "apps\lantern-garage"

$env:LANTERN_GARAGE_PORT = [string]$Port
Set-Location -LiteralPath $app
node validate.js
