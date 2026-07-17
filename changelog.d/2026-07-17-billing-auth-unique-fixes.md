### Fixed

- security/robustness: billing/auth audit fixes (the subset not already covered by the concurrent route/tier fixes).
  - **test-auth no longer fails open to admin** (#2645): `normalizeRole` defaulted an unknown/blank role to `admin`, so a token presented without a role became a full admin session. Now defaults to `guest`; admin/tech_support require naming them explicitly. Added `pilot` to the emulatable roles.
  - **An `incomplete` Stripe sub no longer wedges checkout** (#2647): a first-payment-never-succeeded sub conferred no access but counted as "live", blocking a fresh checkout for ~23h. `hasLiveSubscription` now requires an actually-granted `stripeRole`.
  - **Register account-enumeration killed** (#2617): `POST /api/auth/local/register` returned `409 email_taken` for an existing address vs `202` for a new one — an enumeration oracle. Now returns an identical generic `202` for both and emails the existing owner a recovery link.
  - **Card-subscription auto-link now works for OAuth sign-ins** (#2652): the auto-link only fired for email/password logins; `auth-gate.js` now fires `/api/billing/link` once per session for any authenticated user (guarded server-side), reloading only on a fresh link.
  - **"Link Patreon" → "Subscribe on Patreon"** on pricing.html (#2637): the button starts a Patreon subscription, a different action than profile.html's link-existing flow — reusing "Link" invited "I paid and got nothing" confusion.
  - **Discord tier-label divergence documented** (#2659): Discord's "Deep Dreamer" server role maps to the canonical `supporter`, NOT the web `deep_dreamer`/$20 Pro — annotated so it isn't "fixed" into a desync with the real server roles.
