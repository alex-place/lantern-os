### Added

- trading: adaptive washout depth, shadow-first — TRADER_ADAPTIVE_IBS_PNL=N:X:up:dn deepens the IBS threshold after 11:00 ET while the trader's trailing N-session P&L is below X (default off; MODE=shadow journals the state and every entry it would block, MODE=live refuses them). Validated on four consolidated out-of-sample windows (ledger adaptive-trailing-pnl-depth): the losing quarter -4.86% -> -1.27% at half the drawdown with no window materially hurt.
