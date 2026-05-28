param(
    [string]$Python = "python",
    [switch]$NoHealthCheck
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$botPath = Join-Path $root "src/discord_lounge_bot/bot.py"
$healthPath = Join-Path $root "scripts/Test-DiscordBotHealth.ps1"

if (-not (Test-Path -LiteralPath $botPath)) {
    throw "Missing bot runtime: $botPath"
}

if (-not $NoHealthCheck) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $healthPath
    if ($LASTEXITCODE -ne 0) {
        throw "Discord bot health check failed. Fix failures before launch."
    }
}

Write-Output "Starting Discord lounge bot runtime..."
Write-Output "Path: $botPath"
Write-Output "Press Ctrl+C to stop."

& $Python $botPath
exit $LASTEXITCODE
