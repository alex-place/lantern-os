### Added
- **Σ₀ weather-edge: ask-based half-Kelly sizing + 5-gate risk engine** (`lib/kalshi-kelly.js`).
  Turns the band-robust fair value into a *sized* paper order: fractional Kelly computed
  against the real executable ask (net of fees), behind five pre-trade gates —
  edge, price-band, liquidity (spread + 24h volume), concentration, and a drawdown
  breaker. Distilled from the 2026-07 open-source Kalshi-bot review (OctagonAI 5-gate,
  Viprasol risk manager, ryanfrigo fractional Kelly); fixes their common flaw of sizing
  against a mid/model price instead of the price you pay.
- **Σ₀ forecast calibration loop** (`lib/kalshi-calibration.js`). Grades the model's
  win-probabilities against settled NWS outcomes from the paper ledger, computes Brier +
  bias, and feeds a clamped logit correction back into sizing. Degrades to identity
  (no-op) under 20 settled trades — the honest under-sample behavior. Closes the one gap
  the entire open-source weather-bot field shares (emit a probability, never grade it).

### Changed
- `lib/kalshi-weather-edge-deck.js` now applies the calibrator to each card's win-prob
  and attaches a `sizing` block (contracts, stake, gate audit, Kelly fraction) plus a
  `pPredicted` stamp so resolved trades feed the calibration loop. Deck payload gains
  `sizedCards` and a `calibration` summary. Still PAPER-only; live trading stays paused.
