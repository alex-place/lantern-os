### Changed
- trading: `lib/auto-trader.js` slimmed with no behaviour change — the long dated history comments (153 blocks, ~1,500 lines) moved verbatim to `docs/auto-trader-history.md`; each rule keeps a short what/why comment in the code ending with its history id (`(H38)`). Verified token-identical (comments are the only change) and by the full trader test set.
