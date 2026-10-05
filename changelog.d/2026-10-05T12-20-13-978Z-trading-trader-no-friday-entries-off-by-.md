### Added

- trading: TRADER_NO_FRIDAY_ENTRIES (off by default) skips new entries on an ET Friday. The weekend flat sells every long at Friday 15:50, so a Friday dip has hours, not sessions, to bounce; on the stable box those entries lost on both replay surfaces and without them it netted +0.040% / +0.025% a week more with 3.5 / 2.3 points more winning trades. Exits, stops and the weekend flat are untouched.
