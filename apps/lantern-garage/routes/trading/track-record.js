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

const { getTrackRecord, buildBookFromRows } = require('../../lib/track-record');
const championDemo = require('../../lib/champion-demo');
const { getEffectiveUserId } = require('../../lib/session-identity');
const { internalUserId } = require('../../lib/request-auth');

// PER-USER (#3275): the record is scoped to the requesting account, so a user's
// journal answers with THEIR trades. An id-less request on an owner box is the
// owner (same convention as routes/trading/mode.js), and legacy rows with no
// stamped account read as that same house book.
const scopeFor = (req) => getEffectiveUserId(req) || internalUserId(req) || 'local-owner';

module.exports = async function trackRecordRoutes(req, res, url, ctx) {
  if (url.pathname !== '/api/trading/track-record' || req.method !== 'GET') return false;
  const { sendJson } = ctx;
  try {
    // Demo showroom (#3242 demo-mode): ?demo=champion serves a SIMULATED book —
    // the sanctioned guest pattern (see server.js tradeApiGuard). Never touches
    // the real ledger, so nothing real is published.
    if (url.searchParams.get('demo') === 'champion') {
      const { exits } = championDemo.journalRows();
      sendJson(res, {
        generatedAt: new Date().toISOString(),
        confirmedOnly: true,
        demo: true,
        source: 'champion-demo',
        books: { demo: buildBookFromRows(exits, { label: 'Demo book (simulated)' }) },
        method: 'A simulated demo book — deterministic sample data, not real trades and not the house ledger. Your own account gets the real version of this journal automatically.',
        disclaimers: ['Simulated for demonstration. No real positions, fills, or P&L are shown here.'],
      }, 200);
      return true;
    }
    sendJson(res, getTrackRecord(undefined, scopeFor(req)), 200);
  } catch (e) {
    sendJson(res, { error: 'track_record_failed', message: e.message }, 500);
  }
  return true;
};
