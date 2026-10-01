### Fixed

- trader: the AI day-reader shadow (regime-shadow, #3389) was told the wrong opening gap every morning since 2026-08-21 (minus the previous session's open-to-close move, from a stale daily bar); the gap and today's open now come from the intraday 09:30 bar, journal rows record their source, and the scorer reports the pre-fix morning reads apart
