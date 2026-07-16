### Fixed

- auth: signed-out visitors on a protected page (e.g. `/profile.html`) are now redirected to `/auth.html?returnTo=<page>` instead of hitting a self-contradictory "requires the guest tier" upgrade wall (#2471). The tier-upgrade interstitial is now only reachable signed-in, and gained a "Sign in with another account" CTA for users whose other account holds the tier.
