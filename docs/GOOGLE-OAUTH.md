# Google Sign-In Setup ("Continue with Google")

The provider-agnostic OAuth engine (ADR-0016) already ships a fully-wired Google
provider ([`apps/lantern-garage/lib/auth-providers.js`](../apps/lantern-garage/lib/auth-providers.js)).
It is **not code work** — you only need to create Google OAuth credentials and put
them in the environment. The "Continue with Google" button appears on
`/auth.html` **only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
set**; until then, clicking it shows *"That sign-in method isn't set up on this
server yet."*

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → project picker → **New Project** (or reuse an existing one). Name it
   e.g. `unisona-auth`. Create, then make sure it's the selected project.

## 2. Configure the OAuth consent screen

1. Left menu → **APIs & Services → OAuth consent screen**.
2. User type: **External** (unless everyone signing in is in your Google
   Workspace org). Create.
3. Fill the required fields:
   - **App name**: `Unisona` (this is what users see on the Google consent page).
   - **User support email**: your email.
   - **Developer contact email**: your email.
4. **Scopes**: you don't need to add any manually — the app requests only
   `openid`, `email`, and `profile`, which are the default non-sensitive scopes.
   Save and continue.
5. **Test users**: while the consent screen is in *Testing* status, only emails
   you add here can sign in. Add your own Google address. (To let anyone sign in,
   later hit **Publish app** — for basic profile/email scopes this needs no
   Google verification review.)

## 3. Create the OAuth client ID

1. Left menu → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID**.
3. **Application type**: **Web application**.
4. **Name**: `Unisona Web`.
5. **Authorized redirect URIs** — add one line per origin you serve from. These
   must match **exactly** (scheme, host, port, path). The app's callback path is
   always `/api/auth/google/callback`:
   - Local dev: `http://127.0.0.1:4177/api/auth/google/callback`
   - (Optional dev-server) `http://127.0.0.1:4178/api/auth/google/callback`
   - Production: `https://your-domain.com/api/auth/google/callback`
     (e.g. `https://unisona.ai/api/auth/google/callback`)
   > You do **not** need "Authorized JavaScript origins" — this is a server-side
   > (confidential) flow with PKCE; the browser never holds the client secret.
6. **Create**. Google shows your **Client ID** and **Client secret**.

## 4. Put the credentials in the environment

Add to your `.env` (repo root) or, for the stable deployment, `.env.local`:

```bash
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
# Recommended in any non-local deployment (signs the session + OAuth state cookies):
SESSION_SECRET=<random 32+ char string>
```

Restart the server. The Google button now renders on `/auth.html` and the flow
works end-to-end.

## 5. Verify

1. Open `/auth.html`, click **Continue with Google**.
2. You're redirected to Google, pick an account, consent.
3. You land back on the app, signed in. New Google identities get the free
   (`guest`) role by default; email is trusted as verified because Google asserts
   `email_verified`.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| *"…isn't set up on this server yet"* | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` not set (or server not restarted). |
| `redirect_uri_mismatch` on Google's page | The redirect URI you're hitting isn't in the client's Authorized redirect URIs — it must match scheme+host+port+path exactly. Behind Cloudflare/Railway the app builds the URI from the public host, so register the **public** `https://…` URI, not `127.0.0.1`. |
| `access_denied` / only some accounts work | Consent screen is in *Testing* — add the address as a Test user, or **Publish app**. |
| Works locally, fails in prod | Register the production redirect URI too, and set `SESSION_SECRET` in prod so the signed state cookie survives the round-trip. |

## How it maps to the code (reference)

- Provider config: `lib/auth-providers.js` → `PROVIDERS.google`.
- Generic authorize/token/userinfo + PKCE + signed state cookie: `lib/oauth-core.js`.
- Redirect URI is derived from the request host (`resolveRedirectUri`), so no
  Google-specific redirect env var is needed.
- Routes: `GET /api/auth/google/start` and `GET /api/auth/google/callback`
  (`routes/auth.js`).
