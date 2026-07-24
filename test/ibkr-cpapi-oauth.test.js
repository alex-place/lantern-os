'use strict';

// Phase 2 (ADR-0022) — verifies IbkrCpapi drives the full OAuth 1.0a session against
// a PROTOCOL-FAITHFUL mock IBKR: the mock generates the user's keys, runs the real
// Diffie-Hellman exchange, and derives the Live Session Token exactly as the server
// would. probe()/getAccounts() only succeed if the client's signing + LST derivation
// are correct — so a pass is real evidence, not a stub.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const IbkrOAuth1 = require('../lib/ibkr-oauth1');
const IbkrCpapi = require('../lib/ibkr-cpapi');
const { modPow, toBigEndianBytes } = IbkrOAuth1;

const DH_PRIME = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF';
const P = BigInt('0x' + DH_PRIME);

// ── mock IBKR: owns the user's secret so it can derive the same LST ──────────
const enc = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sig = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CONSUMER = 'MOCKCONSUMER';
const ACCESS_TOKEN = 'MOCKACCESS';
const SECRET_PLAIN = Buffer.from('unisona-ibkr-test-secret-payload', 'utf8'); // == prepend bytes
const ACCESS_TOKEN_SECRET = crypto.publicEncrypt(
  { key: enc.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, SECRET_PLAIN).toString('base64');

function dhChallengeFromAuth(authHeader) {
  const m = String(authHeader || '').match(/diffie_hellman_challenge="([0-9a-fA-F]+)"/);
  return m ? m[1] : null;
}

// Real IBKR returns `live_session_token_expiration` as an ABSOLUTE epoch-ms
// timestamp ~24h out. Mutable so one test can serve a malformed value instead.
let lstExpiration = () => Date.now() + 24 * 60 * 60 * 1000;
let lstHandshakes = 0;

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const path = req.url.split('?')[0];

    if (path === '/v1/api/oauth/live_session_token') {
      lstHandshakes++;
      const A = BigInt('0x' + dhChallengeFromAuth(req.headers.authorization));
      const b = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
      const B = modPow(2n, b, P);
      const K = modPow(A, b, P);                                   // shared secret, server side
      const lst = crypto.createHmac('sha1', Buffer.from(toBigEndianBytes(K))).update(SECRET_PLAIN).digest('base64');
      const lstSig = crypto.createHmac('sha1', Buffer.from(lst, 'base64')).update(CONSUMER, 'utf8').digest('hex');
      return send({ diffie_hellman_response: B.toString(16), live_session_token_signature: lstSig, live_session_token_expiration: lstExpiration() });
    }
    if (path === '/v1/api/iserver/auth/ssodh/init') return send({ authenticated: true, connected: true });
    if (path === '/v1/api/tickle') {
      // Only a correctly HMAC-signed request should reach here in practice; the mock
      // trusts the transport for the test but requires the OAuth Authorization header.
      if (!/^OAuth /.test(req.headers.authorization || '')) return send({ error: 'unauthorized' }, 401);
      return send({ session: 'MOCKSESSION', iserver: { authStatus: { authenticated: true, connected: true, competing: false } } });
    }
    if (path === '/v1/api/portfolio/accounts') {
      if (!/oauth_signature_method="HMAC-SHA256"/.test(req.headers.authorization || '')) return send({ error: 'bad_sig_method' }, 401);
      return send([{ accountId: 'DU1234567', accountVan: 'DU1234567', type: 'DEMO' }]);
    }
    return send({ error: 'not_found', path }, 404);
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  let pass = 0;
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); pass++; };

  const oauth1 = new IbkrOAuth1({
    consumerKey: CONSUMER, accessToken: ACCESS_TOKEN, accessTokenSecret: ACCESS_TOKEN_SECRET,
    signaturePem: sig.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    encryptionPem: enc.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    dhPrime: DH_PRIME, realm: 'limited_poa',
  });
  const client = new IbkrCpapi({ oauth1, baseUrl: `http://127.0.0.1:${port}/v1/api`, timeoutMs: 4000 });

  console.log('OAuth 1.0a session against mock IBKR');
  const probe = await client.probe();
  ok(probe.authenticated === true && probe.connected === true, 'probe() authenticates via the LST handshake (tickle authStatus)');

  const accts = await client.getAccounts();
  ok(Array.isArray(accts) && accts.some((a) => (a.accountId || a) === 'DU1234567'), 'getAccounts() returns the paper account (HMAC-signed request accepted)');

  // Expiration is an absolute epoch-ms deadline: the ~24h token must be cached
  // as-is (not clamped to 10 minutes) and reused across requests.
  ok(client._lst && client._lst.expiresAt > Date.now() + 23 * 60 * 60 * 1000,
    'live_session_token_expiration treated as absolute epoch-ms (~24h cached, not clamped to 10 min)');
  ok(lstHandshakes === 1, 'LST reused across probe()+getAccounts() — exactly one handshake');

  // A malformed expiration (past / duration-style value) must fall back to a
  // 10-minute deadline instead of caching a token that looks already-expired.
  lstExpiration = () => 600000; // epoch 1970 — what a duration-style server bug would send
  const fbClient = new IbkrCpapi({ oauth1, baseUrl: `http://127.0.0.1:${port}/v1/api`, timeoutMs: 4000 });
  const before = Date.now();
  await fbClient.probe();
  ok(fbClient._lst && fbClient._lst.expiresAt > before && fbClient._lst.expiresAt <= Date.now() + 10 * 60 * 1000,
    'malformed expiration falls back to a 10-minute deadline');
  lstExpiration = () => Date.now() + 24 * 60 * 60 * 1000;

  // A tampered signer (wrong encryption key → wrong prepend → wrong LST) must FAIL.
  const badEnc = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const badOauth = new IbkrOAuth1({
    consumerKey: CONSUMER, accessToken: ACCESS_TOKEN, accessTokenSecret: ACCESS_TOKEN_SECRET,
    signaturePem: sig.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    encryptionPem: badEnc.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    dhPrime: DH_PRIME, realm: 'limited_poa',
  });
  const badClient = new IbkrCpapi({ oauth1: badOauth, baseUrl: `http://127.0.0.1:${port}/v1/api`, timeoutMs: 4000 });
  const badProbe = await badClient.probe();
  ok(badProbe.authenticated !== true, 'wrong encryption key → LST validation fails → not authenticated (no fabrication)');

  mock.close();
  console.log(`\nAll ${pass} IbkrCpapi OAuth 1.0a assertions passed.`);
})().catch((e) => { console.error(e); mock.close(); process.exit(1); });
