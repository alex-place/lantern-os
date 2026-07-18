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
 *   POST /api/trading/champion/rebalance  → rebalance the operator PAPER book (dry unless armed)
 *
 * CONTEST (paper-only, all tiers compete in one pool — champion-contest.js):
 *   GET  /api/trading/champion/contest             → the caller's own book (live-marked)
 *   POST /api/trading/champion/contest/start       → start/restart my book (body: {goal})
 *   POST /api/trading/champion/contest/stop        → freeze my book
 *   GET  /api/trading/champion/contest/leaderboard → the whole pool, ranked (public read)
 */

const champion = require('../../lib/champion-book');
const contest = require('../../lib/champion-contest');
const { getSessionUser } = require('../../lib/session-identity');

const CONTEST_PATHS = new Set([
  '/api/trading/champion/contest',
  '/api/trading/champion/contest/start',
  '/api/trading/champion/contest/stop',
  '/api/trading/champion/contest/leaderboard',
]);

function _readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function championRoutes(req, res, url, ctx) {
  const p = url.pathname;
  if (p !== '/api/trading/champion' && p !== '/api/trading/champion/rebalance' && !CONTEST_PATHS.has(p)) return false;
  const { sendJson, getEffectiveUserId } = ctx;
  const userId = getEffectiveUserId ? getEffectiveUserId(req) : null;

  try {
    // ── Operator allocation book (paper, dry-by-default) ──
    if (p === '/api/trading/champion' && req.method === 'GET') {
      const plan = await champion.plan(userId);
      return sendJson(res, plan, plan.ok ? 200 : 503), true;
    }
    if (p === '/api/trading/champion/rebalance' && req.method === 'POST') {
      const out = await champion.rebalanceNow(userId, { arm: url.searchParams.get('arm') === '1' });
      return sendJson(res, out, out.ok === false ? 503 : 200), true;
    }

    // ── Contest: one shared paper pool across Free / Pro / Pilot ──
    if (p === '/api/trading/champion/contest/leaderboard' && req.method === 'GET') {
      return sendJson(res, await contest.leaderboard(), 200), true;   // public read
    }
    if (CONTEST_PATHS.has(p)) {
      const u = getSessionUser(req);   // start/stop/my-book need a stable identity
      if (!u || !u.id) return sendJson(res, { ok: false, error: 'not_signed_in', message: 'Sign in to join the paper-trading contest.' }, 401), true;
      if (p === '/api/trading/champion/contest' && req.method === 'GET') {
        return sendJson(res, await contest.myBook(u.id), 200), true;
      }
      if (p === '/api/trading/champion/contest/start' && req.method === 'POST') {
        const body = await _readBody(req);
        const goal = (body && body.goal != null) ? String(body.goal).slice(0, 200) : null;
        const out = await contest.start(u.id, { name: u.name || u.email || 'Anonymous', role: u.role, tier: u.tier, goal });
        return sendJson(res, out, out.ok ? 200 : 400), true;
      }
      if (p === '/api/trading/champion/contest/stop' && req.method === 'POST') {
        const out = await contest.stop(u.id);
        return sendJson(res, out, out.ok ? 200 : 404), true;
      }
    }
  } catch (e) {
    return sendJson(res, { ok: false, error: 'champion_failed', message: e.message }, 500), true;
  }
  return sendJson(res, { error: 'method_not_allowed' }, 405), true;
};
