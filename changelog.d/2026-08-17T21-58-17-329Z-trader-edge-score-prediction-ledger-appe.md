### Added

- Trader edge score: prediction ledger (append-only JSONL) + replayable settlement from archived bars (no look-ahead) + calibration (Brier, Brier skill score, equal-count decile hit-rates, reliability table). lib/edge-score-ledger.js, 12 tests. The launch gate for any user-facing score (#3259).
