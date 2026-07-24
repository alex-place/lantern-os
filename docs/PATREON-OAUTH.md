# Patreon OAuth 2.0 Integration

Lantern OS includes a built-in Patreon OAuth login system that gates the entire site and maps Patreon tiers to role-based access levels.

## Features

- **OAuth 2.0 with PKCE** — Secure authentication without storing passwords
- **Session Management** — Server-side session cookies with 7-day TTL
- **Role-Based Access Control** — Access tiers: guest, supporter, deep_dreamer (paid), admin (owner only)
- **Profile Page** — User can view their Patreon info and logout from `/profile.html`
- **Auto-Redirect** — Unauthenticated users redirected to `/auth.html`
- **No Vendor Lock-in** — Pure Node.js implementation, no external auth services

## Setup

### 1. Create a Patreon OAuth App

1. Go to https://www.patreon.com/portal/registration/register-oauth-application
2. Fill in the OAuth app form:
   - **App Name:** Lantern OS (or your custom name)
   - **Redirect URI:** `http://127.0.0.1:4177/api/auth/patreon/callback` (dev) or `https://your-domain.com/api/auth/patreon/callback` (production)
3. Accept terms and submit
4. Copy your **Client ID** and **Client Secret** — keep the secret safe!

### 2. Get Your Campaign ID (required)

`PATREON_CAMPAIGN_ID` is the **numeric API campaign id**, used to scope role gating to *your*
campaign (a member's pledges to other creators must not count). It is **not** the vanity slug
in the page URL — `patreon.com/cw/UnisonaAI` has no numeric id in it. Get it from the API while
authenticated as the campaign owner:

```bash
curl -s https://www.patreon.com/api/oauth2/v2/campaigns \
  -H "Authorization: Bearer <owner-access-token>"   # → data[].id is your PATREON_CAMPAIGN_ID
```

If unset, gating only works for a user who backs exactly one campaign; anyone who also backs
another creator fails closed to `guest`.

### 3. Configure `.env`

Add these variables to your `.env` file:

```bash
# Patreon OAuth credentials
PATREON_CLIENT_ID=your_client_id_here
PATREON_CLIENT_SECRET=your_client_secret_here
PATREON_REDIRECT_URI=http://127.0.0.1:4177/api/auth/patreon/callback
PATREON_CAMPAIGN_ID=your_campaign_id_here

# Session secret (can be any random string)
SESSION_SECRET=your_session_secret_here
```

For production, set:
- `PATREON_REDIRECT_URI=https://your-domain.com/api/auth/patreon/callback`
- `NODE_ENV=production` (enables secure cookies over HTTPS)

#### Local dev (`.env.local`, dual-boot ports)

For local development put the credentials in `.env.local` at repo root
(gitignored — do **not** commit). The `redirect_uri` auto-derives from the
request host, but Patreon requires an **exact match**, so register both
dual-boot ports in the Patreon app's Redirect URIs:

```text
http://localhost:4178/api/auth/patreon/callback   (dev server)
http://localhost:4177/api/auth/patreon/callback   (stable server)
```

Smoke test after restart:

```bash
# should redirect to patreon.com with your real client_id:
curl -s -i "http://localhost:4178/api/auth/patreon/start?returnTo=%2F" | grep -i location
```

Then click **Connect with Patreon** on `/auth.html`, complete consent, and
confirm `/api/auth/session` shows `provider:"patreon"` and the mapped role.

### 4. Restart the Server

```bash
npm run dev
```

The server will now:
- Redirect unauthenticated users to `/auth.html` (Patreon login page)
- Gate all pages behind OAuth
- Store sessions in memory (default) or connect a database for persistence

## Role Mapping

Patreon tiers are mapped to roles by **pledge amount** (not campaign-specific tier IDs),
so moving to a new campaign — e.g. `patreon.com/cw/UnisonaAI` — never breaks gating. The
mapping is defined in `lib/auth-providers.js` (`roleForAmountCents`),
and role resolution is **scoped to your `PATREON_CAMPAIGN_ID`** so a member's pledges to
*other* creators can't grant (or block) a role here.

| Entitled pledge (this campaign) | Role | Plan / access |
|-----------|--------------|--------|
| Free / not a paying member | `guest` | Public pages only |
| ≥ $20 | `deep_dreamer` | **Pro** — all paid features + real-money trading unlock |
| ≥ $200 | `pilot` | **Pilot** — everything in Pro plus the autonomous AI trader |

> **Legacy note:** the **$5 Member** tier is **retired and no longer sold**. Its
> `≥ $5 → supporter` mapping is retained *only* so grandfathered patrons keep their
> role; that `supporter` role now sits at the **Free** plan floor (see
> `lib/plan-matrix.js` `ROLE_TO_PLAN`). The currently sold ladder is
> **Free / $20 Pro / $200 Pilot** — do not re-advertise $5 as a paid gate.

Notes:
- **A purchasable tier NEVER grants `admin`.** `admin` is full operator/staff access
  (provider keys, GPU dispatch, feature flags, and the accounts console that can reset any
  password / grant admin), so tying it to a price point would let anyone buy site takeover.
  The top purchasable tier is `pilot` ($200) — it unlocks the autonomous AI trader but
  **not** `admin`; `admin` comes **only** from `LANTERN_ADMIN_IDS`.
- **Fail-closed:** a $0 free-tier member, a below-$5 custom pledge, or an entitlement whose
  amount can't be resolved all yield `guest` (never a free paid role).
- **Re-pricing?** Override the thresholds (cents): `PATREON_SUPPORTER_CENTS` (legacy),
  `PATREON_DEEP_DREAMER_CENTS`, `PATREON_PILOT_CENTS`.
- **Demotion:** logging in via Patreon re-baselines the paid role to the *current*
  entitlement, so a cancelled/downgraded membership loses the tier (staff roles set via
  `setUserRole`/override are never demoted by a login).
- **Owner admin** is account-bound: set `LANTERN_ADMIN_IDS` to the campaign owner's Patreon
  **user id** (numeric, from `/api/oauth2/v2/identity` while logged in as the owner). It
  changes when you move to a new Patreon account. If unset, **no one is admin.**
- Restart the server after changing any of these.

## API Endpoints

All OAuth-related endpoints are in `routes/auth.js`:

### `GET /api/auth/session`
Returns current session info.

**Response (authenticated):**
```json
{
  "authenticated": true,
  "role": "supporter",
  "user": {
    "id": "12345",
    "name": "John Doe",
    "email": "john@example.com",
    "tier": "<entitled-tier-id>"
  }
}
```

**Response (not authenticated):**
```json
{
  "authenticated": false,
  "role": "guest"
}
```

### `GET /api/auth/patreon/start`
Initiates OAuth flow. Query parameter: `returnTo` (optional, defaults to `/`).

**Redirects to:** Patreon OAuth consent screen

### `GET /api/auth/patreon/callback`
OAuth callback endpoint. Patreon redirects here with `code` and `state` parameters.

**Redirects to:** Original page or `/dream-chat.html`

### `POST /api/auth/logout`
Clears session and logs out user.

**Response:**
```json
{ "ok": true }
```

## Files

| File | Purpose |
|------|---------|
| `lib/oauth-core.js` | Provider-agnostic flow engine: `handleOAuthStart` / `handleOAuthCallback` (exchange → fetchUser → role → profile → session) |
| `lib/auth-providers.js` | Per-provider config incl. the `patreon` block (authorize/token URLs, scope, `fetchUser`, `roleForAmountCents` mapping) |
| `lib/user-profiles.js` | `getOrCreateFromIdentity` — profile creation (records `patreonId` + tier) |
| `lib/patreon-auth.js` | Legacy Patreon-specific OAuth logic (superseded by the provider-agnostic pair above) |
| `routes/auth.js` | Route handlers for OAuth endpoints |
| `public/auth.html` | Patreon login page with tier cards |
| `public/profile.html` | User profile page with logout button |
| `public/js/auth-gate.js` | Client-side auth enforcement script |

## Troubleshooting

### "User fetch failed: Bad Request"
The Patreon API rejected the identity endpoint. Check:
1. Token is valid (token exchange succeeded but user fetch failed)
2. Scope is correct: `identity identity.memberships`
3. Bearer token is properly formatted in Authorization header

### Session not persisting
Sessions use in-memory storage by default. Restart clears all sessions. For production:
1. Connect a database store (e.g., `connect-mongo` or `connect-pg-simple`)
2. Add to `server.js`:
   ```javascript
   const store = require('connect-mongo')(session);
   const sessionMiddleware = session({
     store: new store({ url: 'mongodb://...' }),
     // ... rest of config
   });
   ```

### Cookies not being set
Check:
1. `httpOnly: true` is set (cookies are not accessible to JavaScript)
2. Domain/path match correctly (local dev uses `127.0.0.1:4177`)
3. Browser allows third-party cookies for local development

### OAuth redirect loop
Check `PATREON_REDIRECT_URI` matches:
1. The exact URL in your OAuth app settings (case-sensitive)
2. The URL in `handlePatreonStart()` callback

## Development vs. Production

| Setting | Dev | Prod |
|---------|-----|------|
| `PATREON_REDIRECT_URI` | `http://127.0.0.1:4177/api/auth/patreon/callback` | `https://your-domain.com/api/auth/patreon/callback` |
| `NODE_ENV` | (not set) | `production` |
| Cookies: `secure` | `false` | `true` (HTTPS only) |
| Session Store | Memory (cleared on restart) | Persistent database |
| Session Secret | Can be any string | Use `openssl rand -hex 32` |

## Security Considerations

1. **Client Secret** — Never expose to the browser. Keep in `.env` only.
2. **PKCE** — OAuth flow uses PKCE (Proof Key for Code Exchange) for additional security.
3. **HTTPS** — Set `secure: true` in cookie config when deploying to production.
4. **Same-Site** — Cookies use `sameSite: 'lax'` to prevent CSRF attacks.
5. **HTTP-Only** — Session cookies are `httpOnly` and cannot be accessed by JavaScript.

## Testing

### Test OAuth Flow in Browser
1. Open `http://127.0.0.1:4177`
2. Click "Continue with Patreon" button
3. Approve OAuth scope on Patreon
4. Check `/profile.html` to see your user info and role
5. Test logout button

### Test Session Persistence
```bash
# After logging in, in browser console:
fetch('/api/auth/session', { credentials: 'include' })
  .then(r => r.json())
  .then(console.log)
```

Should return your user info and role.

## Support

For issues or questions:
1. Check the server logs for `[AUTH]` debug messages
2. Review `.env` configuration (PATREON_CAMPAIGN_ID + LANTERN_ADMIN_IDS)
3. Verify Patreon app settings match your redirect URI
4. Open an issue on GitHub with full error logs
