---
adr: 0016
title: Provider-agnostic OSS auth (local + Google + Discord + Patreon)
status: Accepted
date: 2026-07-02
deciders: Alex Place (owner), Claude (drafting)
approved-by: Alex Place (2026-07-02)
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.
-->


# ADR-0016: Provider-agnostic OSS auth (local + Google + Discord + Patreon)

## Status

Accepted (Alex Place, 2026-07-02)

## Context

Login today is **Patreon-only**, and the whole system treats the Patreon identity as *the*
identity. The canonical user handle is `req.session.patreon.id` and it is read directly by
the middleware, the gates, and the profile store:

- `apps/lantern-garage/lib/auth-middleware.js` — `requireAuth`/`requireRole`/`requireEntitlement`/
  `isAdmin`/`attachProfile` all read `req.session?.patreon?.id` (e.g. lines 75, 99, 181, 237, 244).
- `apps/lantern-garage/lib/patreon-auth.js:311` — `getSessionInfo()` only reports authenticated
  when `req.session.authenticated` was set by the Patreon callback.
- `apps/lantern-garage/routes/profiles.js:25,38` — `/api/profiles/me` keys off
  `req.session?.patreon?.id` and **401s for any non-Patreon session, including an authenticated
  local admin** (reproduced live on :4178 — see issue #1876).
- `apps/lantern-garage/lib/user-profiles.js` — a profile's primary key *is* the Patreon id
  (`getOrCreateFromPatreon` keys on `patreonUser.id`), with an ad-hoc `account-links.jsonl`
  bolt-on for a single Discord link (#697).

This blocks the three paying/free constituencies from logging in the way they actually have
identities: kriskin/mookman (Discord-native), Google users, and Patreon supporters. It also
produced the filed bugs #1876 (guest gate is a lie / admin 401) and #1877 (OAuth misconfig →
blank 500).

**Loop stage:** primarily **Remember** (a durable, owned, provider-agnostic identity that other
loop stages attach memory/tasks/entitlements to) with a **Verify** component (auth is a
grounding/trust boundary; every identity claim must be evidence-backed and every merge must be
ownership-proven).

**North-Star constraints that shape this:**
- *One loop, four objects; extend, don't add.* We do **not** introduce a second identity system.
  We generalize the one that exists.
- *Models/providers are replaceable.* Identity providers must plug in like model providers do —
  a registry, never a hardcode.
- *External reality beats internal consistency.* An identity claim (esp. an email used to merge
  accounts) is only trusted with evidence: the provider's `email_verified` assertion.
- *Local ownership is a feature.* The user must be able to hold a real account with **no third
  party** and no internet.

**Prior art / research** (external, per the External Reality Rule):
- *Lucia* (the batteries-included OSS auth library) was **deprecated in March 2025** and
  re-scoped to a "build auth from scratch" learning resource; the maintainer's stated reason is
  that a one-size library can't fit arbitrary runtimes/DBs without becoming bloat. This is a
  direct argument **against** adopting a framework here and **for** owning a small, fitted module.
- *Passport.js* (v0.7.0) is Express-middleware-coupled and only lightly maintained; this server is
  framework-less plain `http` with `if`-block routing, so Passport would need an adapter shim for
  little benefit.
- *Account pre-hijacking* (Sudhodanan & Paverd, 2022, arXiv:2205.10174): **35 of the top 75
  sites** were vulnerable to attacks rooted in linking a federated login to a pre-existing,
  **unverified** account by email alone. This dictates our linking rule.

## Decision

We will replace the Patreon-shaped identity with **one provider-agnostic identity + a provider
registry**, owned in-repo, with four concrete decisions:

1. **Generalize in-repo into a provider registry — no auth framework, no new hard runtime dep.**
   The existing `patreon-auth.js` flow (PKCE + signed short-TTL state cookie recovery + exact
   redirect-URI reuse) is refactored into `lib/auth-providers.js`, a registry keyed by provider
   id (`google`, `discord`, `patreon`). Each provider is a small config object (authorize URL,
   token URL, userinfo URL, scopes, `email_verified`/id extractors). Google and Discord are the
   same OAuth2 + PKCE dance, so they are added as data, not new machinery. Generic endpoints
   `GET /api/auth/:provider/start` and `/api/auth/:provider/callback` supersede the
   `patreon`-named ones (which remain as aliases for back-compat). *(Optional, non-binding: the
   actively-maintained OSS `arctic` client library — from Lucia's author — may later back the
   provider quirks via dynamic `import()` since the repo is CommonJS; we start dependency-free.)*

2. **Local accounts use email + password hashed with Node's built-in `crypto.scrypt`.**
   Zero dependencies, works fully offline, preserves the local-ownership property (the reason the
   local option exists). Passwordless/magic-link is rejected for now because it requires email
   infrastructure the repo does not have. Password **reset** is deferred (owner can reset locally);
   it becomes attractive once email infra exists — tracked as a follow-up.

3. **Session identity becomes provider-agnostic: `req.session.user`.**
   Shape: `{ id, name, email, emailVerified, role, provider, entitlements }`, where `id` is the
   **profile** id (stable across linked providers), not any single provider's id. All middleware
   and gates read `req.session.user`. `req.session.patreon` is kept **written** by the Patreon
   path and **read** by a compatibility shim for one release so nothing breaks mid-migration.
   `getSessionInfo()` resolves from `req.session.user`. This fixes #1876 by construction.

4. **Account linking: verified-both auto-link, explicit-link fallback.**
   On a federated login, auto-merge into an existing profile **only when both sides are
   email-verified** — the incoming provider asserts `email_verified === true` **and** the matching
   profile's stored email is itself verified. Otherwise we do **not** merge: the user must first
   authenticate into the existing account and link the new provider from the profile page (the
   existing `link-*` pattern). Patreon email is treated as **unverified** unless confirmed. This
   defeats pre-hijacking (arXiv:2205.10174): an attacker's planted account is never verified, so
   it never auto-merges.

## Consequences

- **Positive:**
  - Discord-native (kriskin/mookman), Google, Patreon, and offline-local users can all hold a
    real account; the app stops pretending everyone is a Patreon supporter.
  - #1876 and #1877 are fixed as part of the work (generic identity + graceful misconfig UI).
  - Providers plug in like models do (registry), satisfying the replaceability principle.
  - No auth-framework lock-in; no heavyweight dependency; password hashing is core-`crypto`.
  - One identity, one profile store — no second identity system; the `account-links.jsonl`
    bolt-on is subsumed by a first-class `identities[]` on the profile (old records still read).
- **Negative / trade-offs:**
  - We own the OAuth/session security surface (state/CSRF, open-redirect on `returnTo`, session
    fixation, cookie flags, scrypt params). Mitigated by an adversarial multi-lens security review
    gate before merge and by reusing the already-hardened PKCE/cookie-recovery code.
  - Password accounts mean we store (scrypt) hashes and must never log them; reset flow is a known
    gap until email infra lands.
  - A migration window where both `req.session.user` and `req.session.patreon` exist; the compat
    shim is debt to remove in a follow-up.
- **Follow-ups:**
  - ~~Password reset + email verification once email infra exists.~~ **Done** — SMTP mailer +
    `auth-tokens.js` (`request-password-reset` / `reset-password`, email-verify) shipped.
  - ~~Remove the `req.session.patreon` compat shim one release after rollout.~~ **Done (#1947)** —
    the read fallback + write mirror in `session-identity.js` were removed after 100+ patch releases;
    every login writes `session.user` and every gate reads it, no other code touched the shim.
  - Discord guild-role → Keystone-role mapping (currently Discord/Google/local default to the free
    tier; Patreon remains the paid-tier source of truth). *(still open)*
  - Close #1876, #1877; fold #1879 (role naming) and #1880 (nav sync) as adjacent cleanups.

## Alternatives considered

- **Do nothing (Patreon-only).** Rejected: locks out the actual user base (Discord/Google/offline)
  and leaves #1876/#1877 unfixed.
- **Adopt Passport.js.** Rejected: Express-coupled, lightly maintained, needs an adapter for a
  framework-less server; strategy-package sprawl for little gain over generalizing what we have.
- **Adopt Lucia / Auth.js (NextAuth).** Rejected: Lucia is deprecated (2025); Auth.js is
  Next.js-oriented and a poor fit for vanilla Node. Adopting either is adopting rewrite risk or a
  dead/ill-fitting dependency.
- **Passwordless-only local auth.** Rejected for now: requires email infra that doesn't exist and
  breaks offline login.
- **Naive auto-link by email.** Rejected on security grounds: it *is* the pre-hijacking vuln
  (arXiv:2205.10174).
- **Explicit-link-only (never auto).** Rejected as the default: unnecessary friction when both
  sides are verified; kept only as the *fallback* when verification is absent.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Identity is Patreon-shaped across the middleware | `apps/lantern-garage/lib/auth-middleware.js:75,99,181,237,244` | High | codebase read |
| `/api/profiles/me` 401s an authenticated admin | `apps/lantern-garage/routes/profiles.js:25`; live repro on :4178 | High | issue #1876 |
| Existing PKCE + state-cookie flow is sound and reusable | `apps/lantern-garage/lib/patreon-auth.js:25-132,151-165` | High | codebase read |
| Profile key == Patreon id; single ad-hoc Discord link | `apps/lantern-garage/lib/user-profiles.js:188-214,317-333` | High | codebase read |
| OAuth misconfig returns a blank 500 | `apps/lantern-garage/lib/patreon-auth.js:99-102`; `public/auth.html:307` | High | issue #1877 |
| Lucia deprecated 2025 → own the code | wisp.blog "Lucia Auth is Dead"; lucia-auth/lucia discussion #1714 | Med-High | web (2026-07) |
| Passport is Express-coupled, lightly maintained (v0.7.0) | passportjs.org | Med | web (2026-07) |
| Email-only auto-link enables pre-hijacking (35/75 sites) | arXiv:2205.10174 | High | peer-reviewed study |
| Node core `crypto.scrypt` gives dependency-free password hashing | Node.js `crypto` module docs | High | official docs |
