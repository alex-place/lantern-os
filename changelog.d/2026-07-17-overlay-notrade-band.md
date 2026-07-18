### Added
- **No-trade band on the daily brake overlay** (`experiments/leverage_daily_overlay.py` `run_daily(band=, band_mode=)`)
  + measurement harness (`experiments/overlay_notrade_band.py`) — tests the control-engineering
  tranche's transaction-cost band claim (arXiv:1303.3148 / 1306.2802) on our own overlay. `band=0`
  is the legacy every-day-retrade behavior (unchanged); `band>0` holds yesterday's exposure until
  the L1 drift to target exceeds the band.

### Measured (experiments/results/overlay_notrade_band.json, $25k lump, net of 2bp turnover)
- The overlay *does* over-trade on daily vol-target noise, and a **symmetric ±~6% no-trade band
  recovers it**: full-2000+ +$5.4k on $225k final (+2.4%), CAGR 8.7→8.8%, Sharpe 0.64, maxDD
  −45→−46% (flat); out-of-sample 2013+ +$3.1k on $122k (+2.5%), Sharpe 0.88→0.90, maxDD −27% (flat),
  turnover cut ~15–25%. Free money — same-or-better risk for less trading — but **cost hygiene, not
  alpha**: the band adds ~0.15pp CAGR, it does NOT close the overlay's bull-market gap to SPY (2013+
  12.5% vs SPY 14.7%).
- **Correction of a design assumption:** the `brake_aware` mode (never band a de-risking move) was
  expected to protect the drawdown brake — but plain `sym` beats it. Real brake/trend cuts are large
  enough to clear any sane band and execute anyway, so a symmetric band only suppresses noise nudges;
  the extra machinery isn't needed.
- The buy-only $20/mo Advisor DCA engine (`dca_walkforward_sim.py`) has **no rebalance churn to fix**
  (it only deploys new cash, never sells to target, $0 commissions) — it already sidesteps the drag.
