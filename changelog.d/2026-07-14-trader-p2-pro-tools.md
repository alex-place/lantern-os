### Added

- trader: drawing tools — ✏ Draw in the chart cluster places horizontal price levels (one click) and trendlines (two clicks); alt-click deletes, Esc disarms; persisted per symbol and re-rendered through zoom/pan/timeframe (#2444)
- trader: ⚡ rapid order mode — explicit persisted opt-in that skips order confirms (ticket + flatten) and arms Shift+B/Shift+S instant market orders at the last-used quantity with a toast receipt (#2445)
- trader: trade journal auto-tag — every order placed from the device snapshots its context (signal, pattern, RVOL, session phase) into a new Journal footer tab (#2446)

### Fixed

- trader: re-land the P0 execution features (volume+VWAP #2436, Flatten #2437, keyboard-first #2438) — PR #2442 had merged into its stacked base branch instead of master, stranding the work
