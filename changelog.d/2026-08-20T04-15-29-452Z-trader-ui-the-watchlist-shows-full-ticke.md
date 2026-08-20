### Changed

- trader-ui: the watchlist shows full ticker names again — the per-row signal chip was eating the symbol column and truncating four-letter tickers to 'S...', and the panel was too narrow for its own columns so Chg% fell off the edge. Chip removed, panel 384px, symbol track widened, and the list can no longer scroll sideways. Emoji are gone from the dashboard chrome, replaced by an inline-SVG icon set that inherits colour and renders the same on every platform (#3355)
