param(
    [int]$Limit = 1000,
    [int]$Top = 20,
    [int]$MaxPages = 5,
    [int]$MinMidCents = 20,
    [double]$MinMarketActivityUsd = 5.0,
    [string]$OutputDataPath = "",
    [string]$OutputReportPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$generatedAt = (Get-Date).ToString("o")
$homepage = "https://kalshi.com/"
$endpoint = "https://external-api.kalshi.com/trade-api/v2/markets?status=open&mve_filter=exclude&limit=$Limit"

if (-not $OutputDataPath) {
    $OutputDataPath = Join-Path $repoRoot "data\kalshi\kalshi-watchlist-latest.json"
}
if (-not $OutputReportPath) {
    $OutputReportPath = Join-Path $repoRoot "reports\KALSHI-KOFI-WATCHLIST-REVENUE-REPORT.md"
}

function Convert-ToNumber {
    param([object]$Value)
    if ($null -eq $Value) { return 0.0 }
    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return 0.0 }
    $parsed = 0.0
    if ([double]::TryParse($text, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return $parsed
    }
    return 0.0
}

function Get-DaysToClose {
    param([object]$CloseTime)
    if ($null -eq $CloseTime) { return $null }
    try {
        $close = [datetime]::Parse([string]$CloseTime, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal)
        return [math]::Round(($close.ToUniversalTime() - [datetime]::UtcNow).TotalDays, 2)
    }
    catch {
        return $null
    }
}

function Get-SafeTitle {
    param([object]$Market)
    $title = ([string]$Market.title).Trim()
    if ([string]::IsNullOrWhiteSpace($title)) { $title = ([string]$Market.ticker).Trim() }
    $title = ($title -replace "\s+", " ").Trim()
    return ([System.Text.RegularExpressions.Regex]::Replace($title, "[^\x20-\x7E]", "?"))
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Text
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Get-MarketEndpoint {
    param([string]$Cursor)
    if ([string]::IsNullOrWhiteSpace($Cursor)) { return $endpoint }
    return ($endpoint + "&cursor=" + [System.Uri]::EscapeDataString($Cursor))
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputDataPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputReportPath) | Out-Null

$allMarkets = New-Object System.Collections.Generic.List[object]
$cursor = ""
$pagesPulled = 0
$cursorPresent = $false
do {
    $pageEndpoint = Get-MarketEndpoint -Cursor $cursor
    $response = Invoke-RestMethod -Uri $pageEndpoint -Method Get -TimeoutSec 45
    $pagesPulled += 1
    foreach ($market in @($response.markets)) {
        $allMarkets.Add($market) | Out-Null
    }
    $cursor = [string]$response.cursor
    $cursorPresent = -not [string]::IsNullOrWhiteSpace($cursor)
} while ($cursorPresent -and $pagesPulled -lt $MaxPages)

$markets = @($allMarkets.ToArray())
$minMid = [math]::Round($MinMidCents / 100.0, 4)

$scored = foreach ($market in $markets) {
    $bid = Convert-ToNumber $market.yes_bid_dollars
    $ask = Convert-ToNumber $market.yes_ask_dollars
    $last = Convert-ToNumber $market.last_price_dollars
    $volume24h = Convert-ToNumber $market.volume_24h_fp
    $volume = Convert-ToNumber $market.volume_fp
    $liquidity = Convert-ToNumber $market.liquidity_dollars
    $openInterest = Convert-ToNumber $market.open_interest_fp
    $visibleActivityUsd = [math]::Round([math]::Max([math]::Max($volume24h, $volume), [math]::Max($liquidity, $openInterest)), 4)
    $spread = if ($ask -gt 0 -and $bid -gt 0 -and $ask -ge $bid) { [math]::Round($ask - $bid, 4) } else { $null }
    $mid = if ($ask -gt 0 -and $bid -gt 0 -and $ask -ge $bid) { [math]::Round(($ask + $bid) / 2, 4) } elseif ($last -gt 0) { $last } else { $null }
    $daysToClose = Get-DaysToClose $market.close_time
    $title = Get-SafeTitle $market

    $spreadPenalty = if ($null -eq $spread) { 24 } else { [math]::Min(24, [math]::Max(0, $spread * 120)) }
    $clarityPenalty = 0
    if ($title.Length -gt 170) { $clarityPenalty += 12 }
    if (([string]$market.ticker) -match "MVE|MULTI|CROSSCATEGORY") { $clarityPenalty += 18 }
    if ($null -ne $mid -and ($mid -lt 0.02 -or $mid -gt 0.98)) { $clarityPenalty += 8 }

    $liquidityScore = [math]::Min(30, [math]::Log10([math]::Max(1, $liquidity) + 1) * 10)
    $volumeScore = [math]::Min(28, [math]::Log10([math]::Max(1, $volume24h) + 1) * 10)
    $openInterestScore = [math]::Min(18, [math]::Log10([math]::Max(1, $openInterest) + 1) * 7)
    $timeScore = if ($null -eq $daysToClose) { 4 } elseif ($daysToClose -lt 0) { 0 } elseif ($daysToClose -le 14) { 12 } elseif ($daysToClose -le 60) { 9 } else { 5 }
    $quoteScore = if ($ask -gt 0 -and $bid -gt 0) { 12 } elseif ($ask -gt 0 -or $bid -gt 0) { 5 } else { 0 }
    $score = [math]::Round([math]::Max(0, $liquidityScore + $volumeScore + $openInterestScore + $timeScore + $quoteScore - $spreadPenalty - $clarityPenalty), 2)
    $maxLossPerContract = if ($ask -gt 0) { [math]::Round($ask, 4) } else { $null }
    $grossProfitIfYes = if ($ask -gt 0) { [math]::Round(1 - $ask, 4) } else { $null }
    $grossProfitRange = if ($null -ne $maxLossPerContract -and $null -ne $grossProfitIfYes) {
        ("-{0:N2} to +{1:N2}" -f $maxLossPerContract, $grossProfitIfYes)
    }
    else {
        "not quoted"
    }
    $dataConfidenceScore = [math]::Min(70, [math]::Round($score, 0))
    $dataConfidence = if ($null -eq $spread -or $null -eq $mid) {
        "low"
    }
    elseif ($mid -lt $minMid) {
        "held_below_min_value"
    }
    elseif ($spread -le 0.02 -and $volume24h -ge 500 -and $openInterest -ge 500) {
        "medium_data_quality"
    }
    elseif ($spread -le 0.05 -and ($volume24h -ge 100 -or $openInterest -ge 100)) {
        "low_medium_data_quality"
    }
    else {
        "low_data_quality"
    }

    $activityClass = if ($liquidity -le 0 -and $volume24h -le 0 -and $openInterest -le 0) {
        "avoid_empty"
    }
    elseif ($null -eq $spread -or $spread -gt 0.20) {
        "research_only_wide_spread"
    }
    elseif ($score -ge 35) {
        "watchlist"
    }
    else {
        "research_only"
    }

    [pscustomobject]@{
        ticker = [string]$market.ticker
        eventTicker = [string]$market.event_ticker
        title = $title
        closeTime = [string]$market.close_time
        daysToClose = $daysToClose
        yesBid = $bid
        yesAsk = $ask
        yesMid = $mid
        spread = $spread
        volume24h = $volume24h
        volume = $volume
        liquidity = $liquidity
        openInterest = $openInterest
        visibleActivityUsd = $visibleActivityUsd
        maxLossPerContract = $maxLossPerContract
        grossProfitIfYes = $grossProfitIfYes
        grossProfitRange = $grossProfitRange
        score = $score
        dataConfidence = $dataConfidence
        dataConfidenceScore = $dataConfidenceScore
        outcomeConfidence = "not_estimated"
        activityClass = $activityClass
        modelGate = "needs_independent_probability_before_trade"
        action = "watch_or_research_only_no_execution"
    }
}

$watchlist = @($scored |
    Where-Object { $_.activityClass -ne "avoid_empty" -and $null -ne $_.yesMid -and $_.yesMid -ge $minMid -and $_.visibleActivityUsd -ge $MinMarketActivityUsd } |
    Sort-Object @{ Expression = "score"; Descending = $true }, @{ Expression = "liquidity"; Descending = $true } |
    Select-Object -First $Top)

$emptyCount = @($scored | Where-Object { $_.activityClass -eq "avoid_empty" }).Count
$wideSpreadCount = @($scored | Where-Object { $_.activityClass -eq "research_only_wide_spread" }).Count
$belowMinCount = @($scored | Where-Object { $null -ne $_.yesMid -and $_.yesMid -lt $minMid }).Count
$belowMinActivityCount = @($scored | Where-Object { $_.visibleActivityUsd -lt $MinMarketActivityUsd }).Count
$watchCount = @($watchlist | Where-Object { $_.activityClass -eq "watchlist" }).Count
$manualApprovalQueue = @($watchlist | Where-Object { $_.dataConfidenceScore -ge 66 -and $_.spread -le 0.06 } | Select-Object -First 3)
$customHftSpreadQueue = @($scored |
    Where-Object {
        $_.activityClass -ne "avoid_empty" -and
        $null -ne $_.yesMid -and
        $_.yesMid -ge $minMid -and
        $_.visibleActivityUsd -ge $MinMarketActivityUsd -and
        $null -ne $_.spread -and
        $_.spread -ge 0.02 -and
        $_.spread -le 0.10
    } |
    Sort-Object @{ Expression = "score"; Descending = $true }, @{ Expression = "spread"; Descending = $true }, @{ Expression = "visibleActivityUsd"; Descending = $true } |
    Select-Object -First 5)

$payload = [ordered]@{
    generatedAt = $generatedAt
    homepage = $homepage
    source = $endpoint
    sourceDocs = @(
        "https://docs.kalshi.com/api-reference/market/get-markets",
        "https://docs.kalshi.com/getting_started/quick_start_market_data",
        "https://docs.kalshi.com/getting_started/api_environments"
    )
    koFi = "https://ko-fi.com/alexplace"
    boundary = "Public market data only. No authenticated trading, no order placement, no pooled capital, no guaranteed profit, no investment advice."
    model = "liquidity_spread_watchlist_v0"
    tradeReadiness = "not_ready_for_actionable_trades_research_only"
    tradeExecutionStatus = "blocked_no_authenticated_trade_execution_manual_approval_required"
    manualReviewBudgetUsd = 19
    minMidCents = $MinMidCents
    minMarketActivityUsd = $MinMarketActivityUsd
    pagesPulled = $pagesPulled
    maxPages = $MaxPages
    totalOpenMarketsPulled = $markets.Count
    cursorPresent = $cursorPresent
    emptyOrNoActivityMarkets = $emptyCount
    wideSpreadResearchOnlyMarkets = $wideSpreadCount
    excludedBelowMinValueMarkets = $belowMinCount
    excludedBelowMinActivityMarkets = $belowMinActivityCount
    watchlistCount = $watchlist.Count
    actionableTradeCount = 0
    manualApprovalQueueCount = $manualApprovalQueue.Count
    manualApprovalQueue = $manualApprovalQueue
    customHftSpreadQueueCount = $customHftSpreadQueue.Count
    customHftSpreadQueue = $customHftSpreadQueue
    watchlist = $watchlist
}

Write-Utf8NoBom -Path $OutputDataPath -Text ($payload | ConvertTo-Json -Depth 8)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Kalshi + Ko-fi Watchlist Revenue Report")
$lines.Add("")
$lines.Add("Generated: $generatedAt")
$lines.Add("")
$lines.Add("Status: current public-data manual-review candidates and outreach packet; no trades executed.")
$lines.Add("")
$lines.Add("## Boundary")
$lines.Add("")
$lines.Add("- This is not financial advice, investment advice, or a guarantee of profit.")
$lines.Add("- No Kalshi order was placed and no authenticated trading endpoint was used.")
$lines.Add("- No pooled capital, copy-trading, trade signals, or managed account offer.")
$lines.Add("- A market can become a trade candidate only after an independent probability estimate, max-loss budget, fee check, and manual review.")
$lines.Add("")
$lines.Add("## Sources")
$lines.Add("")
$lines.Add(('- Kalshi public homepage: `{0}`' -f $homepage))
$lines.Add(('- Kalshi public markets endpoint: `{0}`' -f $endpoint))
$lines.Add('- Kalshi docs: `https://docs.kalshi.com/api-reference/market/get-markets`')
$lines.Add('- Kalshi public data quick start: `https://docs.kalshi.com/getting_started/quick_start_market_data`')
$lines.Add('- Ko-fi support link from existing repo reports: `https://ko-fi.com/alexplace`')
$lines.Add("")
$lines.Add("## Snapshot")
$lines.Add("")
$lines.Add("| Metric | Value |")
$lines.Add("|---|---:|")
$lines.Add("| Open markets pulled | $($markets.Count) |")
$lines.Add("| Public pages pulled | $pagesPulled / $MaxPages |")
$lines.Add("| Cursor present | $($payload.cursorPresent) |")
$lines.Add("| Empty/no-activity markets | $emptyCount |")
$lines.Add("| Wide-spread research-only markets | $wideSpreadCount |")
$lines.Add("| Excluded below $MinMidCents-cent midpoint | $belowMinCount |")
$lines.Add(("| Excluded below `${0:N2}` visible activity | {1} |" -f $MinMarketActivityUsd, $belowMinActivityCount))
$lines.Add("| Watchlist rows emitted | $($watchlist.Count) |")
$lines.Add("| Manual-approval queue rows | $($manualApprovalQueue.Count) |")
$lines.Add("| Executable trade recommendations | 0 |")
$lines.Add("| Trade readiness | research only; not actionable-trade ready |")
$lines.Add("| Manual review budget requested | `$19` |")
$lines.Add("")
$lines.Add("## Right Now Answer")
$lines.Add("")
$lines.Add("Executable trades to make right now: **0**.")
$lines.Add("")
$lines.Add("Best current use of this data: manually review the top watchlist rows, open the market rules in Kalshi, and build an independent probability note before any trade decision. Tight spread and activity make a market worth reading first; they do not prove edge.")
$lines.Add("")
$lines.Add(("Filters applied: do not include market values below {0} cents of YES midpoint, and do not include markets below `${1:N2}` visible public activity." -f $MinMidCents, $MinMarketActivityUsd))
$lines.Add("")
$lines.Add("Profit range is gross per contract if buying YES at the displayed ask: maximum loss is the ask paid; maximum gross profit is `$1.00` minus the ask, before fees and slippage. Confidence is data-quality confidence only, not outcome probability.")
$lines.Add("")
$lines.Add("After loading more data: Lantern can emit a manual-approval queue, but it still cannot place live trades. A human must approve any account action after independent probability, rule, fee, slippage, and max-loss checks.")
$lines.Add("")
$lines.Add("Paper-ticket output: `data/kalshi/kalshi-paper-trade-tickets-latest.json`. Trade docs gate: `manifests/evidence/kalshi-api-docs-and-trade-gate-2026-05-29.md`.")
$lines.Add("")
$lines.Add("Spread course: custom HFT/spread-capture research is preserved. Wider spreads can be desirable for a maker strategy, but only after orderbook depth, queue position, fees, latency, and cancel/fill risk are modeled.")
$lines.Add("")
$lines.Add('## `$19` Manual Review Gate')
$lines.Add("")
$lines.Add("Lantern is ready to prepare a public-data watchlist and research packet. It is not ready to make actionable trades, place orders, manage funds, or recommend that the operator buy or sell a market.")
$lines.Add("")
$lines.Add("The `$19` lane is a manual-review budget marker only:")
$lines.Add("")
$lines.Add("- no authenticated Kalshi endpoint;")
$lines.Add("- no order placement;")
$lines.Add("- no automated execution;")
$lines.Add("- no claim of edge until independent probability, fees, spread, and max-loss notes exist;")
$lines.Add("- final trading decisions remain outside Lantern.")
$lines.Add("")
$lines.Add("## Manual-Approval Queue")
$lines.Add("")
$lines.Add("These rows are the closest thing to a trade queue after the deeper public-data load. They are not orders.")
$lines.Add("")
$lines.Add("| Rank | Ticker | Mid | Gross P/L | Data Conf. | Required Before Trade |")
$lines.Add("|---:|---|---:|---|---:|---|")
$queueRank = 0
foreach ($item in $manualApprovalQueue) {
    $queueRank += 1
    $mid = if ($null -eq $item.yesMid) { "--" } else { "{0:N3}" -f $item.yesMid }
    $lines.Add(("| {0} | `{1}` | {2} | {3} | {4}% | independent probability + human approval + max-loss budget |" -f $queueRank, $item.ticker, $mid, $item.grossProfitRange, $item.dataConfidenceScore))
}
$lines.Add("")
$lines.Add("## Custom HFT / Spread-Capture Research Queue")
$lines.Add("")
$lines.Add("This is the custom HFT direction: spread-aware, maker-style research. It is not live trading and it does not use account credentials.")
$lines.Add("")
$lines.Add("| Rank | Ticker | Mid | Spread | Activity | Gross P/L | Required Before Live |")
$lines.Add("|---:|---|---:|---:|---:|---|---|")
$hftRank = 0
foreach ($item in $customHftSpreadQueue) {
    $hftRank += 1
    $mid = if ($null -eq $item.yesMid) { "--" } else { "{0:N3}" -f $item.yesMid }
    $spread = if ($null -eq $item.spread) { "--" } else { "{0:N3}" -f $item.spread }
    $lines.Add(("| {0} | `{1}` | {2} | {3} | {4} | {5} | orderbook depth + fee model + latency sim + human approval |" -f $hftRank, $item.ticker, $mid, $spread, $item.visibleActivityUsd, $item.grossProfitRange))
}
$lines.Add("")
$lines.Add("## Top Watchlist")
$lines.Add("")
$lines.Add("| Rank | Ticker | Title | Mid | Spread | Gross P/L | Data Conf. | Activity | 24h Vol | OI | Close | Gate |")
$lines.Add("|---:|---|---|---:|---:|---|---:|---:|---:|---:|---|---|")
$rank = 0
foreach ($item in $watchlist) {
    $rank += 1
    $title = $item.title
    if ($title.Length -gt 96) { $title = $title.Substring(0, 93) + "..." }
    $title = $title.Replace("|", "/")
    $mid = if ($null -eq $item.yesMid) { "--" } else { "{0:N3}" -f $item.yesMid }
    $spread = if ($null -eq $item.spread) { "--" } else { "{0:N3}" -f $item.spread }
    $lines.Add(("| {0} | `{1}` | {2} | {3} | {4} | {5} | {6}% | {7} | {8} | {9} | {10} | no execution |" -f $rank, $item.ticker, $title, $mid, $spread, $item.grossProfitRange, $item.dataConfidenceScore, $item.visibleActivityUsd, $item.volume24h, $item.openInterest, $item.closeTime))
}
$lines.Add("")
$lines.Add("## Stats Model")
$lines.Add("")
$lines.Add('Model name: `liquidity_spread_watchlist_v0`.')
$lines.Add("")
$lines.Add("Inputs used:")
$lines.Add("")
$lines.Add("- YES bid / ask / midpoint.")
$lines.Add("- Bid-ask spread.")
$lines.Add("- 24h volume, total volume, liquidity, and open interest.")
$lines.Add("- Visible activity floor and custom HFT spread-capture queue.")
$lines.Add("- Days to close.")
$lines.Add("- Title clarity and combo-market penalty.")
$lines.Add("")
$lines.Add("What the model does:")
$lines.Add("")
$lines.Add("- ranks markets worth reading first;")
$lines.Add("- rejects empty no-activity markets from the top list;")
$lines.Add("- flags wide-spread markets as research-only;")
$lines.Add("- preserves the trading gate: no order without independent probability and bankroll limit.")
$lines.Add("")
$lines.Add("What the model does not do:")
$lines.Add("")
$lines.Add("- it does not estimate true probability;")
$lines.Add("- it does not predict profit;")
$lines.Add("- it does not place trades;")
$lines.Add("- it does not sell trade signals.")
$lines.Add("")
$lines.Add("## Ko-fi Revenue Lane")
$lines.Add("")
$lines.Add("Use Ko-fi for support and paid research operations, not trade pooling.")
$lines.Add("")
$lines.Add("| Offer | Price | Deliverable | Boundary |")
$lines.Add("|---|---:|---|---|")
$lines.Add('| Public supporter note | `$5` | Early watchlist snapshot and methodology note | no trade signals |')
$lines.Add('| Founder/support tester | `$20` | Weekly public-data market watchlist plus Lantern setup support | no managed money |')
$lines.Add('| Custom stats cleanup sprint | `$99-$299` | One repo/data/source cleanup plus a reproducible report | no investment advice |')
$lines.Add("")
$lines.Add("## Outreach Copy")
$lines.Add("")
$lines.Add("Short Ko-fi post:")
$lines.Add("")
$lines.Add("> I pulled a live Kalshi public-market snapshot and turned it into a no-hype watchlist report: liquidity, spreads, close dates, and model gates. No trade signals, no pooled money, no guaranteed profit. If you want more open-source local-first stats tooling like this, support Lantern OS here: https://ko-fi.com/alexplace")
$lines.Add("")
$lines.Add("Warm DM:")
$lines.Add("")
$lines.Add('> I am testing a Lantern OS stats workflow: public Kalshi markets in, clean watchlist/report out. It ranks what is worth researching and blocks actual trade claims until independent probability work is done. If that kind of transparent AI/data tool is useful, I have a `$20` support lane on Ko-fi: https://ko-fi.com/alexplace')
$lines.Add("")
$lines.Add("## Next Manual Actions")
$lines.Add("")
$lines.Add("1. Review the top 20 watchlist rows manually in Kalshi UI.")
$lines.Add("2. Choose 3 markets with clear rules and real liquidity.")
$lines.Add("3. Build independent probability notes for those 3 markets from public sources.")
$lines.Add("4. If any edge exists after fees and spread, record a max-loss budget before any trade.")
$lines.Add("5. Publish the Ko-fi support note as a support/product update, not a trading advice post.")

Write-Utf8NoBom -Path $OutputReportPath -Text ($lines -join "`n")

[ordered]@{
    ok = $true
    generatedAt = $generatedAt
    marketsPulled = $markets.Count
    pagesPulled = $pagesPulled
    watchlistCount = $watchlist.Count
    actionableTradeCount = 0
    manualApprovalQueueCount = $manualApprovalQueue.Count
    dataPath = $OutputDataPath
    reportPath = $OutputReportPath
} | ConvertTo-Json -Depth 4
