### Added

- signals: `RILEY_GATE=0` stops rileyGate vetoing trades. Measured over 31,293 daily bars it discards ~46% of candidates and the survivors have *lower* forward returns than the pool it selected from. Removing the veto improved the backtest in both fit and holdout, on both total R and avg R, across all 5 symbols. Default unchanged (gate still vetoes) pending live measurement.
- backtest: `BT_NO_GATE=1`, and `experiments/entry_edge_test.js` — measures whether each stage of the entry stack beats the unconditional base rate.
