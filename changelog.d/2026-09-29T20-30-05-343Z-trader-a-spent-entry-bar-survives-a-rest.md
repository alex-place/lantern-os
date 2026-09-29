### Fixed

- Trader: a spent entry bar survives a restart. The mark that says this hour's one entry decision has been taken lived in memory only; on 2026-09-29 the armed stable server was rolled three times in twenty minutes by merges to master, and the fresh process bought 3,074 TNA at 14:17 ET inside a bar whose decision IWM had already spent at 14:07. The mark is now saved with the rest of the trader state the moment it is set and restored on load; a mark from another session still blocks nothing.
