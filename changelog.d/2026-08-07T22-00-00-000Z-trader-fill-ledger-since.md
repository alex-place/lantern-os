### Fixed

- trader: the fill reconciler ignores fills that predate the running process. On the first run after a deploy it back-filled the day's already-closed trades with `pnl: null` (the entry price isn't in memory after a restart), adding noise on top of the rows it was meant to replace. Their order ids are still remembered, so they can never resurface.
