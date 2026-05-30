param(
    [string]$InputDataPath = "",
    [string]$OutputPath = "",
    [int]$MaxTickets = 8,
    [double]$MinVisibleActivityUsd = 5.0,
    [switch]$AllowLive
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $InputDataPath) {
    $InputDataPath = Join-Path $repoRoot "data\kalshi\kalshi-watchlist-latest.json"
}
if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot "data\kalshi\kalshi-paper-trade-tickets-latest.json"
}

if ($AllowLive) {
    throw "Live trading is blocked in Lantern OS pre-v1. Use paper tickets plus human approval; do not run authenticated order placement from this script."
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Text
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

if (-not (Test-Path -LiteralPath $InputDataPath)) {
    throw "Missing Kalshi watchlist data: $InputDataPath"
}

$data = Get-Content -Raw -LiteralPath $InputDataPath | ConvertFrom-Json
$watchlist = @($data.watchlist)
$hftQueue = @($data.customHftSpreadQueue)
$candidateRows = @($watchlist) + @($hftQueue)

$tickets = New-Object System.Collections.Generic.List[object]
$rank = 0
foreach ($row in @($candidateRows | Where-Object { $_ -and $_.visibleActivityUsd -ge $MinVisibleActivityUsd } | Select-Object -First $MaxTickets)) {
    $rank += 1
    $lane = if (@($hftQueue | Where-Object { $_.ticker -eq $row.ticker }).Count -gt 0) { "custom_hft_spread_research" } else { "manual_probability_review" }
    $limitCents = if ($null -ne $row.yesBid -and $row.yesBid -gt 0) {
        [int][math]::Max(1, [math]::Floor($row.yesBid * 100))
    }
    else {
        1
    }

    $tickets.Add([ordered]@{
        rank = $rank
        lane = $lane
        ticker = $row.ticker
        title = $row.title
        side = "yes"
        action = "paper_buy_limit"
        count = 1
        suggestedLimitCents = $limitCents
        yesMid = $row.yesMid
        spread = $row.spread
        visibleActivityUsd = $row.visibleActivityUsd
        grossProfitRange = $row.grossProfitRange
        dataConfidenceScore = $row.dataConfidenceScore
        outcomeConfidence = "not_estimated"
        status = "paper_only_requires_human_approval"
        blockers = @(
            "independent_probability_missing",
            "orderbook_depth_missing",
            "fee_and_slippage_model_missing",
            "max_loss_budget_missing",
            "human_approval_missing",
            "authenticated_trading_blocked_pre_v1"
        )
    }) | Out-Null
}

$payload = [ordered]@{
    schema = "lantern.kalshi.paper_trade_tickets.v1"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    source = $InputDataPath
    boundary = "Paper tickets only. No authenticated Kalshi request, no order placement, no custody, no guaranteed profit, no investment advice."
    minVisibleActivityUsd = $MinVisibleActivityUsd
    liveTradingStatus = "blocked"
    ticketCount = $tickets.Count
    tickets = $tickets
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
Write-Utf8NoBom -Path $OutputPath -Text ($payload | ConvertTo-Json -Depth 8)
$payload | ConvertTo-Json -Depth 8
