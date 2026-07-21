# Fetch daily adjclose from Yahoo for a list of tickers -> prices/<ticker>.csv
# Bash sandbox has no network; PowerShell does. Records coverage to coverage_yahoo.json
$ErrorActionPreference = "Stop"
$root = "D:\tmp\claude\C--dev-lantern-os--claude-worktrees-arxiv-corpus-pdfs-verify-daca06\c6a0427a-93e4-405f-a62a-a9c4eda627c8\scratchpad\survivorship"
$pdir = Join-Path $root "prices"
New-Item -ItemType Directory -Force -Path $pdir | Out-Null

# Point-in-time "ever-member" universe (deliberately includes delisted/acquired)
$pit = @("AAPL","MSFT","XOM","GE","C","INTC","CSCO","AIG","ENRNQ","WCOM","LEHMQ","BSC","MER","EKDKQ","MTLQQ","NRTLQ","CCTYQ","WNDXQ","RSHCQ","SUNEQ","CFC","GDW","WB","NCC","SOV","ABK","FNM","FRE","BUD","WYE","SGP","MEDI","GENZ","Q","DYN","NOVL","COMS","OMX","TLAB","KATE","SLE","TYC","DJ","BOL","ANDW","BMET","GLK","YHOO","BBBY","JCP")
# Hand-picked-winners universe (survivorship-biased comparison set)
$winners = @("SPY","QQQ","IWM","EFA","TLT","GLD","XMMO","SPMO","AAPL","MSFT","AMZN","NVDA","JPM","COST","HD","NFLX","GOOGL","AMD","AVGO","XLE")

$all = ($pit + $winners) | Select-Object -Unique
$p1 = [int][double]::Parse((Get-Date "1998-01-01Z" -UFormat %s))
$p2 = [int][double]::Parse((Get-Date -UFormat %s))
$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (UnisonaSim)"

$cov = @{}
foreach ($sym in $all) {
  $ok = $false; $npts = 0; $first = ""; $last = ""; $err = ""
  foreach ($qh in @("query1","query2")) {
    try {
      $url = "https://$qh.finance.yahoo.com/v8/finance/chart/$sym`?interval=1d&period1=$p1&period2=$p2"
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 40 -Headers @{ "User-Agent"=$ua }
      $j = $r.Content | ConvertFrom-Json
      $res = $j.chart.result[0]
      if ($null -eq $res -or $null -eq $res.timestamp) { $err = "no-data"; continue }
      $ts = $res.timestamp
      $adj = $res.indicators.adjclose[0].adjclose
      $sb = New-Object System.Text.StringBuilder
      [void]$sb.AppendLine("date,adjclose")
      for ($i=0; $i -lt $ts.Count; $i++) {
        if ($null -ne $adj[$i]) {
          $d = [DateTimeOffset]::FromUnixTimeSeconds([int64]$ts[$i]).ToString("yyyy-MM-dd")
          [void]$sb.AppendLine("$d,$($adj[$i])")
          $npts++
          if ($first -eq "") { $first = $d }
          $last = $d
        }
      }
      if ($npts -gt 0) {
        [System.IO.File]::WriteAllText((Join-Path $pdir "$sym.csv"), $sb.ToString())
        $ok = $true
      } else { $err = "empty" }
      break
    } catch {
      $err = $_.Exception.Message
    }
  }
  $cov[$sym] = @{ ok=$ok; n=$npts; first=$first; last=$last; err=$err }
  $tag = if ($ok) { "OK   n=$npts $first..$last" } else { "FAIL $err" }
  Write-Output ("{0,-7} {1}" -f $sym, $tag)
  Start-Sleep -Milliseconds 250
}
$cov | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $root "coverage_yahoo.json")
$okc = ($cov.Values | Where-Object { $_.ok }).Count
Write-Output "=== Yahoo coverage: $okc / $($all.Count) tickers ==="