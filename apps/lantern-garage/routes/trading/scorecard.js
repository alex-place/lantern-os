'use strict';
/**
 * routes/trading/scorecard.js — realized-edge scorecard for the stock autopilot.
 *
 * Loop stage: Verify. Thin HTTP surface over lib/trader-scorecard.js — reads the
 * autopilot's exit log and returns win rate / expectancy / profit factor + a
 * per-exit-reason breakdown, split into `confirmed` (broker-accepted fills) and
 * `all` (every exit decision). Market/strategy math only — no account or auth-
 * sensitive data — so it's available to signed-in users like other trading GETs.
 *
 *   GET /api/trading/scorecard                → { confirmed, all, note, generatedAt }
 *   GET /api/trading/scorecard?by=symbol      → per-symbol slices (same honesty split)
 *   GET /api/trading/scorecard?by=hour        → per-ET-hour slices
 *   GET /api/trading/scorecard?by=reason      → per-exit-reason slices (profitOnly flagged)
 *   GET /api/trading/scorecard?by=skip        → the skip log grouped by decline reason (#3243 v1)
 */

const { scorecard, breakdown, BREAKDOWN_KEYS } = require('../../lib/trader-scorecard');

module.exports = async function scorecardRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/scorecard' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    const by = url.searchParams.get('by');
    if (by) {
      if (!BREAKDOWN_KEYS.includes(by)) {
        sendJson(res, { error: 'unknown_breakdown', by, supported: BREAKDOWN_KEYS }, 400);
        return true;
      }
      sendJson(res, breakdown(by), 200);
      return true;
    }
    sendJson(res, scorecard(), 200);
  } catch (e) {
    sendJson(res, { error: 'scorecard_failed', message: e.message }, 500);
  }
  return true;
};
