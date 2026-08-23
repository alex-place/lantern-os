### Changed

- Live brakes the lab never carried: TRADER_STOP_BREAKER=2 and TRADER_MAX_DAILY_LOSS_PCT=2 each fail the fit surfaces; with the 80% gross cap the three together cut the armed stack's 26y holdout from 2,866% to 754% and the recent year from 44.6% to 39.6% at near-identical max DD (they remove paydays, not risk). Fix: TRADER_MAX_DAILY_LOSS_PCT<=0 now disables the halt (0 previously made the limit 0 and halted on any red day)
