'use strict';
/**
 * routes/trading/overnight.js — the overnight sleeve book (the day-trader's measured
 * best self; see lib/overnight-trader.js for the evidence trail).
 *
 *   GET  /api/trading/overnight            → { enabled, armed, config, state, recent }
 *   POST /api/trading/overnight/run        → force one tick now (testing; respects
 *                                            the same windows/gates — outside a window
 *                                            it's a no-op, honestly visible in state)
 *
 * STAFF ONLY (operator decision, 2026-07-31). The overnight book is too early in
 * development to hand to customers, and unlike the intraday/champion traders it is
 * NOT per-user: lib/overnight-trader.js runs as ONE identity (OVERNIGHT_USER, default
 * local-owner), so every call here acts on the OPERATOR'S OWN broker account no matter
 * who is signed in.
 *
 * Both routes were previously ungated — any signed-in user could POST /run to force a
 * tick of the operator's book, and GET leaked its account id, positions and edge
 * stats. What the $200 Pilot tier buys is the INTRADAY and CHAMPION traders, which are
 * gated per-user in routes/trading.js against the `ai_trader` capability.
 */
const overnight = require('../../lib/overnight-trader');
const { requireStaff } = require('../../lib/auth-middleware');

module.exports = async function overnightRoutes(req, res, url, ctx) {
  const p = url.pathname;
  if (p !== '/api/trading/overnight' && p !== '/api/trading/overnight/run') return false;
  const { sendJson, bridge } = ctx;
  // Gate BEFORE any work or disclosure. requireStaff writes its own 302/403.
  if (!requireStaff(req, res)) return true;
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
