### Fixed
- **Real brand logos are back for single stocks, and the literal word "null" is gone.**
  `tickerBadgeHtml()` returns `null` to mean *"no designed badge — use the real logo"*,
  but call sites interpolated that straight into a template, printing **"null"** beside
  Apple, NVIDIA, Tesla and every other stock in the search popup. New
  `tickerBadgeOrLogoHtml()` can never return null: designed badge when one exists,
  else the real brand logo with the colored monogram as its `onerror` fallback. All
  four call sites (both sidebars, both search popups) use it.
- **Crypto shows real coin logos** (BTC/ETH/SOL/DOGE/XRP/LTC via CoinGecko, each CDN
  path verified 200/image-png), falling back to its currency glyph if the fetch fails.
