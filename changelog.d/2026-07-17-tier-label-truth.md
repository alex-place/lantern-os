### Fixed

- docs/ui: swept the stale "$5 Member" tier out of labels, comments, and docs so no surface advertises a plan pricing.html no longer sells (retired in #2613).
  - **Upgrade wall** (#2644): `routes/pages.js` `TIER_LABEL` mapped `supporter → "Member"`, so a Free user hitting a supporter-level gate was sent to buy a non-existent Member plan. Now `supporter`/`deep_dreamer` both display as **Pro** (the cheapest tier that still sells).
  - **Fallback access tables** (#2656): `public/app.js` priced the `supporter` id (the $5 legacy role key) at $20, colliding with Pro; renamed that lane to `deep_dreamer`/"Pro". Fixed the matching "Supporter workspace" copy in `lib/status.js` + `render-server.js`.
  - **Money→role comments** (#2655): `lib/auth-providers.js` + `lib/role-hierarchy.js` now state that `$5 → supporter` is retained ONLY for grandfathered legacy patrons — don't restore a $5 offering, don't delete the mapping (would strip those patrons).
  - **Docs** (#2658): `docs/PATREON-OAUTH.md` role-mapping table + notes corrected (it wrongly said `$200 → deep_dreamer` and omitted `pilot`/`PATREON_PILOT_CENTS`); `CLAUDE.md`'s `guest → supporter → founder → admin` ladder updated to Free / $20 Pro / $200 Pilot with the retired-tier note.
  - **Orphaned payment-bridge** (#2657): the standalone `payment-bridge/` checkout service (sells the retired tier, can't sell Pro, bypasses the canonical guards, nothing boots it) now carries a loud RETIRED / DO-NOT-BOOT banner pointing at `routes/billing.js`.
  - **Discord bot** (#2659): documented the deliberate cross-surface naming divergence (Discord "Deep Dreamer" = canonical `supporter`, NOT the web `deep_dreamer`/$20 Pro) so it isn't mistaken for a bug or "fixed" into a desync with the real server roles.
