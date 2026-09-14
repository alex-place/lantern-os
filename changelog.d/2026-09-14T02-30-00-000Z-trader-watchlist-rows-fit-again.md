### Fixed

- trader: **the watchlist rows fit their rail again.** The AI column added in #3614 pushed the row's fixed tracks past the rail's width, which squeezed the symbol to a few pixels. The row drops its empty spacer track, tightens its gaps and number columns, and the AI chip shrinks to its text, so at the rail's 340px every ticker has its full width and the header lines up with the values.
