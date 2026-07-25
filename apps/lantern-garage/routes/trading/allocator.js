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
  try {
    const a = await allocator.currentAllocation();
    sendJson(res, { ...a, caps: allocator.CAP_PCT, floors: allocator.FLOOR_PCT, min_n: allocator.MIN_N, generatedAt: new Date().toISOString() }, 200);
  } catch (e) {
    sendJson(res, { error: e.message }, 500);
  }
  return true;
};
