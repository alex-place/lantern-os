### Trader dashboard restyled to match the home page

- The Trader hub (`/trader-dashboard.html`) now follows the home page's visual language: it respects the user's light/dark theme (it was hard-locked to dark), uses the mandala hero with motto + tagline, and the three tools render as the home-style accent tiles (per-tile color, hover accent bar, tinted icon chip, sliding arrow).
- Live Data, Open Positions, and System Status panels adopt the same accent-bar + eyebrow-label panel treatment and are fully theme-aware (no more dark-only hardcoded colors). All live polling, element IDs, and trading features are unchanged.
