### Changed

- trader: restrict IBS entries to 1x instruments. Over 16 years / 7,228 trades the IBS edge is in 1x ETFs (+467.6R, 7/7 profitable) while 3x wrappers contributed -319.5R across 4,308 trades — 0/4 inverse profitable in ANY regime, and SOXL (3x long) fails too, so leverage (not direction) is the discriminator. auto-trader.js now blocks NEW entries above TRADER_MAX_ENTRY_LEVERAGE (default 1) using direction-lock.leverageOf; held 3x is still carried and exited by manageHeldExits (gate new entries only, no forced liquidation) (#3295).
