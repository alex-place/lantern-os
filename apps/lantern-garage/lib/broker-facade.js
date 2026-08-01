'use strict';

/**
 * broker-facade.js — make the autopilot broker-agnostic (ADR-0027).
 *
 * runAutoTrade (auto-trader.js) calls bridge.getIBKRAccount / getIBKRPositions /
 * getIBKROpenOrders / getIBKRDayPnl / placeIBKROrder. Rather than rename those call
 * sites (the autopilot's re-protect / trailing-exit logic is delicate), this returns
 * an object exposing the SAME method names, dispatching to whichever broker the user
 * connected: their IBKR account (ADR-0022) or their one-click Alpaca account
 * (ADR-0027). The method names stay IBKR-flavored for zero-diff compatibility;
 * the implementation underneath is broker-neutral.
 *
 * Precedence is operator-configurable: BROKER_PREFER=alpaca tries Alpaca first and
 * falls back to IBKR; the default ('ibkr') preserves the original IBKR-first order.
 * Either way the OTHER broker remains the automatic fallback, so setting a
 * preference never turns a working account into "no broker connected".
 *
 * Returns null when the user has NEITHER broker connected — the caller skips them.
 * Every placeOrder still passes trading-guard inside each adapter (dry unless armed),
 * so the facade never relaxes safety.
 */

const alpaca = require('./alpaca-adapter');

/** Which broker to try first when a user has both connected. The user's own
 *  stored choice wins (broker-preference.js, set from the trader ☰); 'auto' or
 *  no userId falls through to the operator's BROKER_PREFER env; default keeps
 *  IBKR-first. */
function preferredBroker(userId, req) {
  // Highest precedence: the per-browser `broker_pref` cookie. Identity can drift
  // (guest ids rotate; the UI saves under a session id the autopilot/env then pull
  // back toward the default) — a cookie pins the choice to the browser so what the
  // user clicked is what every request-bound route uses, stably across reloads.
  if (req) {
    try {
      const c = require('./oauth-core').readCookie(req, 'broker_pref');
      if (c === 'alpaca' || c === 'ibkr') return c;
    } catch (_e) { /* no cookie / helper — fall through */ }
  }
  // Owner-machine convention (routes/accounts.js): no session id = the owner,
  // the same 'local-owner' identity the broker credential stores already use.
  // Keeps the ☰ switch effective on auth-off/single-user boxes, where every
  // trading route resolves uid as null.
  const uid = userId != null ? userId : 'local-owner';
  const own = require('./broker-preference').get(uid);
  if (own === 'alpaca' || own === 'ibkr') return own;
  return process.env.BROKER_PREFER === 'alpaca' ? 'alpaca' : 'ibkr';
}

/**
 * @param {string} userId
 * @param {object} ibkrBridge  the shared TradingAPIBridge (getIBKR-prefixed methods)
 * @returns {Promise<{broker:string, facade:object}|null>}
 */
async function brokerFacadeFor(userId, ibkrBridge) {
  // ── DEMO rung (#2546) ────────────────────────────────────────────────────────────────
  // An EXPLICIT demo choice short-circuits before any broker is touched: demo is a showroom,
  // so it must not read the user's linked account at all. A user who has never chosen a mode
  // is NOT treated as demo here — that would replace an existing user's real connected
  // account with a simulated fixture. They fall through the normal chain, and only land on
  // demo below if nothing at all is connected (see demoFacade at the end).
  const accountMode = require('./trading-account-mode');
  const demoFacade = () => {
    const demo = require('./champion-demo');
    const snap = demo.positions();
    // Read-only is structural, not conventional: there is no working write path here, so a
    // caller that forgets to check the mode still cannot place an order in demo.
    const reject = async () => accountMode.assertCanPlaceOrder(accountMode.DEMO);
    return {
      broker: 'demo', accountId: snap.account.account_id, demo: true, readOnly: true,
      facade: {
        getIBKRAccount: async () => snap.account,
        getIBKRPositions: async () => demo.positions().positions,
        getIBKROpenOrders: async () => [],          // a fixture has no working orders
        getIBKRDayPnl: async () => ({ dailyPnl: snap.account.pnl_today, unrealizedPnl: snap.account.unrealized, realizedPnl: 0 }),
        placeIBKROrder: reject,
        cancelIBKROrder: reject,
      },
    };
  };
  if (accountMode.getExplicit(userId) === accountMode.DEMO) return demoFacade();

  const tryIbkr = async () => {
    if (!ibkrBridge) return null;
    const acct = await ibkrBridge.getIBKRAccount(userId).catch(() => null);
    return acct && acct.account_id ? { broker: 'ibkr', accountId: acct.account_id, facade: ibkrBridge } : null;
  };
  const tryAlpaca = async () => {
    // An Alpaca account (user's own OAuth, or the operator's server paper keys),
    // wrapped to present the IBKR-named surface.
    if (!alpaca.available(userId)) return null;
    const acct = await alpaca.getAccount(userId).catch(() => null);
    if (!acct) return null;
    const facade = {
      getIBKRAccount: (uid) => alpaca.getAccount(uid),
      getIBKRPositions: async (uid) => ((await alpaca.getPositions(uid)) || { positions: [] }).positions,
      getIBKROpenOrders: (uid) => alpaca.getOpenOrders(uid),
      getIBKRDayPnl: (uid) => alpaca.getDayPnl(uid),
      placeIBKROrder: (uid, order) => alpaca.placeOrder(uid, order),
      // Cancel was missing from the facade (the IBKR bridge has it natively), so any
      // engine cancelling a resting stop through the facade silently couldn't on
      // Alpaca — leaving orphaned GTC sell-stops that can fire on a flat position
      // and open an unintended short. Map it.
      cancelIBKROrder: (uid, orderId) => alpaca.cancelOrder(uid, orderId),
    };
    return { broker: 'alpaca', accountId: acct.account_id, facade };
  };
  // Last resort: the user's OWN house practice account (#2546). A brand-new signed-in user
  // owns no brokerage account, so both attempts above return null and the caller used to skip
  // them entirely — the trader was dead on arrival until they went and opened an Alpaca
  // account. This gives them a personal, per-user practice ledger to trade immediately, and
  // BYOK Alpaca (POST /api/broker/alpaca/connect-keys) remains the destination: the moment
  // they connect their own paper account, tryAlpaca resolves first and this is never reached.
  //
  // Deliberately NOT offered to the null/owner identity — on a single-user box the owner's
  // shared server keys are a real Alpaca paper account and shadowing it with a simulation
  // would be a downgrade. HOUSE_PAPER_FALLBACK=0 disables this entirely.
  const tryHouse = async () => {
    if (userId == null || userId === '' || userId === 'local-owner') return null;
    if (process.env.HOUSE_PAPER_FALLBACK === '0') return null;
    const house = require('./house-paper-broker');
    house.ensureAccount(userId);                 // idempotent — never resets an existing ledger
    const acct = await house.getAccount(userId).catch(() => null);
    if (!acct) return null;
    const facade = {
      getIBKRAccount: (uid) => house.getAccount(uid),
      getIBKRPositions: async (uid) => ((await house.getPositions(uid)) || { positions: [] }).positions,
      getIBKROpenOrders: (uid) => house.getOpenOrders(uid),
      getIBKRDayPnl: (uid) => house.getDayPnl(uid),
      placeIBKROrder: (uid, o) => house.placeOrder(uid, o),
      cancelIBKROrder: (uid, id) => house.cancelOrder(uid, id),
    };
    return { broker: 'house', accountId: acct.account_id, facade, practice: true };
  };

  const order = preferredBroker(userId) === 'alpaca' ? [tryAlpaca, tryIbkr] : [tryIbkr, tryAlpaca];
  for (const attempt of order) {
    const resolved = await attempt();
    if (resolved) return resolved;
  }
  // Nothing connected. An explicit `paper` choice means the user asked to practice, so give
  // them their own house ledger to trade. Anyone else (no choice made) gets the read-only
  // demo book — a populated dashboard beats an empty one, and it can place no orders.
  const house = await tryHouse();
  if (house) return house;
  if (userId != null && userId !== '' && userId !== 'local-owner') return demoFacade();
  return null;   // owner identity with nothing configured — unchanged
}

module.exports = { brokerFacadeFor, preferredBroker };
