"use strict";
/**
 * indeed-oauth.js — OAuth 2.1 + PKCE client for Indeed's official MCP server so a user
 * can connect their Indeed account to Keystone and the assistant can search real Indeed
 * jobs on their behalf (Anthropic MCP-connector path: the stored token is passed as
 * mcp_servers[].authorization_token when the chat routes to Claude).
 *
 * Endpoints are discovered from Indeed's metadata (verified 2026-07):
 *   protected resource : https://mcp.indeed.com/claude/mcp
 *   auth server        : https://secure.indeed.com/
 *   authorize          : https://secure.indeed.com/oauth/v2/authorize   (PKCE S256)
 *   token              : https://apis.indeed.com/oauth/v2/tokens
 *   register (DCR)     : https://secure.indeed.com/oauth/v2/register
 *   scopes             : job_seeker.jobs.search job_seeker.profile.read
 *                        job_seeker.company.details.read offline_access
 *
 * All endpoints are env-overridable. The DCR client is app-level (per redirect_uri),
 * cached on disk so we register once. Per-user tokens live in indeed-token-store.js.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const fetchFn = typeof fetch !== "undefined" ? fetch : require("node-fetch");

const MCP_URL = process.env.INDEED_MCP_URL || "https://mcp.indeed.com/claude/mcp";
const AUTHORIZE_URL = process.env.INDEED_AUTHORIZE_URL || "https://secure.indeed.com/oauth/v2/authorize";
const TOKEN_URL = process.env.INDEED_TOKEN_URL || "https://apis.indeed.com/oauth/v2/tokens";
const REGISTER_URL = process.env.INDEED_REGISTER_URL || "https://secure.indeed.com/oauth/v2/register";
const SCOPES = process.env.INDEED_SCOPES
  || "job_seeker.jobs.search job_seeker.profile.read job_seeker.company.details.read offline_access";

const DATA_DIR = process.env.KEYSTONE_INDEED_DIR
  || path.join(__dirname, "..", "..", "..", "data", "indeed");
const CLIENT_FILE = path.join(DATA_DIR, "client.json");

function _ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ── PKCE ────────────────────────────────────────────────────────────────────
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Dynamic Client Registration (RFC 7591) ────────────────────────────────────
// Registered clients are keyed by redirect_uri (Indeed binds redirect_uris to a client),
// cached so we register at most once per redirect_uri.
function _loadClients() {
  try { return JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8")); } catch { return {}; }
}
function _saveClients(map) { _ensureDir(); fs.writeFileSync(CLIENT_FILE, JSON.stringify(map, null, 2), "utf8"); }

function getCachedClient(redirectUri) {
  // Env-provided partner creds win (skip DCR entirely).
  if (process.env.INDEED_CLIENT_ID) {
    return { client_id: process.env.INDEED_CLIENT_ID, client_secret: process.env.INDEED_CLIENT_SECRET || null };
  }
  const c = _loadClients()[redirectUri];
  return c || null;
}

/** Register (or return cached) an OAuth client for this redirect_uri. */
async function ensureClient(redirectUri) {
  const cached = getCachedClient(redirectUri);
  if (cached) return { ok: true, ...cached, cached: true };

  // NB: no `scope` in the registration body — Indeed's DCR rejects it
  // (invalid_client_metadata); allowed scopes are requested at authorize time instead.
  const body = {
    client_name: process.env.INDEED_CLIENT_NAME || "Keystone OS (Unisona)",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };
  let r;
  try {
    r = await fetchFn(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "unreachable", detail: String(e.message || e) };
  }
  const text = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, error: `register_http_${r.status}`, detail: text.slice(0, 400) };
  let reg;
  try { reg = JSON.parse(text); } catch { return { ok: false, error: "register_bad_json", detail: text.slice(0, 200) }; }
  if (!reg.client_id) return { ok: false, error: "register_no_client_id", detail: text.slice(0, 200) };

  const map = _loadClients();
  map[redirectUri] = { client_id: reg.client_id, client_secret: reg.client_secret || null };
  _saveClients(map);
  return { ok: true, client_id: reg.client_id, client_secret: reg.client_secret || null, cached: false };
}

// ── Authorize URL ─────────────────────────────────────────────────────────────
function buildAuthorizeUrl({ clientId, redirectUri, state, challenge }) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

// ── Token exchange + refresh ───────────────────────────────────────────────────
async function _tokenRequest(form) {
  const r = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, error: `token_http_${r.status}`, detail: text.slice(0, 400) };
  try { return { ok: true, token: JSON.parse(text) }; } catch { return { ok: false, error: "token_bad_json" }; }
}

async function exchangeCode({ client, code, verifier, redirectUri }) {
  return _tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    code_verifier: verifier,
  });
}

async function refreshToken({ client, refresh_token }) {
  return _tokenRequest({
    grant_type: "refresh_token",
    refresh_token,
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  });
}

module.exports = {
  MCP_URL, AUTHORIZE_URL, TOKEN_URL, REGISTER_URL, SCOPES,
  generatePkce, ensureClient, getCachedClient, buildAuthorizeUrl, exchangeCode, refreshToken,
  _paths: { DATA_DIR, CLIENT_FILE },
};
