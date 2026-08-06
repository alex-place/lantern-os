### Added

- backtest: `experiments/signal_audit.js` — splits 26y of daily bars on every component the signal engine boosts or filters on. Result: every momentum/confirmation component is *inverted*; the only informative one is RSI oversold.
- backtest: `BT_MEANREV=1` — mean-reversion-first entry (RSI oversold, no confirmation stack), exits unchanged. OOS total R +192% and avg R +118% vs the current entry, better on all 5 symbols.
