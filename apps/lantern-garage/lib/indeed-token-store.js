"use strict";
/**
 * indeed-token-store.js — per-user Indeed OAuth tokens, encrypted at rest (AES-256-GCM,
 * key derived from SESSION_SECRET). Never returns the raw token to the client; the chat
 * path reads it server-side to pass as mcp_servers[].authorization_token.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = process.env.KEYSTONE_INDEED_DIR
  || path.join(__dirname, "..", "..", "..", "data", "indeed");
const TOK_DIR = path.join(DIR, "tokens");

function _key() {
  const secret = process.env.SESSION_SECRET || "lantern-indeed-token-key";
  return crypto.createHash("sha256").update(String(secret)).digest(); // 32 bytes
}
function _enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", _key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}
function _dec(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", _key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}
function _safeId(userId) {
  return crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
}
function _file(userId) { return path.join(TOK_DIR, `${_safeId(userId)}.enc`); }

function save(userId, token) {
  if (!fs.existsSync(TOK_DIR)) fs.mkdirSync(TOK_DIR, { recursive: true });
  const rec = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || null,
    scope: token.scope || null,
    token_type: token.token_type || "Bearer",
    expires_at: token.expires_in ? Date.now() + (token.expires_in - 60) * 1000 : null, // 60s skew
    connectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(_file(userId), _enc(rec), "utf8");
  return rec;
}
function load(userId) {
  try { return _dec(fs.readFileSync(_file(userId), "utf8")); } catch { return null; }
}
function remove(userId) {
  try { fs.unlinkSync(_file(userId)); return true; } catch { return false; }
}
function isExpired(rec) { return !!(rec && rec.expires_at && Date.now() >= rec.expires_at); }

/** Client-safe status (never the token itself). */
function publicStatus(userId) {
  const rec = load(userId);
  if (!rec) return { connected: false };
  return {
    connected: true,
    scope: rec.scope,
    connectedAt: rec.connectedAt,
    expiresAt: rec.expires_at ? new Date(rec.expires_at).toISOString() : null,
    expired: isExpired(rec),
    hasRefresh: !!rec.refresh_token,
  };
}

/**
 * A currently-valid access token for the user, refreshing once if expired. Returns the
 * token string, or null if not connected / expired-with-no-refresh / refresh failed.
 * `redirectUri` is only needed to resolve the cached OAuth client for a refresh.
 */
async function getValidAccessToken(userId, redirectUri) {
  const rec = load(userId);
  if (!rec || !rec.access_token) return null;
  if (!isExpired(rec)) return rec.access_token;
  if (!rec.refresh_token) return null;
  try {
    const oauth = require("./indeed-oauth"); // lazy (avoids load-order coupling)
    const client = await oauth.ensureClient(redirectUri);
    if (!client.ok) return null;
    const r = await oauth.refreshToken({ client, refresh_token: rec.refresh_token });
    if (!r.ok || !r.token || !r.token.access_token) return null;
    // Indeed may omit a new refresh_token — keep the old one.
    if (!r.token.refresh_token) r.token.refresh_token = rec.refresh_token;
    const saved = save(userId, r.token);
    return saved.access_token;
  } catch { return null; }
}

module.exports = { save, load, remove, isExpired, publicStatus, getValidAccessToken, _paths: { TOK_DIR } };
