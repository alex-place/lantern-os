'use strict';

/**
 * server-book.js — who may read the SERVER's own brokerage session (2026-10-11).
 *
 * lib/trader-agent and a bare `new IbkrCpapi()` read the env IBKR client: the gateway the
 * autonomous trader runs on — the OPERATOR's book, wherever that gateway is signed in.
 * lib/trading-api-bridge already refuses it to a real user ("we must NEVER fall back to the
 * operator's account for a real user"), and lib/alpaca-adapter closed the same hole for
 * Alpaca (#2546: "person B saw person A's positions"). But five read routes still fell back
 * to it whenever a user's own broker did not answer:
 *
 *   /api/trading/positions          the legacy agent, last resort
 *   /api/trading/orders             the legacy agent, then the server-wide manual ledger
 *   /api/trading/portfolio/history  the env IBKR history, then the server's session rows
 *   /api/trading/status             the env account and positions, for anyone with "trade"
 *   /api/trading/zones (PUBLIC)     each ticker's `position`, from the legacy agent
 *
 * So a Pro user with no broker — or one whose own IBKR session had lapsed — was answered
 * from the operator's account where the gateway is signed in, and told "the broker could
 * not be reached" where it is not (production), which is not true either: they have no
 * broker. And the public zones payload carried the operator's positions to anyone; the
 * pages that read it hid the field, which is not the same as not sending it.
 *
 * The rule: an admin, or the configured operator profile (TRADER_OPERATOR_UID, default
 * 'local-owner' as in the routes), may read the server's book. Everyone else reads their
 * own connection, or is told plainly that there is none.
 */

const OPERATOR_UID = () => process.env.TRADER_OPERATOR_UID || 'local-owner';

/** May this request read the server's own brokerage session? Fails closed. */
function mayReadServerBook(req, uid) {
  try { if (require('./auth-middleware').isAdmin(req)) return true; } catch (_e) { /* fail closed */ }
  return !!(uid && uid === OPERATOR_UID());
}

/** Has this user connected a broker of their own (IBKR or Alpaca)? */
function hasOwnBroker(uid) {
  if (!uid) return false;
  try { if (require('./ibkr-credentials').has(uid)) return true; } catch (_e) { /* not connected */ }
  try { if (require('./alpaca-credentials').has(uid)) return true; } catch (_e) { /* not connected */ }
  return false;
}

/**
 * The positions answer for a user the server's book is not theirs to read: the
 * endpoint's own "available:false" (#2725), saying which of two different things is true.
 * `no_broker` lets the page say "connect a broker" instead of "the broker could not be
 * reached" — the second is only true for someone who has one.
 */
function noServerBook(uid) {
  const own = hasOwnBroker(uid);
  return {
    available: false,
    no_broker: !own,
    reason: own ? 'your broker did not answer' : 'no broker connected',
    positions: [],
    account: {},
  };
}

module.exports = { mayReadServerBook, hasOwnBroker, noServerBook, OPERATOR_UID };
