# Handoff — Finish Patreon login (credentials live on your device)

**Date:** 2026-07-03
**Branch:** `claude/sigma0-ev-council` (3 new commits, pushed to fork `kriskin9-hash/lantern-os`)
**Owner of blocker:** whoever holds the Patreon app's Client ID + Secret.

## TL;DR

The Patreon OAuth flow is **fully wired and verified end-to-end in code** — it
already works on live unisona.ai up to the authorize redirect (real `client_id`,
correct `redirect_uri`, `scope=identity identity.memberships`, state + PKCE S256).
Two things remain, both requiring the credentials that are only on your machine:

1. **Local wiring** — add `PATREON_CLIENT_ID` / `PATREON_CLIENT_SECRET` to
   `.env.local` so Patreon login works on `localhost` (dev), not just live.
2. **Verify tier→role mapping** against the live campaign's real tier IDs.

Plus a deploy step (below) that gets the session fixes onto master.

## Verified already (no action needed)

- Provider config: [`apps/lantern-garage/lib/auth-providers.js`](../../apps/lantern-garage/lib/auth-providers.js) — `patreon` block (authorize/token URLs, scope, `fetchUser`, `mapRole`).
- Flow engine: [`apps/lantern-garage/lib/oauth-core.js`](../../apps/lantern-garage/lib/oauth-core.js) — `handleOAuthStart` / `handleOAuthCallback` (exchange → fetchUser → role → profile → session). `redirect_uri` auto-derives from the request host.
- Profile creation: `getOrCreateFromIdentity` in [`apps/lantern-garage/lib/user-profiles.js`](../../apps/lantern-garage/lib/user-profiles.js) (Patreon keeps its provider id as the profile id; records `patreonId` + tier).
- Login page: `auth.html` shows "Connect with Patreon"; unconfigured providers fail gracefully.

Proof the wiring builds a valid request (dummy creds, local):
```
https://www.patreon.com/oauth2/authorize?response_type=code&client_id=<ID>
  &redirect_uri=http%3A%2F%2Flocalhost%3A4178%2Fapi%2Fauth%2Fpatreon%2Fcallback
  &scope=identity%20identity.memberships&state=<...>&code_challenge=<...>&code_challenge_method=S256
```

## Task 1 — Wire Patreon locally

Add to `.env.local` at repo root (gitignored — do **not** commit):
```
PATREON_CLIENT_ID=<your value>
PATREON_CLIENT_SECRET=<your value>
```
(These are the same values already set in the live deployment's env.)

In the Patreon app ([patreon.com/portal/registration/register-clients](https://www.patreon.com/portal/registration/register-clients)),
add these to **Redirect URIs** — Patreon requires an exact match:
```
http://localhost:4178/api/auth/patreon/callback   (dev server)
http://localhost:4177/api/auth/patreon/callback   (stable server)
```
The live URL `https://unisona.ai/api/auth/patreon/callback` is already registered.

Restart the server, then verify:
```bash
# should now redirect to patreon.com with your real client_id:
curl -s -i "http://localhost:4178/api/auth/patreon/start?returnTo=%2F" | grep -i location
```
Then click **Connect with Patreon** on `/auth.html`, complete consent, and confirm
you land back logged in as your real Patreon identity (check `/api/auth/session`).

## Task 2 — Verify tier→role mapping

The mapping is in [`apps/lantern-garage/lib/auth-providers.js`](../../apps/lantern-garage/lib/auth-providers.js)
as `PATREON_TIER_TO_ROLE` (⚠️ NOT `patreon-auth.js` / `TIER_TO_ROLE` — the older
`docs/PATREON-OAUTH.md` is stale on this point). Current values:

| Tier | Tier ID | Role |
|---|---|---|
| Wanderer ($5) | `28764312` | `supporter` |
| Deep Dreamer ($20) | `28740619` | `deep_dreamer` |
| Synthesasia Guild ($200) | `28764307` | `admin` |

Owner admin override: `patreon:49294581` in `ADMIN_OVERRIDES` (same file).

Confirm these tier IDs match the current campaign (Patreon → campaign settings →
Tier management, or the tier `id`s returned by the identity API include). Fix any
that drifted, or set `LANTERN_ADMIN_IDS` for extra admin overrides.

## Task 3 — Deploy the session fixes to master

Three commits on `claude/sigma0-ev-council` (pushed to the fork) must reach
`master` so live stops overriding real logins:

- `9f6911c0` fix(auth): harden local-admin bypass + make Sign out actually work
- `5614ed9d` redesign(auth): brand-matched, responsive sign-in page
- `b11ca1df` feat(guest): read-only trader + orchestration + admin-gated control endpoints

**Why this matters for Patreon:** commit `9f6911c0` fixes the bug where every
tunnel visitor (all of unisona.ai) was auto-authenticated as admin "Dev", which
**silently overrode a completed Patreon login** — you'd sign in with Patreon but
still show up as "Dev". Until this lands on master, Patreon login on live won't
resolve to the real identity.

Open a PR from `claude/sigma0-ev-council` → `alex-place/lantern-os:master` and
merge (a second `claude/` PR may be blocked by the one-PR-per-lane rule until the
other open `claude/` PR merges/closes). Railway/the tunnel picks up master.

## Quick smoke test after everything

1. Logged out → `/auth.html` shows all providers; "Connect with Patreon" → Patreon.
2. Complete consent → redirected back, `/api/auth/session` shows `provider:"patreon"` and the mapped role.
3. Sign out → session clears and stays cleared.
