fix(nav): hide Settings (orchestration) + Work header tabs and footer links for the guest role

Guests (not signed in, or accounts assigned the `guest` role) no longer see
the Settings (/orchestration.html) and Work (/work.html) links in the header
nav or the footer sitemap. auth-gate.js gains `hideGuestNav()` mirroring the
existing `hideTradeNav()` pattern; covers `<nav>` + `.site-footer` (the same
coverage as applyNavVisibility), and fail-open on transient session errors
like the rest of the nav wiring. Pages stay reachable by URL (orchestration
is public read-only, work is server-gated) — this only trims links guests
can't meaningfully use. Improves Act (role-appropriate guest surface).
