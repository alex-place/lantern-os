/**
 * kalshi-api.js — Kalshi v2 REST client with RSA-PSS auth
 *
 * Fix for issue #397: Kalshi generates PKCS#1 RSA keys but Node.js
 * crypto.sign() requires PKCS#8. We use crypto.createPrivateKey() which
 * accepts both formats, resolving the "unsupported" decoder error.
 *
 * Auth model:
 *   Public endpoints (/markets, /events, /orderbook) — no auth
 *   Authenticated (/portfolio/*, /balance) — RSA-PSS signed headers
 *
 * Env vars:
 *   KALSHI_API_KEY_ID      — your API key ID from kalshi.com/settings/api
 *   KALSHI_PRIVATE_KEY     — PEM content (PKCS#1 or PKCS#8, both accepted)
 *   KALSHI_PRIVATE_KEY_PATH — path to PEM file (fallback if no inline key)
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const KALSHI_HOST    = 'trading-api.kalshi.com';
const KALSHI_API_V2  = '/trade-api/v2';
const REQUEST_TIMEOUT_MS = 10_000;

// ── Private key loader — handles PKCS#1 and PKCS#8 ───────────────────────────

/**
 * Load private key from env or file, normalise to KeyObject.
 * Accepts both PKCS#1 (-----BEGIN RSA PRIVATE KEY-----) and
 * PKCS#8 (-----BEGIN PRIVATE KEY-----) PEM formats.
 * Returns a crypto.KeyObject or null if no key is configured.
 */
function loadPrivateKey() {
  let pem = process.env.KALSHI_PRIVATE_KEY || '';

  if (!pem) {
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (keyPath) {
      try {
        pem = fs.readFileSync(path.resolve(keyPath), 'utf8');
      } catch {
        return null;
      }
    }
  }

  if (!pem) return null;

  pem = pem.trim();

  // #397 fix: crypto.createPrivateKey accepts both PKCS#1 and PKCS#8.
  // Node's crypto.sign() with a raw string PEM only accepts PKCS#8 and
  // throws "unsupported" on PKCS#1. Wrapping in createPrivateKey fixes this.
  try {
    return crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    console.error('[kalshi-api] Failed to parse private key:', err.message);
    return null;
  }
}

// ── RSA-PSS signed headers ────────────────────────────────────────────────────

/**
 * Build Kalshi RSA-PSS authentication headers.
 * Returns {} if credentials are not configured (public endpoint fallback).
 */
function signedHeaders(method, path) {
  const apiKeyId = process.env.KALSHI_API_KEY_ID || '';
  const privateKey = loadPrivateKey();

  if (!apiKeyId || !privateKey) return {};

  const ts = Date.now().toString();
  // Kalshi signature message format: timestamp + method + path
  const msg = `${ts}${method.toUpperCase()}${path}`;

  const signature = crypto.sign(
    'sha256',
    Buffer.from(msg),
    {
      key:        privateKey,
      padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }
  ).toString('base64');

  return {
    'KALSHI-ACCESS-KEY':       apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

// ── Core HTTP helper ──────────────────────────────────────────────────────────

function kalshiRequest(method, apiPath, body = null, authenticated = false) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      ...(authenticated ? signedHeaders(method, `/trade-api/v2${apiPath}`) : {}),
    };

    const reqBody = body ? JSON.stringify(body) : null;
    if (reqBody) headers['Content-Length'] = Buffer.byteLength(reqBody);

    const options = {
      hostname: KALSHI_HOST,
      path:     `${KALSHI_API_V2}${apiPath}`,
      method:   method.toUpperCase(),
      headers,
      timeout:  REQUEST_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(Object.assign(new Error(`Kalshi ${res.statusCode}`), { status: res.statusCode, body: parsed }));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Kalshi parse error (status ${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Kalshi request timeout')); });
    req.on('error', reject);

    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// ── Public endpoints ──────────────────────────────────────────────────────────

/**
 * Get open markets, optionally filtered by series_ticker or category.
 * @param {Object} params — e.g. { series_ticker: 'KXBTU', limit: 100 }
 */
function getMarkets(params = {}) {
  const qs = new URLSearchParams({ status: 'open', limit: '100', ...params }).toString();
  return kalshiRequest('GET', `/markets?${qs}`);
}

/**
 * Get events — useful for discovering crypto prediction markets.
 * @param {Object} params — e.g. { series_ticker: 'KXBTU', limit: 100 }
 */
function getEvents(params = {}) {
  const qs = new URLSearchParams({ status: 'open', limit: '100', ...params }).toString();
  return kalshiRequest('GET', `/events?${qs}`);
}

/**
 * Get available series (for discovering crypto tickers like KXBTU, KXETHU).
 */
function getSeries() {
  return kalshiRequest('GET', '/series');
}

/**
 * Get orderbook for a specific market.
 * @param {string} ticker — market ticker, e.g. 'KXMLBTC5PM-24DEC31-B50000'
 */
function getOrderbook(ticker) {
  return kalshiRequest('GET', `/markets/${encodeURIComponent(ticker)}/orderbook`);
}

/**
 * Get a single market's details.
 */
function getMarket(ticker) {
  return kalshiRequest('GET', `/markets/${encodeURIComponent(ticker)}`);
}

// ── Authenticated endpoints ───────────────────────────────────────────────────

/**
 * Get account balance. Requires KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY.
 * Returns { balance: number } where balance is in cents.
 */
function getBalance() {
  return kalshiRequest('GET', '/portfolio/balance', null, true);
}

/**
 * Get open positions.
 */
function getPositions() {
  return kalshiRequest('GET', '/portfolio/positions', null, true);
}

/**
 * Get fills (trade history).
 * @param {Object} params — e.g. { limit: 50 }
 */
function getFills(params = {}) {
  const qs = new URLSearchParams({ limit: '50', ...params }).toString();
  return kalshiRequest('GET', `/portfolio/fills?${qs}`, null, true);
}

/**
 * Get portfolio orders.
 * @param {Object} params — e.g. { status: 'resting', limit: 50 }
 */
function getOrders(params = {}) {
  const qs = new URLSearchParams({ limit: '50', ...params }).toString();
  return kalshiRequest('GET', `/portfolio/orders?${qs}`, null, true);
}

/**
 * Check if RSA credentials are configured.
 */
function hasCredentials() {
  return !!(process.env.KALSHI_API_KEY_ID && (process.env.KALSHI_PRIVATE_KEY || process.env.KALSHI_PRIVATE_KEY_PATH));
}

// ── Crypto market discovery (issue #398) ─────────────────────────────────────

const CRYPTO_SERIES = ['KXBTU', 'KXETHU', 'KXSOLU', 'KXXRPU', 'KXDOGEU'];

/**
 * Discover BTC/ETH/SOL/XRP/DOGE 15-minute prediction markets.
 * Kalshi's standard /markets feed omits these — they require series_ticker filters.
 * Returns deduplicated list of open crypto markets sorted by close_time ascending.
 */
async function getCryptoMarkets(limit = 50) {
  const results = [];
  const seen = new Set();

  await Promise.allSettled(
    CRYPTO_SERIES.map(async (ticker) => {
      try {
        const data = await getMarkets({ series_ticker: ticker, limit });
        const markets = data.markets || [];
        for (const m of markets) {
          if (!seen.has(m.ticker)) {
            seen.add(m.ticker);
            results.push({ ...m, _series: ticker });
          }
        }
      } catch {
        // Series may not exist for this account tier — skip silently
      }
    })
  );

  // Also try events endpoint for crypto series
  await Promise.allSettled(
    CRYPTO_SERIES.map(async (ticker) => {
      try {
        const data = await getEvents({ series_ticker: ticker, limit: 20 });
        const events = data.events || [];
        for (const ev of events) {
          for (const m of (ev.markets || [])) {
            if (!seen.has(m.ticker)) {
              seen.add(m.ticker);
              results.push({ ...m, _series: ticker, _from_event: ev.event_ticker });
            }
          }
        }
      } catch { /* skip */ }
    })
  );

  results.sort((a, b) => new Date(a.close_time || 0) - new Date(b.close_time || 0));
  return results;
}

module.exports = {
  getMarkets,
  getEvents,
  getSeries,
  getOrderbook,
  getMarket,
  getBalance,
  getPositions,
  getFills,
  getOrders,
  getCryptoMarkets,
  hasCredentials,
  loadPrivateKey,   // exported for testing
  signedHeaders,    // exported for testing
  CRYPTO_SERIES,
};
