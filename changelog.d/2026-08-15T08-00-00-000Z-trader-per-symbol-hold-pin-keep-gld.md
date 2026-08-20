### Added

- trader: per-symbol HOLD pin (#3318) — "keep GLD" is now expressible. A pinned symbol keeps every protective mechanism (stop, ladder banking, breaker) but signal-derived exits (`signal_exit`, `momentum_died`) are suppressed with an honest skip row. Pins come from `TRADER_PIN=SYM1,SYM2` and a hot-reloaded `pins.json` beside the trade ledger (2s cache) — pinning works mid-session with no restart. On 2026-08-14 the operator kept GLD as the carry and the engine signal-exited it nine minutes in; that is no longer possible silently
