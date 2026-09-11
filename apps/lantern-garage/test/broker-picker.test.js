'use strict';
/**
 * test/broker-picker.test.js — #3530.
 *
 * Settings → Connections shows brokers the way TradingView does: a grid of tiles and
 * a Connect modal per tile that goes straight to the broker's own sign-in when that's
 * possible. Alpaca one-click is offered only once Alpaca has actually activated our
 * OAuth app. The server probes that (GET /api/broker/alpaca/status → oneClick), so
 * nobody lands on Alpaca's "invalid client" page. The OAuth return lands on the right
 * panel (query before the #hash), and returnTo can only point back into this site.
 *
 * Part 1 drives the page's pure picker functions, extracted from settings.html.
 * Part 2 drives the REAL route with https.request stubbed: no network.
 * Run: node --test apps/lantern-garage/test/broker-picker.test.js
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

// ── Part 1: the page ─────────────────────────────────────────────────────────────
const PAGE = process.env.SETTINGS_PAGE || path.join(__dirname, '..', 'public', 'settings.html');
const html = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('/* ── Broker picker (#');
const end = html.indexOf('/* ── end broker picker');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = new Function('esc', html.slice(start, end) + '\nreturn { BROKERS, brokerState, brokerTilesHtml, brokerModalSpec, alpacaReturnNote };')(esc);
const tile = (h, id) => {
  const m = h.match(new RegExp(`<button[^>]*data-broker="${id}"[^>]*>([\\s\\S]*?)</button>`));
  assert.ok(m, `a tile for ${id}`);
  return m[1];
};
const state = (ib, al) => P.brokerState(ib, al);
const NONE = state({ hasCredentials: false }, { connected: false, configured: false, oneClick: false });

test('the picker block is on the page and wired into Connections', () => {
  assert.ok(start > 0 && end > start, 'block markers present');
  const rc = html.slice(html.indexOf('async function renderConnections()'));
  assert.match(rc, /const bState = brokerState\(ib\.body, al\.body\);/);
  assert.match(rc, /Trade with your broker[\s\S]*?\$\{brokerTilesHtml\(bState\)\}/);
  assert.match(rc, /querySelectorAll\("\[data-broker\]"\)\.forEach\(\(t\) => t\.onclick = \(\) => openBrokerModal\(t\.dataset\.broker, bState\)\)/);
  assert.doesNotMatch(html, /c-al-on|c-al-off/, 'the old paste-only Alpaca row is gone');
});

test('nothing connected: one tile per broker; Alpaca takes API keys, IBKR is a guided setup', () => {
  const h = P.brokerTilesHtml(NONE);
  assert.strictEqual((h.match(/class="broker"/g) || []).length, 2);
  assert.match(tile(h, 'alpaca'), /Not connected[\s\S]*b-tag">API keys</);
  assert.match(tile(h, 'ibkr'), /Not connected[\s\S]*b-tag">Guided setup</);
  assert.doesNotMatch(h, /\p{Extended_Pictographic}/u, 'no emoji on the tiles');
});

test("Alpaca's tile says One-click only when the server says one-click is live", () => {
  const h = P.brokerTilesHtml(state({}, { connected: false, configured: true, oneClick: true }));
  assert.match(tile(h, 'alpaca'), /b-tag">One-click</);
  const h2 = P.brokerTilesHtml(state({}, { connected: false, configured: true, oneClick: false }));
  assert.match(tile(h2, 'alpaca'), /b-tag">API keys</, 'configured is not enough: Alpaca must have activated the app');
});

test('connected tiles show the account, escaped, and drop the tag', () => {
  const s = state({ hasCredentials: true, live: { connected: true, accountId: 'DUR193395' } },
    { connected: true, via: 'keys', accountNumber: 'PA3K<b>' });
  const h = P.brokerTilesHtml(s);
  assert.match(tile(h, 'alpaca'), /b-state on">Connected · paper · PA3K&lt;b&gt;</);
  assert.match(tile(h, 'ibkr'), /b-state on">Connected · DUR193395</);
  assert.doesNotMatch(h, /b-tag/);
  const saved = P.brokerTilesHtml(state({ hasCredentials: true, live: { connected: false } }, {}));
  assert.match(tile(saved, 'ibkr'), /Saved, not connected[\s\S]*Guided setup/);
});

test('each tile opens the right Connect modal', () => {
  const oauth = P.brokerModalSpec('alpaca', state({}, { oneClick: true }));
  assert.strictEqual(oauth.kind, 'oauth');
  assert.strictEqual(oauth.href, '/api/broker/alpaca/connect?returnTo=%2Fsettings.html%23connections');
  assert.strictEqual(oauth.action, 'Connect with Alpaca');
  const keys = P.brokerModalSpec('alpaca', NONE);
  assert.strictEqual(keys.kind, 'keys');
  assert.match(keys.sub, /paper/);
  const guided = P.brokerModalSpec('ibkr', NONE);
  assert.deepStrictEqual([guided.kind, guided.href, guided.action], ['guided', '/orchestration.html#broker', 'Open guided setup']);
  assert.strictEqual(P.brokerModalSpec('ibkr', state({ hasCredentials: true }, {})).action, 'Reconnect');
  const conn = P.brokerModalSpec('alpaca', state({}, { connected: true, via: 'keys', accountNumber: 'PA1' }));
  assert.deepStrictEqual([conn.kind, conn.action], ['connected', 'Disconnect']);
  const serverKeys = P.brokerModalSpec('alpaca', state({}, { connected: true, via: 'server-keys' }));
  assert.strictEqual(serverKeys.kind, 'info');
  assert.strictEqual(serverKeys.action, undefined, "the server's own keys aren't the user's to disconnect");
  const ib = P.brokerModalSpec('ibkr', state({ live: { connected: true, accountId: 'DU1' } }, {}));
  assert.deepStrictEqual([ib.kind, ib.action], ['connected', 'Disconnect']);
});

test('brokerState tolerates missing payloads', () => {
  const s = P.brokerState(null, null);
  assert.deepStrictEqual(s, {
    alpaca: { connected: false, account: '', via: '', oneClick: false },
    ibkr: { connected: false, saved: false, account: '' },
  });
});

test('the OAuth return is announced in words', () => {
  assert.deepStrictEqual(P.alpacaReturnNote('connected'), { ok: true, text: 'Alpaca connected. Your paper account is linked.' });
  assert.match(P.alpacaReturnNote('error', 'access_denied').text, /declined/);
  assert.strictEqual(P.alpacaReturnNote('error', 'access_denied').ok, false);
  assert.strictEqual(P.alpacaReturnNote(null), null);
});

// ── Part 2: the route ────────────────────────────────────────────────────────────
const ROUTE = require.resolve(path.join(__dirname, '..', 'routes', 'broker-alpaca.js'));
const route = require(ROUTE);
const { signOauth, verifyOauth } = require('../lib/oauth-core');
const ENV_KEYS = ['ALPACA_OAUTH_CLIENT_ID', 'ALPACA_OAUTH_CLIENT_SECRET'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const configure = (on) => {
  if (on) { process.env.ALPACA_OAUTH_CLIENT_ID = 'test-client'; process.env.ALPACA_OAUTH_CLIENT_SECRET = 'test-secret'; }
  else ENV_KEYS.forEach((k) => delete process.env[k]);
};

const realRequest = https.request;
let calls = 0;
let reply = { status: 401, body: { code: 40110000, message: 'invalid_client' } };
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => req; req.write = () => {}; req.destroy = () => {};
  req.end = () => {
    calls++;
    const r = reply;
    setTimeout(() => {
      if (r.error) return req.emit('error', new Error(r.error));
      const res = new EventEmitter();
      res.statusCode = r.status;
      cb(res); res.emit('data', JSON.stringify(r.body)); res.emit('end');
    }, r.delayMs || 0);
  };
  return req;
};
after(() => {
  https.request = realRequest;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[ROUTE];
});

async function call(pathAndQuery, { cookie } = {}) {
  const headers = { host: '127.0.0.1:4177' };
  if (cookie) headers.cookie = cookie;
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers, socket: {}, url: pathAndQuery });
  const out = { status: 0, headers: {}, body: '' };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    writeHead: (code, h) => { out.status = code; for (const [k, v] of Object.entries(h || {})) out.headers[k.toLowerCase()] = v; },
    end: (b) => { out.body = b || ''; },
  };
  await route(req, res, new URL('http://127.0.0.1:4177' + pathAndQuery));
  let json = null;
  try { json = JSON.parse(out.body); } catch (_e) { /* a redirect */ }
  return { ...out, json };
}
const status = () => call('/api/broker/alpaca/status');

test('unconfigured: oneClick is false and Alpaca is never asked', async () => {
  configure(false); route._resetProbe(); calls = 0;
  const r = await status();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.configured, false);
  assert.strictEqual(r.json.oneClick, false);
  assert.strictEqual(calls, 0);
});

test('configured but not activated by Alpaca (invalid_client): oneClick false, and cached', async () => {
  configure(true); route._resetProbe(); calls = 0;
  reply = { status: 401, body: { code: 40110000, message: 'invalid_client' } };   // Alpaca's real reply, 2026-09-11
  const r = await status();
  assert.strictEqual(r.json.configured, true);
  assert.strictEqual(r.json.oneClick, false);
  await status();
  assert.strictEqual(calls, 1, 'one probe per cache window, not one per page load');
});

test('activated (the client is known, the dummy code is not): oneClick true', async () => {
  configure(true); route._resetProbe();
  reply = { status: 400, body: { error: 'invalid_grant' } };
  assert.strictEqual((await status()).json.oneClick, true);
});

test('the probe classifier: unknown is not active, and not cached for long', () => {
  const c = route._classifyProbe;
  assert.strictEqual(c({ ok: false, error: 'ECONNRESET' }), null);
  assert.strictEqual(c({ status: 503, json: {} }), null);
  assert.strictEqual(c({ status: 401, json: { message: 'invalid_client' } }), false);
  assert.strictEqual(c({ status: 401, json: { error: 'invalid_client' } }), false);
  assert.strictEqual(c({ status: 400, json: { error: 'invalid_grant' } }), true);
});

test('a slow probe never holds the status call: stale answer now, fresh one next time', async () => {
  configure(true); route._resetProbe();
  reply = { status: 400, body: { error: 'invalid_grant' }, delayMs: 150 };
  const t0 = Date.now();
  assert.strictEqual(await route._oauthActive('http://127.0.0.1:4177/api/broker/alpaca/callback', { waitMs: 20 }), false);
  assert.ok(Date.now() - t0 < 120, 'returned at waitMs, not when Alpaca answered');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(await route._oauthActive('http://127.0.0.1:4177/api/broker/alpaca/callback', { waitMs: 20 }), true);
});

test('/connect keeps returnTo on this site', async () => {
  configure(true);
  const back = async (rt) => {
    const r = await call('/api/broker/alpaca/connect?returnTo=' + encodeURIComponent(rt));
    assert.strictEqual(r.status, 302);
    const raw = String(r.headers['set-cookie']).match(/lantern_alpaca_oauth=([^;]+)/)[1];
    return verifyOauth(decodeURIComponent(raw)).returnTo;
  };
  assert.strictEqual(await back('/settings.html#connections'), '/settings.html#connections');
  assert.strictEqual(await back('https://evil.example/x'), '/orchestration.html#broker');
  assert.strictEqual(await back('//evil.example/x'), '/orchestration.html#broker');
});

test('the OAuth result lands in the query, before the #hash', async () => {
  const cookie = (returnTo) => 'lantern_alpaca_oauth=' + encodeURIComponent(signOauth({
    state: 's1', env: 'paper', userId: null, returnTo, redirectUri: 'http://127.0.0.1:4177/api/broker/alpaca/callback', exp: Date.now() + 60000,
  }));
  const r = await call('/api/broker/alpaca/callback?error=access_denied&state=s1', { cookie: cookie('/settings.html#connections') });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/settings.html?alpaca=error&reason=access_denied#connections');
  const off = await call('/api/broker/alpaca/callback?error=access_denied&state=s1', { cookie: cookie('https://evil.example') });
  assert.match(off.headers.location, /^\/orchestration\.html\?alpaca=error/, 'even a signed cookie cannot send the browser off-site');
});
