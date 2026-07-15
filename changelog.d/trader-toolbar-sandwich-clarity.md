### Changed

- Trader toolbar declutter + self-explaining menu: Explore, Connect broker, and
  💬 Chat now live inside the ☰ (sandwich) menu at every width, alongside
  Pre/After and Kalshi — the inline toolbar keeps only the logo, badges, account
  stats, chart controls, the live-pulse dot, and ☰. Inside the menu every action
  carries a small caption saying what it does (CSS-rendered from
  `data-hmenu-desc`, so items round-trip to the toolbar untouched), and choosing
  an action closes the menu (chart controls keep it open). The `#feedStamp`
  LIVE·3s feed-honesty label (arriving with the trader-P1-trust PR) is picked up
  defensively and will join the menu when it exists — its pulse dot deliberately
  stays inline so a stale feed remains glanceable. Also added clarifying
  `title`/`aria-label` text across the page: PAPER / READ-ONLY badges, every
  header stat (Equity, Day P&L, VIX, Positions, Market), chart type/timeframe
  selects, footer tabs, and the fullscreen BUY/SELL buttons.
