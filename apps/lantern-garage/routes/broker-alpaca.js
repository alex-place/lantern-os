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

const AUTHORIZE_URL = 'https://app.alpaca.markets/oauth/authorize';
const TOKEN_HOST = 'api.alpaca.markets';
const TOKEN_PATH = '/oauth/token';
const COOKIE = 'lantern_alpaca_oauth';
const SCOPE = 'account:write trading';   // read account + place trades on the user's behalf

function _clientId() { return process.env.ALPACA_OAUTH_CLIENT_ID || ''; }
function _clientSecret() { return process.env.ALPACA_OAUTH_CLIENT_SECRET || ''; }
function _configured() { return !!(_clientId() && _clientSecret()); }
function _secret() { return process.env.SESSION_SECRET || 'lantern-alpaca-oauth-secret'; }

function _sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', _secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function _verify(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', _secret()).update(data).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); return p && p.exp && Date.now() <= p.exp ? p : null; } catch { return null; }
}
function _readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
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
  if (!p.startsWith('/api/broker/alpaca/')) return false;
  const method = req.method;
  const userId = getEffectiveUserId(req);
  const origin = _origin(req);
  const redirectUri = `${origin}/api/broker/alpaca/callback`;

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
    const cookie = _sign({ state, env, userId, returnTo, redirectUri, exp: Date.now() + 10 * 60 * 1000 });
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
    const ck = _verify(_readCookie(req, COOKIE));
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
