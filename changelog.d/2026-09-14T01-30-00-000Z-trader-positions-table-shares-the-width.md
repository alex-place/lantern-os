### Changed

- trader: **the positions table's columns share the panel's width**, the way TradingView's do, instead of huddling at the left with the action column holding all the slack. Add a column and the others close up to make room; when they outgrow the panel it scrolls sideways. The **symbol cell now carries the issuer's badge**, like the watchlist row, and the **exchange** beside the ticker once it is known (fetched once per symbol, never guessed). The orders and history tables get the same symbol cell.
