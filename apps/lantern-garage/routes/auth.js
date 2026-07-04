/**
 * Auth routes (ADR-0016): provider-agnostic OAuth (Google / Discord / Patreon),
 * local email+password, session, logout.
 *
 *   GET  /api/auth/session               → { authenticated, role, provider, entitlements, user, authRequired, providers }
 *   GET  /api/auth/providers             → { providers: [{ id, displayName }] }
 *   GET  /api/auth/:provider/start       → 302 to the provider (or /auth.html?error=… if unconfigured)
 *   GET  /api/auth/:provider/callback    → 302 back to returnTo on success
 *   POST /api/auth/local/register        → { ok, user }   (sets session)
 *   POST /api/auth/local/login           → { ok, user }   (sets session)
 *   POST /api/auth/logout                → { ok }
 */

const { getSessionInfo, handleLogout } = require("../lib/patreon-auth");
const { handleOAuthStart, handleOAuthCallback } = require("../lib/oauth-core");
const { getSessionUser } = require("../lib/session-identity");
const { handleLocalRegister, handleLocalLogin } = require("../lib/local-auth");
const { patreonAuthEnabled } = require("../lib/auth-middleware");
const { listEnabledProviders, getProvider } = require("../lib/auth-providers");

const START_RE = /^\/api\/auth\/([a-z]+)\/start$/;
const CALLBACK_RE = /^\/api\/auth\/([a-z]+)\/callback$/;

module.exports = async function authRoutes(req, res, url, deps) {
  const path = url.pathname;
  const method = req.method;

  console.log(`[AUTH] ${method} ${path}`);

  // GET /api/auth/session
  if (method === "GET" && path === "/api/auth/session") {
    const info = getSessionInfo(req);
    // Tell the client whether the login gate is active. When false, auth-gate.js
    // must not bounce guests to /auth.html.
    info.authRequired = patreonAuthEnabled();
    // Advertise which login methods are actually usable (configured OAuth + local).
    info.providers = listEnabledProviders();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(info));
  }

  // GET /api/auth/providers — configured login methods for the login page.
  if (method === "GET" && path === "/api/auth/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ providers: listEnabledProviders() }));
  }

  // POST /api/auth/local/register
  if (method === "POST" && path === "/api/auth/local/register") {
    await handleLocalRegister(req, res);
    return true;
  }

  // POST /api/auth/local/login
  if (method === "POST" && path === "/api/auth/local/login") {
    await handleLocalLogin(req, res);
    return true;
  }

  // GET /api/auth/:provider/start
  const startMatch = method === "GET" && START_RE.exec(path);
  if (startMatch) {
    const provider = startMatch[1];
    if (!getProvider(provider)) return false; // unknown → fall through to 404
    // Link mode: a signed-in user connecting another provider to THIS account
    // (?link=1). Only honored when there's an active session; the callback links
    // the identity and returns to the profile page.
    const linkMode = url.searchParams.get("link") === "1";
    const sessionUser = linkMode ? getSessionUser(req) : null;
    const linkTo = sessionUser && sessionUser.id ? sessionUser.id : null;
    const returnTo = linkTo ? "/profile.html" : url.searchParams.get("returnTo") || "/";
    handleOAuthStart(provider, req, res, returnTo, { linkTo });
    return true;
  }

  // GET /api/auth/:provider/callback
  const cbMatch = method === "GET" && CALLBACK_RE.exec(path);
  if (cbMatch) {
    const provider = cbMatch[1];
    if (!getProvider(provider)) return false;
    const query = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    };
    await handleOAuthCallback(provider, req, res, query);
    return true;
  }

  // POST /api/auth/logout
  if (method === "POST" && path === "/api/auth/logout") {
    handleLogout(req, res);
    return true;
  }

  return false;
};
