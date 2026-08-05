### Added

- trader: skip reasons are now logged to the trade ledger (deduped — one row per symbol per distinct blocker). A session where the trader declines everything now leaves a record of why.
- signals: opt-in `ZONE_TREND_DIR=1` stops the direction primitive calling a confirmed uptrend BEARISH just because there is overhead resistance. Holdout total R +35-38%; fit is break-even at ~3bp costs. Default OFF pending live measurement.
- backtest: `BT_COST` charges round-trip transaction costs, so changes that trade more no longer get trade count for free.

### Fixed

- backtest: a momentum entry used a hardcoded 60-day hold, monopolising a symbol and displacing zone trades. Now `BT_MOMO_HOLD`. Momentum mode was re-gated at every hold length and FAILED — it is not shipped.
