/**
 * Trading routes — misc group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function miscRoutes(req, res, url, ctx) {
  const { deps, sendJson, collectRequestBody, bridge, traderAgent, tradingMemory, readJsonCached, recordSignal, queryRecentTradingRecords } = ctx;


  // GET /api/trading/agent-log
  // Recent agent activity log (from local memory or CSF)
  if (url.pathname === '/api/trading/agent-log' && req.method === 'GET') {
    try {
      // Query recent signal records from CSF memory (via trading-memory.js)
      const records = queryRecentTradingRecords(20, 'signal');
      const logs = records.map(r => ({
        time: r.created_at ? new Date(r.created_at).toLocaleTimeString() : '',
        type: 'signal',
        agent: r.content.agent || 'trader',
        body: r.content.action || JSON.stringify(r.content).slice(0, 90)
      }));
      sendJson(res, logs, 200);
    } catch (error) {
      console.error('[Trading] /agent-log error:', error.message);
      sendJson(res, [], 500);
    }
    return true;
  }

  // GET /api/trading/llm-usage — daily Σ₀ model-read tally (made vs saved by the
  // scan cache + grounding pre-gate), so the API-spend reduction is observable.
  if (url.pathname === '/api/trading/llm-usage' && req.method === 'GET') {
    try {
      const p = require('path').join(__dirname, '..', 'data', 'lantern-garage', 'trading', 'llm-usage.json');
      // mtime-cached: the daily tally file is polled by the trading UI but only
      // changes when a scan runs — no need to re-read + re-parse every GET (#1889).
      const days = readJsonCached(p, {});
      const today = Object.keys(days).sort().slice(-1)[0] || null;
      let totMade = 0, totSaved = 0;
      for (const d of Object.values(days)) { totMade += d.reads_made || 0; totSaved += (d.saved_cache || 0) + (d.saved_pregate || 0); }
      const pct = (totMade + totSaved) ? Math.round(100 * totSaved / (totMade + totSaved)) : 0;
      sendJson(res, { days, today, totals: { reads_made: totMade, reads_saved: totSaved, pct_avoided: pct } }, 200);
    } catch (error) {
      sendJson(res, { days: {}, error: error.message }, 200);
    }
    return true;
  }

  // POST /api/trading/agent-log
  // Body: a single agent-log entry, `{ logs: [...] }` / `{ agentLog: [...] }`
  // / `{ agent_log: [...] }`, or a bare array of entries. Entries without a
  // `time` get one generated. Persists into the local trading store and into
  // CSF memory as Tier.TRACE records (tags: trading, signal, <type>).
  if (url.pathname === '/api/trading/agent-log' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const entries = tradingMemory._toArray(payload, ['logs', 'agentLog', 'agent_log']);
      for (const entry of entries) {
        if (entry && !entry.time) {
          entry.time = new Date().toISOString();
        }
      }
      const written = await tradingMemory.recordNewSignals({ logs: entries });
      sendJson(res, { recorded: written.length, logs: written }, 201);
    } catch (error) {
      sendJson(res, { error: 'Failed to record agent-log entry', details: error.message }, 400);
    }
    return true;
  }

  // GET /api/trading/status
  // Returns real-time status of all connected APIs
  if (url.pathname === '/api/trading/status' && req.method === 'GET') {
    try {
      const data = await bridge.getDashboardData();
      sendJson(res, data, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/memory/recent?limit=20&kind=order|signal
  // Trading Phase 2 (#323): recent orders/signals persisted into CSF memory
  // queryable by dream-chat and other agents. Newest first.
  if (url.pathname === '/api/trading/memory/recent' && req.method === 'GET') {
    try {
      const limit = Number(url.searchParams.get('limit')) || 20;
      const rawKind = url.searchParams.get('kind');
      const kind = rawKind === 'order' || rawKind === 'signal' ? rawKind : undefined;
      const records = await tradingMemory.queryRecent({ limit, kind });
      sendJson(res, { records }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to query trading memory', details: error.message, records: [] }, 500);
    }
    return true;
  }

  // GET /api/trading/csf-records?limit=50
  // Same CSF registry as /memory/recent, records + count, no kind filter.
  if (url.pathname === '/api/trading/csf-records' && req.method === 'GET') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const records = queryRecentTradingRecords(limit);
      sendJson(res, { records, count: records.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'CSF query failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/sigma0/calibration
  // Σ₀ council (Converge stage): Brier calibration + per-signal realized edge over
  // the trader's graded convergence outcomes. The learning input for re-weighting
  // the EV signals — which evidence actually predicted wins.
  if (url.pathname === '/api/trading/sigma0/calibration' && req.method === 'GET') {
    try {
      const { council } = require('../../lib/sigma0-trader-council');
      sendJson(res, council(), 200);
    } catch (error) {
      sendJson(res, { error: 'calibration failed', details: error.message, graded: 0 }, 200);
    }
    return true;
  }

  // GET /api/trading/settings
  // Get API key status (shows which are configured, no secrets exposed).
  // IBKR status is a REAL probe of the Client Portal gateway, not a hardcoded true:
  // it reads connected only when the gateway is up AND authenticated.
  if (url.pathname === '/api/trading/settings' && req.method === 'GET') {
    const ibkrStatus = await bridge.getIBKRStatus().catch(() => null);
    const providers = {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      ibkr: !!(ibkrStatus && ibkrStatus.connected),
      kalshi: !!process.env.KALSHI_API_KEY,
    };
    sendJson(res, {
      configured: providers,
      ibkr: ibkrStatus || null,
      mcp: {
        ibkr: `IBKR Web API at ${ibkrStatus ? ibkrStatus.gatewayUrl : 'https://api.ibkr.com/v1/api'} (bearer key; account + positions + gated orders)`
      }
    }, 200);
    return true;
  }

  // POST /api/trading/settings
  // Update API keys (only in memory for this session, recommend setting via .env)
  if (url.pathname === '/api/trading/settings' && req.method === 'POST') {
    try {
      const body = await deps.collectRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const updated = [];

      if (payload.anthropic) {
        process.env.ANTHROPIC_API_KEY = payload.anthropic;
        updated.push('anthropic');
      }
      if (payload.openai) {
        process.env.OPENAI_API_KEY = payload.openai;
        updated.push('openai');
      }
      if (payload.gemini) {
        process.env.GEMINI_API_KEY = payload.gemini;
        updated.push('gemini');
      }
      if (payload.kalshi) {
        process.env.KALSHI_API_KEY = payload.kalshi;
        updated.push('kalshi');
      }
      // trading.html posts { ibkr: { account_id, api_key, api_secret } }. CPAPI
      // auth is gateway/session-based, so only the account id (+ optional gateway
      // URL) are meaningful; api_key/secret are no-ops for the gateway path. The
      // old code read payload.ibkr_account/ibkr_password (never sent) and wrote
      // IBKR_PASSWORD (never read) — so saving IBKR settings silently did nothing.
      const ibkrCfg = payload.ibkr || {};
      if (ibkrCfg.account_id || payload.ibkr_account) {
        process.env.IBKR_ACCOUNT_ID = ibkrCfg.account_id || payload.ibkr_account;
        updated.push('ibkr');
      }
      if (ibkrCfg.gateway_url || payload.ibkr_gateway_url) {
        process.env.IBKR_GATEWAY_URL = ibkrCfg.gateway_url || payload.ibkr_gateway_url;
        if (!updated.includes('ibkr')) updated.push('ibkr');
      }

      sendJson(res, {
        ok: true,
        updated,
        message: updated.length > 0
          ? `Updated ${updated.join(', ')} (session only; add to .env to persist)`
          : 'No keys updated'
      }, 200);
    } catch (error) {
      sendJson(res, { error: 'Settings update failed', details: error.message }, 400);
    }
    return true;
  }

  // ── TradingTesseract ─────────────────────────────────────────────────────

  // POST /api/trading/evaluate-asset
  // Body: { asset: 'AAPL', zones_data?, market_status?, agent_log? }
  // Returns: { asset, cube, confidence, action, evaluated_at }
  if (url.pathname === '/api/trading/evaluate-asset' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const params = body ? JSON.parse(body) : {};
        if (!params.asset) {
          sendJson(res, { error: 'asset is required' }, 400);
          return;
        }
        if (!traderAgent) {
          sendJson(res, { error: 'TraderAgent not initialised' }, 503);
          return;
        }
        // Fetch supporting data in parallel if not supplied
        const [zonesResult, marketResult, agentLogResult] = await Promise.all([
          params.zones_data   ? Promise.resolve({ zones: params.zones_data })
                              : traderAgent._callPython('scan_market', { watchlist: [params.asset] }).catch(() => ({})),
          params.market_status ? Promise.resolve(params.market_status)
                               : traderAgent._callPython('get_market_status', {}).catch(() => ({})),
          traderAgent._callPython('scan_market', {}).catch(() => ({ logs: [] })).catch(() => ({ logs: [] })),
        ]);
        const evaluateArgs = {
          asset:         params.asset,
          zones_data:    zonesResult.zones || zonesResult || {},
          market_status: marketResult,
          agent_log:     (agentLogResult.signals || agentLogResult.logs || []),
        };
        const result = await traderAgent._callPython('evaluate_asset', evaluateArgs);

        // Persist to CSF memory as a TRACE record
        try {
          const { recordSignal } = require('../../lib/trading-memory');
          await recordSignal({
            id:        `tesseract-${result.asset}-${Date.now()}`,
            symbol:    result.asset,
            type:      'tesseract_evaluation',
            action:    result.action,
            confidence: result.confidence,
            cube:      result.cube,
            timestamp: result.evaluated_at,
          });
        } catch (_) { /* non-fatal */ }

        sendJson(res, result);
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // POST /api/trading/evaluate-watchlist
  // Body: { watchlist?: string[], zones_data?, market_status?, agent_log? }
  // Returns: { evaluations: [...], count, evaluated_at }
  if (url.pathname === '/api/trading/evaluate-watchlist' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const params = body ? JSON.parse(body) : {};
        const DEFAULT_WL = ['SPY', 'AAPL', 'TSLA', 'NVDA', 'MSFT'];
        const watchlist = params.watchlist || DEFAULT_WL;
        const zones    = params.zones_data    || {};
        const market   = params.market_status || {};
        const agentLog = params.agent_log     || [];

        // Pure-JS TradingTesseract (mirrors trading_tesseract.py exactly)
        function classifyTime(z, m) {
          if (!m.market_open) return 'eod';
          const ts = z.timestamp || z.updated_at;
          if (ts) {
            const ageS = (Date.now() - new Date(ts).getTime()) / 1000;
            if (ageS < 60)   return 'realtime';
            if (ageS < 3600) return 'intraday';
            return 'session';
          }
          return 'intraday';
        }
        function classifyMarket(m) {
          const vix = (m.vix_regime || '').toUpperCase();
          if (vix === 'HIGH' || vix === 'EXTREME') return 'volatile';
          const spy = parseFloat(m.spy_day_change_pct || 0);
          if (spy >  0.8) return 'bullish';
          if (spy < -0.8) return 'bearish';
          if (vix === 'CALM') return 'calm';
          return 'neutral';
        }
        function classifySignal(asset, z, log) {
          for (let i = log.length - 1; i >= Math.max(0, log.length - 50); i--) {
            const e = log[i];
            const sym = (e.symbol || e.asset || e.ticker || '').toUpperCase();
            if (sym !== asset.toUpperCase()) continue;
            const s = (e.signal_strength || e.strength || '').toLowerCase();
            if (['strong','moderate','weak','invalid'].includes(s)) return s;
            const sc = parseFloat(e.score || e.confidence || 0);
            if (sc >= 0.75) return 'strong';
            if (sc >= 0.45) return 'moderate';
            if (sc > 0)     return 'weak';
          }
          const az = z[asset] || {};
          const top = parseFloat(az.top || az.resistance || 0);
          const bot = parseFloat(az.bottom || az.support || 0);
          const mid = parseFloat(az.mid || az.entry_price || 0);
          if (!top || !bot || !mid) return 'invalid';
          const spread = (top - bot) / mid;
          if (spread < 0.02) return 'strong';
          if (spread < 0.05) return 'moderate';
          return 'weak';
        }
        function classifyLayer(log, asset) {
          for (let i = log.length - 1; i >= Math.max(0, log.length - 50); i--) {
            const e = log[i];
            const sym = (e.symbol || e.asset || e.ticker || '').toUpperCase();
            if (sym !== asset.toUpperCase()) continue;
            const a = (e.agent || e.layer || '').toLowerCase();
            if (['scanner','riley','mft','risk','claude','execution'].includes(a)) return a;
            if (a.includes('claude'))  return 'claude';
            if (a.includes('mft'))     return 'mft';
            if (a.includes('riley'))   return 'riley';
            if (a.includes('risk'))    return 'risk';
            if (a.includes('execut'))  return 'execution';
          }
          return 'scanner';
        }
        function classifyState(asset, m) {
          for (const p of (m.positions || [])) {
            const sym = (p.symbol || p.ticker || '').toUpperCase();
            if (sym !== asset.toUpperCase()) continue;
            return parseFloat(p.qty || p.quantity || 0) !== 0 ? 'in_trade' : 'closed';
          }
          return 'watching';
        }
        const SIG_SC  = {strong:1.0, moderate:0.6, weak:0.3, invalid:0.0};
        const MKT_SC  = {bullish:1.0, neutral:0.5, calm:0.5, volatile:0.35, bearish:0.1};
        const ST_SC   = {watching:0.5, active:0.8, in_trade:0.9, closed:0.0, rejected:0.0};
        const LYR_SC  = {claude:1.0, mft:0.85, riley:0.75, scanner:0.6, risk:0.5, execution:0.4};
        const TIME_SC = {realtime:1.0, intraday:0.8, session:0.6, eod:0.4};
        function confidence(cube) {
          return Math.round(10000 * (
            0.35 * (SIG_SC[cube.signal]      || 0) +
            0.30 * (MKT_SC[cube.market]      || 0.5) +
            0.15 * (ST_SC[cube.asset_state]  || 0) +
            0.10 * (LYR_SC[cube.layer]       || 0.5) +
            0.10 * (TIME_SC[cube.time]       || 0.5)
          )) / 10000;
        }
        function deriveAction(conf, cube) {
          if (cube.signal === 'invalid')                                       return 'skip';
          if (['closed','rejected'].includes(cube.asset_state))               return 'skip';
          if (cube.market === 'volatile' && conf < 0.55)                      return 'hold';
          if (conf >= 0.72 && ['bullish','neutral','calm'].includes(cube.market)) return 'buy';
          if (conf >= 0.55)                                                    return 'watch';
          if (cube.market === 'bearish' && ['weak','invalid'].includes(cube.signal)) return 'skip';
          return 'hold';
        }

        const now = new Date().toISOString();
        const evaluations = watchlist.map(asset => {
          const cube = {
            time:        classifyTime(zones, market),
            market:      classifyMarket(market),
            signal:      classifySignal(asset, zones, agentLog),
            layer:       classifyLayer(agentLog, asset),
            asset_state: classifyState(asset, market),
          };
          const conf = confidence(cube);
          return { asset: asset.toUpperCase(), cube, confidence: conf, action: deriveAction(conf, cube), evaluated_at: now };
        }).sort((a, b) => b.confidence - a.confidence);

        sendJson(res, { evaluations, count: evaluations.length, evaluated_at: now });
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // ── Trade History Persistence (P3) ──────────────────────────────────
  // GET /api/trading/history/trades?symbol=BTCUSD&limit=20
  // Returns completed trades with entry, exit, and P&L
  if (url.pathname === '/api/trading/history/trades' && req.method === 'GET') {
    try {
      const tradingHistory = require('../../lib/trading-history-logger');
      const symbol = url.searchParams.get('symbol');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const trades = tradingHistory.getTradeHistory({ symbol, limit });
      sendJson(res, { trades, count: trades.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch trade history', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/history/signals?symbol=BTCUSD&limit=20&min_confidence=0.7
  // Returns generated trading signals with confidence scores
  if (url.pathname === '/api/trading/history/signals' && req.method === 'GET') {
    try {
      const tradingHistory = require('../../lib/trading-history-logger');
      const symbol = url.searchParams.get('symbol');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const minConfidence = parseFloat(url.searchParams.get('min_confidence') || '0');
      const signals = tradingHistory.getSignalHistory({ symbol, limit, min_confidence: minConfidence });
      sendJson(res, { signals, count: signals.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch signal history', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/history/stats?symbol=BTCUSD
  // Returns trade statistics (win rate, average P&L, etc.)
  if (url.pathname === '/api/trading/history/stats' && req.method === 'GET') {
    try {
      const tradingHistory = require('../../lib/trading-history-logger');
      const symbol = url.searchParams.get('symbol');
      const stats = tradingHistory.getTradeStats({ symbol });
      sendJson(res, { timestamp: new Date().toISOString(), stats }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to compute trade statistics', details: error.message }, 500);
    }
    return true;
  }


  return false;
};
