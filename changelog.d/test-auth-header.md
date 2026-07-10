refactor(auth): remove IP local-admin bypass → token-gated test-auth + role picker

The loopback/dev-port/LANTERN_LOCAL_ADMIN admin bypass (isLocalBypass) is removed.
Dev/test sign-in is now explicit and token-gated (lib/test-auth.js), resolved through
the single getSessionUser() seam so every gate honors the emulated role:

- OFF unless LANTERN_TEST_AUTH_TOKEN is set (never in production); refused on any
  proxied/tunnelled request, so it can't be used from the internet.
- One seeded verified account (test@unisona.local) emulates any role per-request via
  X-Test-Auth (+ X-Test-Role/X-Test-Provider), ?__test=, or a role picker on /auth.html;
  real email+password login works too.
- Plain localhost is now a real guest → auth-gate.js repurposes the nav profile button
  into a "Sign in" link for guests.

Docs: docs/TEST-AUTH.md. Coverage: tests/test_admin_local_bypass.js,
tests/test_patreon_auth_flag.js, and Playwright `npm run test:auth`
(tests/e2e-auth/auth.spec.js, 11 cases). Improves Verify (honest auth boundaries).
