### Removed

- trader: **the separate Watch page is gone.** One trader for everyone: a visitor without the trade entitlement gets the same charts, watchlist and signals in view-only mode — without the account panel at the bottom (no demo portfolio stands in for it any more), no "Pro feature" overlay, no bounce to another page. `/watch.html` redirects to the trader. The **news feed** that lived on the Watch page has no home yet; its API stays.

### Changed

- trader: **the page's list is the watchlist, with the AI trader's list marked on it.** Every row has an **AI toggle**: on puts the symbol on the autopilot's tradelist (warned once per session), off takes it back off; the row stays on the watchlist either way. Tracking a symbol — adding it, charting it — needs no warning any more; removing one that the AI trades warns and takes it off both lists.
