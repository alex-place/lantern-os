feat(auth): provider-agnostic OSS auth — local (email/password) + Google + Discord + Patreon (ADR-0016)

Replaces Patreon-only login with one provider-agnostic identity + a provider
registry. Highlights:

- **One identity, one profile.** Sessions carry a canonical `req.session.user`
  (`{id, role, provider, email, emailVerified, …}`) resolved through
  `lib/session-identity.js`; every gate (`auth-middleware`, `routes/profiles`,
  `routes/admin-flags`, `routes/explore`) reads it instead of `req.session.patreon`.
  A back-compat shim still reads the legacy Patreon-shaped session for one release.
- **Provider registry** (`lib/auth-providers.js`) + a generic PKCE engine
  (`lib/oauth-core.js`) drive Google, Discord and Patreon through one authorize →
  token → userinfo flow. Generic endpoints `GET /api/auth/:provider/start|callback`;
  the login page shows only providers whose client id + secret are configured.
- **Local accounts** (`lib/local-auth.js`) via `POST /api/auth/local/register|login`,
  hashed with Node's built-in `crypto.scrypt` (zero deps, offline). Best-effort
  per-ip+email brute-force throttle.
- **Verified-both account linking** (ADR-0016 / arXiv:2205.10174): a federated login
  auto-links to an existing profile only when BOTH emails are provider-verified;
  otherwise it stays separate (explicit link later). Defeats account pre-hijacking.
- **Fixes #1876** — `/api/profiles/me` now resolves any provider's session (was 401
  for authenticated non-Patreon users); credentials are stripped from every profile
  response via `publicProfile()`.
- **Fixes #1877** — an unconfigured provider redirects to `/auth.html?error=…` with a
  friendly message instead of a raw 500; `auth.html` rebuilt into a multi-provider
  login (dynamic buttons + local form + error banner).
- Consolidates the duplicated `roleHierarchy` literal into `lib/role-hierarchy.js`.

Loop stage: Remember (durable owned identity) + Verify (every identity/link claim is
evidence-gated). Backward-compatible: existing `data/profiles/index.jsonl` and
`account-links.jsonl` still read/write; the Python Discord bot's link format is kept.
Covered by `tests/test_identity_linking.js` (21) and
`tests/test_multiauth_integration.js` (21), plus the existing auth suite stays green.
