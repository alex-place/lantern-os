'use strict';
/**
 * routes/trading/track-record.js — the settlement-graded record snapshot.
 *
 * Loop stage: Verify. Serves the snapshot built by lib/track-record.js:
 * confirmed-fills-only stats, daily realized P&L, max drawdown, per-exit-reason
 * table, and the Champion book's honest `pending` state — the data layer for
 * the signed-in journal UI (#3242). Deliberately NOT on PUBLIC_TRADING_READS:
 * product decision 2026-08-11, the ledger is not published, so this sits behind
 * the standard trade gate like the scorecard.
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
