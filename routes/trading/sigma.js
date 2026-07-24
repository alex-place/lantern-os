'use strict';
/**
 * routes/trading/sigma.js — the Sigma Trader allocation book (ADR-0027/0028).
 *
 * Loop stage: Act (slow, diversified — NOT a day-trader). Thin HTTP surface over
 * lib/sigma-trader.js. Runs on the Sigma Trader's OWN dedicated Alpaca account
 * (SIGMA_ALPACA_* keys or its own connected OAuth) — never the day-trader's shared
 * book. PAPER only; DRY by default; places PAPER orders ONLY when explicitly armed
 * (?arm=1) AND the operator set SIGMA_ARM=1. Real capital stays gated on ADR-0028.
 *
 *   GET  /api/trading/sigma-trader            → plan: target weights × brake gross,
 *                                                current vs target, drift orders + schedule state
 *   POST /api/trading/sigma-trader/rebalance  → rebalance the OWN paper book (dry unless armed)
 *
 * /api/trading/champion(/rebalance) kept as a back-compat alias for one release.
 */

const sigma = require('../../lib/sigma-trader');

const PLAN = new Set(['/api/trading/sigma-trader', '/api/trading/champion']);
const REBAL = new Set(['/api/trading/sigma-trader/rebalance', '/api/trading/champion/rebalance']);

module.exports = async function sigmaRoutes(req, res, url, ctx) {
  const p = url.pathname;
  if (!PLAN.has(p) && !REBAL.has(p)) return false;
  const { sendJson } = ctx;
  try {
    if (PLAN.has(p) && req.method === 'GET') {
      const plan = await sigma.plan();
      // Attach the scheduler state so the UI shows whether Sigma is running itself.
      let schedule = null;
      try { schedule = require('../../lib/sigma-scheduler').getStatus(); } catch (_e) { /* absent */ }
      return sendJson(res, { ...plan, schedule }, plan.ok ? 200 : 503), true;
    }
    if (REBAL.has(p) && req.method === 'POST') {
      const arm = url.searchParams.get('arm') === '1';
      const out = await sigma.rebalanceNow({ arm });
      return sendJson(res, out, out.ok === false ? 503 : 200), true;
    }
  } catch (e) {
    return sendJson(res, { ok: false, error: 'sigma_failed', message: e.message }, 500), true;
  }
  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
