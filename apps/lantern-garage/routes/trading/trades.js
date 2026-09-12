'use strict';
/**
 * routes/trading/trades.js — the trade log (#3558).
 *
 * Loop stage: Observe. The journal has shown aggregates since #3543 and never the list
 * they are drawn from, so there was nowhere to look up one trade you remember making.
 *
 *   GET /api/trading/trades
 *     ?limit  1..200 (default 50)   ?offset   paging
 *     ?sort   ts|pnl|pnl_pct|r|symbol|qty     ?dir  asc|desc
 *     ?symbol ?from ?to ?result win|loss|flat|all   filters
 *     ?view   confirmed (default) | all       the honesty split every other figure carries
 *     ?demo=champion                          the simulated book a guest journal shows
 *
 * Paging and sorting are server-side because sorting a page rather than the set would
 * order the rows that happen to be visible — which looks like sorting and is not.
 */

const { tradeLog, buildLog } = require('../../lib/trade-log');
const championDemo = require('../../lib/champion-demo');
const { getEffectiveUserId } = require('../../lib/session-identity');
const { internalUserId } = require('../../lib/request-auth');

// PER-USER (#3275) — the same scoping rule as scorecard.js and track-record.js, so the
// list and the figures above it are drawn from one book.
const scopeFor = (req) => getEffectiveUserId(req) || internalUserId(req) || 'local-owner';

/** Same operator fallback as the scorecard: ADMIN ONLY, and only when the read was empty. */
function operatorFallbackUid(req, hadRows) {
  if (hadRows) return null;
  let admin = false;
  try { admin = require('../../lib/auth-middleware').isAdmin(req); } catch (_e) { admin = false; }
  if (!admin) return null;
  return process.env.TRADER_OPERATOR_UID || 'local-owner';
}

function optsFrom(url) {
  const q = url.searchParams;
  return {
    limit: q.get('limit'), offset: q.get('offset'),
    sort: q.get('sort'), dir: q.get('dir'),
    symbol: q.get('symbol'), from: q.get('from'), to: q.get('to'),
    result: q.get('result'), view: q.get('view'),
  };
}

module.exports = async function tradesRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/trades' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    const opts = optsFrom(url);
    if (url.searchParams.get('demo') === 'champion') {
      // The guest journal reads a SIMULATED book through the same builders, so the demo
      // trade log is the demo statistics' own rows rather than a second invention.
      const { exits } = championDemo.journalRows();
      sendJson(res, { ...buildLog(exits, opts), demo: true, source: 'champion-demo' }, 200);
      return true;
    }
    let log = tradeLog(undefined, scopeFor(req), opts);
    const alt = operatorFallbackUid(req, log.total > 0);
    if (alt) log = tradeLog(undefined, alt, opts);
    sendJson(res, log, 200);
  } catch (e) {
    sendJson(res, { error: 'trade_log_failed', message: e.message }, 500);
  }
  return true;
};
