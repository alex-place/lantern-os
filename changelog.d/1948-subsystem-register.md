feat(sigma0): extend the surface boundary to non-HTML subsystems — bots + background services (ADR-0013, #1948)

`lib/surface-registry.js` gains a `SUBSYSTEMS` registry classifying the 9 top-level
services server.js manages/spawns as CORE (loop stage) or EXTENSION (module), each
citing its on-disk `entry`. `test/surface-boundary.test.js` validates the shape AND
verifies every `entry` exists (no fabricated/stale entries). `lib/feature-graph.js`
gains an alignment note to the registry. Also classified two HTML surfaces that had
landed unclassified (kalshi-screener.html, reset-password.html), restoring the
anti-sprawl gate to green. Strengthens **Converge** (anti-sprawl).
