### Changed
- **Overnight book: levered execution** (`OVERNIGHT_EXEC=1x|2x|3x`) — same measured
  signals, levered-ETF execution (SSO/QLD at 2x; UPRO/TQQQ/TNA/SPXS at 3x). Backtested
  2010–2026 via the shipped gates: 3x = 29.3% CAGR / Sharpe 1.24 / maxDD 26.3% vs SPY
  12.2%/0.76/34.1% — and more cost-robust than 1x (edge scales, slippage doesn't).
  Synthetic margin financing measured worse than the levered ETFs at every tier.
  Direction-lock covers all execution instruments; ledger records signal + exec symbol.
### Added
- **Options paper-trading bridge** (`OPTIONS_PAPER=1`, default off): the options
  shadow's nightly tickets (ladder + penny calls) are mirrored as REAL Alpaca paper
  option orders (limit-at-ask entries, marketable-limit exits, entry-fill lookup on
  close) so the expectancy ledger gains broker-verified fills. Hard-gated to the
  paper host — live auth is refused in code. Verified end-to-end: order accepted +
  canceled on account PA3KZEWVVZTP (options level 3).
- `scripts/overnight-leverage-backtest.js` + `scripts/overnight-book-backtest.js` —
  drive the production engine's own exported gates; no re-implementation drift.
