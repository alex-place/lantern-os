fix(nav): hide Settings (orchestration) + Work header tabs for the guest role

Guests (not signed in, or accounts assigned the `guest` role) no longer see
the Settings (/orchestration.html) and Work (/work.html) tabs in the header
nav. auth-gate.js gains `hideGuestNav()` mirroring the existing
`hideTradeNav()` pattern; scoped to `<nav>` so the footer sitemap is
untouched, and fail-open on transient session errors like the rest of the
nav wiring. Pages stay reachable by URL (orchestration is public read-only,
work is server-gated) — this only trims tabs guests can't meaningfully use.
Improves Act (cleaner guest surface, role-appropriate navigation).
