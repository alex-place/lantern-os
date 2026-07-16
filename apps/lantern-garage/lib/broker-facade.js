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
function preferredBroker(userId) {
  if (userId != null) {
    const own = require('./broker-preference').get(userId);
    if (own === 'alpaca' || own === 'ibkr') return own;
  }
  return process.env.BROKER_PREFER === 'alpaca' ? 'alpaca' : 'ibkr';
}

/**
 * @param {string} userId
 * @param {object} ibkrBridge  the shared TradingAPIBridge (getIBKR-prefixed methods)
 * @returns {Promise<{broker:string, facade:object}|null>}
 */
async function brokerFacadeFor(userId, ibkrBridge) {
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
    };
    return { broker: 'alpaca', accountId: acct.account_id, facade };
  };
  const order = preferredBroker(userId) === 'alpaca' ? [tryAlpaca, tryIbkr] : [tryIbkr, tryAlpaca];
  for (const attempt of order) {
    const resolved = await attempt();
    if (resolved) return resolved;
  }
  return null;
}

module.exports = { brokerFacadeFor, preferredBroker };
