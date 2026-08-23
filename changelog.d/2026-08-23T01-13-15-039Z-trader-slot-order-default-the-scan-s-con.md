### Changed

- TRADER_SLOT_ORDER (default: the scan's confidence order): admission order of same-scan entry candidates when slots are scarce — depth = deepest session IBS first; expectancy = highest TRADER_SYMBOL_SIZE_MULT weight first, deepest IBS as tie-break. round7_lab F, 26y holdout: arbitrary 643% / deepest-IBS 1,494% / expectancy-then-depth 2,866% (return/DD 129 vs 89; recent year 44.6% vs 31.5%), fit winner, holdout confirms
