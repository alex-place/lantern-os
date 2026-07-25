# Fresh OUT-OF-SAMPLE weather pull for the maker-edge candidate.
#
# The candidate was discovered on KXHIGHNY (New York). These are SIX OTHER CITIES — genuinely
# independent markets driven by the same proposed mechanism (thin volume -> less market-maker
# competition -> wider spreads -> liquidity provision pays). Passing here is cross-sectional
# out-of-sample evidence; failing here kills the candidate.
#
# NY is deliberately NOT re-pulled: it is the discovery set and must stay in-sample.
#
# Public market-data endpoints, READ ONLY. Places no orders.
# Run:  powershell -ExecutionPolicy Bypass -File scripts/kalshi_pull_weather_oos.ps1

$ErrorActionPreference = "Stop"
$base    = "https://api.elections.kalshi.com/trade-api/v2"
$outDir  = "data/kalshi/settled"
$series  = @("KXHIGHCHI","KXHIGHLAX","KXHIGHMIA","KXHIGHDEN","KXHIGHAUS","KXHIGHPHIL")
$maxMkts = 60
$maxPage = 12
$sleepMs = 130

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-Json($url) {
  for ($try = 1; $try -le 3; $try++) {
    try { return Invoke-RestMethod $url -TimeoutSec 40 }
    catch { if ($try -eq 3) { throw }; Start-Sleep -Milliseconds (500 * $try) }
  }
}

foreach ($s in $series) {
  $mktPath = Join-Path $outDir "$s.markets.jsonl"
  $trdPath = Join-Path $outDir "$s.trades.jsonl"
  Remove-Item $mktPath, $trdPath -ErrorAction SilentlyContinue

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

  $tradeLines = New-Object System.Collections.Generic.List[string]
  $done = 0
  foreach ($m in $markets) {
    $tk = $m.ticker; $cur = $null; $pages = 0
    while ($pages -lt $maxPage) {
      $u = "$base/markets/trades?ticker=$tk&limit=1000"
      if ($cur) { $u = "$u&cursor=$cur" }
      try { $t = Get-Json $u } catch { break }
      if (-not $t.trades -or $t.trades.Count -eq 0) { break }
      foreach ($tr in $t.trades) { $tradeLines.Add(($tr | ConvertTo-Json -Compress -Depth 4)) }
      $pages++; $cur = $t.cursor
      if (-not $cur) { break }
      Start-Sleep -Milliseconds $sleepMs
    }
    $done++
    Start-Sleep -Milliseconds $sleepMs
  }
  Set-Content -Path $trdPath -Value $tradeLines -Encoding utf8
  Write-Output "$s : $($markets.Count) markets, $($tradeLines.Count) trades"
}
Write-Output "DONE"
