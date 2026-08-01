'use strict';
/**
 * routes/trading/account-mode.js — the DEMO / PAPER / TRADE switch (#2546).
 *
 *   GET  /api/trading/account-mode → { mode, readOnly, canPlaceOrders, backing, available, … }
 *   POST /api/trading/account-mode { mode } → set it (+ a 1-year cookie, like broker_pref)
 *
 * Distinct from /api/trading/mode, which picks the STRATEGY (stock | champion). This picks
 * WHOSE MONEY it runs on. See lib/trading-account-mode.js for the ladder.
 *
 * `trade` is refused unless the user has LIVE Alpaca credentials — a UI that says "live"
 * while orders quietly land on paper is the worst possible failure here, so the server
 * decides, not the client.
 */

const accountMode = require('../../lib/trading-account-mode');

/** Which BYOK Alpaca credentials does this user actually hold? Never returns the secrets. */
function _credentials(userId) {
  try {
    const st = require('../../lib/alpaca-credentials').publicStatus(userId);
    if (!st || !st.connected) return { hasPaperKeys: false, hasLiveKeys: false };
    return { hasPaperKeys: st.env !== 'live', hasLiveKeys: st.env === 'live' };
  } catch (_e) { return { hasPaperKeys: false, hasLiveKeys: false }; }
}

module.exports = async function accountModeRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/account-mode') return false;
  const { sendJson, collectRequestBody, getEffectiveUserId } = ctx;
  // Owner-machine convention, same as broker-preference / trader-mode: an id-less request on
  // a box with the auth funnel off IS the owner.
  const uid = getEffectiveUserId(req) || 'local-owner';
  const creds = _credentials(uid);

  if (req.method === 'GET') {
    return sendJson(res, { ok: true, ...accountMode.describe(uid, creds) }, 200), true;
  }

  if (req.method === 'POST') {
    const body = await collectRequestBody(req);
    let mode = '';
    try { mode = String((JSON.parse(body || '{}') || {}).mode || '').toLowerCase(); } catch (_e) { /* bad json */ }

    if (!accountMode.VALID.has(mode)) {
      return sendJson(res, { error: 'invalid_mode', message: "mode must be 'demo', 'paper' or 'trade'" }, 400), true;
    }
    if (!accountMode.set(uid, mode, { hasLiveCredentials: creds.hasLiveKeys })) {
      // The only way a valid mode fails is `trade` without live keys.
      return sendJson(res, {
        error: 'live_not_connected',
        message: 'Real-money trading needs your Alpaca LIVE keys connected first. '
          + 'Paper keys keep you on the Paper rung.',
        nextStep: { action: 'connect_broker', endpoint: '/api/broker/alpaca/connect-keys' },
      }, 400), true;
    }

    const secure = (((req.headers && req.headers['x-forwarded-proto']) || '').includes('https')
      || (req.socket && req.socket.encrypted)) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `account_mode=${mode}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
    return sendJson(res, { ok: true, ...accountMode.describe(uid, creds) }, 200), true;
  }

  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
