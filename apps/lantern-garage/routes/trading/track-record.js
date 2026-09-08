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

/**
 * OPERATOR VIEW (mirrors routes/trading/market.js, 2026-08-06).
 *
 * The autonomous trader books under a FIXED operator id ('local-owner'), but these
 * routes resolve the BROWSER session's profile id. Those are different identities,
 * so an operator signed in normally read an empty slice while their own ledger held
 * a month of confirmed fills -- the journal could not see the book it exists to
 * review. market.js hit the same wall and reported $0.00 while the bot traded a
 * $960k IBKR account.
 *
 * ADMIN ONLY, and only as a FALLBACK: an admin who HAS trades of their own still
 * sees their own, and a non-admin is never redirected to the house book, so no real
 * ledger can leak to a normal user.
 */
function operatorFallbackUid(req, hadRows) {
  if (hadRows) return null;
  let admin = false;
  try { admin = require('../../lib/auth-middleware').isAdmin(req); } catch (_e) { admin = false; }
  if (!admin) return null;
  return process.env.TRADER_OPERATOR_UID || 'local-owner';
}
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
    let rec = getTrackRecord(undefined, scopeFor(req));
    // Did the session's own slice actually contain anything?
    const _has = Object.values((rec && rec.books) || {})
      .some((b) => b && b.stats && b.stats.trades > 0);
    const _op = operatorFallbackUid(req, _has);
    if (_op) rec = getTrackRecord(undefined, _op);
    sendJson(res, rec, 200);
  } catch (e) {
    sendJson(res, { error: 'track_record_failed', message: e.message }, 500);
  }
  return true;
};
