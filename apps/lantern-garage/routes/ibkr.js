'use strict';

/**
 * Per-user IBKR connection routes (ADR-0022, phase 3). All are under /api/trading/*,
 * so they're already gated to the "trade" entitlement ($20+) by tradeApiGuard, and
 * require a session (per-user). Secrets are stored encrypted and never returned.
 *
 *   POST /api/trading/ibkr/connect     { consumerKey, accessToken, accessTokenSecret,
 *                                        signaturePem, encryptionPem, dhPrime, realm?, accountId? }
 *   POST /api/trading/ibkr/disconnect
 *   GET  /api/trading/ibkr/connection  → { hasCredentials, connected, accountId, mode, live }
 */

const store = require('../lib/ibkr-credentials');
const IbkrCpapi = require('../lib/ibkr-cpapi');
const { getEffectiveUserId } = require('../lib/session-identity');

function _readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); }); // PEM keys are a few KB
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function _json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

/** Live connection probe for a user's stored credentials (fail-soft). */
async function _probe(userId) {
  const signer = store.buildSigner(userId);
  if (!signer) return { connected: false };
  const client = new IbkrCpapi({ oauth1: signer });
  const p = await client.probe();
  const out = { connected: !!(p && p.connected), authenticated: !!(p && p.authenticated), competing: !!(p && p.competing) };
  // Resolve the account id live so the UI never shows "account (unknown)" when the
  // handshake succeeded but the user left the Account ID field blank — IBKR reports
  // it via /portfolio/accounts. Fail-soft: leave it off if it can't be resolved.
  if (out.authenticated) {
    const acctId = await client.resolveAccountId().catch(() => null);
    if (acctId) { out.accountId = acctId; out.mode = IbkrCpapi.inferMode(acctId); }
  }
  // Surface WHY the OAuth handshake failed so the UI can distinguish "not
  // activated yet" (normal for a new consumer) from a real key/config error.
  if (!out.authenticated && client._lstError) {
    out.reason = client._lstError.code;
    const R = {
      invalid_consumer: 'IBKR rejects your consumer key as unknown (error 164, "invalid consumer"). This is NOT an activation delay — waiting won\'t help. Register the consumer in IBKR\'s Self-Service OAuth portal and enter the EXACT consumer key IBKR accepts.',
      not_activated_or_unauthorized: 'IBKR rejected the OAuth handshake — your consumer is most likely not active yet (activation can take up to ~24h). Nothing to fix; retry later.',
      lst_signature_mismatch: 'Handshake signature mismatch — the keys/DH prime in unisona don\'t match what was uploaded to IBKR. Regenerate keys, re-upload all 3 files to IBKR, and reconnect.',
      bad_key: 'One of the private keys couldn\'t be read. Regenerate your keys and reconnect.',
      no_dh_response: 'IBKR didn\'t return a Diffie-Hellman response — usually a not-yet-active consumer.',
      unreachable: 'Couldn\'t reach IBKR\'s Web API. Check your connection and try again.',
    };
    out.reasonText = R[client._lstError.code] || ('IBKR handshake failed (' + client._lstError.code + ').');
  }
  return out;
}

const OWNED = new Set([
  '/api/trading/ibkr/connect',
  '/api/trading/ibkr/disconnect',
  '/api/trading/ibkr/connection',
]);

// Per-user cache of the live-gateway probe (see GET connection below).
const _probeCache = new Map(); // userId → { live, ts }
const PROBE_CACHE_TTL_MS = 20_000;

module.exports = async function ibkrRoutes(req, res, url) {
  const path = url.pathname;
  if (!OWNED.has(path)) return false; // account/positions/status live in routes/trading

  const userId = getEffectiveUserId(req);
  if (!userId) { _json(res, 401, { error: 'not_authenticated' }); return true; }

  // GET connection status. The live probe hits the IBKR gateway and can take
  // seconds (measured ~3s) — every trader-page load calls this, pinning one of
  // the browser's six connections and making the whole page feel slow. The
  // gateway's state doesn't flap second-to-second: cache the probe 20s per user.
  if (req.method === 'GET' && path === '/api/trading/ibkr/connection') {
    const status = store.publicStatus(userId);
    if (status.hasCredentials) {
      const hit = _probeCache.get(userId);
      if (hit && Date.now() - hit.ts < PROBE_CACHE_TTL_MS) {
        status.live = hit.live;
        status.cached = true;
      } else {
        status.live = await _probe(userId);
        _probeCache.set(userId, { live: status.live, ts: Date.now() });
      }
    }
    _json(res, 200, status);
    return true;
  }

  // POST connect — save creds (encrypted) + report a live probe
  if (req.method === 'POST' && path === '/api/trading/ibkr/connect') {
    const body = await _readJson(req);
    if (!body) { _json(res, 400, { error: 'invalid_json' }); return true; }
    // The form shows "saved — leave blank to keep" on the six credential fields
    // once creds exist, so honor it: fill blank fields from the stored creds.
    // Users with nothing saved must still supply every field.
    const saved = store.load(userId);
    if (saved) {
      for (const k of store.REQUIRED) {
        if (body[k] == null || String(body[k]).trim() === '') body[k] = saved[k];
      }
    }
    const norm = store.normalize(body);
    if (norm.error) { _json(res, 400, { error: norm.error }); return true; }
    store.save(userId, norm.creds);
    const live = await _probe(userId);
    _probeCache.set(userId, { live, ts: Date.now() });   // fresh creds → fresh cache
    _json(res, 200, { ok: true, status: store.publicStatus(userId), live });
    return true;
  }

  // POST disconnect — delete creds
  if (req.method === 'POST' && path === '/api/trading/ibkr/disconnect') {
    const removed = store.remove(userId);
    _probeCache.delete(userId);
    _json(res, 200, { ok: true, removed });
    return true;
  }

  _json(res, 404, { error: 'not_found' });
  return true;
};
