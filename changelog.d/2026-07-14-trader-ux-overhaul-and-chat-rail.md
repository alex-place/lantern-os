### Added

- trader: docked Unisona chat rail (order-ticket-style right dock, reflows the deck, streams from /api/dream/chat/stream; starter chips + hero empty state) (#2431)
- trader: permanent ☰ sandwich menu — Pre/After + Kalshi at every width; chart controls, Explore, and broker link collapse in on narrow screens

### Changed

- trader toolbar consolidated to one inline line: single-line stat pills, chart controls as one segmented cluster, no wrap/clip at any width (#2431, #2432)
- trader charts: direction-aware line color + gradient fill, glowing live-price dot, day-change ▲/▼ chips, hover lift, WATCHING pulse (#2433)
- trader responsive views: viewport-scaled grid rows, priority-shedding toolbar, narrower sidebar/chat rail on tablets — verified 1280/1024/768-portrait/375 (#2435)
- trader mobile: merged Robinhood-style view — full chart deck stacked as the hero, one tap zooms with technicals + buy/sell beneath (replaces the Chart/Tickers tab switch)

### Fixed

- trader charts: bad-tick glitch wicks no longer slam into the plot ceiling — drawn wicks clamped by the same >10× median-span rule the auto-range uses
