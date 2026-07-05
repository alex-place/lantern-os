'use strict';

// Phase 3 (ADR-0022) — HTTP-level test of the per-user connect/disconnect flow:
// the real routes/ibkr.js + encrypted store + live probe, against a protocol-faithful
// mock IBKR. A fake session injects the user id (tradeApiGuard/login are server-level
// and tested elsewhere). Proves: connect saves encrypted creds + probes live, status
// reflects it, disconnect removes it — and secrets never come back in responses.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const IbkrOAuth1 = require('../lib/ibkr-oauth1');
const { modPow, toBigEndianBytes } = IbkrOAuth1;
const store = require('../lib/ibkr-credentials');

const DH_PRIME = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF';
const P = BigInt('0x' + DH_PRIME);
const USER = 'test-ibkr-user-' + crypto.randomBytes(4).toString('hex');

process.env.SESSION_SECRET = 'ibkr-phase3-test-secret';

// mock IBKR (knows the secret so it derives the same LST)
const enc = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sig = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CONSUMER = 'PH3CONSUMER';
const SECRET_PLAIN = Buffer.from('phase3-secret-payload', 'utf8');
const ACCESS_TOKEN_SECRET = crypto.publicEncrypt(
  { key: enc.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, SECRET_PLAIN).toString('base64');

const mock = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    const send = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = req.url.split('?')[0];
    if (p === '/v1/api/oauth/live_session_token') {
      const A = BigInt('0x' + /diffie_hellman_challenge="([0-9a-f]+)"/.exec(req.headers.authorization)[1]);
      const b = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
      const B = modPow(2n, b, P), K = modPow(A, b, P);
      const lst = crypto.createHmac('sha1', Buffer.from(toBigEndianBytes(K))).update(SECRET_PLAIN).digest('base64');
      const s = crypto.createHmac('sha1', Buffer.from(lst, 'base64')).update(CONSUMER, 'utf8').digest('hex');
      return send({ diffie_hellman_response: B.toString(16), live_session_token_signature: s, live_session_token_expiration: 600000 });
    }
    if (p === '/v1/api/iserver/auth/ssodh/init') return send({ authenticated: true, connected: true });
    if (p === '/v1/api/tickle') return send({ session: 'S', iserver: { authStatus: { authenticated: true, connected: true } } });
    return send({ error: 'nf' }, 404);
  });
});

// tiny harness server: inject a fake session, delegate to the real ibkr route
const ibkrRoutes = require('../routes/ibkr');
const harness = http.createServer(async (req, res) => {
  req.session = { user: { id: USER } };
  const url = new URL(req.url, 'http://127.0.0.1');
  const handled = await ibkrRoutes(req, res, url);
  if (!handled) { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.IBKR_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1/api`;
  await new Promise((r) => harness.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${harness.address().port}`;
  let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); pass++; };

  const creds = {
    consumerKey: CONSUMER, accessToken: 'PH3TOKEN', accessTokenSecret: ACCESS_TOKEN_SECRET,
    signaturePem: sig.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    encryptionPem: enc.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    dhPrime: DH_PRIME, realm: 'limited_poa', accountId: 'DU1234567',
  };

  console.log('connect');
  const cr = await (await fetch(`${base}/api/trading/ibkr/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) })).json();
  ok(cr.ok === true && cr.live && cr.live.connected === true, 'connect saves creds + live probe reports connected');
  ok(cr.status.accountId === 'DU1234567' && cr.status.mode === 'paper', 'status shows the paper account (DU…) mode');
  ok(!JSON.stringify(cr).includes('PRIVATE KEY') && !JSON.stringify(cr).includes(ACCESS_TOKEN_SECRET), 'response never leaks the PEM keys or secret');

  console.log('at-rest encryption');
  const raw = fs.readFileSync(store._file(USER), 'utf8');
  ok(!raw.includes('PRIVATE KEY') && !raw.includes('PH3TOKEN') && /"ct":/.test(raw), 'stored file is AES-GCM ciphertext, not plaintext');
  ok(store.buildSigner(USER) instanceof IbkrOAuth1, 'buildSigner reconstructs the signer from the encrypted store');

  console.log('status');
  const st = await (await fetch(`${base}/api/trading/ibkr/connection`)).json();
  ok(st.hasCredentials === true && st.live && st.live.connected === true, 'GET connection reports connected');

  console.log('bad-credentials probe fails soft (no fabrication)');
  const badCreds = { ...creds, encryptionPem: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) };
  const br = await (await fetch(`${base}/api/trading/ibkr/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(badCreds) })).json();
  ok(br.ok === true && br.live.connected === false, 'wrong key → saved but honestly reports disconnected');

  console.log('disconnect');
  const dr = await (await fetch(`${base}/api/trading/ibkr/disconnect`, { method: 'POST' })).json();
  ok(dr.ok === true && dr.removed === true, 'disconnect removes the stored credentials');
  const st2 = await (await fetch(`${base}/api/trading/ibkr/connection`)).json();
  ok(st2.hasCredentials === false, 'after disconnect, no credentials remain');

  try { fs.unlinkSync(store._file(USER)); } catch {}
  mock.close(); harness.close();
  console.log(`\nAll ${pass} IBKR connect-flow assertions passed.`);
})().catch((e) => { console.error(e); try { fs.unlinkSync(store._file(USER)); } catch {} mock.close(); harness.close(); process.exit(1); });
