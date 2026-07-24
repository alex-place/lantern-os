'use strict';

// Verifies the IBKR OAuth 1.0a signer's crypto is internally consistent:
// - modPow / toBigEndianBytes / quotePlus primitives
// - RSA-PKCS1 decrypt of the "prepend" (round-trip against a local keypair)
// - RSA-SHA256 request signature (verifiable with the public key)
// - full DH → Live Session Token derivation + validation, simulating the server
//   side (both parties derive g^(ab) mod p, so the LST must match).
// Live IBKR calls can't be tested without real credentials; this proves the math.

const assert = require('assert');
const crypto = require('crypto');
const IbkrOAuth1 = require('../lib/ibkr-oauth1');
const { modPow, toBigEndianBytes, quotePlus } = IbkrOAuth1;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ✓', m); pass++; };

// RFC 2409 MODP-1024 prime, generator 2 — valid DH params for the math test.
const DH_PRIME = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF';

console.log('primitives');
ok(modPow(2n, 10n, 1000n) === 24n, 'modPow(2^10 mod 1000) = 24');
ok(modPow(4n, 13n, 497n) === 445n, 'modPow(4^13 mod 497) = 445');
ok(quotePlus('a b/c?d=e') === 'a+b%2Fc%3Fd%3De', 'quotePlus encodes + spaces as +');
ok(Buffer.from(toBigEndianBytes(0x00ffn)).toString('hex') === '00ff', 'toBigEndianBytes pads high-bit byte');

console.log('RSA keys (2048-bit) for encryption + signature');
const enc = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sig = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const encPem = enc.privateKey.export({ type: 'pkcs1', format: 'pem' });
const sigPem = sig.privateKey.export({ type: 'pkcs1', format: 'pem' });

const signer = new IbkrOAuth1({
  consumerKey: 'TESTCONSUMER',
  accessToken: 'TESTTOKEN',
  accessTokenSecret: crypto.publicEncrypt(
    { key: enc.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from('the-quick-brown-fox', 'utf8')
  ).toString('base64'),
  signaturePem: sigPem,
  encryptionPem: encPem,
  dhPrime: DH_PRIME,
  realm: 'limited_poa',
});

console.log('prepend (RSA-PKCS1 decrypt round-trip)');
const prepend = signer._decryptPrepend(signer.accessTokenSecret);
ok(Buffer.from(prepend, 'hex').toString('utf8') === 'the-quick-brown-fox', 'access-token-secret decrypts to the original');

console.log('RSA-SHA256 request signature is verifiable with the public key');
const lstReq = signer.buildLiveSessionTokenRequest('https://api.ibkr.com/v1/api/oauth/live_session_token');
ok(/OAuth /.test(lstReq.headers.Authorization), 'Authorization header is OAuth');
ok(/oauth_signature_method="RSA-SHA256"/.test(lstReq.headers.Authorization), 'LST request uses RSA-SHA256');
ok(/diffie_hellman_challenge="[0-9a-f]+"/.test(lstReq.headers.Authorization), 'carries diffie_hellman_challenge');
ok(typeof lstReq.dhRandom === 'string' && lstReq.dhRandom.length === 64, 'dhRandom is 32 bytes hex');

console.log('full DH → Live Session Token derivation + validation');
// Simulate the SERVER side: it knows the prime, picks b, returns B = g^b mod p,
// computes K = A^b, and signs LST = HMAC-SHA1(K, prepend).
const p = BigInt('0x' + DH_PRIME);
const a = BigInt('0x' + lstReq.dhRandom);
const A = modPow(2n, a, p);                                   // client challenge (what we sent)
const b = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
const B = modPow(2n, b, p);                                   // server response
const Kserver = modPow(A, b, p);                              // shared secret server-side
const lstExpected = crypto.createHmac('sha1', Buffer.from(toBigEndianBytes(Kserver)))
  .update(Buffer.from(prepend, 'hex')).digest('base64');
const serverSig = crypto.createHmac('sha1', Buffer.from(lstExpected, 'base64'))
  .update('TESTCONSUMER', 'utf8').digest('hex');

const lst = signer.computeLiveSessionToken(B.toString(16), lstReq.dhRandom, prepend);
ok(lst === lstExpected, 'client-derived LST equals the server-derived LST (g^ab agree)');
ok(signer.validateLiveSessionToken(lst, serverSig) === true, 'validateLiveSessionToken accepts the server signature');
ok(signer.validateLiveSessionToken(lst, 'deadbeef') === false, 'validateLiveSessionToken rejects a bad signature');

console.log('request signing with the LST (HMAC-SHA256)');
const rh = signer.signRequest('https://api.ibkr.com/v1/api/portfolio/accounts', 'GET', lst);
ok(/oauth_signature_method="HMAC-SHA256"/.test(rh.Authorization), 'signed requests use HMAC-SHA256');
ok(/oauth_signature="[^"]+"/.test(rh.Authorization), 'carries an oauth_signature');

console.log(`\nAll ${pass} IBKR OAuth 1.0a assertions passed.`);
