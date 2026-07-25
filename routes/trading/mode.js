'use strict';
/**
 * routes/trading/trader-mode.js — the ACTIVE-TRADER switch (Phase 2).
 *
 *   GET  /api/trading/mode  → { mode: 'stock'|'champion' } for this user
 *   POST /api/trading/mode  → { mode } sets it (also a 1-year cookie so the choice
 *                             survives session-id drift, like broker_pref)
 *
 * One account, one active strategy: the autopilot loop reads this and runs either the
 * day-trader or the Champion allocation book on the user's account — never both.
 */

const traderMode = require('../../lib/trader-mode');

module.exports = async function traderModeRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/mode') return false;
  const { sendJson, collectRequestBody, getEffectiveUserId } = ctx;
  // Owner-machine convention (mirrors broker/preference): an id-less request on a box
  // with the auth funnel off IS the owner, so the switch works for the single-user
  // local setup the trader ships in.
  const uid = getEffectiveUserId(req) || 'local-owner';
  const { readCookie } = require('../../lib/oauth-core');

  if (req.method === 'GET') {
    const cookie = (() => { const c = readCookie(req, 'trader_mode'); return traderMode.VALID.has(c) ? c : null; })();
    return sendJson(res, { mode: cookie || traderMode.get(uid) }, 200), true;
  }
  if (req.method === 'POST') {
    const body = await collectRequestBody(req);
    let mode = '';
    try { mode = String((JSON.parse(body || '{}') || {}).mode || '').toLowerCase(); } catch (_e) { /* bad json */ }
    if (!traderMode.set(uid, mode)) {
      return sendJson(res, { error: 'invalid_mode', message: "mode must be 'stock' or 'champion'" }, 400), true;
    }
    // Single-user/owner box (auth off): mirror to local-owner so the background
    // autopilot (which trades the 'local-owner' account) follows the UI choice.
    try {
      const { loginGateEnabled } = require('../../lib/auth-middleware');
      if (!loginGateEnabled() && uid !== 'local-owner') traderMode.set('local-owner', mode);
    } catch (_e) { /* auth module absent → nothing to mirror */ }
    const secure = (((req.headers && req.headers['x-forwarded-proto']) || '').includes('https') || (req.socket && req.socket.encrypted)) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `trader_mode=${mode}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
    return sendJson(res, { ok: true, mode }, 200), true;
  }
  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
