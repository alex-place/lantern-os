### Fixed

- trader-ui: prevClose now comes from our own bar cache (last prior session's official close), falling back to the quote-derived reference only when the cache lacks the symbol. Yahoo's 1d chart rolls per-symbol at an undocumented hour — at 04:42 ET it still served Wednesday as "previous close", so the newly-unlocked pre-market Day P&L would have shown Thursday's move re-badged as today (SPXS −$1,186 against a 24.04 reference)
