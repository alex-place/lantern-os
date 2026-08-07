### Fixed

- trader: the minimum-stop floor now applies to **every** entry path, not just support entries. The four symbols outside `TRADER_SUP_ENTRY_SYMBOLS` (XLK, IWM, DIA, SOXL) kept taking 1.0–1.5% plan/ATR stops; XLK was tagged 24 minutes after entry for −$642 on a 1% move. New entries only — stops already resting at the broker are untouched.
