### Changed
- **Kalshi decks no longer surface crypto cards.** Removed the `kalshi-crypto-suggester`
  merge from both `paper-deck` and `decisive-deck` — the realized-PnL backtest showed no
  taker edge on short-window crypto after fees (kalshi-no-taker-edge). LIVE mode was
  already weather-edge-only (`grounded-deck`); this makes PAPER match. The only profitable
  arm remains the Σ₀ weather edge. (The standalone `crypto-intraday` endpoint is untouched;
  it is not polled by the terminal.)
