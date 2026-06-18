/**
 * Patreon OAuth 2.0 authentication module.
 * Handles login/logout, session management, and role mapping from Patreon tier data.
 * Requires: Node 18+ (native fetch), express-session, crypto, querystring
 */

const crypto = require("crypto");
const querystring = require("querystring");
const { getOrCreateFromPatreon } = require("./user-profiles");

// Use native fetch (Node 18+) or require a polyfill
const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");

// Tier ID to Lantern role mapping.
// Campaign: Dream Journal By Lantern OS (ID: 16143763)
const TIER_TO_ROLE = {
  "28764312": "supporter",     // Wanderer ($5)
  "28740619": "founder",       // Deep Dreamer ($20)
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

/**
 * Start OAuth flow: redirect to Patreon login.
 */
function handlePatreonStart(req, res, returnTo) {
  const clientId = process.env.PATREON_CLIENT_ID;
  const redirectUri = process.env.PATREON_REDIRECT_URI;

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

  const params = querystring.stringify({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "identity identity.memberships",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.writeHead(302, { Location: `https://www.patreon.com/oauth2/authorize?${params}` });
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

  // Verify state
  if (state !== req.session.oauth_state) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "State mismatch" }));
  }

  try {
    // Exchange code for token (server-side, never expose client secret to browser)
    const token = await exchangePatreonCode(code, req.session.pkce_verifier);

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

    const returnTo = req.session.return_to || "/dream-chat.html";
    delete req.session.return_to;

    // Explicitly save session before redirect
    req.session.save((err) => {
      if (err) {
        console.error("[AUTH] Session save error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Session save failed" }));
      }
      console.log("[AUTH] Session saved, redirecting to:", returnTo);
      res.writeHead(302, { Location: returnTo });
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
async function exchangePatreonCode(code, verifier) {
  const clientId = process.env.PATREON_CLIENT_ID;
  const clientSecret = process.env.PATREON_CLIENT_SECRET;
  const redirectUri = process.env.PATREON_REDIRECT_URI;

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
    return {
      authenticated: true,
      role: req.session.patreon.role,
      user: {
        id: req.session.patreon.id,
        name: req.session.patreon.name,
        email: req.session.patreon.email,
        tier: req.session.patreon.tier,
      },
    };
  }
  // Dev bypass: port 4178 skips auth gate (admin session, local only)
  const devPort = req.socket && req.socket.localPort;
  if (devPort === 4178) {
    return { authenticated: true, role: "admin", user: { id: "dev", name: "Dev", email: "", tier: "dev" } };
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
  const roleHierarchy = { guest: 0, supporter: 1, founder: 2, admin: 3 };
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
};
