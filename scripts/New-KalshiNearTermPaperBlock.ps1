param(
    [int]$WindowMinutes = 20,
    [int]$Limit = 1000,
    [int]$MaxPages = 5,
    [int]$MaxOrders = 10,
    [double]$BudgetUsd = 50.0,
    [double]$MaxDailyLossPct = 0.10,
    [double]$MaxPerOrderLossPct = 0.02,
    [double]$MinVisibleActivityUsd = 5.0,
    [int]$MinLimitCents = 1,
    [string]$OutputPath = "",
    [string]$ReceiptPath = "",
    [switch]$AllowLive
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $OutputPath) {
    $OutputPath = Join-Path $repoRoot "data\kalshi\kalshi-near-term-paper-block-latest.json"
}
if (-not $ReceiptPath) {
    $ReceiptPath = Join-Path $repoRoot "manifests\evidence\kalshi-near-term-paper-block-receipt-2026-05-30.md"
}

if ($AllowLive) {
    throw "Live trading is blocked from this script. Near-term block execution is paper-only; real orders require manual operator action in Kalshi."
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Text
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Convert-DollarString {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return [double]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture)
}

function Convert-UtcDate {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try {
        return [datetime]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function Get-SoonestFutureTime {
    param([object]$Market, [datetime]$NowUtc)
    $candidates = @(
        (Convert-UtcDate $Market.expected_expiration_time),
        (Convert-UtcDate $Market.close_time),
        (Convert-UtcDate $Market.expiration_time),
        (Convert-UtcDate $Market.latest_expiration_time)
    ) | Where-Object { $null -ne $_ -and $_ -gt $NowUtc }
    if (@($candidates).Count -eq 0) { return $null }
    return @($candidates | Sort-Object | Select-Object -First 1)[0]
}

$generatedAt = (Get-Date).ToUniversalTime()
$windowEnd = $generatedAt.AddMinutes($WindowMinutes)
$maxDailyPaperLossUsd = [math]::Round($BudgetUsd * $MaxDailyLossPct, 2)
$maxPerOrderPaperLossUsd = [math]::Round($BudgetUsd * $MaxPerOrderLossPct, 2)

$allMarkets = New-Object System.Collections.Generic.List[object]
$cursor = ""
$pagesPulled = 0
for ($page = 1; $page -le $MaxPages; $page += 1) {
    $url = "https://external-api.kalshi.com/trade-api/v2/markets?status=open&mve_filter=exclude&limit=$Limit"
    if ($cursor) {
        $url = "$url&cursor=$([uri]::EscapeDataString($cursor))"
    }
    $response = Invoke-RestMethod -Uri $url -TimeoutSec 20
    $pagesPulled += 1
    foreach ($market in @($response.markets)) {
        $allMarkets.Add($market) | Out-Null
    }
    $cursor = [string]$response.cursor
    if (-not $cursor) { break }
}

$candidates = New-Object System.Collections.Generic.List[object]
foreach ($market in @($allMarkets.ToArray())) {
    $settleTime = Get-SoonestFutureTime -Market $market -NowUtc $generatedAt
    if ($null -eq $settleTime -or $settleTime -gt $windowEnd) { continue }
    $bid = Convert-DollarString $market.yes_bid_dollars
    $ask = Convert-DollarString $market.yes_ask_dollars
    $volume = Convert-DollarString $market.volume_fp
    $volume24h = Convert-DollarString $market.volume_24h_fp
    $openInterest = Convert-DollarString $market.open_interest_fp
    $volumeValue = if ($null -eq $volume) { 0.0 } else { [double]$volume }
    $volume24hValue = if ($null -eq $volume24h) { 0.0 } else { [double]$volume24h }
    $openInterestValue = if ($null -eq $openInterest) { 0.0 } else { [double]$openInterest }
    $visibleActivityUsd = [math]::Round([math]::Max([math]::Max($volumeValue, $volume24hValue), $openInterestValue), 2)
    if ($visibleActivityUsd -lt $MinVisibleActivityUsd) { continue }
    if ($null -eq $bid -or $null -eq $ask -or $bid -le 0 -or $ask -le 0 -or $ask -lt $bid) { continue }
    $limitCents = [int][math]::Floor($bid * 100)
    if ($limitCents -lt $MinLimitCents) { continue }
    $paperMaxLossUsd = [math]::Round($limitCents / 100.0, 2)
    if ($paperMaxLossUsd -gt $maxPerOrderPaperLossUsd) { continue }
    $minutesToKnown = [math]::Round(($settleTime - $generatedAt).TotalMinutes, 2)
    $candidates.Add([ordered]@{
        ticker = $market.ticker
        eventTicker = $market.event_ticker
        title = $market.title
        yesSubTitle = $market.yes_sub_title
        side = "yes"
        action = "paper_buy_limit_maker"
        paperLimitCents = $limitCents
        paperMaxLossUsd = $paperMaxLossUsd
        yesBid = $bid
        yesAsk = $ask
        yesMid = [math]::Round(($bid + $ask) / 2, 4)
        spread = [math]::Round($ask - $bid, 4)
        visibleActivityUsd = $visibleActivityUsd
        soonestKnownTime = $settleTime.ToString("o")
        minutesToKnown = $minutesToKnown
        closeTime = [string]$market.close_time
        expectedExpirationTime = [string]$market.expected_expiration_time
        status = [string]$market.status
        outcomeConfidence = "not_estimated"
        liveOrderStatus = "not_submitted"
        realMoneyUsd = 0
    }) | Out-Null
}

$allocatedPaperRiskUsd = 0.0
$orders = New-Object System.Collections.Generic.List[object]
$rank = 0
foreach ($candidate in @($candidates.ToArray() | Sort-Object minutesToKnown, spread, @{ Expression = "visibleActivityUsd"; Descending = $true } | Select-Object -First $MaxOrders)) {
    if (($allocatedPaperRiskUsd + [double]$candidate.paperMaxLossUsd) -gt $maxDailyPaperLossUsd) { continue }
    $rank += 1
    $allocatedPaperRiskUsd = [math]::Round($allocatedPaperRiskUsd + [double]$candidate.paperMaxLossUsd, 2)
    $order = [ordered]@{}
    foreach ($property in $candidate.Keys) {
        $order[$property] = $candidate[$property]
    }
    $order["rank"] = $rank
    $order["orderStatus"] = "paper_open_unfilled"
    $order["blocker"] = "near_term_paper_only_no_live_execution"
    $orders.Add($order) | Out-Null
}

$payload = [ordered]@{
    schema = "lantern.kalshi.near_term_paper_block.v1"
    generatedAt = $generatedAt.ToString("o")
    windowMinutes = $WindowMinutes
    windowEnd = $windowEnd.ToString("o")
    pagesPulled = $pagesPulled
    marketsPulled = $allMarkets.Count
    candidatesWithinWindow = $candidates.Count
    boundary = "Paper block only. No authenticated Kalshi request, no real order, no custody, no guaranteed profit, no investment advice."
    liveTradingStatus = "blocked"
    realMoneyUsd = 0
    budgetPolicy = [ordered]@{
        bankrollUsd = $BudgetUsd
        maxDailyPaperLossUsd = $maxDailyPaperLossUsd
        maxPerOrderPaperLossUsd = $maxPerOrderPaperLossUsd
        allocatedPaperRiskUsd = $allocatedPaperRiskUsd
        remainingDailyPaperRiskUsd = [math]::Round([math]::Max(0, $maxDailyPaperLossUsd - $allocatedPaperRiskUsd), 2)
        liveSpendUsd = 0
    }
    paperOrderCount = $orders.Count
    orders = $orders
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReceiptPath) | Out-Null
Write-Utf8NoBom -Path $OutputPath -Text ($payload | ConvertTo-Json -Depth 10)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Kalshi Near-Term Paper Block Receipt - 2026-05-30")
$lines.Add("")
$lines.Add("Status: near-term paper block executed locally; live trading remains blocked.")
$lines.Add("")
$lines.Add("## Window")
$lines.Add("")
$lines.Add("| Field | Value |")
$lines.Add("|---|---:|")
$lines.Add(("| Window minutes | {0} |" -f $WindowMinutes))
$lines.Add(("| Markets pulled | {0} |" -f $allMarkets.Count))
$lines.Add(("| Candidates within window | {0} |" -f $candidates.Count))
$lines.Add(("| Paper orders opened | {0} |" -f $orders.Count))
$lines.Add(("| Paper risk allocated | `${0:N2}` |" -f $allocatedPaperRiskUsd))
$lines.Add(("| Real money spent | `${0:N2}` |" -f 0))
$lines.Add("")
$lines.Add("## Boundary")
$lines.Add("")
$lines.Add("- No authenticated Kalshi request was made.")
$lines.Add("- No real order was submitted.")
$lines.Add("- Only markets with a future known/expiry time inside the next window were eligible.")
$lines.Add("- Orders are paper maker limits at public YES bid and may be unfilled in simulation.")
$lines.Add("")
$lines.Add("## Paper Block")
$lines.Add("")
$lines.Add("| Rank | Ticker | Title | Limit | Max Loss | Minutes | Known Time | Status |")
$lines.Add("|---:|---|---|---:|---:|---:|---|---|")
foreach ($order in @($orders.ToArray())) {
    $title = ([string]$order.title).Replace("|", "/")
    $lines.Add(("| {0} | `{1}` | {2} | {3}c | `${4:N2}` | {5:N2} | {6} | {7} |" -f $order.rank, $order.ticker, $title, $order.paperLimitCents, $order.paperMaxLossUsd, $order.minutesToKnown, $order.soonestKnownTime, $order.orderStatus))
}
$lines.Add("")
$lines.Add("## Files")
$lines.Add("")
$lines.Add("| Artifact | Path |")
$lines.Add("|---|---|")
$lines.Add("| Near-term paper block JSON | `data/kalshi/kalshi-near-term-paper-block-latest.json` |")

Write-Utf8NoBom -Path $ReceiptPath -Text ($lines -join "`n")
$payload | ConvertTo-Json -Depth 10
