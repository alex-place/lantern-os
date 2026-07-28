### Changed
- **Trader sidebar: one row per symbol, aligned and readable.** Each watchlist/
  tradelist entry is now a single grid row — logo · symbol · price · day% ·
  signal — with every cell the same 12px mono (was a two-line stack mixing
  9.5/10/10.5/11px, whose space-between rows never formed columns). The remove ×
  overlays on hover instead of eating a column. Default sidebar width raised to
  296px (min 248) so the row actually fits — persisted narrower widths clamp up
  on load. Header stats/badges/nav-links raised to the 12px floor the rest of
  the app (chat.html) uses, per the WCAG AA guidance in docs/ACCESSIBILITY.md.
