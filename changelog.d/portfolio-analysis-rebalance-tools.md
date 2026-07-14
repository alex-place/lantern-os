### Added

- Portfolio analytics for the one assistant (Reason stage): three new chat tools apply
  the UNISONA-SHARPE-CERTIFICATE math to the operator's **actual** broker holdings.
  `portfolio_analysis` measures current weights, per-holding + whole-portfolio
  annualized Sharpe with Lo (2002) 95% CIs, volatility, worst drawdown, the pairwise
  correlation matrix, and concentration (effective N / largest position).
  `portfolio_whatif` (guest-safe, public data only) scores any user-proposed weight
  allocation on the same evidence so "what if I went 60/20/20?" gets a measured
  answer instead of a vibe. `propose_rebalance` computes a shrunk-tangency
  (w ∝ Σ⁻¹μ, long-only, per-position cap) rebalance PROPOSAL over the existing
  holdings only, with current-vs-proposed CIs, an explicit statistically-
  indistinguishable verdict when the bands overlap, and a dry-run whole-share order
  list — it never suggests new purchases and never places orders (Act stays behind
  `lib/trading-guard.js` / ADR-0020). Engine: `lib/portfolio-analytics.js`, same
  Yahoo adjclose total-return source and Sharpe/CI formulas as
  `scripts/daily-backtest-harness.js` (live outputs cross-checked against the
  2026-07-10 leaderboard: SPY 0.88, GLD 0.74, SPY–GLD ρ 0.10). Offline unit suite:
  `npm run test:portfolio --prefix apps/lantern-garage`.
