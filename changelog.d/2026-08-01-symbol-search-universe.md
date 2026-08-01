### Changed
- **The symbol-search popup is now a browsable universe.** It opened on 15 curated
  names capped at 40 rows, and the server's empty-query fallback returns arbitrary
  tickers (`HVMCW`, `HVIIU`…) — so there was nothing useful to scroll. The empty
  state now lists **124 instruments** (mega-cap tech, NYSE blue chips, core and
  sector ETFs, leveraged ETFs, 14 majors crypto), the client-side 40-row cap is
  gone so the list scrolls, and typed queries return up to 120 matches from the
  broker's full asset universe instead of 40.
