# Test Auth — local/dev sign-in without the old IP bypass

**TL;DR:** plain `localhost` is now a **real guest** (you get sent to `/auth.html`,
same as a public visitor). To sign in for testing, set one env var and either pick a
role on the auth page or send a header. The old "loopback = admin Dev" bypass is
**gone**.

## Why this changed

The previous `isLocalBypass()` granted **admin** to any un-proxied loopback request
(and the dev port 4178, and `LANTERN_LOCAL_ADMIN=1`). That was:

- **Misleading** — on `localhost` every page thought you were logged in as an empty
  "Dev" admin, so you could never see the real guest / logged-out experience.
- **Fragile** — trusting a socket address is unsound behind a reverse proxy/tunnel.

It was replaced with an **explicit, token-gated** path: nothing is bypassed unless
you present a token, and even then only on a direct (non-proxied) request.

## Enabling it

Set a token in the server's environment (any non-empty string):

```bash
LANTERN_TEST_AUTH_TOKEN=my-dev-token
# optional: change the seeded account's password (default: test-account-1234)
LANTERN_TEST_PASSWORD=some-password
# optional: emulate a SPECIFIC profile id (default: test-user) — lets a dev boot
# exercise per-user state saved under that id, e.g. an IBKR connection whose
# encrypted creds file is keyed by profile id (point IBKR_CRED_DIR at the dir
# that holds it; reads are file-name-keyed so no credential copying is needed)
LANTERN_TEST_USER_ID=some-profile-id
```

When set (and **only** then), the server:

- seeds one verified test account — `test@unisona.local` / `test-account-1234`,
- exposes a **role picker** on `/auth.html` (a direct hit only),
- honors the `X-Test-Auth` header / `?__test=` query param.

`LANTERN_TEST_AUTH_TOKEN` is **never** set in production, so all of this is inert
there. Even if it were, any proxy/tunnel header (`X-Forwarded-*`, `CF-*`, …) makes
the token refuse — it can never be used from the public internet.

## Three ways to sign in

### 1. Role picker (browser)

Open `/auth.html` on the dev machine. A "🔧 test sign-in" panel appears with a button
per role (Supporter, Deep Dreamer, Founder, Admin, Tech Support). Clicking one signs
you in as the test account **with that role** and returns you to `?returnTo=…`. This
is the "pick a role, no default" flow — you choose your identity every time.

### 2. Header (Playwright / curl / API tests)

Stateless, per-request — ideal for automated tests:

```bash
curl -H "X-Test-Auth: my-dev-token" http://127.0.0.1:4177/api/auth/session
# emulate a specific role / SSO provider:
curl -H "X-Test-Auth: my-dev-token" -H "X-Test-Role: supporter" \
     -H "X-Test-Provider: google" http://127.0.0.1:4177/api/auth/session
```

Playwright:

```js
const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Test-Auth': 'my-dev-token' } });
```

Unspecified role defaults to `admin`.

### 3. Real email + password

The seeded account is a normal verified local account, so the real login form works:

```
POST /api/auth/local/login  { "email": "test@unisona.local", "password": "test-account-1234" }
```

This exercises the actual scrypt login path end-to-end (role = the account's stored
role, `admin`).

## Query param (browser navigation)

`?__test=<token>` on any URL is accepted too (handy when you can't set a header). Pair
it with `?__test_role=` / `?__test_provider=` to choose the emulated identity.

## Tests

- Unit: `node tests/test_admin_local_bypass.js` (token mechanism + proxy rejection),
  `node tests/test_patreon_auth_flag.js` (gate × test-auth matrix).
- E2E (Playwright): `npm run test:auth` — boots the real server with a token and walks
  guest → picker → authed → logout, header emulation, and email+password login.
  Config: [`tests/playwright-auth.config.ts`](../tests/playwright-auth.config.ts);
  specs: [`tests/e2e-auth/auth.spec.js`](../tests/e2e-auth/auth.spec.js).

## Operator note

Because loopback no longer auto-grants admin, the admin control panels
(`orchestration.html` keys/training, `admin-flags.html`, `accounts.html`) are hidden
on plain `localhost`. To use them locally, set `LANTERN_TEST_AUTH_TOKEN` and sign in
as **Admin** via the picker (or the header). Real production admins are unaffected.
