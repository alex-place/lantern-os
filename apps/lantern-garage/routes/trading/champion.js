'use strict';
/**
 * routes/trading/champion.js — the Champion allocation book (ADR-0027/0028).
 *
 * Loop stage: Act (slow, diversified — NOT a day-trader). Thin HTTP surface over
 * lib/champion-book.js. PAPER only; DRY by default. The POST places PAPER orders
 * ONLY when explicitly armed (?arm=1) AND the operator set CHAMPION_ARM=1 — real
 * capital stays gated on the ADR-0028 Sharpe-CI mandate (nothing has met it).
 *
 *   GET  /api/trading/champion            → plan: target weights × live brake gross,
 *                                            current vs target, drift orders (no trade)
 *   POST /api/trading/champion/rebalance  → rebalance the PAPER book (dry unless armed)
 */

const champion = require('../../lib/champion-book');

module.exports = async function championRoutes(req, res, url, ctx) {
  const p = url.pathname;
  if (p !== '/api/trading/champion' && p !== '/api/trading/champion/rebalance') return false;
  const { sendJson, getEffectiveUserId } = ctx;
  const userId = getEffectiveUserId ? getEffectiveUserId(req) : null;

  try {
    if (p === '/api/trading/champion' && req.method === 'GET') {
      const plan = await champion.plan(userId);
      return sendJson(res, plan, plan.ok ? 200 : 503), true;
    }
    if (p === '/api/trading/champion/rebalance' && req.method === 'POST') {
      const arm = url.searchParams.get('arm') === '1';
      const out = await champion.rebalanceNow(userId, { arm });
      return sendJson(res, out, out.ok === false ? 503 : 200), true;
    }
  } catch (e) {
    return sendJson(res, { ok: false, error: 'champion_failed', message: e.message }, 500), true;
  }
  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
