### Fixed

- trader: **the Opened column tells "this server doesn't report open times yet" apart from "the ledger has no entry row for this lot".** Both arrive as a falsy `entry_ts`, but only the second is about your data — and a box that takes the page without the server half (the race box takes public files only) would otherwise have blamed the ledger for every position it holds.
