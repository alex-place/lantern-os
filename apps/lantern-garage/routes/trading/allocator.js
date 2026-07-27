'use strict';
/**
 * routes/trading/allocator.js — the capital allocator's live view (Converge stage).
 *
 *   GET /api/trading/allocator → { equity, regime, sleeves: {intraday|overnight|
 *     options: { pct, usd, proven, score, evidence, why }}, cash_pct }
 *
 * Read-only: the allocator places nothing; engines pull budgetPctFor() themselves.
 */
const allocator = require('../../lib/capital-allocator');

module.exports = async function allocatorRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/allocator' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  // Staff surface (operator direction 2026-07-26): the Book is internal — users
  // never see raw sleeve budgets. Admin/staff only; an auth-off box is the operator.
  try {
    const am = require('../../lib/auth-middleware');
    if (am.loginGateEnabled && am.loginGateEnabled()) {
      const sess = require('../../lib/session-identity').getSessionUser(req);
      const role = String((sess && sess.role) || 'guest');
      if (!['admin', 'tech_support'].includes(role)) {
        sendJson(res, { error: 'staff_only', message: 'The allocator book is an internal surface' }, 403);
        return true;
      }
    }
  } catch (_e) { /* auth module absent → single-user box */ }
  try {
    const a = await allocator.currentAllocation();
    sendJson(res, { ...a, caps: allocator.CAP_PCT, floors: allocator.FLOOR_PCT, min_n: allocator.MIN_N, generatedAt: new Date().toISOString() }, 200);
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
  return true;
};
