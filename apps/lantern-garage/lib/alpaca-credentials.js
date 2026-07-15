'use strict';

/**
 * Per-user Alpaca OAuth2 token store (ADR-0027, one-click broker connect).
 *
 * Mirrors ibkr-credentials.js: each user's Alpaca OAuth token is stored ENCRYPTED
 * AT REST (AES-256-GCM), keyed by profile id, in its OWN directory. Secrets are
 * never returned to the client or logged — the only thing that leaves is a
 * redacted status. Deliberately a separate module from the IBKR store so the
 * working IBKR path is untouched; both share the same crypto discipline.
 *
 * Alpaca OAuth2 (docs.alpaca.markets) returns a bearer access_token scoped to the
 * user's account. We persist { access_token, token_type, scope, env, account_id,
 * account_number, obtained_at }. No refresh_token flow is offered by Alpaca's
 * current OAuth — tokens are long-lived; on 401 the user re-authorizes (one click).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Own directory, resolved relative to THIS module (not cwd) — same rationale as
// the IBKR store: a server started from repo root vs apps/lantern-garage must find
// the same creds. An explicit ALPACA_CRED_DIR wins.
const DIR = process.env.ALPACA_CRED_DIR
  ? path.resolve(process.env.ALPACA_CRED_DIR)
  : path.join(__dirname, '..', 'data', 'alpaca-credentials');

function _key() {
  // Reuse the IBKR/session secret chain so operators configure one key, not three.
  const secret = process.env.ALPACA_CRED_KEY || process.env.IBKR_CRED_KEY || process.env.SESSION_SECRET
    || 'lantern-local-dev-secret-change-in-prod';
  return crypto.scryptSync(secret, 'alpaca-cred-v1', 32);
}
function _encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function _decrypt(blob) {
  const d = crypto.createDecipheriv('aes-256-gcm', _key(), Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}
function _file(userId) { return path.join(DIR, encodeURIComponent(String(userId)) + '.enc.json'); }

/** Persist a fresh OAuth token bundle for a user (overwrites any prior). */
function save(userId, creds) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify(_encrypt({
    access_token: String(creds.access_token || ''),
    token_type: creds.token_type || 'bearer',
    scope: creds.scope || '',
    env: creds.env === 'live' ? 'live' : 'paper',   // default paper — the safe posture
    account_id: creds.account_id || null,
    account_number: creds.account_number || null,
    obtained_at: creds.obtained_at || new Date().toISOString(),
  })), { mode: 0o600 });
}
function load(userId) {
  try { return _decrypt(JSON.parse(fs.readFileSync(_file(userId), 'utf8'))); }
  catch (_e) { return null; }
}
function has(userId) { return fs.existsSync(_file(userId)); }
function remove(userId) { try { fs.unlinkSync(_file(userId)); return true; } catch { return false; } }

/** Every user with a saved Alpaca token (so the autopilot can iterate them). */
function listUsers() {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch (_e) { return []; }
  return files.filter((f) => f.endsWith('.enc.json')).map((f) => {
    try { return decodeURIComponent(f.slice(0, -'.enc.json'.length)); } catch (_e) { return null; }
  }).filter(Boolean);
}

/** Non-secret status for the client (NEVER includes the token). */
function publicStatus(userId) {
  const c = load(userId);
  if (!c) return { connected: false, hasCredentials: false, provider: 'alpaca' };
  return {
    connected: true, hasCredentials: true, provider: 'alpaca',
    env: c.env || 'paper',
    mode: c.env === 'live' ? 'live' : 'paper',
    accountNumber: c.account_number || null,
    obtainedAt: c.obtained_at || null,
  };
}

module.exports = { save, load, has, remove, listUsers, publicStatus, _file };
