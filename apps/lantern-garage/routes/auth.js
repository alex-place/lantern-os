/**
 * Auth routes: Patreon OAuth login, session management, logout.
 */

const { handlePatreonStart, handlePatreonCallback, getSessionInfo, handleLogout } = require("../lib/patreon-auth");
const { patreonAuthEnabled } = require("../lib/auth-middleware");

module.exports = async function authRoutes(req, res, url, deps) {
  const path = url.pathname;
  const method = req.method;

  console.log(`[AUTH] ${method} ${path}`);

  // GET /api/auth/session
  if (method === "GET" && path === "/api/auth/session") {
    console.log("[AUTH] Handling /api/auth/session");
    const info = getSessionInfo(req);
    // Tell the client whether the Patreon login gate is active. When false, the
    // client-side auth-gate.js must not bounce guests to /auth.html.
    info.authRequired = patreonAuthEnabled();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(info));
  }

  // GET /api/auth/patreon/start?returnTo=...
  if (method === "GET" && path === "/api/auth/patreon/start") {
    console.log("[AUTH] Handling /api/auth/patreon/start");
    const returnTo = url.searchParams.get("returnTo") || "/";
    handlePatreonStart(req, res, returnTo);
    return true;
  }

  // GET /api/auth/patreon/callback?code=...&state=...
  if (req.method === "GET" && path === "/api/auth/patreon/callback") {
    const query = {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    };
    await handlePatreonCallback(req, res, query, deps);
    return true;
  }

  // POST /api/auth/logout
  if (req.method === "POST" && path === "/api/auth/logout") {
    handleLogout(req, res);
    return true;
  }

  return false;
};
