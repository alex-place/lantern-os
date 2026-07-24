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
 *   GET /api/trading/scorecard  → { confirmed, all, note, generatedAt }
 */

const { scorecard } = require('../../lib/trader-scorecard');

module.exports = async function scorecardRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/scorecard' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    sendJson(res, scorecard(), 200);
  } catch (e) {
    sendJson(res, { error: 'scorecard_failed', message: e.message }, 500);
  }
  return true;
};
