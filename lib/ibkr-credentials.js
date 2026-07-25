'use strict';

/**
 * Per-user IBKR OAuth 1.0a credential store (ADR-0022, phase 3).
 *
 * Stores each user's six self-service OAuth secrets ENCRYPTED AT REST (AES-256-GCM),
 * keyed by profile id. Secrets are never returned to the client or logged — the only
 * thing that leaves is a redacted status. The AES key is derived from the server
 * secret (IBKR_CRED_KEY, else SESSION_SECRET) so credentials aren't readable from the
 * files alone.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const IbkrOAuth1 = require('./ibkr-oauth1');

// Resolve the store relative to THIS module (data), NOT the
// process cwd — otherwise a server started from any cwd
// looks in different places and can't find creds saved by the other, showing a
// spurious "Connect broker" / hasCredentials:false. An explicit IBKR_CRED_DIR wins.
// A legacy cwd-relative dir is honored read-only so pre-existing creds still load.
const DIR = process.env.IBKR_CRED_DIR
  ? path.resolve(process.env.IBKR_CRED_DIR)
  : path.join(__dirname, '..', 'data', 'ibkr-credentials');
const LEGACY_DIR = path.join(process.cwd(), 'data', 'ibkr-credentials');
const REQUIRED = ['consumerKey', 'accessToken', 'accessTokenSecret', 'signaturePem', 'encryptionPem', 'dhPrime'];

function _key() {
  const secret = process.env.IBKR_CRED_KEY || process.env.SESSION_SECRET || 'lantern-local-dev-secret-change-in-prod';
  return crypto.scryptSync(secret, 'ibkr-cred-v1', 32);
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
function _name(userId) { return encodeURIComponent(String(userId)) + '.enc.json'; }
function _file(userId) { return path.join(DIR, _name(userId)); }
// The path to READ from: the canonical location, or the legacy cwd-relative one if
// that's where a pre-fix server saved it. Writes always go to the canonical DIR.
function _readFile(userId) {
  const primary = _file(userId);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(LEGACY_DIR, _name(userId));
  return legacy !== primary && fs.existsSync(legacy) ? legacy : primary;
}

/** Validate + normalize an incoming credentials payload. Returns {creds}|{error}. */
function normalize(input) {
  const c = input || {};
  for (const k of REQUIRED) if (!c[k] || typeof c[k] !== 'string') return { error: `missing_${k}` };
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(c.signaturePem)) return { error: 'bad_signaturePem' };
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(c.encryptionPem)) return { error: 'bad_encryptionPem' };
  if (!/^[0-9a-fA-F]+$/.test(String(c.dhPrime).replace(/^0x/i, ''))) return { error: 'bad_dhPrime' };
  return {
    creds: {
      consumerKey: c.consumerKey.trim(),
      accessToken: c.accessToken.trim(),
      accessTokenSecret: c.accessTokenSecret.trim(),
      signaturePem: c.signaturePem,
      encryptionPem: c.encryptionPem,
      dhPrime: String(c.dhPrime).replace(/^0x/i, ''),
      realm: (c.realm || 'limited_poa').trim(),
      accountId: (c.accountId || '').trim(),
    },
  };
}

function save(userId, creds) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_file(userId), JSON.stringify(_encrypt(creds)), { mode: 0o600 });
}
function load(userId) {
  try { return _decrypt(JSON.parse(fs.readFileSync(_readFile(userId), 'utf8'))); }
  catch (e) { return null; }
}
function has(userId) { return fs.existsSync(_readFile(userId)); }
function remove(userId) { try { fs.unlinkSync(_file(userId)); return true; } catch { return false; } }

/** Every user with saved IBKR credentials (canonical + legacy dirs), deduped. The
 *  autopilot iterates these so it trades EVERY connected account, not just one. */
function listUsers() {
  const out = new Set();
  for (const dir of [DIR, LEGACY_DIR]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_e) { continue; }
    for (const f of files) {
      if (!f.endsWith('.enc.json')) continue;
      try { out.add(decodeURIComponent(f.slice(0, -'.enc.json'.length))); } catch (_e) { /* skip bad name */ }
    }
  }
  return [...out];
}

/** Build an IbkrOAuth1 signer for a user, or null if not connected / unreadable. */
function buildSigner(userId) {
  const c = load(userId);
  if (!c) return null;
  try { return new IbkrOAuth1(c); } catch { return null; }
}

/** Non-secret status for the client (never includes keys/secrets). */
function publicStatus(userId) {
  const c = load(userId);
  if (!c) return { connected: false, hasCredentials: false };
  const acct = c.accountId || '';
  const mode = acct ? (/^DU/i.test(acct) ? 'paper' : 'live') : 'unknown';
  return {
    connected: true, hasCredentials: true,
    accountId: acct || null, mode,
    consumerKeyLast4: c.consumerKey.slice(-4),
  };
}

module.exports = { normalize, save, load, has, remove, listUsers, buildSigner, publicStatus, _file, REQUIRED };
