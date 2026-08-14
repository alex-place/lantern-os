### Fixed

- trader: a stop-out seen as an ABSENCE now arms the tail defenses. Both the re-entry cooldown and the daily circuit breaker armed only inside `_reconcileFills`, which needs a broker stop fill it can see; a stop that surfaced through the external-close sweep armed neither. Live 2026-08-13 SQQQ stopped out for -$1,674.06 and was re-entered three seconds later, and the session ended with `stopCooldownThrough {}` and `stopFills {count:0}` after a real stop had fired
