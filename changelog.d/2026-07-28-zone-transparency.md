### Fixed
- **S/R zone overlays no longer bury the candles (#3050).** Zone fills were
  scaling opacity up to 0.75 — a strong zone rendered as a near-solid slab over
  the price action. Fills now cap at 0.20 (strength still maps to intensity,
  0.05–0.20), and **every** zone keeps a 1px edge line (stronger for
  today/weekly tiers, amber when entry-triggered) so the precise level stays
  readable while the band recedes to context.
