'use strict';

/**
 * broker-facade.js — make the autopilot broker-agnostic (ADR-0027).
 *
 * runAutoTrade (auto-trader.js) calls bridge.getIBKRAccount / getIBKRPositions /
 * getIBKROpenOrders / getIBKRDayPnl / placeIBKROrder. Rather than rename those call
 * sites (the autopilot's re-protect / trailing-exit logic is delicate), this returns
 * an object exposing the SAME method names, dispatching to whichever broker the user
 * connected: their IBKR account (ADR-0022) if present, else their one-click Alpaca
 * account (ADR-0027). The method names stay IBKR-flavored for zero-diff compatibility;
 * the implementation underneath is broker-neutral.
 *
 * Returns null when the user has NEITHER broker connected — the caller skips them.
 * Every placeOrder still passes trading-guard inside each adapter (dry unless armed),
 * so the facade never relaxes safety.
 */

const alpaca = require('./alpaca-adapter');

/**
 * @param {string} userId
 * @param {object} ibkrBridge  the shared TradingAPIBridge (getIBKR-prefixed methods)
 * @returns {Promise<{broker:string, facade:object}|null>}
 */
async function brokerFacadeFor(userId, ibkrBridge) {
  // IBKR wins when connected (better execution) — return the real bridge unchanged.
  if (ibkrBridge) {
    const acct = await ibkrBridge.getIBKRAccount(userId).catch(() => null);
    if (acct && acct.account_id) return { broker: 'ibkr', accountId: acct.account_id, facade: ibkrBridge };
  }
  // Else an Alpaca account (user's own OAuth, or the operator's server paper keys),
  // wrapped to present the IBKR-named surface.
  if (alpaca.available(userId)) {
    const acct = await alpaca.getAccount(userId).catch(() => null);
    if (acct) {
      const facade = {
        getIBKRAccount: (uid) => alpaca.getAccount(uid),
        getIBKRPositions: async (uid) => ((await alpaca.getPositions(uid)) || { positions: [] }).positions,
        getIBKROpenOrders: (uid) => alpaca.getOpenOrders(uid),
        getIBKRDayPnl: (uid) => alpaca.getDayPnl(uid),
        placeIBKROrder: (uid, order) => alpaca.placeOrder(uid, order),
      };
      return { broker: 'alpaca', accountId: acct.account_id, facade };
    }
  }
  return null;
}

module.exports = { brokerFacadeFor };
