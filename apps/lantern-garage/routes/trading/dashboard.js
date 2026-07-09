/**
 * Trading routes — dashboard group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function dashboardRoutes(req, res, url, ctx) {
  const { sendJson, callDashboard, tradingStore, tradingNews, recordOrder, recordSignal, DASHBOARD_PROXY_ROUTES, DIRECT_DASHBOARD_PROXY_PATHS } = ctx;


  // ── Trading memory: local orders & agent-log (Trading Phase 2, #323) ──────
  // LanternOS-native: reads/writes data/lantern-garage/trading/*.jsonl and
  // CSF Tier.TRACE records under data/csf_memory/ directly. No external
  // service, no Python process — works from a fresh checkout of this repo
  // alone.

  // GET /api/trading/dashboard/orders
  // Local order history, newest entries last (matches the order they were
  // recorded). Returns a bare array — trading.html does
  // `Array.isArray(orders)`.
  if (url.pathname === '/api/trading/dashboard/orders' && req.method === 'GET') {
    try {
      const limitParam = Number(url.searchParams.get('limit'));
      const orders = tradingStore.listOrders(limitParam > 0 ? { limit: limitParam } : {});
      sendJson(res, orders, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to read local orders', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/dashboard/agent-log
  // Local agent/signal log, newest entries last. Returns a bare array —
  // trading.html does `Array.isArray(logs)`.
  if (url.pathname === '/api/trading/dashboard/agent-log' && req.method === 'GET') {
    try {
      const limitParam = Number(url.searchParams.get('limit'));
      const logs = tradingStore.listLogEntries({ limit: limitParam > 0 ? limitParam : 100 });
      sendJson(res, logs, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to read local agent log', details: error.message }, 500);
    }
    return true;
  }

  // ── /trading.html + /trading-news.html dashboard proxy routes ─────────────
  // Legacy/optional — see DASHBOARD_PROXY_ROUTES note above. Not required
  // for trading memory (orders/agent-log/CSF), which is served above.
  // GET /api/trading/dashboard/{positions,market-status,zones,watchlist-prices,agent-log,orders,news-feed}
  if (req.method === 'GET' && DASHBOARD_PROXY_ROUTES[url.pathname]) {
    try {
      const proxyPath = DASHBOARD_PROXY_ROUTES[url.pathname];
      const data = await callDashboard(proxyPath);
      // CSF memory wiring: write orders, agent-log, and news to CSF on state change
      if (proxyPath === '/api/orders' && Array.isArray(data?.orders || data)) {
        const orders = data.orders || data;
        for (const o of orders) { recordOrder(o).catch(() => {}); }
      }
      if (proxyPath === '/api/agent-log' && Array.isArray(data?.logs || data)) {
        const logs = data.logs || data;
        for (const s of logs) { recordSignal(s).catch(() => {}); }
      }
      if (proxyPath === '/api/news-feed') {
        const items = [...(data?.ticker_news || []), ...(data?.broad_news || [])];
        for (const item of items) { tradingNews.recordNewsItem(item).catch(() => {}); }
      }
      sendJson(res, data, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 502);
    }
    return true;
  }

  // GET /api/{positions,market-status,watchlist-prices,ai-trader/signals}[/demo]
  // Bare-path proxy for trading.html's direct fetches — see
  // DIRECT_DASHBOARD_PROXY_PATHS above.
  if (req.method === 'GET' && DIRECT_DASHBOARD_PROXY_PATHS.has(url.pathname)) {
    try {
      const data = await callDashboard(url.pathname + (url.search || ''));
      sendJson(res, data, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 502);
    }
    return true;
  }

  return false;
};
