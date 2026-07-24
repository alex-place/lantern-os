/**
 * Trading routes — watchlist group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

const watchlistStore = require('../../lib/watchlist-store');
const { getEffectiveUserId } = require('../../lib/session-identity');

module.exports = async function watchlistRoutes(req, res, url, ctx) {
  const { sendJson, collectRequestBody, bridge, traderAgent } = ctx;
  const uid = getEffectiveUserId(req); // per-user watchlist (the signed-in user's own list)

  // GET /api/trading/watchlist — this user's own list
  if (url.pathname === '/api/trading/watchlist' && req.method === 'GET') {
    sendJson(res, { watchlist: watchlistStore.getWatchlist(uid) }, 200);
    return true;
  }

  // POST /api/trading/watchlist
  // Body: { ticker } — add a ticker to the persisted watchlist
  if (url.pathname === '/api/trading/watchlist' && req.method === 'POST') {
    if (!traderAgent) {
      sendJson(res, { watchlist: [], error: 'TraderAgent not initialized' }, 503);
      return true;
    }
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const sym = String(payload.ticker || '').trim();
      if (!sym) { sendJson(res, { error: 'ticker required' }, 400); return true; }
      // Validate the symbol is a real, tradable asset before adding (#1624) — via
      // the Python bridge, which has the Alpaca creds. Don't store unverified
      // tickers like "WALMART" that never get price data. Falls open only if the
      // validator itself errors (so a bridge hiccup can't block every add).
      let v = null;
      try { v = await traderAgent.validateSymbol(sym); } catch (_e) { v = null; }
      if (v && v.valid === false) {
        sendJson(res, { error: `"${sym}" isn't a tradable symbol${v.reason ? ' — ' + v.reason : ''}`, valid: false }, 400);
        return true;
      }
      const watchlist = watchlistStore.addTicker(uid, (v && v.symbol) || sym);
      if (traderAgent) traderAgent.clearCache();
      sendJson(res, { watchlist, resolved: v || null }, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // DELETE /api/trading/watchlist/:ticker — remove a ticker from the watchlist
  if (req.method === 'DELETE') {
    const watchlistMatch = url.pathname.match(/^\/api\/trading\/watchlist\/([A-Za-z]{1,10})$/);
    if (watchlistMatch) {
      const watchlist = watchlistStore.removeTicker(uid, watchlistMatch[1]);
      if (traderAgent) traderAgent.clearCache();
      sendJson(res, { watchlist }, 200);
      return true;
    }
  }

  return false;
};
