### Changed

- trading/strategy: **retuned the day-trader toward its measured edge.** Walk-forward
  backtests (real signal engine, no-lookahead, ~1mo 15m bars) showed the mean-reversion
  engine is **negative-expectancy on high-beta single stocks** (META/NVDA/AAPL basket: 26%
  win, avg −0.26R, PF 0.65) but **positive on liquid + leveraged/inverse ETFs at a tight
  target** (leveraged/inverse basket, longs-only: 55% win, +0.07R, PF 1.17). Three changes:
  1. **Default universe → ETFs.** `data/lantern-garage/trading/watchlist.seed.json` and the
     `watchlist-store` hardcoded fallback now seed liquid broad ETFs + high-vol leveraged/
     inverse ETFs (SPY/QQQ/IWM/DIA/GLD/TLT/SMH/XLK + TQQQ/SQQQ/SOXL/SOXS/SPXL/SPXS/TNA/TZA)
     instead of single stocks + crypto. Existing users' saved watchlists are untouched.
  2. **Trend/regime entry filter** (`scan.js`, `TRADER_REGIME_FILTER`, on by default): a
     BULLISH entry is only taken when the name is trend-aligned — price above its SMA-50
     (15m) AND MACD histogram positive. Stops the engine catching falling knives (buying
     dips in a downtrend), which is where the single-stock edge was destroyed. Fail-open on
     thin history.
  3. **R-multiple take-profit** (`auto-trader.js`, `TRADER_TAKE_PROFIT_R`, default **1**):
     exit a long at +1R (= `stopPct`). This engine's winners don't run — a 1R target beat
     2R/3R on every basket in the sweep — so gains are banked instead of round-tripped.
  All env-overridable. Covered by new tests in `auto-trader-trailing.test.js` (a +1R long
  is banked, a <1R long is held). Note: this is a backtest-grounded improvement on a **thin
  ~1mo sample** (leveraged-ETF decay unmodeled, single regime) — a real but modest edge
  (PF 1.17), pending out-of-sample validation, not a proven money-maker.
