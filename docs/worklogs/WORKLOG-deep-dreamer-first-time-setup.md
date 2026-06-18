# Worklog — First-Time Setup Demo: "Deep Dreamer" Subscriber

**Date:** 2026-06-18
**Author:** Claude (research + demo dry-run)
**Scenario:** A brand-new user signs up, subscribes at the **Deep Dreamer ($20/mo)** Patreon
tier, and wants to use **Dream Chat** and the **Creator Suite** with their **Patreon and
Discord roles set**, with **no access to the trading terminal**.
**Status:** Research complete. Demo is *partially* achievable today — see [Gaps & Blockers](#gaps--blockers).

> Note on naming: the request said "Deem Dreamer." There is no such tier. The intended tier
> is **Deep Dreamer** ($20/mo), the middle of the three Patreon tiers. This worklog uses the
> correct name throughout.

---

## 1. What "Deep Dreamer" actually means in the code

The tier maps differently across the two role systems (web app vs Discord bot). This matters
for the demo because the same subscriber gets two different role labels.

| System | Source | Deep Dreamer maps to | Notes |
|--------|--------|----------------------|-------|
| **Web app role** | [`patreon-auth.js:16-20`](../../apps/lantern-garage/lib/patreon-auth.js) `TIER_TO_ROLE` | `founder` | Patreon tier ID `28740619` → `founder` |
| **Web role hierarchy** | [`patreon-auth.js:276`](../../apps/lantern-garage/lib/patreon-auth.js) | level 2 of 4 | `guest:0, supporter:1, founder:2, admin:3` |
| **Discord role** | [`bot_v2.py:67-73`](../../src/discord_lounge_bot/bot_v2.py) `_ROLE_ALIASES` | `supporter` (canonical) | server role "Deep Dreamer" → `ROLE_SUPPORTER` |
| **Discord tier order** | [`bot_v2.py:75`](../../src/discord_lounge_bot/bot_v2.py) | level 1 of 3 | `@everyone:0, supporter:1, pilot:2, founder:3` |

**Tier feature matrix** (from [`csf/ingest/convergence-patreon-tiers.md`](../../csf/ingest/convergence-patreon-tiers.md)):

| Tier | Price | Web role | Features | Quota |
|------|-------|----------|----------|-------|
| Wanderer | $5/mo (7-day trial) | `supporter` | Dream journal, 3 agents, CTF symbols, offline, JSONL export | 100 chat/mo, 15 art, 5 door plays |
| **Deep Dreamer** | **$20/mo** | **`founder`** | **All 6 agents, unlimited chat, priority Gemini grounding, voice TTS, CSV export** | **Unlimited** |
| Synthesasia Guild | $200/mo | `admin` | Everything + early features, founder Discord, custom LoRA slot, priority routing | Unlimited + priority |

⚠️ **Naming collision:** "Deep Dreamer" → `founder` in the web app, but the Patreon "Synthesasia
Guild" → `admin`, and the Discord bot uses `founder` as its *top* tier (mapped from `admin`).
The word "founder" means different privilege levels in the two systems. Flag for cleanup.

---

## 2. End-to-end first-time setup journey (the demo script)

### Step 0 — Operator prerequisites (one-time, before any user can sign up)

These are **environment/config** steps the operator must complete. **This is the first blocker:
the Patreon OAuth variables are not documented in `.env.example`.**

Required env vars (read by [`patreon-auth.js`](../../apps/lantern-garage/lib/patreon-auth.js)):

```bash
PATREON_CLIENT_ID=...          # from patreon.com/portal → My Clients
PATREON_CLIENT_SECRET=...
PATREON_REDIRECT_URI=http://127.0.0.1:4177/api/auth/patreon/callback
SESSION_SECRET=...             # express-session signing key
```

Required for Discord role sync (already partially in `.env.example`, lines 60-64):

```bash
DISCORD_BOT_TOKEN=...
LANTERN_DISCORD_GUILD_ID=...   # numeric guild ID
```

Trading should be disabled for this demo profile (see Step 5):

```bash
LANTERN_DISABLE_TRADING=1      # skips trading microservice + AI trader at boot (server.js:283)
```

Start the server:

```bash
make quickstart            # dual-boot 4177 (stable) + 4178 (dev)
# or single:
npm run dev --prefix apps/lantern-garage
```

### Step 1 — User lands on the site
- New user hits any protected page (e.g. `/dream-chat.html`).
- [`auth-gate.js:55-72`](../../apps/lantern-garage/public/js/auth-gate.js) calls `/api/auth/session`,
  sees `authenticated: false`, and redirects to `/auth.html?returnTo=/dream-chat.html`.
- Public pages that skip the gate: `/auth.html`, `/explore.html`, `/knowledgecenter.html`
  ([`auth-gate.js:8`](../../apps/lantern-garage/public/js/auth-gate.js)).

### Step 2 — User subscribes on Patreon (external)
- User visits `https://www.patreon.com/c/lanterndreamjournal` and joins the **Deep Dreamer** tier.
- Patreon processes the $20/mo payment. (This is outside Lantern OS.)

### Step 3 — User signs in with Patreon (OAuth PKCE)
- On `/auth.html` the user clicks the Patreon sign-in button →
  `GET /api/auth/patreon/start?returnTo=/dream-chat.html`.
- [`handlePatreonStart`](../../apps/lantern-garage/lib/patreon-auth.js) generates PKCE + state,
  stores them in session, redirects to Patreon's `authorize` endpoint with scope
  `identity identity.memberships`.
- User approves → Patreon redirects back to
  `GET /api/auth/patreon/callback?code=...&state=...`.
- [`handlePatreonCallback`](../../apps/lantern-garage/lib/patreon-auth.js):
  1. Verifies `state` matches session.
  2. Exchanges code for token (`exchangePatreonCode`).
  3. Fetches identity + memberships (`getPatreonUserWithMemberships`).
  4. Maps the entitled tier IDs to a role (`mapPatreonTierToRole`) → **`founder`** for Deep Dreamer.
  5. `getOrCreateFromPatreon` writes the profile to `data/profiles/index.jsonl`.
  6. Stores `req.session.patreon = { id, email, name, tier, role:"founder", token, expiresAt }`.
  7. Redirects to `returnTo` (`/dream-chat.html`).

### Step 4 — User uses Dream Chat ✅
- `auth-gate.js` now sees `authenticated: true` → no redirect.
- All 6 agents (`lantern`, `blinkbug`, `keystone`, `waterfall`, `xenon`, `founder`) are available
  via [`dream-chat.js`](../../apps/lantern-garage/lib/dream-chat.js) `selectAgent()`.
- Per the tier matrix, Deep Dreamer is entitled to all 6 agents + unlimited chat + voice TTS.

### Step 5 — User uses the Creator Suite ✅ (with a caveat)
- `/create.html` loads `auth-gate.js` ([`create.html:1200`](../../apps/lantern-garage/public/create.html))
  → only checks **authenticated**, not role. A logged-in Deep Dreamer gets in.
- Creator/curator endpoints live under `/api/curator/*` (image LoRA curation UI).

### Step 6 — Trading must be locked ⚠️ (NOT enforced today — see gaps)
- The requirement: this subscriber has **no access to trade**.
- Reality: `/trading.html` and `/trader-dashboard.html` also only include `auth-gate.js`
  ([`trading.html:1318`](../../apps/lantern-garage/public/trading.html)) — **authenticated-only,
  no role check.** Any logged-in user (including Deep Dreamer) can open them.
- `/api/trading/*` routes in [`routes/trading.js`](../../apps/lantern-garage/routes/trading.js)
  perform **no role/session gating** at all.
- So "no access to trade" is currently only achievable by **disabling trading server-wide**
  (`LANTERN_DISABLE_TRADING=1`), not per-user. See remediation below.

### Step 7 — Discord role sync
- The user joins the Discord guild and is assigned the **"Deep Dreamer"** role.
- [`bot_v2.py`](../../src/discord_lounge_bot/bot_v2.py) reads `member.roles`, aliases
  "deep dreamer" → `supporter`, and gates slash commands by `TIER_ORDER`.
- ⚠️ The web session role (`founder`) and the Discord role (`supporter`) are **not linked** —
  there's no shared identity between the Patreon OAuth `id` and the Discord user `id`. They are
  set independently. For the demo, both must be configured by hand.

---

## 3. Access matrix for this persona (as-built today)

| Surface | Should have? | Enforced by code? | Result |
|---------|-------------|-------------------|--------|
| Dream Chat (`/dream-chat.html`) | ✅ yes | authenticated-only gate | ✅ Works |
| All 6 agents | ✅ yes | tier doc only (not code-enforced) | ✅ Works (no agent filter found) |
| Creator Suite (`/create.html`) | ✅ yes | authenticated-only gate | ✅ Works |
| Voice TTS / CSV export | ✅ yes | not code-gated | ✅ Works |
| Trading (`/trading.html`, `/api/trading/*`) | ❌ no | **NOT gated** | ❌ Accessible — requirement violated |
| Patreon role set | ✅ yes | OAuth callback | ✅ Works |
| Discord role set | ✅ yes | manual + bot | ⚠️ Works but unlinked to web identity |

---

## 4. Gaps & Blockers

1. **`PATREON_*` env vars undocumented.** `.env.example` only has Discord vars (commented).
   A first-time operator cannot complete OAuth without `PATREON_CLIENT_ID`,
   `PATREON_CLIENT_SECRET`, `PATREON_REDIRECT_URI`, and `SESSION_SECRET`. **Add them to
   `.env.example`.**

2. **No per-user trade gating.** "No access to trade" cannot be expressed per-profile. Trading
   pages use the same authenticated-only gate as everything else, and `/api/trading/*` has no
   session check. Today the only lever is the server-wide `LANTERN_DISABLE_TRADING=1`.
   - *Fix:* add a `requireRole`/feature-flag check to trading pages and API routes, or a
     per-profile `entitlements` field (e.g. `{ trade: false }`) checked in middleware.

3. **Role-based page gating is not wired.** `lib/auth-middleware.js` exports `protectStaticPage`
   /`requireRole`, but **`server.js` never calls them** for static HTML. All page-level access
   control is client-side (`auth-gate.js`) and binary (authed vs not). A founder-only or
   trade-locked page is not currently possible without code changes.

4. **Web ↔ Discord identity not linked.** Patreon OAuth `id` and Discord user `id` are separate;
   roles are maintained independently. There's no single source of truth tying a Deep Dreamer's
   web role to their Discord role.

5. **"founder" naming collision.** `founder` = the $20 web role, but also the Discord *top* tier
   (mapped from `admin`/$200 Synthesasia Guild). Confusing; recommend renaming the web role to
   `deep_dreamer`.

---

## 5. Recommended worklist (to make the demo fully correct)

| # | Task | File(s) | Effort |
|---|------|---------|--------|
| 1 | Document Patreon + session env vars | `.env.example` | 10 min |
| 2 | Add per-profile `entitlements` (e.g. `{trade:false}`) to profile schema | `lib/user-profiles.js` | 1 h |
| 3 | Gate `/api/trading/*` with a session/entitlement check | `routes/trading.js` | 1–2 h |
| 4 | Gate trading HTML pages (server-side or in `auth-gate.js` by role) | `server.js` / `auth-gate.js` | 1 h |
| 5 | Rename web role `founder` → `deep_dreamer`; update hierarchy + mapping | `patreon-auth.js`, `auth-middleware.js`, `user-profiles.js` | 1 h |
| 6 | Link Patreon ↔ Discord identity (account-link table) | new `lib/identity-link.js` + `bot_v2.py` | 3–4 h |
| 7 | Enforce agent count / quota by tier server-side (Phase 2 of tiers doc) | `routes/dream.js` | 2 h |

---

## 6. Demo readiness verdict

- **Can demo today:** Patreon sign-up → OAuth login → Dream Chat (6 agents) → Creator Suite,
  with trading hidden by setting `LANTERN_DISABLE_TRADING=1` server-wide and configuring the
  Discord "Deep Dreamer" role manually.
- **Cannot honestly demo today:** *per-user* "no trade access" while trading is enabled for
  others, and an automatic web↔Discord role link. Those need tasks 2–4 and 6 above.

**Bottom line:** the happy path (subscribe → chat → create) works; the *access-control* part of
the request ("no access to trade", linked roles) is aspirational and needs the worklist above.

---

## 7. Addendum — canonical-code reconciliation (2026-06-18)

§§1–6 above were drafted from the **OneDrive working copy**, which is stale relative to the
canonical repo (`C:\dev\lantern-os`). Verifying against canonical code corrected several findings:

- **§4.1 (env vars):** Canonical `.env.example` *already* had a Patreon OAuth section. The real
  problem was **misleading config** (documented `PATREON_TIER_*` vars the code never reads — tier→role
  is hardcoded in `patreon-auth.js`) plus a **missing local-dev redirect URI**. ✅ Fixed (PR #699).
- **§4.3 (role gating "never wired"):** **Incorrect for canonical.** `routes/pages.js` *does* gate
  pages server-side: `create.html`→`founder` (so Deep Dreamer reaches the Creator Suite),
  `trader-dashboard.html`/`kalshi-terminal.html`→`admin`. Issue #696 was largely already done.
- **§4.2 (trade access):** **Partially correct.** trader-dashboard/kalshi-terminal were admin-gated,
  but `trading.html`/`trading-news.html` were only auth-gated, and **all `/api/trading/*` endpoints
  were ungated**. ✅ Fixed (PR #699) via a per-user `trade` entitlement: `entitlements.trade`
  defaults `false`, an `/api/trading/*` guard, page gating by entitlement, and nav hiding. A
  Deep Dreamer (`founder`) now has **no trade access** unless explicitly granted — without needing
  the server-wide `LANTERN_DISABLE_TRADING=1` blunt instrument.

**Still open (separate follow-ups):** #697 (Patreon↔Discord identity link) and #698 (`founder`
role rename) — larger/riskier, intentionally not bundled into PR #699.
