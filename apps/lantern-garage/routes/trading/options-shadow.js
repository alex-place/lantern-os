'use strict';
/**
 * routes/trading/options-shadow.js — the asymmetric-options SHADOW trader (Verify stage).
 *
 *   GET  /api/trading/options-shadow          → config + state + MEASURED win-rate/expectancy + verdict
 *   GET  /api/trading/options-shadow/probe    → what it WOULD trade right now (gates, contract, quote)
 *   POST /api/trading/options-shadow/tick     → manual tick (testing; normally the autoscan drives it)
 *
 * Places no orders anywhere — it measures the operator's low-win-rate OTM-overnight
 * thesis against real chain quotes, and refuses arming until expectancy is measured > 0.
 */

const shadow = require('../../lib/options-shadow');

module.exports = async function optionsShadowRoutes(req, res, url, ctx) {
  const p = url.pathname;
  if (!p.startsWith('/api/trading/options-shadow')) return false;
  const { sendJson } = ctx;
  try {
    if (p === '/api/trading/options-shadow' && req.method === 'GET') {
      return sendJson(res, shadow.status(), 200), true;
    }
    if (p === '/api/trading/options-shadow/probe' && req.method === 'GET') {
      return sendJson(res, await shadow.probe(), 200), true;
    }
    if (p === '/api/trading/options-shadow/tick' && req.method === 'POST') {
      await shadow.tick();
      return sendJson(res, { ok: true, ...shadow.status() }, 200), true;
    }
  } catch (e) {
    return sendJson(res, { error: 'options_shadow_failed', message: e.message }, 500), true;
  }
  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
