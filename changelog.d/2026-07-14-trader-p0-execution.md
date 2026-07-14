### Added

- trader: volume histogram (bottom band, direction-colored) + dashed amber VWAP overlay on every chart — self-skips when the feed ships no volume (#2436)
- trader: one-click ✕ Flatten per position row + ✕ Close all in the Positions tab — market-closes via the existing orders/place endpoint with a single confirm (#2437)
- trader: keyboard-first trading — `/` jump-to-symbol, `B`/`S` buy/sell ticket for the focused symbol, `←→` cycle chart focus, `0-6` layouts; guarded against typing contexts and modifier keys; cheat-sheet pinned in the ☰ menu (#2438)
