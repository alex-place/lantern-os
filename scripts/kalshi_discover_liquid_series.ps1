# Discover which Kalshi series actually have SETTLED, LIQUID markets — across all categories.
#
# WHY: the maker-edge candidate was found by testing THREE series out of 12,184. That is not a
# survey, it is an anecdote. The stated mechanism — thin volume -> less market-maker competition
# -> wider spreads -> liquidity provision pays — predicts maker edge should scale INVERSELY WITH
# VOLUME across every category. That is a far stronger test than replicating weather six times,
# and it needs a real cross-category sample.
#
# Read-only public market data. Places no orders.
# Run:  powershell -ExecutionPolicy Bypass -File scripts/kalshi_discover_liquid_series.ps1

$ErrorActionPreference = "Stop"
$base = "https://api.elections.kalshi.com/trade-api/v2"
$out  = "data/kalshi/liquid_series.jsonl"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Remove-Item $out -ErrorAction SilentlyContinue

function Get-Json($url) {
  for ($i = 1; $i -le 3; $i++) {
    try { return Invoke-RestMethod $url -TimeoutSec 35 }
    catch { if ($i -eq 3) { return $null }; Start-Sleep -Milliseconds (400 * $i) }
  }
}

# 1. pull the series catalogue, bucketed by category
$all = @{}
$cursor = $null; $pages = 0
while ($pages -lt 12) {
  $u = "$base/series?limit=1000"
  if ($cursor) { $u = "$u&cursor=$cursor" }
  $r = Get-Json $u
  if (-not $r -or -not $r.series) { break }
  foreach ($s in $r.series) {
    $c = $s.category
    if (-not $c) { $c = "Uncategorized" }
    if (-not $all.ContainsKey($c)) { $all[$c] = New-Object System.Collections.Generic.List[string] }
    $all[$c].Add($s.ticker)
  }
  $cursor = $r.cursor; $pages++
  if (-not $cursor) { break }
  Start-Sleep -Milliseconds 120
}
Write-Output "catalogue: $(($all.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum) series in $($all.Keys.Count) categories"

# 2. probe series per category for SETTLED markets with real volume
$probePerCat = 45     # how many series to probe per category
$keepPerCat  = 4      # how many liquid ones to keep per category
$lines = New-Object System.Collections.Generic.List[string]

foreach ($cat in ($all.Keys | Sort-Object)) {
  $kept = 0; $probed = 0
  # probe in random order so we do not systematically sample alphabetically-early series
  foreach ($tk in ($all[$cat] | Get-Random -Count ([Math]::Min($probePerCat, $all[$cat].Count)))) {
    if ($kept -ge $keepPerCat) { break }
    $probed++
    $m = Get-Json "$base/markets?limit=50&status=settled&series_ticker=$tk"
    if (-not $m -or -not $m.markets -or $m.markets.Count -lt 8) { Start-Sleep -Milliseconds 90; continue }
    $vols = @($m.markets | ForEach-Object { [double]$_.volume_fp } | Where-Object { $_ -gt 0 })
    if ($vols.Count -lt 8) { Start-Sleep -Milliseconds 90; continue }
    $sorted = $vols | Sort-Object
    $med = $sorted[[int]($sorted.Count / 2)]
    if ($med -lt 500) { Start-Sleep -Milliseconds 90; continue }   # need some real trading
    $rec = [pscustomobject]@{
      series = $tk; category = $cat; settled_n = $m.markets.Count
      median_volume = [math]::Round($med, 0)
    }
    $lines.Add(($rec | ConvertTo-Json -Compress))
    $kept++
    Write-Output ("  {0,-24} {1,-24} n={2,-4} medVol={3,10:N0}" -f $cat, $tk, $m.markets.Count, $med)
    Start-Sleep -Milliseconds 110
  }
}
Set-Content -Path $out -Value $lines -Encoding utf8
Write-Output "kept $($lines.Count) liquid settled series -> $out"
