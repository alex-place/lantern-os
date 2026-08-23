### Changed

- Exit authority: the IBS bounce exit (TRADER_IBS_EXIT) is pre-empted on live by the zone ladder (armed for every entry since #3285; 305 'ladder owns' skips 8/10–8/21), take_profit_R, momentum_died and the p_win gate. round7_lab: ladder-owned exits earn 462% vs 1,494% on the 26y holdout. The engine now journals one config_warning row per process naming each pre-empting knob; the validated structure is TRADER_ZONE_EXIT=0 TRADER_TAKE_PROFIT_R=0 TRADER_MOMENTUM_EXIT=0 TRADER_EXIT_MIN_PWIN=0. Tests pin the live pre-emption and the env fix.
