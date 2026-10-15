### Added

- exit_intent rows carry ref_px, the quote the exit was decided on (closeLong's refPrice; the signal's price on a signal exit), so exit slippage can be scored against the fill the way entry slippage is scored from quote_px vs fill_px
