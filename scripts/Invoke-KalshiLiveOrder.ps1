<#
.SYNOPSIS
    Place a real-money Kalshi order with hard safety rails.

.DESCRIPTION
    Authenticated Kalshi trade-api/v2 order placement.

    SAFETY MODEL (all enforced here, not optional):
      - Dry-run is the default. A real order is only sent when -Live is passed.
      - A kill switch (file data/kalshi/LIVE-KILL-SWITCH or env KALSHI_KILL_SWITCH=1)
        blocks every live order regardless of other flags.
      - Per-order capital-at-risk cap (-MaxPerOrderUsd).
      - Daily capital-at-risk cap (-MaxDailyLossUsd), measured from the live ledger.
      - Max live trades per day (-MaxTradesPerDay), measured from the live ledger.
      - Defaults to the DEMO environment. Production requires -Environment prod.
      - Credentials are read from environment variables only, never from the repo:
          KALSHI_API_KEY_ID      = your API Key ID
          KALSHI_PRIVATE_KEY     = RSA private key PEM (full text), OR
          KALSHI_PRIVATE_KEY_PATH= path to the .key/.pem file

    For a Kalshi binary contract, max loss on a buy equals the cost paid, so
    "capital at risk" for a buy = count * limitCents / 100.

.EXAMPLE
    # Dry run (no creds needed, sends nothing):
    pwsh -File scripts/Invoke-KalshiLiveOrder.ps1 -Ticker KXMLBGAME-26MAY311435KCTEX-TEX -LimitCents 35

.EXAMPLE
    # Real order against demo, then production (requires creds + explicit -Live):
    pwsh -File scripts/Invoke-KalshiLiveOrder.ps1 -Ticker SOMETICKER -LimitCents 35 -Live -Environment demo
    pwsh -File scripts/Invoke-KalshiLiveOrder.ps1 -Ticker SOMETICKER -LimitCents 35 -Live -Environment prod
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Ticker,

    [ValidateSet("yes", "no")]
    [string]$Side = "yes",

    [ValidateSet("buy", "sell")]
    [string]$Action = "buy",

    [ValidateRange(1, 10000)]
    [int]$Count = 1,

    [ValidateRange(1, 99)]
    [int]$LimitCents = 0,

    [ValidateSet("limit", "market")]
    [string]$Type = "limit",

    [double]$MaxPerOrderUsd = 40.0,
    [double]$MaxDailyLossUsd = 40.0,
    [int]$MaxTradesPerDay = 1,

    [ValidateSet("demo", "prod")]
    [string]$Environment = "demo",

    [string]$BaseUrl = "",
    [string]$LedgerPath = "",
    [string]$ReceiptDir = "",

    [switch]$Live
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $LedgerPath) {
    $LedgerPath = Join-Path $repoRoot "data/kalshi/kalshi-live-ledger.jsonl"
}
if (-not $ReceiptDir) {
    $ReceiptDir = Join-Path $repoRoot "manifests/evidence"
}
$killSwitchFile = Join-Path $repoRoot "data/kalshi/LIVE-KILL-SWITCH"

if (-not $BaseUrl) {
    $BaseUrl = if ($Environment -eq "prod") {
        "https://api.elections.kalshi.com/trade-api/v2"
    }
    else {
        "https://demo-api.kalshi.co/trade-api/v2"
    }
}

function Write-Status {
    param([string]$Message)
    Write-Information -MessageData $Message -InformationAction Continue
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Out-LedgerEntry {
    param([hashtable]$Entry)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LedgerPath) | Out-Null
    $line = ($Entry | ConvertTo-Json -Compress -Depth 8)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($LedgerPath, $line + "`n", $utf8NoBom)
}

function Test-KillSwitch {
    if (Test-Path -LiteralPath $killSwitchFile) {
        return "file:$killSwitchFile"
    }
    $envVal = [Environment]::GetEnvironmentVariable("KALSHI_KILL_SWITCH")
    if ($envVal -and $envVal -ne "0" -and $envVal.ToLowerInvariant() -ne "false") {
        return "env:KALSHI_KILL_SWITCH=$envVal"
    }
    return $null
}

function Get-TodayLiveSummary {
    # Returns @{ Trades = <int>; RiskUsd = <double> } from today's (UTC) live ledger rows.
    $stats = @{ Trades = 0; RiskUsd = 0.0 }
    if (-not (Test-Path -LiteralPath $LedgerPath)) { return $stats }
    $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
    foreach ($raw in (Get-Content -LiteralPath $LedgerPath)) {
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        try { $row = $raw | ConvertFrom-Json } catch { continue }
        if ($row.mode -ne "live") { continue }
        if ($row.event -ne "live_order_submitted") { continue }
        if (-not $row.ts) { continue }
        $rowDay = ([datetime]$row.ts).ToUniversalTime().ToString("yyyy-MM-dd")
        if ($rowDay -ne $today) { continue }
        $stats.Trades += 1
        $stats.RiskUsd += [double]$row.costUsd
    }
    $stats.RiskUsd = [math]::Round($stats.RiskUsd, 2)
    return $stats
}

function Get-KalshiPrivateKey {
    $pem = [Environment]::GetEnvironmentVariable("KALSHI_PRIVATE_KEY")
    if (-not $pem) {
        $path = [Environment]::GetEnvironmentVariable("KALSHI_PRIVATE_KEY_PATH")
        if ($path -and (Test-Path -LiteralPath $path)) {
            $pem = Get-Content -Raw -LiteralPath $path
        }
    }
    if (-not $pem) {
        throw "No private key. Set KALSHI_PRIVATE_KEY (PEM text) or KALSHI_PRIVATE_KEY_PATH."
    }
    $rsa = [System.Security.Cryptography.RSA]::Create()
    # Accept well-formed PEM as-is; otherwise normalize a header-less / whitespace-flattened
    # paste into DER and try PKCS#1 then PKCS#8 (Kalshi keys may be either).
    try {
        $rsa.ImportFromPem($pem.ToCharArray())
        return $rsa
    }
    catch {
        $b64 = ($pem -replace "-----[A-Z ]+-----", "") -replace "\s", ""
        try { $der = [Convert]::FromBase64String($b64) }
        catch { throw "KALSHI_PRIVATE_KEY is not valid PEM or base64." }
        $bytesRead = 0
        foreach ($fmt in @("pkcs1", "pkcs8")) {
            try {
                if ($fmt -eq "pkcs1") { $rsa.ImportRSAPrivateKey($der, [ref]$bytesRead) }
                else { $rsa.ImportPkcs8PrivateKey($der, [ref]$bytesRead) }
                return $rsa
            }
            catch {
                Write-Verbose ("Key import as {0} failed: {1}" -f $fmt, $_.Exception.Message)
            }
        }
        throw "KALSHI_PRIVATE_KEY could not be parsed as PKCS#1 or PKCS#8 RSA key."
    }
}

function Get-KalshiSignature {
    param([System.Security.Cryptography.RSA]$Rsa, [string]$Message)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Message)
    $sig = $Rsa.SignData(
        $bytes,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pss)
    return [Convert]::ToBase64String($sig)
}

function Invoke-KalshiSigned {
    param([string]$Method, [string]$Path, [object]$Body = $null)
    $apiKeyId = [Environment]::GetEnvironmentVariable("KALSHI_API_KEY_ID")
    if (-not $apiKeyId) { throw "No KALSHI_API_KEY_ID set." }
    $rsa = Get-KalshiPrivateKey
    try {
        $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
        $signPath = ([System.Uri]($BaseUrl + $Path)).AbsolutePath
        $signature = Get-KalshiSignature -Rsa $rsa -Message ($ts + $Method + $signPath)
        $headers = @{
            "KALSHI-ACCESS-KEY"       = $apiKeyId
            "KALSHI-ACCESS-TIMESTAMP" = $ts
            "KALSHI-ACCESS-SIGNATURE" = $signature
        }
        $uri = $BaseUrl + $Path
        if ($Method -eq "GET") {
            return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 20
        }
        $json = $Body | ConvertTo-Json -Depth 8
        return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType "application/json" -Body $json -TimeoutSec 20
    }
    finally {
        $rsa.Dispose()
    }
}

# --- Validate inputs / compute risk -----------------------------------------
if ($Type -eq "limit" -and $LimitCents -le 0) {
    throw "A limit order requires -LimitCents between 1 and 99."
}

$priceCents = $LimitCents
$costUsd = [math]::Round(($Count * $priceCents) / 100.0, 2)
$mode = if ($Live) { "live" } else { "dry_run" }
$nowIso = (Get-Date).ToUniversalTime().ToString("o")
$clientOrderId = [guid]::NewGuid().ToString()

Write-Status "=== Kalshi order plan ($mode) ==="
Write-Status ("  environment   : {0}  ({1})" -f $Environment, $BaseUrl)
Write-Status ("  ticker        : {0}" -f $Ticker)
Write-Status ("  action/side   : {0} {1}" -f $Action, $Side)
Write-Status ("  type/count    : {0} x{1}" -f $Type, $Count)
Write-Status ("  limit (cents) : {0}" -f $priceCents)
Write-Status ("  capital risk  : `${0:N2}  (per-order cap `${1:N2})" -f $costUsd, $MaxPerOrderUsd)

# --- Hard safety gates ------------------------------------------------------
$blockers = New-Object System.Collections.Generic.List[string]

$kill = Test-KillSwitch
if ($kill) { $blockers.Add("kill_switch_active ($kill)") }

if ($Action -eq "buy" -and $costUsd -gt $MaxPerOrderUsd) {
    $blockers.Add("per_order_cap_exceeded (`$$costUsd > `$$MaxPerOrderUsd)")
}

$today = Get-TodayLiveSummary
Write-Status ("  today (live)  : {0} trade(s), `${1:N2} at risk" -f $today.Trades, $today.RiskUsd)
if ($today.Trades -ge $MaxTradesPerDay) {
    $blockers.Add("daily_trade_count_reached ($($today.Trades) >= $MaxTradesPerDay)")
}
if ($Action -eq "buy" -and ([math]::Round($today.RiskUsd + $costUsd, 2)) -gt $MaxDailyLossUsd) {
    $blockers.Add("daily_risk_cap_exceeded (`$$([math]::Round($today.RiskUsd + $costUsd,2)) > `$$MaxDailyLossUsd)")
}

$orderBody = [ordered]@{
    action          = $Action
    side            = $Side
    ticker          = $Ticker
    count           = $Count
    type            = $Type
    client_order_id = $clientOrderId
}
if ($Type -eq "limit") {
    if ($Side -eq "yes") { $orderBody["yes_price"] = $priceCents } else { $orderBody["no_price"] = $priceCents }
}
if ($Action -eq "buy") { $orderBody["buy_max_cost"] = [int]($Count * $priceCents) }

# --- Dry run: show everything, send nothing ---------------------------------
if (-not $Live) {
    Write-Status ""
    Write-Status "DRY RUN: no request sent. Request body that WOULD be posted:"
    Write-Status ($orderBody | ConvertTo-Json -Depth 8)
    if ($blockers.Count -gt 0) {
        Write-Status ""
        Write-Status "NOTE: the following gates would block a live order:"
        foreach ($b in $blockers) { Write-Status "  - $b" }
    }
    Out-LedgerEntry @{
        ts            = $nowIso
        mode          = "dry_run"
        event         = "dry_run_order_planned"
        environment   = $Environment
        ticker        = $Ticker
        action        = $Action
        side          = $Side
        type          = $Type
        count         = $Count
        limitCents    = $priceCents
        costUsd       = $costUsd
        clientOrderId = $clientOrderId
        wouldBlock    = @($blockers)
    }
    exit 0
}

# --- Live path --------------------------------------------------------------
if ($blockers.Count -gt 0) {
    Write-Status ""
    Write-Status "LIVE ORDER BLOCKED by safety gates:"
    foreach ($b in $blockers) { Write-Status "  - $b" }
    Out-LedgerEntry @{
        ts            = $nowIso
        mode          = "live"
        event         = "live_order_blocked"
        environment   = $Environment
        ticker        = $Ticker
        costUsd       = $costUsd
        clientOrderId = $clientOrderId
        blockers      = @($blockers)
    }
    throw "Live order blocked: $([string]::Join('; ', $blockers))"
}

Write-Status ""
Write-Status "LIVE: verifying credentials via balance preflight..."
$balance = Invoke-KalshiSigned -Method "GET" -Path "/portfolio/balance"
$balanceUsd = [math]::Round([double]$balance.balance / 100.0, 2)
Write-Status ("  account balance: `${0:N2}" -f $balanceUsd)
if ($Action -eq "buy" -and ($costUsd * 100) -gt [double]$balance.balance) {
    throw "Insufficient balance: cost `$$costUsd > balance `$$balanceUsd."
}

Write-Status "LIVE: submitting real-money order..."
$response = Invoke-KalshiSigned -Method "POST" -Path "/portfolio/orders" -Body $orderBody
$order = $response.order
$orderId = if ($order) { $order.order_id } else { $null }
$status = if ($order) { $order.status } else { "unknown" }
Write-Status ("  order_id: {0}  status: {1}" -f $orderId, $status)

Out-LedgerEntry @{
    ts            = $nowIso
    mode          = "live"
    event         = "live_order_submitted"
    environment   = $Environment
    ticker        = $Ticker
    action        = $Action
    side          = $Side
    type          = $Type
    count         = $Count
    limitCents    = $priceCents
    costUsd       = $costUsd
    clientOrderId = $clientOrderId
    orderId       = $orderId
    status        = $status
    realMoneyUsd  = $costUsd
}

# --- Receipt ----------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $ReceiptDir | Out-Null
$receiptPath = Join-Path $ReceiptDir ("kalshi-live-order-receipt-{0:yyyyMMddHHmmss}.md" -f (Get-Date).ToUniversalTime())
$receipt = @(
    "# Kalshi Live Order Receipt"
    ""
    "Status: REAL-MONEY order submitted."
    ""
    "| Field | Value |"
    "|---|---|"
    "| Time (UTC) | $nowIso |"
    "| Environment | $Environment |"
    "| Ticker | ``$Ticker`` |"
    "| Action / Side | $Action $Side |"
    "| Type / Count | $Type x$Count |"
    "| Limit (cents) | $priceCents |"
    "| Capital at risk | `$$costUsd |"
    "| client_order_id | ``$clientOrderId`` |"
    "| order_id | ``$orderId`` |"
    "| status | $status |"
    ""
    "## Risk caps in force"
    ""
    "- Per-order cap: `$$MaxPerOrderUsd"
    "- Daily risk cap: `$$MaxDailyLossUsd"
    "- Max trades/day: $MaxTradesPerDay"
) -join "`n"
Write-Utf8NoBom -Path $receiptPath -Text $receipt
Write-Status ("Receipt: {0}" -f $receiptPath)

$response | ConvertTo-Json -Depth 8
