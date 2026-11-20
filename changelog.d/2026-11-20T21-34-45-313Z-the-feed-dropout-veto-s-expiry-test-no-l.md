### Fixed

- The feed-dropout veto's expiry test no longer races the wall clock: it pins the clock on both scans (a 60 s window, read at 61 s) instead of a 1 ms window between two Date.now() readings, which failed CI on 2026-11-20 when both landed in the same millisecond. Test only; the trader's code is unchanged.
