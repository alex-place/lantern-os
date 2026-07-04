/**
 * Generic OAuth 2.0 + PKCE engine (ADR-0016).
 *
 * One authorize → token → userinfo flow drives every provider in the registry
 * (auth-providers.js). Generalized from the hardened Patreon implementation
 * (#689): PKCE S256, a signed short-TTL HttpOnly state cookie that survives the
 * cross-site redirect / server restart, and exact redirect_uri reuse at token
 * exchange.
 *
 * On success it writes the provider-agnostic `req.session.user` identity via
 * session-identity.setSessionUser and redirects to the caller's returnTo.
 */

const crypto = require("crypto");
const querystring = require("querystring");
const { getProvider, resolveRole } = require("./auth-providers");
const {
  getOrCreateFromIdentity,
  getProfileByIdentity,
  linkIdentity,
  publicProfile,
} = require("./user-profiles");
const { establishSession } = require("./session-identity");

const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");

// ── PKCE ──────────────────────────────────────────────────────────────────────
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return { verifier, challenge };
}

// ── Signed state cookie (issue #689) ────────────────────────────────────────────
// The in-memory session may not survive the provider → 127.0.0.1 redirect (or a
// restart). We also carry {state, verifier, return_to, redirect_uri, provider} in a
// signed, short-TTL HttpOnly cookie (SameSite=Lax) and recover from it on callback.
const OAUTH_COOKIE = "lantern_oauth";
function _oauthSecret() {
  return process.env.SESSION_SECRET || process.env.PATREON_CLIENT_SECRET || "lantern-oauth-secret";
}
function signOauth(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", _oauthSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function verifyOauth(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", _oauthSecret()).update(data).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return p && p.exp && Date.now() <= p.exp ? p : null;
  } catch {
    return null;
  }
}
function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/**
 * A safe, same-origin returnTo path. Rejects absolute URLs, protocol-relative
 * (`//host`), and backslash tricks so a crafted `returnTo` can't turn the callback
 * into an open redirect.
 */
function safeReturnTo(returnTo, fallback = "/") {
  if (typeof returnTo !== "string" || !returnTo) return fallback;
  if (!returnTo.startsWith("/")) return fallback; // must be root-relative
  if (returnTo.startsWith("//") || returnTo.startsWith("/\\")) return fallback; // no proto-relative
  if (returnTo.includes("\\")) return fallback;
  return returnTo;
}

/**
 * Build the redirect_uri for a provider from the request that served /start, so
 * the callback returns to the SAME origin the flow began on (Railway/Cloudflare
 * forward the public host). Falls back to a per-provider env override.
 */
function resolveRedirectUri(req, providerId) {
  const host = req.headers && req.headers.host;
  if (host) {
    const proto =
      (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
      (req.socket && req.socket.encrypted ? "https" : "http");
    return `${proto}://${host}/api/auth/${providerId}/callback`;
  }
  // Legacy single-provider override kept for Patreon; generic override otherwise.
  if (providerId === "patreon" && process.env.PATREON_REDIRECT_URI) return process.env.PATREON_REDIRECT_URI;
  return process.env.OAUTH_REDIRECT_BASE
    ? `${process.env.OAUTH_REDIRECT_BASE}/api/auth/${providerId}/callback`
    : null;
}

/** Redirect the browser to the login page with a surfaced error (fixes #1877). */
function _redirectWithError(res, code, provider) {
  const q = querystring.stringify({ error: code, provider });
  res.writeHead(302, { Location: `/auth.html?${q}` });
  res.end();
}

/**
 * Start an OAuth flow for `providerId`. On misconfiguration it redirects back to
 * /auth.html with a friendly error instead of dumping a raw 500 (#1877).
 */
function handleOAuthStart(providerId, req, res, returnTo, opts = {}) {
  const provider = getProvider(providerId);
  if (!provider) {
    _redirectWithError(res, "unknown_provider", providerId);
    return;
  }
  const clientId = provider.clientId();
  const redirectUri = resolveRedirectUri(req, providerId);
  if (!clientId || !provider.clientSecret() || !redirectUri) {
    _redirectWithError(res, "provider_unconfigured", providerId);
    return;
  }

  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString("hex");
  const rt = safeReturnTo(returnTo, "/");
  // Link mode: an already-signed-in user connecting another provider to THIS
  // account. Carry the target profile id through the flow so the callback links
  // instead of switching/creating an account (#profile-link).
  const linkTo = opts.linkTo || null;

  req.session.pkce_verifier = verifier;
  req.session.oauth_state = state;
  req.session.oauth_provider = providerId;
  req.session.return_to = rt;
  req.session.redirect_uri = redirectUri;
  req.session.oauth_link_to = linkTo;

  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: provider.scope,
    state,
    ...(provider.usePkce ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
    ...(provider.extraAuthorizeParams || {}),
  };

  const oauthToken = signOauth({
    state,
    verifier,
    provider: providerId,
    return_to: rt,
    redirect_uri: redirectUri,
    link_to: linkTo,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
  res.writeHead(302, {
    Location: `${provider.authorizeUrl}?${querystring.stringify(params)}`,
    "Set-Cookie": `${OAUTH_COOKIE}=${encodeURIComponent(oauthToken)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
  });
  res.end();
}

/** Exchange an authorization code for tokens (server-side; secret never leaves). */
async function exchangeCode(provider, code, verifier, redirectUri) {
  const body = querystring.stringify({
    grant_type: "authorization_code",
    code,
    client_id: provider.clientId(),
    client_secret: provider.clientSecret(),
    redirect_uri: redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
  });
  const r = await fetchFn(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!r.ok) {
    // Truncate the provider error body — it only ever reaches server logs (the
    // callback maps this to a generic /auth.html?error=oauth_failed for the user),
    // but a bounded snippet keeps logs clean and avoids echoing anything large.
    const snippet = (await r.text().catch(() => "")).slice(0, 200);
    throw new Error(`Token exchange failed (${provider.id}): ${r.status} ${snippet}`);
  }
  return r.json();
}

/**
 * Handle an OAuth callback for `providerId`: verify state, exchange code, fetch the
 * user, map the role, upsert/link the profile, and establish the session.
 */
async function handleOAuthCallback(providerId, req, res, query) {
  const provider = getProvider(providerId);
  if (!provider) {
    _redirectWithError(res, "unknown_provider", providerId);
    return;
  }
  const { code, state } = query;
  const clearCookie = `${OAUTH_COOKIE}=; Path=/; Max-Age=0`;

  if (!code || !state) {
    res.writeHead(400, { "Content-Type": "application/json", "Set-Cookie": clearCookie });
    return res.end(JSON.stringify({ error: "Missing code or state" }));
  }

  // Recover state/verifier/redirect_uri from session, else the signed cookie (#689).
  const ck = verifyOauth(readCookie(req, OAUTH_COOKIE));
  const expectedState = req.session.oauth_state || (ck && ck.state) || null;
  const verifier = req.session.pkce_verifier || (ck && ck.verifier) || null;
  const redirectUri =
    req.session.redirect_uri || (ck && ck.redirect_uri) || resolveRedirectUri(req, providerId);
  // Guard against a cookie minted for a different provider.
  const cookieProvider = req.session.oauth_provider || (ck && ck.provider) || providerId;

  if (!expectedState || state !== expectedState || cookieProvider !== providerId) {
    res.writeHead(403, { "Content-Type": "application/json", "Set-Cookie": clearCookie });
    return res.end(JSON.stringify({ error: "State mismatch" }));
  }

  // Link mode: connecting this provider to an already-signed-in account.
  const linkTo = req.session.oauth_link_to || (ck && ck.link_to) || null;

  try {
    const token = await exchangeCode(provider, code, verifier, redirectUri);
    const accessToken = token.access_token;
    const user = await provider.fetchUser(accessToken);
    const role = resolveRole(provider, user);

    // ── Link mode ── attach this identity to the current profile instead of
    // switching/creating. Refuse if the identity already belongs to a DIFFERENT
    // account (would hijack/merge). Keeps the existing session as-is.
    if (linkTo) {
      const owner = getProfileByIdentity(providerId, String(user.providerId));
      if (owner && owner.id !== linkTo) {
        res.writeHead(302, {
          "Set-Cookie": clearCookie,
          Location: `/profile.html?error=identity_in_use&provider=${providerId}`,
        });
        return res.end();
      }
      linkIdentity(linkTo, providerId, user.providerId, user.email, user.emailVerified === true);
      res.writeHead(302, {
        "Set-Cookie": clearCookie,
        Location: `/profile.html?linked=${providerId}`,
      });
      return res.end();
    }

    const { profile } = getOrCreateFromIdentity(providerId, user, role);

    // Resolve returnTo from the OLD session/cookie BEFORE regenerating the session
    // (regeneration drops the one-time flow state, which is what we want).
    const returnTo = safeReturnTo(req.session.return_to || (ck && ck.return_to), "/dream-chat.html");

    // establishSession regenerates the session id (anti-fixation) then persists.
    establishSession(
      req,
      {
        id: profile.id,
        name: profile.name,
        email: profile.email,
        emailVerified: profile.emailVerified === true,
        role: profile.role,
        tier: profile.tier,
        provider: providerId,
        token: accessToken,
        expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
      },
      (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json", "Set-Cookie": clearCookie });
          return res.end(JSON.stringify({ error: "Session save failed" }));
        }
        // Clear the OAuth flow cookie AND the explicit-signout marker (a fresh
        // login restores the local/dev admin bypass). #auth-signout
        res.writeHead(302, {
          Location: returnTo,
          "Set-Cookie": [clearCookie, "ln_signout=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"],
        });
        res.end();
      }
    );
    return publicProfile(profile);
  } catch (err) {
    console.error(`[AUTH] ${providerId} callback error:`, err.message);
    res.writeHead(302, { "Set-Cookie": clearCookie, Location: `/auth.html?error=oauth_failed&provider=${providerId}` });
    res.end();
  }
}

module.exports = {
  generatePkce,
  signOauth,
  verifyOauth,
  readCookie,
  safeReturnTo,
  resolveRedirectUri,
  handleOAuthStart,
  handleOAuthCallback,
  OAUTH_COOKIE,
};
