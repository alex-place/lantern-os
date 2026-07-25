/**
 * Trading routes — TRADELIST group (the AI autopilot's per-user trading universe).
 *
 * Mirrors routes/trading/watchlist.js shape-for-shape at /api/trading/tradelist.
 * The tradelist gates the AUTOPILOT only (routes/trading.js autoscan filter):
 * the AI enters symbols on this list and nothing else. The watchlist is
 * tracking-only, and manual buy/sell stays free on any symbol.
 */

const tradelistStore = require('../../lib/tradelist-store');
const { getEffectiveUserId } = require('../../lib/session-identity');

module.exports = async function tradelistRoutes(req, res, url, ctx) {
  const { sendJson, collectRequestBody, traderAgent } = ctx;
  const uid = getEffectiveUserId(req); // per-user tradelist (the signed-in user's own list)

  // GET /api/trading/tradelist — this user's own AI trading universe
  if (url.pathname === '/api/trading/tradelist' && req.method === 'GET') {
    sendJson(res, { tradelist: tradelistStore.getTradelist(uid) }, 200);
    return true;
  }

  // POST /api/trading/tradelist — body { ticker }: allow the AI to trade this symbol
  if (url.pathname === '/api/trading/tradelist' && req.method === 'POST') {
    if (!traderAgent) {
      sendJson(res, { tradelist: [], error: 'TraderAgent not initialized' }, 503);
      return true;
    }
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const sym = String(payload.ticker || '').trim();
      if (!sym) { sendJson(res, { error: 'ticker required' }, 400); return true; }
      // Same validation as the watchlist add: never store an unverified ticker the
      // scanner can't price. Falls open only if the validator itself errors.
      let v = null;
      try { v = await traderAgent.validateSymbol(sym); } catch (_e) { v = null; }
      if (v && v.valid === false) {
        sendJson(res, { error: `"${sym}" isn't a tradable symbol${v.reason ? ' — ' + v.reason : ''}`, valid: false }, 400);
        return true;
      }
      const tradelist = tradelistStore.addTicker(uid, (v && v.symbol) || sym);
      if (traderAgent) traderAgent.clearCache();   // scan universe changed
      sendJson(res, { tradelist, resolved: v || null }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // DELETE /api/trading/tradelist/:ticker — the AI may no longer trade this symbol
  if (req.method === 'DELETE') {
    const m = url.pathname.match(/^\/api\/trading\/tradelist\/([A-Za-z]{1,10})$/);
    if (m) {
      const tradelist = tradelistStore.removeTicker(uid, m[1]);
      if (traderAgent) traderAgent.clearCache();
      sendJson(res, { tradelist }, 200);
      return true;
    }
  }

  return false;
};
