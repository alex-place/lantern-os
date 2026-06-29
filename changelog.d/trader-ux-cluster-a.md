### Trader UX cleanup — removed the legacy hub page, repointed nav to the stock trader

- Deleted the legacy `trader-dashboard.html` hub (it showed a stale "Collector Offline" state) and removed its `/trader-dashboard.html` route from `routes/pages.js`. The `/stock-trader.html` route now carries the `trade` entitlement the old hub had. (#1575)
- Repointed every internal "Trader" link to `/stock-trader.html` — the home header, home tile, and footer (`index.html`), plus shared nav (`js/site-chrome.js`), feature-flag registry (`lib/feature-flags.js`), convergence agent actions, markdown-render nav, the auth-gate trade-page list, the sitemap, and the remaining static surfaces. (#1576)
- Removed the "← Hub" back-link from the stock trader header now that the hub is gone. (#1580)
