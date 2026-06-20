/**
 * Patreon OAuth 2.0 authentication module.
 * Handles login/logout, session management, and role mapping from Patreon tier data.
 * Requires: Node 18+ (native fetch), express-session, crypto, querystring
 */

const crypto = require("crypto");
const querystring = require("querystring");
const { getOrCreateFromPatreon, getProfile } = require("./user-profiles");

// Use native fetch (Node 18+) or require a polyfill
const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");

// Tier ID to Lantern role mapping.
// Campaign: Dream Journal By Lantern OS (ID: 16143763)
const TIER_TO_ROLE = {
  "28764312": "supporter",     // Wanderer ($5)
  "28740619": "deep_dreamer",  // Deep Dreamer ($20) — renamed from "founder" (#698: avoid collision with the Discord top tier)
  "28764307": "admin",         // Synthesasia Guild ($200)
};

/**
 * Generate PKCE code challenge for OAuth security.
 */
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

// ── OAuth state cookie (issue #689) ──────────────────────────────────────────
// The in-memory session does not survive the cross-site redirect from
// patreon.com → 127.0.0.1 (or a server restart), causing "State mismatch". We
// also carry {state, verifier, return_to} in a signed, short-TTL HttpOnly cookie
// (SameSite=Lax so it returns on the top-level GET redirect) and recover from it
// on the callback when the session is gone.
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
    return (p && p.exp && Date.now() <= p.exp) ? p : null;
  } catch { return null; }
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
 * Resolve the OAuth redirect_uri from the request that served /start, so the
 * callback always returns to the SAME origin the flow began on. Behind Railway's
 * proxy, `x-forwarded-proto` + `host` give the public URL (e.g. lantern-os.net).
 * Falls back to the static env var only when no host header is present.
 * (Fixes cross-origin "State mismatch": flow started on lantern-os.net but the
 * env-configured redirect_uri pointed at 127.0.0.1.)
 */
function resolveRedirectUri(req) {
  const host = req.headers && req.headers.host;
  if (host) {
    const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
      || (req.socket && req.socket.encrypted ? "https" : "http");
    return `${proto}://${host}/api/auth/patreon/callback`;
  }
  return process.env.PATREON_REDIRECT_URI || null;
}

/**
 * Start OAuth flow: redirect to Patreon login.
 */
function handlePatreonStart(req, res, returnTo) {
  const clientId = process.env.PATREON_CLIENT_ID;
  const redirectUri = resolveRedirectUri(req);

  if (!clientId || !redirectUri) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Patreon OAuth not configured" }));
  }

  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString("hex");

  // Store in session for verification
  req.session.pkce_verifier = verifier;
  req.session.oauth_state = state;
  req.session.return_to = returnTo || "/";
  req.session.redirect_uri = redirectUri;

  const params = querystring.stringify({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "identity identity.memberships",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  // Belt-and-suspenders: also carry state/verifier in a signed short-TTL cookie
  // so the callback can recover them if the session was lost (issue #689).
  const oauthToken = signOauth({ state, verifier, return_to: returnTo || "/", redirect_uri: redirectUri, exp: Date.now() + 10 * 60 * 1000 });
  const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
  res.writeHead(302, {
    Location: `https://www.patreon.com/oauth2/authorize?${params}`,
    "Set-Cookie": `${OAUTH_COOKIE}=${encodeURIComponent(oauthToken)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
  });
  res.end();
}

/**
 * Handle OAuth callback from Patreon.
 */
async function handlePatreonCallback(req, res, query, deps) {
  const { code, state } = query;
  const { sendJson } = deps;

  console.log("[AUTH] Callback received - code:", code ? code.slice(0, 10) + "..." : "missing");
  console.log("[AUTH] Callback received - state:", state ? state.slice(0, 10) + "..." : "missing");
  console.log("[AUTH] Session oauth_state:", req.session.oauth_state ? req.session.oauth_state.slice(0, 10) + "..." : "missing");
  console.log("[AUTH] Session pkce_verifier:", req.session.pkce_verifier ? "present" : "missing");

  if (!code || !state) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing code or state" }));
  }

  // Recover from the signed cookie when the session was lost across the redirect
  // or a restart (issue #689). Session takes precedence; cookie is the fallback.
  const oauthCk = verifyOauth(readCookie(req, OAUTH_COOKIE));
  const expectedState = req.session.oauth_state || (oauthCk && oauthCk.state) || null;
  const verifier = req.session.pkce_verifier || (oauthCk && oauthCk.verifier) || null;
  // Reuse the EXACT redirect_uri used at /start (Patreon requires an exact match
  // at token exchange). Fall back to deriving it from this request's host.
  const redirectUri = req.session.redirect_uri || (oauthCk && oauthCk.redirect_uri) || resolveRedirectUri(req);
  console.log("[AUTH] Cookie oauth recovery:", oauthCk ? "present" : "none");

  // Verify state (constant-time-ish): require a non-empty expected state that matches
  if (!expectedState || state !== expectedState) {
    res.writeHead(403, { "Content-Type": "application/json", "Set-Cookie": `${OAUTH_COOKIE}=; Path=/; Max-Age=0` });
    return res.end(JSON.stringify({ error: "State mismatch" }));
  }

  try {
    // Exchange code for token (server-side, never expose client secret to browser)
    const token = await exchangePatreonCode(code, verifier, redirectUri);

    // Fetch user identity and membership data
    const user = await getPatreonUserWithMemberships(token);

    // Map tier to role; owner always gets admin
    const OWNER_IDS = new Set(["49294581"]);
    const patreonRole = OWNER_IDS.has(String(user.id)) ? "admin" : mapPatreonTierToRole(user.memberships);

    // Create or update user profile in local database
    const profile = getOrCreateFromPatreon(user, patreonRole);

    // Store in session (use profile data which may have local overrides)
    req.session.patreon = {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      tier: profile.tier,
      role: profile.role, // May be overridden locally
      token: token.access_token,
      expiresAt: Date.now() + (token.expires_in * 1000),
    };
    req.session.authenticated = true;

    // Clear PKCE
    delete req.session.pkce_verifier;
    delete req.session.oauth_state;

    const returnTo = req.session.return_to || (oauthCk && oauthCk.return_to) || "/dream-chat.html";
    delete req.session.return_to;

    // Explicitly save session before redirect; clear the one-time oauth cookie.
    req.session.save((err) => {
      const clearCookie = `${OAUTH_COOKIE}=; Path=/; Max-Age=0`;
      if (err) {
        console.error("[AUTH] Session save error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json", "Set-Cookie": clearCookie });
        return res.end(JSON.stringify({ error: "Session save failed" }));
      }
      console.log("[AUTH] Session saved, redirecting to:", returnTo);
      res.writeHead(302, { Location: returnTo, "Set-Cookie": clearCookie });
      res.end();
    });
  } catch (err) {
    console.error("Patreon callback error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * Exchange authorization code for access token (server-side).
 */
async function exchangePatreonCode(code, verifier, redirectUriArg) {
  const clientId = process.env.PATREON_CLIENT_ID;
  const clientSecret = process.env.PATREON_CLIENT_SECRET;
  const redirectUri = redirectUriArg || process.env.PATREON_REDIRECT_URI;

  console.log("[AUTH] Token exchange - code:", code.slice(0, 10) + "...");
  console.log("[AUTH] Token exchange - redirectUri:", redirectUri);
  console.log("[AUTH] Token exchange - verifier:", verifier ? "present" : "missing");

  const body = querystring.stringify({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  console.log("[AUTH] Token exchange body length:", body.length);

  const res = await fetchFn("https://www.patreon.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  return res.json();
}

/**
 * Fetch user identity and membership data from Patreon.
 */
async function getPatreonUserWithMemberships(token) {
  // Include memberships + their entitled tiers (relationship traversal, no invalid field params)
  const url = "https://www.patreon.com/api/oauth2/v2/identity" +
    "?include=memberships.currently_entitled_tiers" +
    "&fields%5Btier%5D=title,amount_cents";
  console.log("[AUTH] User fetch URL:", url);

  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log("[AUTH] User fetch error response:", errText);
    throw new Error(`User fetch failed: ${res.statusText} - ${errText}`);
  }

  const json = await res.json();
  console.log("[AUTH] User fetch success, data id:", json.data?.id);

  const { data, included } = json;

  // Find membership in included data
  const membership = (included || []).find((r) => r.type === "member");
  const tierIds = membership?.relationships?.currently_entitled_tiers?.data?.map((t) => t.id) || [];

  return {
    id: data.id,
    email: data.attributes.email,
    name: data.attributes.full_name,
    memberships: tierIds,
    primaryTier: tierIds[0] || null,
  };
}

/**
 * Map Patreon tier to Lantern role.
 */
function mapPatreonTierToRole(tierIds) {
  // Check tiers in order (highest privilege first)
  for (const tierId of tierIds) {
    if (TIER_TO_ROLE[tierId]) {
      return TIER_TO_ROLE[tierId];
    }
  }
  // Default to supporter if member but no tier mapping
  return tierIds.length > 0 ? "supporter" : "guest";
}

/**
 * Get current session info (for /api/auth/session).
 */
function getSessionInfo(req) {
  if (req.session && req.session.authenticated) {
    const role = req.session.patreon.role;
    const profile = getProfile(req.session.patreon.id);
    // Admins hold all entitlements implicitly; otherwise read the profile flag.
    const trade = role === "admin" || !!(profile && profile.entitlements && profile.entitlements.trade === true);
    return {
      authenticated: true,
      role,
      entitlements: { trade },
      user: {
        id: req.session.patreon.id,
        name: req.session.patreon.name,
        email: req.session.patreon.email,
        tier: req.session.patreon.tier,
      },
    };
  }
  // Local-only admin bypass (matches auth-middleware isLocalBypass):
  // dev port 4178, or LANTERN_LOCAL_ADMIN=1 on a loopback connection.
  const devPort = req.socket && req.socket.localPort;
  const ip = (req.socket && req.socket.remoteAddress) || "";
  const loopbackAdmin =
    process.env.LANTERN_LOCAL_ADMIN === "1" &&
    (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
  if (devPort === 4178 || loopbackAdmin) {
    return { authenticated: true, role: "admin", entitlements: { trade: true }, user: { id: "dev", name: "Dev", email: "", tier: "dev" } };
  }
  return { authenticated: false, role: "guest" };
}

/**
 * Logout: clear session.
 */
function handleLogout(req, res) {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }
}

/**
 * Middleware: require specific role.
 */
function requirePatreonRole(requiredRole) {
  // deep_dreamer is the $20 web tier; `founder` kept as a legacy alias so sessions
  // persisted before the #698 rename still resolve to level 2.
  const roleHierarchy = { guest: 0, supporter: 1, deep_dreamer: 2, founder: 2, admin: 3 };
  const requiredLevel = roleHierarchy[requiredRole] || 0;

  return (req, res, next) => {
    const session = getSessionInfo(req);
    const userLevel = roleHierarchy[session.role] || 0;

    if (userLevel < requiredLevel) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "Insufficient permissions",
          required: requiredRole,
          current: session.role,
        })
      );
    }

    // Attach to request for downstream handlers
    req.patreonSession = session;
    next();
  };
}

module.exports = {
  handlePatreonStart,
  handlePatreonCallback,
  getSessionInfo,
  handleLogout,
  requirePatreonRole,
  mapPatreonTierToRole,
  // exported for tests (issue #689 oauth-cookie recovery)
  signOauth,
  verifyOauth,
  readCookie,
};
