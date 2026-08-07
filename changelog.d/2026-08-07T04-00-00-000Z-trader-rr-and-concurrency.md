### Added

- trader: `TRADER_STOP_FROM_TGT` (default 3) derives the stop from the target — stop = (distance to first real resistance) / n — so reward:risk is n:1 by construction instead of an accident of zone geometry. Holdout: +0.378%/trade vs +0.334%; 2:1/3:1/4:1 all beat off in both windows.
- trader: `TRADER_MAX_CONCURRENT` (default 2) caps simultaneous open positions. Portfolio replay showed every worst day pinned at exactly −9.00% = 3 positions × the 3% stop floor; cap 2 cuts days worse than −5% by 15% with average %/trade slightly better. It truncates severity, not frequency — the negative-day rate is 59–60% at every cap including off.
