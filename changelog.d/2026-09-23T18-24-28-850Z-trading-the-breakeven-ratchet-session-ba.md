### Fixed

- trading: the breakeven-ratchet session bar is now read even with TRADER_STOP_COOLDOWN_DAYS=0 (stable's value) — a breakeven exit blocks the same-session re-entry as #3413/#3414 validated; live 2026-09-23 UPRO was re-bought 28 minutes after its breakeven stop
