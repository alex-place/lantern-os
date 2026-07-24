'use strict';

/**
 * broker-alpaca.js — one-click Alpaca OAuth2 connect (ADR-0027).
 *
 * Endpoints (all under /api/broker/alpaca/):
 *   GET  /connect     → 302 to Alpaca's authorize page (starts OAuth2; env=paper by default)
 *   GET  /callback    → exchange ?code → access_token → store encrypted → back to the return page
 *   GET  /status      → { connected, env, accountNumber, ... } (no secrets)
 *   POST /disconnect  → delete the stored token
 *
 * INERT UNTIL CONFIGURED: needs ALPACA_OAUTH_CLIENT_ID + ALPACA_OAUTH_CLIENT_SECRET
 * (register the app at app.alpaca.markets → OAuth). Without them /connect returns a
 * clear "not configured" message instead of a broken redirect. We never hold user
 * API keys — only the per-user OAuth token the user grants, stored AES-GCM encrypted.
 */

const crypto = require('crypto');
const https = require('https');
const { getEffectiveUserId } = require('../lib/session-identity');
const store = require('../lib/alpaca-credentials');
// The signed short-TTL state cookie is the same primitive every other OAuth2 provider
// here already uses, so reuse it rather than keeping a second copy of the HMAC: one
// signer, one secret resolution, one place to harden. (lib/oauth-core, ADR-0016.)
const { signOauth, verifyOauth, readCookie } = require('../lib/oauth-core');

const AUTHORIZE_URL = 'https://app.alpaca.markets/oauth/authorize';
const TOKEN_HOST = 'api.alpaca.markets';
const TOKEN_PATH = '/oauth/token';
const COOKIE = 'lantern_alpaca_oauth';
const SCOPE = 'account:write trading';   // read account + place trades on the user's behalf

function _clientId() { return process.env.ALPACA_OAUTH_CLIENT_ID || ''; }
function _clientSecret() { return process.env.ALPACA_OAUTH_CLIENT_SECRET || ''; }
function _configured() { return !!(_clientId() && _clientSecret()); }

function _origin(req) {
  const host = (req.headers && req.headers.host) || '127.0.0.1';
  const proto = ((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}
function _json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

// POST body reader (small JSON only)
function _readBody(req) {
  return new Promise((resolve) => {
    let data = ''; req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// POST application/x-www-form-urlencoded to Alpaca's token endpoint.
function _exchangeCode({ code, redirectUri }) {
  return new Promise((resolve) => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: _clientId(),
      client_secret: _clientSecret(),
      redirect_uri: redirectUri,
    }).toString();
    const req = https.request({
      host: TOKEN_HOST, path: TOKEN_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_e) { /* */ } resolve({ ok: res.statusCode === 200 && j && j.access_token, json: j, status: res.statusCode }); });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(form); req.end();
  });
}

// GET the account the token authorized, for its number + env confirmation.
function _fetchAccount(token, env) {
  const host = env === 'live' ? 'api.alpaca.markets' : 'paper-api.alpaca.markets';
  return new Promise((resolve) => {
    const req = https.request({ host, path: '/v2/account', method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_e) { /* */ } resolve(res.statusCode === 200 ? j : null); });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(9000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = async function brokerAlpacaRoutes(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/broker/alpaca/') && p !== '/api/broker/preference') return false;
  const method = req.method;
  const userId = getEffectiveUserId(req);
  const origin = _origin(req);
  const redirectUri = `${origin}/api/broker/alpaca/callback`;

  // GET/POST /api/broker/preference — which connected broker executes THIS user's
  // trades ('alpaca' | 'ibkr' | 'auto' = server default). No secrets; the stored
  // value only matters for users who actually have a broker connected.
  if (p === '/api/broker/preference') {
    const prefs = require('../lib/broker-preference');
    const { preferredBroker } = require('../lib/broker-facade');
    // Owner-machine convention (same as routes/accounts.js): a request with no
    // session id on a box whose auth funnel is off IS the owner — the identity the
    // broker stores already use ('local-owner', e.g. ibkr-credentials). Without
    // this, the ☰ broker switch 401s exactly for the single-user local setup the
    // trader ships in. Patreon-gated deployments always have a session id, so
    // anonymous internet visitors there never reach this fallback.
    const prefUserId = userId != null ? userId : 'local-owner';
    // The per-browser cookie (set on POST below) is the authoritative choice for
    // request-bound routes, so a rotating guest id can't lose it.
    const { readCookie } = require('../lib/oauth-core');
    const cookiePref = (() => { const c = readCookie(req, 'broker_pref'); return (c === 'alpaca' || c === 'ibkr') ? c : null; })();
    if (method === 'GET') {
      let ibkrConnected = false;
      try { ibkrConnected = require('../lib/ibkr-credentials').has(prefUserId); } catch (_e) { /* absent module = not connected */ }
      const adapter = require('../lib/alpaca-adapter');
      // The cookie (if present) is what the user last picked in THIS browser; show it
      // as the selected preference so the UI reflects reality, not a drifted store.
      return _json(res, 200, {
        preference: cookiePref || prefs.get(prefUserId),
        effective: preferredBroker(prefUserId, req),   // cookie > store > env > default
        connected: { alpaca: adapter.available(prefUserId), ibkr: ibkrConnected },
      }), true;
    }
    if (method === 'POST') {
      const body = await _readBody(req);
      const broker = String((body && body.broker) || '').toLowerCase();
      if (!prefs.set(prefUserId, broker)) {
        return _json(res, 400, { error: 'invalid_broker', message: "broker must be 'alpaca', 'ibkr', or 'auto'" }), true;
      }
      // Single-user/owner box (auth off): the background auto-trader trades the
      // 'local-owner' account and reads that key's preference — mirror the choice
      // there so the autopilot follows the UI instead of falling back to the env
      // default. On multi-user prod (auth on) each user's own id is authoritative,
      // so we do NOT hijack local-owner.
      try {
        const { loginGateEnabled } = require('../lib/auth-middleware');
        if (!loginGateEnabled() && prefUserId !== 'local-owner') prefs.set('local-owner', broker);
      } catch (_e) { /* auth module absent → nothing to mirror */ }
      // Persist the choice to the browser: a 1-year cookie so it survives reloads
      // and session-id drift. 'auto' clears the cookie (falls back to store/env).
      const secure = (((req.headers && req.headers['x-forwarded-proto']) || '').includes('https') || (req.socket && req.socket.encrypted)) ? '; Secure' : '';
      const cookie = broker === 'auto'
        ? `broker_pref=; Path=/; Max-Age=0; SameSite=Lax${secure}`
        : `broker_pref=${broker}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      res.setHeader('Set-Cookie', cookie);
      // effective from the NEW choice (the Set-Cookie above isn't on `req` yet):
      // an explicit alpaca/ibkr IS the effective broker; 'auto' resolves via store/env.
      const effective = (broker === 'alpaca' || broker === 'ibkr') ? broker : preferredBroker(prefUserId);
      return _json(res, 200, { ok: true, preference: broker, effective }), true;
    }
    return _json(res, 405, { error: 'method_not_allowed' }), true;
  }

  // GET /status — redacted connection state (safe for guests to poll)
  if (method === 'GET' && p === '/api/broker/alpaca/status') {
    const st = store.publicStatus(userId);
    // If the user has no OAuth token but the operator set server paper keys, the
    // trader still trades a real Alpaca paper account — report that as connected.
    if (!st.connected) {
      const adapter = require('../lib/alpaca-adapter');
      if (adapter.available(userId)) {
        return _json(res, 200, { connected: true, hasCredentials: true, provider: 'alpaca',
          env: process.env.ALPACA_ENV === 'live' ? 'live' : 'paper', mode: 'paper',
          via: 'server-keys', accountNumber: null, configured: _configured() }), true;
      }
    }
    return _json(res, 200, { ...st, configured: _configured() }), true;
  }

  // GET /connect — start OAuth2. ?env=live opts into the live account; default paper.
  if (method === 'GET' && p === '/api/broker/alpaca/connect') {
    if (!_configured()) {
      return _json(res, 503, { error: 'not_configured', message: 'Alpaca one-click is not set up on this server yet (missing ALPACA_OAUTH_CLIENT_ID / _SECRET). Register the app at app.alpaca.markets → OAuth.' }), true;
    }
    const env = url.searchParams.get('env') === 'live' ? 'live' : 'paper';
    const returnTo = url.searchParams.get('returnTo') || '/orchestration.html#broker';
    const state = crypto.randomBytes(16).toString('hex');
    const cookie = signOauth({ state, env, userId, returnTo, redirectUri, exp: Date.now() + 10 * 60 * 1000 });
    const secure = redirectUri.startsWith('https://') ? '; Secure' : '';
    const authUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
      response_type: 'code',
      client_id: _clientId(),
      redirect_uri: redirectUri,
      state,
      scope: SCOPE,
      // Alpaca honors env to scope the consent to a paper- or live-only account.
      env,
    }).toString()}`;
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`, Location: authUrl });
    return res.end(), true;
  }

  // GET /callback — Alpaca redirects here with ?code&state (or ?error)
  if (method === 'GET' && p === '/api/broker/alpaca/callback') {
    const clear = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
    const ck = verifyOauth(readCookie(req, COOKIE));
    const back = (msg) => { res.writeHead(302, { 'Set-Cookie': clear, Location: `${(ck && ck.returnTo) || '/orchestration.html#broker'}${((ck && ck.returnTo) || '').includes('?') ? '&' : '?'}alpaca=${msg}` }); return res.end(), true; };
    const err = url.searchParams.get('error');
    if (err) return back(`error&reason=${encodeURIComponent(err)}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !ck || ck.state !== state) return back('error&reason=state');
    const tok = await _exchangeCode({ code, redirectUri: ck.redirectUri });
    if (!tok.ok) return back(`error&reason=${encodeURIComponent((tok.json && (tok.json.error_description || tok.json.error)) || tok.error || 'token')}`);
    const acct = await _fetchAccount(tok.json.access_token, ck.env);
    store.save(ck.userId || userId, {
      access_token: tok.json.access_token,
      token_type: tok.json.token_type,
      scope: tok.json.scope,
      env: ck.env,
      account_id: acct && acct.id,
      account_number: acct && acct.account_number,
    });
    return back('connected');
  }

  // POST /disconnect — forget the stored token
  if (method === 'POST' && p === '/api/broker/alpaca/disconnect') {
    await _readBody(req);
    const removed = store.remove(userId);
    return _json(res, 200, { ok: true, removed }), true;
  }

  return _json(res, 404, { error: 'not_found' }), true;
};
