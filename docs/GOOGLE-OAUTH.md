# Google Sign-In Setup ("Continue with Google")

The provider-agnostic OAuth engine (ADR-0016) already ships a fully-wired Google
provider ([`lib/auth-providers.js`](../lib/auth-providers.js)).
It is **not code work** — you only need to create Google OAuth credentials and put
them in the environment. The "Continue with Google" button works on `/auth.html`
**only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set**; until
then it shows *"That sign-in method isn't set up on this server yet."*

## 1. Create / select a Google Cloud project
<https://console.cloud.google.com/> → project picker → **New Project** (or reuse
one). Make sure it's the selected project.

## 2. Configure the consent screen (Google Auth Platform wizard)
- **App name:** `Unisona` (no URLs / no the word "Google", or it's rejected)
- **User support email:** your email
- **Audience:** **External**
- **Contact Information:** your email
- Finish → agree to the policy → Create.

This wizard only creates the consent screen — you still need the client below.

## 3. Create the OAuth client ID
**Clients / Credentials → Create client → Application type: Web application.**
- **Authorized JavaScript origins:** leave empty (server-side PKCE flow).
- **Authorized redirect URIs** — add each, matching **exactly** (scheme, host,
  port, path). The callback path is always `/api/auth/google/callback`:
  - `http://127.0.0.1:4177/api/auth/google/callback`  (local)
  - `http://127.0.0.1:4178/api/auth/google/callback`  (dev server, optional)
  - `https://your-domain.com/api/auth/google/callback`  (production, e.g.
    `https://unisona.ai/api/auth/google/callback`)
- **Create** → copy the **Client ID** and **Client secret**.

## 4. Put the credentials in the environment
Add to `.env` (repo root) or, for the stable deployment, `.env.local`:

```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
SESSION_SECRET=<random 32+ char string>   # recommended in any non-local deploy
```

Restart the server — the Google button goes live.

## 5. Add yourself as a test user (or publish)
While the consent screen is in *Testing*, only allow-listed accounts can sign in:
**Google Auth Platform → Audience → Test users → Add** your Google email, or click
**Publish app** (basic email/profile scopes need no verification review).

## Troubleshooting
| Symptom | Cause / Fix |
|---|---|
| *"…isn't set up on this server yet"* | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` not set, or server not restarted. |
| `redirect_uri_mismatch` | The redirect URI you're hitting isn't registered — it must match scheme+host+port+path exactly. Behind Cloudflare/Railway the app builds the URI from the public host, so register the **public** `https://…` URI. |
| `access_denied` | Consent screen in *Testing* — add the address as a Test user, or publish. |
| Works locally, fails in prod | Register the production redirect URI too, and set `SESSION_SECRET` in prod so the signed state cookie survives the round-trip. |

## Reference (code map)
- Provider config: `lib/auth-providers.js` → `PROVIDERS.google`.
- Generic authorize/token/userinfo + PKCE + signed state cookie: `lib/oauth-core.js`
  (redirect URI derived from the request host — no Google-specific redirect env var).
- Routes: `GET /api/auth/google/start` and `GET /api/auth/google/callback`
  (`routes/auth.js`).
