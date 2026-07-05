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
const { getSessionUserId } = require('../lib/session-identity');

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
  return { connected: !!(p && p.connected), authenticated: !!(p && p.authenticated), competing: !!(p && p.competing) };
}

module.exports = async function ibkrRoutes(req, res, url) {
  const path = url.pathname;
  if (!path.startsWith('/api/trading/ibkr/')) return false;

  const userId = getSessionUserId(req);
  if (!userId) { _json(res, 401, { error: 'not_authenticated' }); return true; }

  // GET connection status
  if (req.method === 'GET' && path === '/api/trading/ibkr/connection') {
    const status = store.publicStatus(userId);
    if (status.hasCredentials) status.live = await _probe(userId);
    _json(res, 200, status);
    return true;
  }

  // POST connect — save creds (encrypted) + report a live probe
  if (req.method === 'POST' && path === '/api/trading/ibkr/connect') {
    const body = await _readJson(req);
    if (!body) { _json(res, 400, { error: 'invalid_json' }); return true; }
    const norm = store.normalize(body);
    if (norm.error) { _json(res, 400, { error: norm.error }); return true; }
    store.save(userId, norm.creds);
    const live = await _probe(userId);
    _json(res, 200, { ok: true, status: store.publicStatus(userId), live });
    return true;
  }

  // POST disconnect — delete creds
  if (req.method === 'POST' && path === '/api/trading/ibkr/disconnect') {
    const removed = store.remove(userId);
    _json(res, 200, { ok: true, removed });
    return true;
  }

  _json(res, 404, { error: 'not_found' });
  return true;
};
