### Added

- trading: two choices for the close-IBS sleeve C, both off by default, the design L25 + C1: TRADER_CLOSE_IBS_ONE_BAR=1 decides on the 15:50 bar alone, and TRADER_CLOSE_IBS_NEWS_GATE=1 refuses C's entries unless the session's SHOCK headlines rank HIGH or the prior session's dealer gamma ranks LOW, read from the shared entry-tags files, failing open when a reading is missing, with one close_ibs_gate row per decision day in the worker's own log. No live config changes here.
