### Changed

- nav: retire two orphaned pages behind server-side 302 redirects so old links don't 404 and the surface map stays honest (1.11 polish pass).
  - **`/trading.html` → `/stock-trader.html`** (#2488): the 1307-line legacy dashboard had zero inbound user-facing links and was superseded by `stock-trader.html`/`kalshi-terminal.html`. Removed from `PROTECTED_PAGES` (routes/pages.js) and the `TRADE_PAGES` registry (auth-gate.js), repointed the feature-graph node to the live trader, deleted the file, and added a redirect.
  - **`/upgrade-lab.html` → `/pricing.html`** (#2473): the orphaned, off-brand internal upgrade workbench advertised non-existent tiers and linked to a 404 (`/view?path=CLEANUP.md`). Deleted the file and added a redirect.
  - Both surface-registry entries were dropped (the files are gone; the redirects live in `routes/pages.js`, not as public surfaces — matching the `ibkr-connect.html` retirement). Verified: `deployment-profile` + `surface-boundary` suites pass, and pages.js emits `302 → /stock-trader.html` / `302 → /pricing.html`.
