"use strict";
/**
 * Indeed connector routes — connect a user's real Indeed account (OAuth 2.1 + PKCE) so
 * the assistant can search Indeed jobs on their behalf via the Anthropic MCP-connector
 * path. See lib/indeed-oauth.js + lib/indeed-token-store.js.
 *
 *   GET  /api/job/indeed/status       → { connected, scope, expiresAt, ... }
 *   GET  /api/job/indeed/connect      → 302 to Indeed authorize (starts OAuth)
 *   GET  /api/job/indeed/callback     → exchange code → store token → back to chat
 *   POST /api/job/indeed/disconnect   → forget the token
 *   GET  /api/job/indeed/_probe       → operator-only: verify DCR works (no user token)
 */

const crypto = require("crypto");
const oauth = require("../lib/indeed-oauth");
const tokens = require("../lib/indeed-token-store");
const { getEffectiveUserId } = require("../lib/session-identity");
const { isOperatorRequest } = require("../lib/request-auth");
const { resolveSessionSecret } = require("../lib/session-secret");

const COOKIE = "lantern_indeed_oauth";
// Sign the OAuth state cookie with the SAME fail-closed secret as the session, never a
// hardcoded literal (#2619 — the fix lib/oauth-core.js already carries). The previous
// `process.env.SESSION_SECRET || "lantern-indeed-oauth-secret"` fell back to a constant
// that is public in this repo, so on any deploy without SESSION_SECRET the OAuth state
// cookie was signed with a key an attacker can read here — i.e. forgeable, which is
// exactly what signing the state is meant to prevent. resolveSessionSecret throws
// beyond loopback instead of falling back.
function _secret() { return resolveSessionSecret(); }
function _sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", _secret()).update(data).digest("base64url"); // codeql[js/insufficient-password-hash]
  return `${data}.${sig}`;
}
function _verify(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", _secret()).update(data).digest("base64url"); // codeql[js/insufficient-password-hash]
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8")); return p && p.exp && Date.now() <= p.exp ? p : null; } catch { return null; }
}
function _readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function _redirectUri(req) {
  const host = (req.headers && req.headers.host) || "127.0.0.1";
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (req.socket && req.socket.encrypted ? "https" : "http");
  return `${proto}://${host}/api/job/indeed/callback`;
}
function _json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

module.exports = async function indeedRoutes(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith("/api/job/indeed/")) return false;
  const method = req.method;
  const userId = getEffectiveUserId(req);

  // Operator-only DCR probe: does Indeed accept our self-registration?
  if (method === "GET" && p === "/api/job/indeed/_probe") {
    if (!isOperatorRequest(req)) return _json(res, 403, { error: "operator_only" }), true;
    const redirectUri = _redirectUri(req);
    const r = await oauth.ensureClient(redirectUri);
    return _json(res, r.ok ? 200 : 502, {
      redirectUri,
      registerUrl: oauth.REGISTER_URL,
      ok: r.ok,
      cached: r.cached || false,
      clientIdPreview: r.client_id ? `${String(r.client_id).slice(0, 8)}…` : null,
      hasClientSecret: !!r.client_secret,
      error: r.error || null,
      detail: r.detail || null,
    }), true;
  }

  if (method === "GET" && p === "/api/job/indeed/status") {
    if (!userId) return _json(res, 200, { connected: false, authenticated: false }), true;
    return _json(res, 200, { authenticated: true, ...tokens.publicStatus(userId) }), true;
  }

  if (method === "POST" && p === "/api/job/indeed/disconnect") {
    if (!userId) return _json(res, 401, { error: "not_authenticated" }), true;
    return _json(res, 200, { ok: true, removed: tokens.remove(userId) }), true;
  }

  if (method === "GET" && p === "/api/job/indeed/connect") {
    if (!userId) return _json(res, 401, { error: "not_authenticated" }), true;
    const redirectUri = _redirectUri(req);
    const client = await oauth.ensureClient(redirectUri);
    if (!client.ok) return _json(res, 502, { error: "client_registration_failed", detail: client.error }), true;
    const { verifier, challenge } = oauth.generatePkce();
    const state = crypto.randomBytes(16).toString("hex");
    const cookie = _sign({ state, verifier, redirectUri, userId, exp: Date.now() + 10 * 60 * 1000 });
    const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
    res.writeHead(302, {
      Location: oauth.buildAuthorizeUrl({ clientId: client.client_id, redirectUri, state, challenge }),
      "Set-Cookie": `${COOKIE}=${encodeURIComponent(cookie)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
    });
    res.end();
    return true;
  }

  if (method === "GET" && p === "/api/job/indeed/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const err = url.searchParams.get("error");
    const clear = `${COOKIE}=; Path=/; Max-Age=0`;
    if (err) { res.writeHead(302, { "Set-Cookie": clear, Location: `/chat.html?indeed=error&reason=${encodeURIComponent(err)}` }); return res.end(), true; }
    const ck = _verify(_readCookie(req, COOKIE));
    if (!code || !state || !ck || ck.state !== state) {
      res.writeHead(302, { "Set-Cookie": clear, Location: "/chat.html?indeed=error&reason=state" });
      return res.end(), true;
    }
    const client = await oauth.ensureClient(ck.redirectUri); // cached from /connect
    if (!client.ok) { res.writeHead(302, { "Set-Cookie": clear, Location: "/chat.html?indeed=error&reason=client" }); return res.end(), true; }
    const ex = await oauth.exchangeCode({ client, code, verifier: ck.verifier, redirectUri: ck.redirectUri });
    if (!ex.ok) { res.writeHead(302, { "Set-Cookie": clear, Location: `/chat.html?indeed=error&reason=${encodeURIComponent(ex.error)}` }); return res.end(), true; }
    tokens.save(ck.userId, ex.token);
    res.writeHead(302, { "Set-Cookie": clear, Location: "/chat.html?indeed=connected" });
    return res.end(), true;
  }

  return _json(res, 404, { error: "not_found" }), true;
};
