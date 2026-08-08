### Changed

- **trader: defaults reconfigured to the two-window optimum (14% × 6).** A
  portfolio-replay scaling sweep of the deployed ladder config (IBS ≤ 0.15, 5%
  floor, 3:1, R2 trail, 3 bp costs, 8 unleveraged watchlist ETFs) found the
  concurrency cap — not position size — is where the strategy scales: at cap 4
  the replay skipped 26% (fit 2000–14) / 31% (holdout 2015–26) of entries
  because washouts cluster on exactly the highest-signal days. New defaults:
  `TRADER_MAX_CONCURRENT` 2→6, `TRADER_MAX_POSITION_PCT` 5→14 (guard fallback
  in trading-guard.js moved in lockstep), `TRADER_RISK_PCT` 0.06→0.7 (= 14%
  notional at the 5% stop floor), `TRADER_STOP_MIN_PCT` 3→5 and
  `TRADER_R2_TRAIL` on by default (both already the deployed session config),
  `TRADER_MAX_GROSS_PCT` 80→85 so the 84% max gross of the optimum never trips
  the cash brake. Sweep evidence, fit | holdout: 14%×6 returns 14.8%/yr Sharpe
  1.47 maxDD 12.4% | 15.3%/yr Sharpe 1.87 maxDD 8.6%, vs 7%×4 at 5.0%/1.30 |
  4.9%/1.69 — better in BOTH windows on return AND Sharpe, no margin (max gross
  84%). Every knob remains env-overridable; per-user autopilot stays off by
  default and unchanged.
