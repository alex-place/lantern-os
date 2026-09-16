### Fixed

- trader: **the trader-mode test suite described a world with two modes.** #3212 added `'off'` — the per-user autopilot kill-switch — and made it the default for real signed-in users, but `trader-mode.test.js` kept asserting the old two-mode contract and had been failing ever since. Three permanent red tests are where a real regression hides, so it now tests what the store actually does, and the module's own header comment (which still listed two modes and called `'stock'` the default) says which default applies to whom.
