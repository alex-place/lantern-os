### Added

- trader: honest feed stamp — "LIVE · 3s" by the pulse dot flips to a red "STALE — reconnecting" after 2 failed polls, so stale prices never masquerade as live (#2439)
- trader: ET session clock in the toolbar (Pre-mkt/Open/After-hrs/Closed + countdown to the next phase) (#2439)
- trader: RVOL chip in the symbol panel (relative volume from the regime engine, amber when ≥1.5×) (#2439)
- trader: risk-based position sizing in the order ticket — enter dollars-at-risk, units auto-compute from the stop distance (#2439)
- trader: one-shot price alerts per symbol (toast + browser notification, self-removing, persisted) (#2439)
- trader: watchlist sort — server order · day Δ% · RVOL (#2439)
