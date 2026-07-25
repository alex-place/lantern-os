# TEST B pull: trades for the cross-category liquid series, to test the MECHANISM.
#
# The maker-edge candidate came with a stated mechanism — thin volume -> less market-maker
# competition -> wider spreads -> liquidity provision pays. That predicts maker edge scales
# INVERSELY WITH VOLUME across every category, which is a far stronger test than replicating
# one market type. This pulls the breadth needed to regress edge on log(volume).
#
# Depth is deliberately small (30 markets/series): the mechanism test needs MANY SERIES, not
# many markets per series.
#
# Read-only public market data. Places no orders.
# Run:  powershell -ExecutionPolicy Bypass -File scripts/kalshi_pull_mechanism_sample.ps1

$ErrorActionPreference = "Stop"
$base    = "https://api.elections.kalshi.com/trade-api/v2"
$outDir  = "data/kalshi/mechanism"
$maxMkts = 30
$maxPage = 6
$sleepMs = 120

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-Json($url) {
  for ($i = 1; $i -le 3; $i++) {
    try { return Invoke-RestMethod $url -TimeoutSec 35 }
    catch { if ($i -eq 3) { return $null }; Start-Sleep -Milliseconds (400 * $i) }
  }
}

$series = Get-Content "data/kalshi/liquid_series.jsonl" -Encoding utf8 |
          Where-Object { $_.Trim() } | ForEach-Object { ($_ | ConvertFrom-Json).series }

foreach ($s in $series) {
  $mktPath = Join-Path $outDir "$s.markets.jsonl"
  $trdPath = Join-Path $outDir "$s.trades.jsonl"
  if ((Test-Path $trdPath) -and ((Get-Item $trdPath).Length -gt 0)) { continue }

  $r = Get-Json "$base/markets?limit=100&status=settled&series_ticker=$s"
  if (-not $r -or -not $r.markets) { continue }
  $markets = $r.markets | Select-Object -First $maxMkts
  $markets | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 6 } | Set-Content $mktPath -Encoding utf8

  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($m in $markets) {
    $tk = $m.ticker; $cur = $null; $pages = 0
    while ($pages -lt $maxPage) {
      $u = "$base/markets/trades?ticker=$tk&limit=1000"
      if ($cur) { $u = "$u&cursor=$cur" }
      $t = Get-Json $u
      if (-not $t -or -not $t.trades -or $t.trades.Count -eq 0) { break }
      foreach ($tr in $t.trades) { $lines.Add(($tr | ConvertTo-Json -Compress -Depth 4)) }
      $pages++; $cur = $t.cursor
      if (-not $cur) { break }
      Start-Sleep -Milliseconds $sleepMs
    }
    Start-Sleep -Milliseconds $sleepMs
  }
  Set-Content -Path $trdPath -Value $lines -Encoding utf8
  Write-Output "$s : $($markets.Count) markets, $($lines.Count) trades"
}
Write-Output "DONE"
