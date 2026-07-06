refactor(boundary): the default profile foregrounds the loop; extensions opt-in (ADR-0023)

The Σ₀ surface boundary now bites in the running default, not just the registry.
`feature-flags.js getNavConfig()` default-hides an EXTENSION nav entry unless its
gating flag is enabled (env or admin toggle); `auth-gate.js` applies this to the
header nav AND the site footer, so the default app presents the loop
(Chat · Settings · Work · Explore). The trader is kept as a foregrounded product
mainstay via `surface-registry.NAV_FOREGROUND` (still an EXTENSION, just not
hidden); Create/media/game are opt-in behind their flags, not deleted. The
sprawl tripwire now treats a registry-classified surface as justified (one gate,
one source of truth) instead of demanding a duplicate loop-stage annotation.
All 19 CORE surfaces now self-declare `<meta name="loop-stage">`, so the pre-push
sprawl tripwire passes clean with no `SKIP_SPRAWL_CHECK` bypass. The IBKR redirect
stub was removed (a moved surface is now a server-side 302 in `routes/pages.js`,
not a `public/*.html` that inflates the count) and `ibkr-setup-guide.html` was
classified under trading — turning `test/surface-boundary.test.js` green
(19 core · 18 extension · ratio 0.95, no silent sprawl). Strengthens the Converge
stage (scope discipline). No capability removed.
