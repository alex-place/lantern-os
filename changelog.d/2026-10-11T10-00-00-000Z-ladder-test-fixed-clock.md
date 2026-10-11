### Fixed

- tests: **`ladder-vol-targets` failed every weekend.** It anchored on `Date.now()`, and the engine has weekend behaviour armed — so on a Saturday or Sunday the exit path answers "bearish, no long to exit" instead of "zone ladder owns" and the ownership assertion cannot hold. It now runs on a fixed Wednesday mid-session clock, which is the question it always meant to ask. No engine behaviour changes.
