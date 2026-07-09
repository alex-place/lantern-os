/**
 * Trading routes — ibkr group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function ibkrRoutes(req, res, url, ctx) {
  const { sendJson, bridge, getEffectiveUserId } = ctx;


  // GET /api/trading/ibkr/account
  // Returns IBKR account details (account is null when the gateway is not
  // connected; the accompanying status explains why).
  if (url.pathname === '/api/trading/ibkr/account' && req.method === 'GET') {
    try {
      const uid = getEffectiveUserId(req);
      const [account, status] = await Promise.all([
        bridge.getIBKRAccount(uid),
        bridge.getIBKRStatus(uid),
      ]);
      sendJson(res, { account, status }, 200);
    } catch (error) {
      sendJson(res, { error: 'IBKR gateway error', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/ibkr/positions
  // Returns IBKR open positions ([] when the gateway is not connected)
  if (url.pathname === '/api/trading/ibkr/positions' && req.method === 'GET') {
    try {
      const positions = await bridge.getIBKRPositions(getEffectiveUserId(req));
      sendJson(res, { positions }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch positions', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/ibkr/status
  // Honest, evidence-bearing IBKR Client Portal gateway status — a real probe of
  // the local gateway, not a hardcoded flag. Always 200; connected:false + the
  // reason in `evidence` when the gateway is down or unauthenticated.
  if (url.pathname === '/api/trading/ibkr/status' && req.method === 'GET') {
    try {
      const status = await bridge.getIBKRStatus(getEffectiveUserId(req));
      sendJson(res, status, 200);
    } catch (error) {
      sendJson(res, { connected: false, reachable: false, source: 'ibkr-cpapi', error: error.message }, 200);
    }
    return true;
  }

  return false;
};
