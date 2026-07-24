/**
 * Trading routes — ai-trader group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function aiTraderRoutes(req, res, url, ctx) {
  const { sendJson, collectRequestBody, traderAgent, callAITrader, tradingMemory, tradeHistory, AI_TRADER_HOST, AI_TRADER_PORT } = ctx;


  // ── AI Trader Integration Routes ──────────────────────────────────────────
  // Proxies to the Independent AI Trader's REST API (port 5555, see
  // C:\Independant AI Trader\src\ai_trader_api.py). That service only
  // exposes /health, /api/status, /api/watchlist, /api/zones, /api/signals,
  // /api/positions, /api/alerts, and /api/control/{pause,resume,close-position}
  // — routes below map onto those. Endpoints with no equivalent there
  // (signal generation, trade history, metrics) return 501.

  // GET /api/trading/ai-trader/health
  // Check AI trader microservice health
  if (url.pathname === '/api/trading/ai-trader/health' && req.method === 'GET') {
    try {
      const result = await callAITrader('/health');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, {
        error: 'AI trader service unavailable',
        details: error.message,
        endpoint: `http://${AI_TRADER_HOST}:${AI_TRADER_PORT}`
      }, 503);
    }
    return true;
  }

  // GET /api/trading/ai-trader/signals
  // Get recent AI-generated trading signals
  if (url.pathname === '/api/trading/ai-trader/signals' && req.method === 'GET') {
    try {
      const limit = url.searchParams.get('limit') || 10;
      const result = await callAITrader(`/api/signals?limit=${limit}`);
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch signals', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/signals/generate
  // Trigger the LOCAL market scanner on demand (the honest "scan now" mapping —
  // the external AI-trader microservice has no on-demand endpoint). Non-blocking:
  // the scan (~90s) runs in the background and records any signals to the agent
  // log, which the UI polls. No more 501 dead affordance (#1229).
  if (url.pathname === '/api/trading/ai-trader/signals/generate' && req.method === 'POST') {
    if (!traderAgent) {
      sendJson(res, { status: 'error', error: 'TraderAgent not initialized' }, 503);
      return true;
    }
    traderAgent.scanMarket().then((scan) => {
      const signals = Array.isArray(scan && scan.signals) ? scan.signals : [];
      const logs = signals.filter((s) => s && s.symbol).map((s) => ({
        id: `scan_${scan.timestamp}_${s.symbol}`,
        agent: s.agent || 'scanner',
        action: s.direction || s.action || s.status || 'signal',
        symbol: s.symbol,
        confidence: s.confidence,
        timestamp: scan.timestamp,
      }));
      if (logs.length) tradingMemory.recordNewSignals({ logs }).catch(() => {});
    }).catch((e) => console.error('[Trading] ai-trader signals/generate scan failed:', e.message));
    sendJson(res, { status: 'scan_triggered', message: 'Local market scan started; new signals will appear in the agent log shortly.' }, 202);
    return true;
  }

  // GET /api/trading/ai-trader/portfolio
  // Get current open positions from AI trader
  if (url.pathname === '/api/trading/ai-trader/portfolio' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/positions');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Portfolio fetch failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/trades
  // Real local append-only trade history (trading-history-logger), consistent
  // with the Kalshi history logger — not the absent external service (#1229).
  if (url.pathname === '/api/trading/ai-trader/trades' && req.method === 'GET') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const trades = tradeHistory.getTradeHistory({ limit: limit > 0 ? limit : 50 });
      sendJson(res, { trades }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to read trade history', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/trades
  // Append a trade to the local trade history.
  if (url.pathname === '/api/trading/ai-trader/trades' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const trade = body ? JSON.parse(body) : {};
      if (!trade || !trade.entry_symbol) {
        sendJson(res, { error: 'entry_symbol is required' }, 400);
        return true;
      }
      await tradeHistory.logTrade(trade);
      sendJson(res, { recorded: true, trade }, 201);
    } catch (error) {
      sendJson(res, { error: 'Failed to log trade', details: error.message }, 400);
    }
    return true;
  }

  // GET /api/trading/ai-trader/metrics
  // Real metrics (win-rate, P&L, count) derived from the local trade history.
  if (url.pathname === '/api/trading/ai-trader/metrics' && req.method === 'GET') {
    try {
      sendJson(res, tradeHistory.getTradeStats(), 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to compute metrics', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/scanner/start
  // Maps to the AI trader's /api/control/resume (clears its paused flag)
  if (url.pathname === '/api/trading/ai-trader/scanner/start' && req.method === 'POST') {
    try {
      const result = await callAITrader('/api/control/resume', 'POST');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Scanner start failed', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/ai-trader/scanner/stop
  // Maps to the AI trader's /api/control/pause (sets its paused flag)
  if (url.pathname === '/api/trading/ai-trader/scanner/stop' && req.method === 'POST') {
    try {
      const result = await callAITrader('/api/control/pause', 'POST');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Scanner stop failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/scanner/status
  // Maps to the AI trader's /api/status, which includes a `paused` flag
  if (url.pathname === '/api/trading/ai-trader/scanner/status' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/status');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Scanner status check failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/status
  // Get complete AI trader system status
  if (url.pathname === '/api/trading/ai-trader/status' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/status');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Status check failed', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/ai-trader/watchlist
  // Get AI trader's current watchlist
  if (url.pathname === '/api/trading/ai-trader/watchlist' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/watchlist');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Watchlist fetch failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/ai-trader/zones
  // Get AI trader's detected market zones
  if (url.pathname === '/api/trading/ai-trader/zones' && req.method === 'GET') {
    try {
      const result = await callAITrader('/api/zones');
      sendJson(res, result.data, result.status);
    } catch (error) {
      sendJson(res, { error: 'Zones fetch failed', details: error.message }, 500);
    }
    return true;
  }

  return false;
};
