### Added

- trading: two context gates for the two-sleeve engine, both off by default. `TRADER_NOISE_CONTEXT_GATE` refuses a new noise-leg entry when dealer gamma and the sectors do not back the break; `TRADER_OVERNIGHT_BOND_GATE` refuses the night's overnight entries when TLT is down more than 0.30 % at the entry bar. `shadow` journals the same read and trades nothing; a reading the gate cannot trust leaves it open and journals why.
