# ForecastEx UHLGA day-ahead backtest results + degenerate-price guard (#2217)

- Ran `scripts/backtest-forecastex-dayahead.js` on a CI runner (`forecastex-backtest.yml`);
  results committed to `data/eval/forecastex-klga-dayahead-backtest*.{jsonl,json}`.
- **Verdict: no robust edge certified; `certified` stays false.** Available day-ahead boards are
  2026-02-12 → 2026-04-20 only (out-of-season for the summer-fit oracle); ceiling untested (max
  87°F). 92% of the raw +64.41¢ P&L is a non-fillable degenerate-0/1-close artifact; the tradeable
  remainder (n=17, +4.48¢) is below the n≥20 floor and still fill-at-close.
- Oracle distribution is well-calibrated even out-of-season (ladder RPS 0.153 < climatology 0.168,
  PIT χ²ᵣ 1.79, beats the venue board 39/55).
- Hardened `forecastex-paper-verify`: certifies on TRADEABLE cards only (ask ∈ (0.02, 0.98)); the
  backtest summary reports the same split; `lib/forecastex-dayahead` flags `card.tradeable`.
- +2 regression tests (degenerate-close proof); 17 tests total across the two suites.
- Research note: `docs/research/2026-07-10-forecastex-klga-dayahead-backtest.md`.
