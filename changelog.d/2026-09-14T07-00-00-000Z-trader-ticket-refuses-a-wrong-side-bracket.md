### Fixed

- trader: **the order ticket refuses a bracket on the wrong side of the entry.** A take-profit below a buy's entry, or a stop loss above it (and the mirror for a sell), is already "hit" the moment the order fills and would close the position as soon as it opens. The ticket accepted such values silently and sent them; it now says which exit is on the wrong side and does not send the order, the same way it already refuses an empty limit price.
