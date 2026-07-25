'use strict';
/**
 * routes/trading/overnight.js — the overnight sleeve book (the day-trader's measured
 * best self; see lib/overnight-trader.js for the evidence trail).
 *
 *   GET  /api/trading/overnight            → { enabled, armed, config, state, recent }
 *   POST /api/trading/overnight/run        → force one tick now (testing; respects
 *                                            the same windows/gates — outside a window
 *                                            it's a no-op, honestly visible in state)
 */
const overnight = require('../../lib/overnight-trader');

module.exports = async function overnightRoutes(req, res, url, ctx) {
  const p = url.pathname;
  if (p !== '/api/trading/overnight' && p !== '/api/trading/overnight/run') return false;
  const { sendJson, bridge } = ctx;
  try {
    if (p === '/api/trading/overnight' && req.method === 'GET') {
      return sendJson(res, overnight.status(), 200), true;
    }
    if (p === '/api/trading/overnight/run' && req.method === 'POST') {
      await overnight.tick({ bridge });
      return sendJson(res, { ok: true, ...overnight.status() }, 200), true;
    }
  } catch (e) {
    return sendJson(res, { ok: false, error: 'overnight_failed', message: e.message }, 500), true;
  }
  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
