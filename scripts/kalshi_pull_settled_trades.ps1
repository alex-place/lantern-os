# Pull SETTLED Kalshi markets + their real executed trade history.
#
# Fixes every data gap that made the KXMLBGAME pilot a pilot:
#   - settlement ground truth   : status=settled markets carry `result` (yes/no)
#   - REAL fills, not quotes    : /markets/trades gives executed prices
#   - trade DIRECTION truth     : each trade carries `taker_side` — the very thing the Polymarket
#                                 microstructure result (arXiv:2604.24366) says an order-book feed
#                                 cannot supply (~59% accuracy). Kalshi publishes it, which makes
#                                 the maker/adverse-selection test possible for the first time.
#   - temporal out-of-sample    : settled markets span real calendar time
#   - breadth                   : several series, not one class
#
# Public market-data endpoints — no auth, no credentials, READ ONLY. Places no orders.
# Bash has no egress in this sandbox, hence PowerShell.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts/kalshi_pull_settled_trades.ps1

$ErrorActionPreference = "Stop"
$base    = "https://api.elections.kalshi.com/trade-api/v2"
$outDir  = "data/kalshi/settled"
$series  = @("KXMLBGAME", "KXBTC15M", "KXHIGHNY")
$maxMkts = 60      # settled markets per series
$maxPage = 12      # trade pages per market (1000/page) — bounds the pull, logged if hit
$sleepMs = 130     # be polite to the API

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-Json($url) {
  for ($try = 1; $try -le 3; $try++) {
    try { return Invoke-RestMethod $url -TimeoutSec 40 }
    catch {
      if ($try -eq 3) { throw }
      Start-Sleep -Milliseconds (500 * $try)
    }
  }
}

foreach ($s in $series) {
  $mktPath = Join-Path $outDir "$s.markets.jsonl"
  $trdPath = Join-Path $outDir "$s.trades.jsonl"
  Remove-Item $mktPath, $trdPath -ErrorAction SilentlyContinue

  # ---- settled markets (paginated) ----
  $markets = @(); $cursor = $null
  while ($markets.Count -lt $maxMkts) {
    $u = "$base/markets?limit=100&status=settled&series_ticker=$s"
    if ($cursor) { $u = "$u&cursor=$cursor" }
    $r = Get-Json $u
    if (-not $r.markets -or $r.markets.Count -eq 0) { break }
    $markets += $r.markets
    $cursor = $r.cursor
    if (-not $cursor) { break }
    Start-Sleep -Milliseconds $sleepMs
  }
  $markets = $markets | Select-Object -First $maxMkts
  $markets | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 } | Set-Content $mktPath -Encoding utf8
  Write-Output "$s : $($markets.Count) settled markets -> $mktPath"

  # ---- executed trades per market (paginated) ----
  $tradeLines = New-Object System.Collections.Generic.List[string]
  $done = 0; $truncated = 0
  foreach ($m in $markets) {
    $tk = $m.ticker; $cur = $null; $pages = 0
    while ($pages -lt $maxPage) {
      $u = "$base/markets/trades?ticker=$tk&limit=1000"
      if ($cur) { $u = "$u&cursor=$cur" }
      try { $t = Get-Json $u } catch { break }
      if (-not $t.trades -or $t.trades.Count -eq 0) { break }
      foreach ($tr in $t.trades) { $tradeLines.Add(($tr | ConvertTo-Json -Compress -Depth 4)) }
      $pages++
      $cur = $t.cursor
      if (-not $cur) { break }
      Start-Sleep -Milliseconds $sleepMs
    }
    if ($pages -ge $maxPage) { $truncated++ }
    $done++
    if ($done % 15 -eq 0) { Write-Output "   trades: $done/$($markets.Count) markets, $($tradeLines.Count) trades" }
    Start-Sleep -Milliseconds $sleepMs
  }
  Set-Content -Path $trdPath -Value $tradeLines -Encoding utf8
  Write-Output "$s : $($tradeLines.Count) trades -> $trdPath  (page-capped markets: $truncated)"
}
Write-Output "DONE"
