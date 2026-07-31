'use strict';

/**
 * IBKR Web API OAuth 1.0a signer (self-service / first-party) — ADR-0022.
 *
 * Implements the exact IBKR flow: a Diffie-Hellman exchange + RSA-SHA256 signed
 * request obtains a Live Session Token (LST); every subsequent request is signed
 * HMAC-SHA256 with the LST. Dependency-free (Node `crypto` + BigInt), ported from
 * a verified reference implementation (art1c0/ibkr-client, IBKR OAuth 1.0a docs).
 *
 * SECURITY: the six credentials (consumerKey, accessToken, accessTokenSecret, the
 * two RSA private keys, the DH prime) are secrets. Callers must store them
 * encrypted at rest and never log or return them. This module only signs.
 */

const crypto = require('crypto');

const GENERATOR = 2n;

class IbkrOAuth1 {
  /**
   * @param {object} cfg
   * @param {string} cfg.consumerKey
   * @param {string} cfg.accessToken
   * @param {string} cfg.accessTokenSecret  base64, RSA-encrypted by IBKR
   * @param {string} cfg.signaturePem       signing RSA private key (PEM)
   * @param {string} cfg.encryptionPem      encryption RSA private key (PEM)
   * @param {string} cfg.dhPrime            Diffie-Hellman prime (hex, optional 0x)
   * @param {string} [cfg.realm='limited_poa']
   */
  constructor(cfg) {
    if (!cfg || !cfg.consumerKey || !cfg.accessToken) throw new Error('ibkr_oauth1: missing consumerKey/accessToken');
    this.consumerKey = cfg.consumerKey;
    this.accessToken = cfg.accessToken;
    this.accessTokenSecret = cfg.accessTokenSecret;
    this.signaturePem = cfg.signaturePem;
    this.encryptionPem = cfg.encryptionPem;
    this.dhPrime = BigInt('0x' + String(cfg.dhPrime || '').replace(/^0x/i, ''));
    this.realm = cfg.realm || 'limited_poa';
  }

  // ── Step 1: build the /oauth/live_session_token request ────────────────────
  /**
   * @param {string} url absolute URL of the live_session_token endpoint
   * @returns {{headers:object, dhRandom:string, prepend:string}}
   */
  buildLiveSessionTokenRequest(url) {
    const dhRandom = crypto.randomBytes(32).toString('hex');           // DH private `a`
    const dhChallenge = modPow(GENERATOR, BigInt('0x' + dhRandom), this.dhPrime).toString(16);
    const prepend = this._decryptPrepend(this.accessTokenSecret);       // RSA-decrypted secret → hex
    const headers = this._oauthHeaders(url, 'POST', null, null, { diffie_hellman_challenge: dhChallenge }, prepend);
    return { headers, dhRandom, prepend };
  }

  // ── Step 2: derive + validate the Live Session Token from the DH response ──
  /**
   * @param {string} dhResponse  hex, from the server's `diffie_hellman_response`
   * @param {string} dhRandom    the `dhRandom` returned by buildLiveSessionTokenRequest
   * @param {string} prepend     the `prepend` returned by buildLiveSessionTokenRequest
   * @returns {string} the LST (base64)
   */
  computeLiveSessionToken(dhResponse, dhRandom, prepend) {
    const K = modPow(BigInt('0x' + dhResponse), BigInt('0x' + dhRandom), this.dhPrime);
    const h = crypto.createHmac('sha1', Buffer.from(toBigEndianBytes(K)));
    h.update(Buffer.from(prepend, 'hex'));
    return h.digest('base64');
  }

  /** Confirm the LST matches the server's signature before using it. */
  validateLiveSessionToken(lst, liveSessionTokenSignature) {
    // HMAC-SHA1 is mandated by IBKR's OAuth1 spec for LST validation — it is a protocol
    // MAC over a public consumer key, not password storage, and the algorithm is not
    // ours to choose. Changing it would simply fail their verification.
    const h = crypto.createHmac('sha1', Buffer.from(lst, 'base64')); // codeql[js/insufficient-password-hash]
    h.update(this.consumerKey, 'utf8');
    return h.digest('hex') === liveSessionTokenSignature;
  }

  // ── Step 3: sign an ordinary API request with the LST ──────────────────────
  /**
   * @param {string} url absolute request URL (no query for signing convenience; pass params separately)
   * @param {string} method HTTP method
   * @param {string} lst the Live Session Token (base64)
   * @param {object} [params] query/body params to include in the signature base
   * @returns {object} headers incl. Authorization: OAuth …
   */
  signRequest(url, method, lst, params) {
    return this._oauthHeaders(url, method, lst, params || null, null, null);
  }

  // ── internals ──────────────────────────────────────────────────────────────
  _oauthHeaders(url, method, lst, params, extra, prepend) {
    const headers = {
      oauth_signature_method: lst ? 'HMAC-SHA256' : 'RSA-SHA256',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_consumer_key: this.consumerKey,
      oauth_nonce: nonce(),
      oauth_token: this.accessToken,
      ...(extra || {}),
    };
    const baseString = this._baseString(url, method, headers, params || {}, prepend);
    headers.realm = this.realm;
    headers.oauth_signature = lst
      ? this._hmacSha256(baseString, lst)
      : this._rsaSha256(baseString);
    const oauth = Object.entries(headers)
      .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');
    return {
      Accept: '*/*',
      'Accept-Encoding': 'gzip,deflate',
      Authorization: `OAuth ${oauth}`,
      Connection: 'keep-alive',
      'User-Agent': 'unisona-ibkr/1',
    };
  }

  _baseString(url, method, headers, params, prepend) {
    const parts = { ...headers, ...params };
    const encoded = Object.entries(parts)
      .sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const base = [method.toUpperCase(), quotePlus(url), quotePlus(encoded)].join('&');
    return (prepend || '') + base;
  }

  _rsaSha256(baseString) {
    const sig = crypto.createSign('RSA-SHA256').update(baseString, 'utf8').sign(this.signaturePem, 'base64');
    return quotePlus(sig);
  }

  _hmacSha256(baseString, lst) {
    const h = crypto.createHmac('sha256', Buffer.from(lst, 'base64'));
    h.update(baseString, 'utf8');
    return quotePlus(h.digest('base64'));
  }

  /** RSA (PKCS#1 v1.5) decrypt the base64 access-token-secret → hex "prepend".
   *  Node 22 removed RSA_PKCS1_PADDING for private decryption (CVE mitigation), so
   *  we do a raw RSA_NO_PADDING decrypt and strip the EME-PKCS1-v1_5 padding
   *  ourselves: EM = 0x00 || 0x02 || PS(>=8 non-zero) || 0x00 || M. */
  _decryptPrepend(secretB64) {
    const em = crypto.privateDecrypt(
      { key: this.encryptionPem, padding: crypto.constants.RSA_NO_PADDING },
      Buffer.from(secretB64, 'base64')
    );
    if (em.length < 11 || em[0] !== 0x00 || em[1] !== 0x02) throw new Error('ibkr_oauth1: bad PKCS1 block');
    let i = 2;
    while (i < em.length && em[i] !== 0x00) i++;           // skip PS
    if (i >= em.length || i < 10) throw new Error('ibkr_oauth1: PKCS1 separator not found');
    return em.slice(i + 1).toString('hex');                // M → hex
  }
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Modular exponentiation over BigInt: base^exp mod mod. */
function modPow(base, exp, mod) {
  base %= mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Big-endian, unsigned byte array of a BigInt (leading 0 when bitlen % 8 === 0),
 *  matching IBKR's expected HMAC key encoding. */
function toBigEndianBytes(x) {
  let hex = x.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = [];
  if (x.toString(2).length % 8 === 0) bytes.push(0);
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** RFC-3986 percent-encode, then %20 → + (IBKR's "quote_plus"). */
function quotePlus(str) {
  return encodeURIComponent(str).replace(/%20/g, '+');
}

function nonce() {
  const az = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  const b = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) s += az[b[i] % az.length];
  return s;
}

module.exports = IbkrOAuth1;
module.exports.modPow = modPow;
module.exports.toBigEndianBytes = toBigEndianBytes;
module.exports.quotePlus = quotePlus;
