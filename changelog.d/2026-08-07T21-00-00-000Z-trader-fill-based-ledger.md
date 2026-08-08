### Fixed

- trader: exits are recorded from **broker fills**, not from the engine's intent priced at the last mark. The old path was wrong in both directions every session — stop-outs understated 30–60% (XLK logged −$319.62, filled −$641.62), exit orders that never filled still logged as completed exits (QQQ logged twice, +$453.54 vs +$218.48 real), and fast stop-outs could vanish entirely (SOXL −$590, no row). Placement-time rows are now `exit_intent`; only a confirmed fill produces an `exit`.
