# ForecastEx UHLGA day-ahead backtest + nightly forward paper-verification (#2217)

- `apps/lantern-garage/lib/forecastex-dayahead.js` — pure shared core: board→ladder
  (gap-folding, open tails), cumulative-difference asks, settlement-interval grading
  (clean flip or bound-decided buckets only — never guessed), card P&L net of the flat fee.
- `scripts/backtest-forecastex-dayahead.js` — retrospective DAY-AHEAD replay of the venue's
  public prices history: contract date D scored with the D-1 EOD board + D-1 MOS run
  (lead 1). Emits per-day JSONL + summary under `data/eval/`.
- `apps/lantern-garage/lib/forecastex-paper-verify.js` — nightly forward job (opt-in
  `FORECASTEX_PAPER_VERIFY=1`, one fleet host): stamps tomorrow's prediction after the EOD
  file publishes, closes settled days from the venue's own flips, accrues RPS/PIT + edge
  P&L; `certifiedEdge` gated on n≥20 settled days, n≥20 settled cards, net P&L > 0.
- `kalshi-weather-verify.gradedRecords` gains a ticker-prefix scope (default unchanged)
  so the same verifier grades the UHLGA paper ledger.
- `.github/workflows/forecastex-backtest.yml` — manual-dispatch measurement runner
  (egress) that commits results back to the dispatching branch.
- server wiring in the market-loops block; 15 new tests.
