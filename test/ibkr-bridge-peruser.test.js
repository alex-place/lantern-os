'use strict';

// Phase 5 (ADR-0022) — the bridge resolves each user's OWN IBKR client, and a
// signed-in user WITHOUT their own credentials is disconnected (never falls back to
// the operator's account). Disconnect takes effect immediately. Mock IBKR is
// protocol-faithful (derives the same LST).

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const IbkrOAuth1 = require('../lib/ibkr-oauth1');
const { modPow, toBigEndianBytes } = IbkrOAuth1;
const store = require('../lib/ibkr-credentials');
const TradingAPIBridge = require('../lib/trading-api-bridge');

process.env.SESSION_SECRET = 'ibkr-phase5-test';
const DH_PRIME = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF';
const P = BigInt('0x' + DH_PRIME);
const USER_A = 'phase5-A-' + crypto.randomBytes(3).toString('hex');
const USER_B = 'phase5-B-' + crypto.randomBytes(3).toString('hex');

const enc = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sig = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CONSUMER = 'P5CONSUMER';
const SECRET = Buffer.from('phase5-secret', 'utf8');
const ATS = crypto.publicEncrypt({ key: enc.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, SECRET).toString('base64');

const mock = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    const send = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = req.url.split('?')[0];
    if (p === '/v1/api/oauth/live_session_token') {
      const A = BigInt('0x' + /diffie_hellman_challenge="([0-9a-f]+)"/.exec(req.headers.authorization)[1]);
      const b = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
      const B = modPow(2n, b, P), K = modPow(A, b, P);
      const lst = crypto.createHmac('sha1', Buffer.from(toBigEndianBytes(K))).update(SECRET).digest('base64');
      const s = crypto.createHmac('sha1', Buffer.from(lst, 'base64')).update(CONSUMER, 'utf8').digest('hex');
      return send({ diffie_hellman_response: B.toString(16), live_session_token_signature: s, live_session_token_expiration: 600000 });
    }
    if (p === '/v1/api/iserver/auth/ssodh/init') return send({ authenticated: true, connected: true });
    if (p === '/v1/api/tickle') return send({ session: 'S', iserver: { authStatus: { authenticated: true, connected: true } } });
    return send({ error: 'nf' }, 404);
  });
});

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.IBKR_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1/api`;
  let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); pass++; };

  store.save(USER_A, {
    consumerKey: CONSUMER, accessToken: 'P5TOKEN', accessTokenSecret: ATS,
    signaturePem: sig.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    encryptionPem: enc.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    dhPrime: DH_PRIME, realm: 'limited_poa', accountId: 'DU777',
  });

  const bridge = new TradingAPIBridge();

  console.log('per-user isolation');
  const a = await bridge.getIBKRStatus(USER_A);
  ok(a && a.connected === true, 'user A (connected) → their own IBKR session is live');

  const b = await bridge.getIBKRStatus(USER_B);
  ok(b && b.connected === false, 'user B (no creds) → disconnected, NOT the operator account');

  ok(bridge.ibkrForUser(USER_B) === null, 'ibkrForUser(no-creds) returns null (never a fallback client)');
  ok(bridge.ibkrForUser(USER_A) !== null, 'ibkrForUser(connected) returns a client');

  console.log('disconnect is immediate');
  store.remove(USER_A);
  const a2 = await bridge.getIBKRStatus(USER_A);
  ok(a2 && a2.connected === false, 'after disconnect, user A is immediately disconnected (cache re-validated)');

  mock.close();
  console.log(`\nAll ${pass} per-user bridge assertions passed.`);
})().catch((e) => { console.error(e); try { store.remove(USER_A); } catch {} mock.close(); process.exit(1); });
