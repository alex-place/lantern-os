#Requires -Version 5.1
<#
.SYNOPSIS
    Ingest trading config (IBKR account + optional Kalshi key) into the repo .env file.

.DESCRIPTION
    Prompts for trading settings and upserts them into .env at the repo root.
    Existing values are updated in-place; new keys are appended under a Trading APIs block.
    The .env file is never committed — it is in .gitignore.

    NOTE: Alpaca has been removed. The broker is now IBKR via the Client Portal
    Gateway (see docs/IBKR-API-SETUP.md + ADR-0019/ADR-0020). IBKR CPAPI has NO
    API key/secret — the local gateway holds the authenticated session — so this
    script only records the (optional) IBKR_ACCOUNT_ID and IBKR_GATEWAY_URL.
    Order placement is armed separately via TRADER_LIVE / MAX_ORDER_* env flags,
    which this script intentionally does not touch.

.EXAMPLE
    .\scripts\Set-TradingKeys.ps1
    .\scripts\Set-TradingKeys.ps1 -Kalshi
#>
param(
    [switch]$Kalshi    # also prompt for Kalshi API key
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$envFile  = Join-Path $repoRoot '.env'

# ── helpers ─────────────────────────────────────────────────────────────────

function Read-EnvFile {
    param([string]$Path)
    $lines = @()
    if (Test-Path $Path) { $lines = Get-Content $Path -Encoding UTF8 }
    return $lines
}

function Upsert-EnvKey {
    param(
        [string[]]$Lines,
        [string]$Key,
        [string]$Value
    )
    $pattern = "^$([regex]::Escape($Key))\s*="
    $newLine  = "$Key=$Value"
    $match = $Lines | Select-String -Pattern $pattern | Select-Object -First 1
    if ($match) {
        $idx = $match.LineNumber - 1  # LineNumber is 1-based
        $Lines[$idx] = $newLine
    } else {
        $Lines += $newLine
    }
    return $Lines
}

function Prompt-Secret {
    param([string]$Prompt, [string]$Current)
    if ($Current) {
        $masked = $Current.Substring(0, [Math]::Min(6, $Current.Length)) + '...'
        $input = Read-Host "$Prompt (current: $masked, Enter to keep)"
        if ([string]::IsNullOrWhiteSpace($input)) { return $Current }
        return $input.Trim()
    }
    $input = Read-Host $Prompt
    return $input.Trim()
}

# ── load current .env ────────────────────────────────────────────────────────

$lines = Read-EnvFile $envFile

function Get-CurrentValue([string]$Key) {
    $pattern = "^$([regex]::Escape($Key))\s*=\s*(.*)$"
    $match = $lines | Select-String -Pattern $pattern | Select-Object -First 1
    if ($match) { return $match.Matches[0].Groups[1].Value.Trim() }
    return ''
}

# ── IBKR (broker) ────────────────────────────────────────────────────────────
# Alpaca is removed. IBKR CPAPI has no key/secret — the local Client Portal
# Gateway holds the authenticated session. We only record the (optional) account
# id and gateway URL; both auto-fall back to sensible defaults if left blank.

Write-Host ''
Write-Host '=== IBKR (Interactive Brokers) ===' -ForegroundColor Cyan
Write-Host 'Run the Client Portal Gateway locally and log in at https://localhost:5000'
Write-Host 'first. See docs/IBKR-API-SETUP.md. There is NO API key — leave blank to'
Write-Host 'use the defaults (account id is auto-discovered from the gateway session).'
Write-Host ''

$ibkrAccount = Prompt-Secret 'IBKR_ACCOUNT_ID (e.g. DU1234567; blank = auto)' (Get-CurrentValue 'IBKR_ACCOUNT_ID')
$ibkrUrl     = Prompt-Secret 'IBKR_GATEWAY_URL (blank = https://localhost:5000/v1/api)' (Get-CurrentValue 'IBKR_GATEWAY_URL')

if ($ibkrAccount) { $lines = Upsert-EnvKey $lines 'IBKR_ACCOUNT_ID'  $ibkrAccount }
if ($ibkrUrl)     { $lines = Upsert-EnvKey $lines 'IBKR_GATEWAY_URL' $ibkrUrl }

# ── Kalshi (optional) ────────────────────────────────────────────────────────

if ($Kalshi) {
    Write-Host ''
    Write-Host '=== Kalshi Prediction Markets ===' -ForegroundColor Cyan
    Write-Host 'Get your key at: https://kalshi.com/account/api'
    Write-Host ''
    $kalshiKey = Prompt-Secret 'KALSHI_API_KEY' (Get-CurrentValue 'KALSHI_API_KEY')
    if ($kalshiKey) { $lines = Upsert-EnvKey $lines 'KALSHI_API_KEY' $kalshiKey }
}

# ── write back ───────────────────────────────────────────────────────────────

$lines | Set-Content $envFile -Encoding UTF8
Write-Host ''
Write-Host '✓ Keys written to .env' -ForegroundColor Green
Write-Host '  Restart the server to pick up changes.' -ForegroundColor DarkGray
Write-Host ''
