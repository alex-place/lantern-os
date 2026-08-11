'use strict';
/**
 * routes/trading/track-record.js — the public, settlement-graded track record.
 *
 * Loop stage: Converge. Serves the public-safe snapshot built by
 * lib/track-record.js: confirmed-fills-only stats, daily realized P&L, max
 * drawdown, per-exit-reason table, and the Champion book's honest `pending`
 * state. This endpoint is on server.js PUBLIC_TRADING_READS — the whole point
 * is that a logged-out visitor can audit the record (#3246/#3247). It contains
 * no account balances, quantities, order ids, or user data.
 *
 *   GET /api/trading/track-record → { generatedAt, confirmedOnly, books, method, disclaimers }
 */

const { getTrackRecord } = require('../../lib/track-record');

module.exports = async function trackRecordRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/track-record' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    sendJson(res, getTrackRecord(), 200);
  } catch (e) {
    sendJson(res, { error: 'track_record_failed', message: e.message }, 500);
  }
  return true;
};
