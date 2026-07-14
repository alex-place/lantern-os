/**
 * Trading routes — kalshi group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function kalshiRoutes(req, res, url, ctx) {
  const { deps, sendJson, collectRequestBody, bridge, getStrategyFitness, logPerformance } = ctx;


  // GET /api/trading/kalshi/events
  // Returns KALSHI open events for prediction markets
  if (url.pathname === '/api/trading/kalshi/events' && req.method === 'GET') {
    try {
      const events = await bridge.getKALSHIEvents();
      sendJson(res, { events }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch KALSHI events', details: error.message }, 503);
    }
    return true;
  }

  // GET /api/trading/kalshi/markets
  // Returns the CIO collector's recorded Kalshi odds (read-only, from snapshots)
  if (url.pathname === '/api/trading/kalshi/markets' && req.method === 'GET') {
    try {
      const stats = require('../../lib/kalshi-stats').getKalshiStats();
      sendJson(res, stats, 200);
    } catch (error) {
      sendJson(res, { error: 'Kalshi stats unavailable', details: error.message }, 503);
    }
    return true;
  }

  // ── Full Kalshi v2 API surface (for the on-dashboard terminal) ────────────
  // Read endpoints are public; portfolio + orders are RSA-signed & gated.
  if (url.pathname.startsWith('/api/trading/kalshi/') &&
      url.pathname !== '/api/trading/kalshi/events' &&
      url.pathname !== '/api/trading/kalshi/markets') {
    const kalshi = require('../../lib/kalshi-api');
    const q = Object.fromEntries(url.searchParams.entries());
    try {
      // GET — connection & safety snapshot
      if (url.pathname === '/api/trading/kalshi/connection' && req.method === 'GET') {
        return sendJson(res, await kalshi.getConnection(), 200), true;
      }
      // GET — CIO suggestion deck (the "Tinder of trading" cards)
      if (url.pathname === '/api/trading/kalshi/suggestions' && req.method === 'GET') {
        const suggest = require('../../lib/kalshi-suggest');
        const limit = q.limit ? Number(q.limit) : 60;
        const collector = deps.kalshiCollector || null;
        return sendJson(res, await suggest.getSuggestions({ limit, collector }), 200), true;
      }

      // GET — Screener: a broad market board sorted by OUR grounded edge (not just
      // volume). Attaches the edge badge (cached grounding + fees + Brier) to every
      // market; grounded/mispriced markets rank first. Verso sorts by what moved; we
      // sort by what's WRONG. Filters: ?sort=edge|volume|close &groundedOnly=1
      // &minEdge=<cents> &q=<search> &category=<substr> &rows=<n>.
      if (url.pathname === '/api/trading/kalshi/screener' && req.method === 'GET') {
        const screener = require('../../lib/kalshi-screener');
        const mr = await kalshi.getMarkets({ status: 'open', limit: Math.min(Number(q.limit) || 300, 1000) });
        const markets = (mr.ok && mr.data && Array.isArray(mr.data.markets)) ? mr.data.markets : [];
        const rows = screener.buildRows(markets, {
          groundedOnly: q.groundedOnly === '1',
          minEdge: q.minEdge != null && q.minEdge !== '' ? Number(q.minEdge) : undefined,
          q: q.q, category: q.category, sort: q.sort,
          limit: Math.min(Number(q.rows) || 150, 400),
        });
        return sendJson(res, {
          count: rows.length, total: markets.length,
          generatedAt: new Date().toISOString(),
          note: markets.length ? undefined : 'no open markets returned (rate-limited or off-hours)',
          rows,
        }, 200), true;
      }

      // GET — Convergence-optimized games (ideal time window + conviction + momentum)
      if (url.pathname === '/api/trading/kalshi/convergence-ranked' && req.method === 'GET') {
        const suggest = require('../../lib/kalshi-suggest');
        const scorer = require('../../lib/kalshi-convergence-scorer');
        const limit = q.limit ? Number(q.limit) : 12;
        const collector = deps.kalshiCollector || null;
        const suggestions = await suggest.getSuggestions({ limit: 200, collector });
        const ranked = scorer.rankByConvergence(suggestions.cards || [], limit);
        return sendJson(res, {
          count: ranked.length,
          note: 'Games ranked by convergence fitness: ideal time window (1-6h) + high conviction + strong momentum',
          cards: ranked
        }, 200), true;
      }

      // GET — Crypto intraday markets (15m, 1h, daily predictions)
      // GLOBAL TRADING-PAUSE GATE — when data/kalshi/TRADING-PAUSED exists, every
      // trade-suggestion deck returns ZERO cards. Engaged after the realized-PnL
      // backtest showed no edge after fees (experiments/kalshi_pnl_backtest.py);
      // remove the flag only once a strategy is proven net-profitable.
      if (req.method === 'GET' && kalshi.tradingPaused && kalshi.tradingPaused() && [
            '/api/trading/kalshi/crypto-intraday',
            '/api/trading/kalshi/impossibility-deck',
            '/api/trading/kalshi/decisive-deck',
            '/api/trading/kalshi/positions-deck',
          ].includes(url.pathname)) {
        return sendJson(res, {
          cards: [], count: 0, exitCount: 0, entryCount: 0, paused: true,
          generatedAt: new Date().toISOString(),
          note: 'TRADING PAUSED — all cards cleared. No strategy is proven net-profitable after fees. Remove data/kalshi/TRADING-PAUSED to re-enable.',
        }, 200), true;
      }

      if (url.pathname === '/api/trading/kalshi/crypto-intraday' && req.method === 'GET') {
        const cryptoSuggest = require('../../lib/kalshi-crypto-suggester');
        const limit = q.limit ? Number(q.limit) : 20;
        const collector = deps.kalshiCollector || null;
        return sendJson(res, await cryptoSuggest.getCryptoSuggestions({ limit, collector }), 200), true;
      }

      // GET — Win rate stats (Phase 1 profitability data)
      if (url.pathname === '/api/trading/kalshi/winrate-stats' && req.method === 'GET') {
        const { computeWinRate } = require('../../lib/kalshi-winrate-tracker');
        return sendJson(res, computeWinRate(), 200), true;
      }

      // POST — Start position monitor (automated stop-losses)
      if (url.pathname === '/api/trading/kalshi/monitor/start' && req.method === 'POST') {
        const { getMonitor } = require('../../lib/kalshi-position-monitor');
        getMonitor().start();
        return sendJson(res, { status: 'monitoring started' }, 200), true;
      }

      // POST — Stop position monitor
      if (url.pathname === '/api/trading/kalshi/monitor/stop' && req.method === 'POST') {
        const { getMonitor } = require('../../lib/kalshi-position-monitor');
        getMonitor().stop();
        return sendJson(res, { status: 'monitoring stopped' }, 200), true;
      }

      // GET — Get monitored positions
      if (url.pathname === '/api/trading/kalshi/monitor/positions' && req.method === 'GET') {
        const { getMonitor } = require('../../lib/kalshi-position-monitor');
        const monitor = getMonitor();
        return sendJson(res, {
          monitoring: monitor.monitoring,
          positions: monitor.getMonitoredPositions(),
          readyToClose: monitor.getReadyToClose(),
          stats: monitor.getStats()
        }, 200), true;
      }

      // POST — Train convergence model from trade logs
      if (url.pathname === '/api/trading/kalshi/convergence/train' && req.method === 'POST') {
        const { trainModel } = require('../../lib/kalshi-convergence-trainer');
        const result = await trainModel();
        return sendJson(res, result, 200), true;
      }

      // GET — Get convergence model and stats
      if (url.pathname === '/api/trading/kalshi/convergence/model' && req.method === 'GET') {
        const { getTrainer } = require('../../lib/kalshi-convergence-trainer');
        const trainer = getTrainer();
        return sendJson(res, {
          model: trainer.getModel(),
          summary: trainer.getSummary()
        }, 200), true;
      }

      // GET — Get convergence accuracy for a ticker
      if (url.pathname === '/api/trading/kalshi/convergence/accuracy' && req.method === 'GET') {
        const ticker = q.ticker;
        if (!ticker) return sendJson(res, { error: 'ticker required' }, 400), true;
        const { getTrainer } = require('../../lib/kalshi-convergence-trainer');
        const trainer = getTrainer();
        return sendJson(res, {
          ticker,
          accuracy: trainer.getAccuracy(ticker),
          multiplier: trainer.getTypeMultiplier(trainer.getMarketType(ticker))
        }, 200), true;
      }

      // POST — Start convergence enhancement loop (continuous self-improvement)
      if (url.pathname === '/api/trading/kalshi/convergence/enhance/start' && req.method === 'POST') {
        const { startEnhancing } = require('../../lib/kalshi-convergence-enhancer');
        startEnhancing();
        return sendJson(res, { status: 'enhancement started' }, 200), true;
      }

      // POST — Stop convergence enhancement loop
      if (url.pathname === '/api/trading/kalshi/convergence/enhance/stop' && req.method === 'POST') {
        const { stopEnhancing } = require('../../lib/kalshi-convergence-enhancer');
        stopEnhancing();
        return sendJson(res, { status: 'enhancement stopped' }, 200), true;
      }

      // GET — Get convergence enhancer status and predictions
      if (url.pathname === '/api/trading/kalshi/convergence/enhance/status' && req.method === 'GET') {
        const ticker = q.ticker;
        const { getEnhancer } = require('../../lib/kalshi-convergence-enhancer');
        const enhancer = getEnhancer();
        return sendJson(res, {
          status: enhancer.getStatus(),
          context: ticker ? enhancer.getContext(ticker) : null,
          prediction: ticker ? enhancer.getPrediction(ticker) : null
        }, 200), true;
      }

      // POST — Start LoRA fine-tuning analysis (proactive, continuous)
      if (url.pathname === '/api/trading/kalshi/convergence/lora/start' && req.method === 'POST') {
        const { startAnalyzing } = require('../../lib/kalshi-convergence-lora');
        startAnalyzing();
        return sendJson(res, { status: 'LoRA analysis started' }, 200), true;
      }

      // POST — Stop LoRA analysis
      if (url.pathname === '/api/trading/kalshi/convergence/lora/stop' && req.method === 'POST') {
        const { stopAnalyzing } = require('../../lib/kalshi-convergence-lora');
        stopAnalyzing();
        return sendJson(res, { status: 'LoRA analysis stopped' }, 200), true;
      }

      // GET — Get LoRA model status and training progress
      if (url.pathname === '/api/trading/kalshi/convergence/lora/status' && req.method === 'GET') {
        const { getLora } = require('../../lib/kalshi-convergence-lora');
        const lora = getLora();
        return sendJson(res, {
          model: lora.getStatus(),
          training: lora.getTrainingSummary()
        }, 200), true;
      }

      // GET — Dashboard: Complete progress report
      if (url.pathname === '/api/trading/kalshi/dashboard/progress' && req.method === 'GET') {
        const { getReport } = require('../../lib/kalshi-progress-report');
        const report = getReport().getReport();
        return sendJson(res, report, 200), true;
      }

      // GET — Dashboard: Quick overview
      if (url.pathname === '/api/trading/kalshi/dashboard/overview' && req.method === 'GET') {
        const { getReport } = require('../../lib/kalshi-progress-report');
        const { getEnhancer } = require('../../lib/kalshi-convergence-enhancer');
        const { getLora } = require('../../lib/kalshi-convergence-lora');

        const report = getReport().getReport();
        const overview = {
          projectName: report.projectName,
          phases: Object.keys(report.phases).length,
          loops: Object.keys(report.trainingLoops).length,
          enhancerStatus: getEnhancer().getStatus(),
          loraStatus: getLora().getStatus(),
          generatedAt: new Date().toISOString()
        };
        return sendJson(res, overview, 200), true;
      }

      // GET — Real-Time Dashboard: Live positions + portfolio metrics
      if (url.pathname === '/api/trading/kalshi/realtime/dashboard' && req.method === 'GET') {
        try {
          const { buildDashboard, getRecentTrades, calculatePerformanceMetrics } = require('../../lib/kalshi-realtime-dashboard');
          const dashboard = await buildDashboard();
          const recentTrades = getRecentTrades(20);
          const performanceMetrics = calculatePerformanceMetrics(recentTrades);
          return sendJson(res, { ...dashboard, recentTrades, performanceMetrics }, 200), true;
        } catch (e) {
          console.error('[Trading Routes] Real-time dashboard error:', e.message);
          return sendJson(res, { error: e.message }, 500), true;
        }
      }

      // GET — Impossibility Engine deck: constraint-elimination over short-window markets
      // Returns same card shape as crypto-intraday + { determined, stateLabel, knowledge, trace }
      if (url.pathname === '/api/trading/kalshi/impossibility-deck' && req.method === 'GET') {
        const { createKalshiEngine, engineResultToCard } = require('../../lib/impossibility-engine');
        const { isShortWindowMarket } = require('../../lib/kalshi-crypto-suggester');
        const limit = q.limit ? Number(q.limit) : 20;
        const nowMs = Date.now();

        // Fetch short-window markets
        let markets = [];
        const collector = deps.kalshiCollector;
        if (collector) {
          const latest = collector.getLatestMarkets?.();
          if (latest && latest.length > 0) {
            markets = latest.filter(m => isShortWindowMarket(m, nowMs));
          }
        }
        if (markets.length === 0) {
          const mk = await kalshi.getMarkets({ status: 'open', limit: 500 });
          markets = (mk.data?.markets || []).filter(m => isShortWindowMarket(m, nowMs));
        }

        if (markets.length === 0) {
          return sendJson(res, { count: 0, cards: [], note: 'No markets closing within 6 hours' }, 200), true;
        }

        const engine = createKalshiEngine();
        const solved = engine.solveAll(markets);
        const cards  = solved
          .slice(0, limit)
          .map(({ market, result }) => engineResultToCard(market, result));

        return sendJson(res, {
          count: cards.length,
          generatedAt: new Date().toISOString(),
          note: 'Impossibility Engine: constraint-elimination over short-window Kalshi markets',
          determined: cards.filter(c => c.determined).length,
          cards,
        }, 200), true;
      }

      // GET — Decisive Deck: ONE action per market (buy or sell, not both)
      // Consolidates all positions + suggestions into high-conviction trades only
      // WITH regime detection + strategy fitness scoring (Phase C MVP)
      if (url.pathname === '/api/trading/kalshi/decisive-deck' && req.method === 'GET') {
        const suggest = require('../../lib/kalshi-suggest');
        const { createKalshiEngine, engineResultToCard } = require('../../lib/impossibility-engine');
        const { isShortWindowMarket } = require('../../lib/kalshi-crypto-suggester');
        // Crypto suggester cards intentionally REMOVED (no post-fee taker edge — see
        // kalshi-no-taker-edge). isShortWindowMarket is still imported as a pure helper.
        const RegimeDetector = require('../../lib/regime-detector');
        const performanceLogger = require('../../lib/strategy-performance-logger');
        const strategyRegistry = require('../../lib/strategy-registry');
        const sigma0Deck = require('../../lib/sigma0-deck');
        const collector = deps.kalshiCollector || null;
        const nowMs = Date.now();
        // Σ₀ ranking knob: 0 = safety (lowest loss odds), 1 = return (largest delta)
        const riskAppetite = q.risk != null ? Number(q.risk) : 0.5;

        try {
          // Initialize regime detector
          const regimeDetector = new RegimeDetector();

          // Step 1: Get all suggestions in parallel (crypto suggester REMOVED — no
          // post-fee taker edge; see kalshi-no-taker-edge).
          const [suggestions, ieCards] = await Promise.all([
            suggest.getSuggestions({ limit: 100, collector }),
            (async () => {
              let markets = [];
              if (collector) {
                const latest = collector.getLatestMarkets?.();
                if (latest?.length > 0) markets = latest.filter(m => isShortWindowMarket(m, nowMs));
              }
              if (markets.length === 0) {
                const mk = await kalshi.getMarkets({ status: 'open', limit: 500 });
                markets = (mk.data?.markets || []).filter(m => isShortWindowMarket(m, nowMs));
              }
              if (markets.length === 0) return [];
              const engine = createKalshiEngine();
              const solved = engine.solveAll(markets);
              return solved.slice(0, 20).map(({ market, result }) => engineResultToCard(market, result));
            })(),
          ]);

          // Step 2: Extract cards from suggestions (already includes exits + entries)
          const existingCards = suggestions.cards || [];
          const allSignals = [...existingCards, ...ieCards];

          // Step 3: Detect regime + score strategies per market
          const activeStrategies = strategyRegistry.getActiveStrategies();
          const strategyIds = activeStrategies.map(s => s.strategy_id);

          // Enrich cards with regime detection + strategy fitness
          const enrichedCards = allSignals.map(card => {
            // Detect regime for this market
            const regime = regimeDetector.detect(card.market || {});

            // Score available strategies for this regime
            const bestStrategy = performanceLogger.getBestStrategyForRegime(regime, strategyIds);

            return {
              ...card,
              regime,
              best_strategy: bestStrategy.strategy_id,
              strategy_fitness: bestStrategy.fitness,
              strategy_score: bestStrategy.score,
            };
          });

          // Step 4: Consolidate: one action per ticker (exits take priority)
          const decisiveMap = new Map();

          // Sort so exits come first, then by strategy fitness + conviction
          enrichedCards.sort((a, b) => {
            const aIsExit = a.kind === 'exit' ? 0 : 1;
            const bIsExit = b.kind === 'exit' ? 0 : 1;
            if (aIsExit !== bIsExit) return aIsExit - bIsExit;

            // Tie-breaker: strategy fitness score
            const aStrategyScore = a.strategy_score || 0;
            const bStrategyScore = b.strategy_score || 0;
            if (Math.abs(aStrategyScore - bStrategyScore) > 0.1) {
              return bStrategyScore - aStrategyScore;
            }

            // Final tie-breaker: conviction
            return (b.conviction || 0) - (a.conviction || 0);
          });

          // Take first action per ticker (exits first, then highest fitness strategy + conviction entry)
          for (const card of enrichedCards) {
            if (!decisiveMap.has(card.ticker)) {
              // Only add entries if conviction > 70% OR strategy has positive recent fitness
              const hasPositiveFitness = card.strategy_fitness?.pnl > 0;
              if (card.kind === 'exit' || (card.conviction || 0) >= 70 || hasPositiveFitness) {
                decisiveMap.set(card.ticker, card);
              }
            }
          }

          // Step 5: Legacy decisionScore (kept as a tiebreaker signal)
          const allCards = Array.from(decisiveMap.values());
          allCards.forEach(card => {
            const timeWeight = (card.minsToClose ?? 60) < 60 ? 1.2 : (card.minsToClose ?? 60) < 240 ? 1.0 : 0.7;
            const strategyWeight = Math.min(1.5, 1.0 + (card.strategy_fitness?.stability || 0.5) * 0.5);
            card.decisionScore = (card.conviction || 0) * timeWeight * strategyWeight;
          });

          // Step 5b: Σ₀ END-STATE RANKING — predict each card's attractor + a
          // contraction confidence, score by risk-adjusted capturable delta gated
          // by confidence (minimize loss / maximize gain per swipe). Exits keep
          // priority (not acting on a stop is itself a loss); within each group
          // Σ₀ score orders, with legacy decisionScore as the final tiebreaker.
          const scored = sigma0Deck.rankDeck(allCards, { riskAppetite });
          // Step 5c: news → signal. Join the existing news feed onto each card
          // (Observe→Reason) BEFORE the final sort so a fresh high-impact headline
          // can nudge conviction. Deterministic ticker/title join; local, no LLM.
          try { require('../../lib/news-signal').enrichDeckWithNews(scored, { nowMs }); }
          catch (e) { console.error('[Decisive Deck] news-signal skipped:', e.message); }
          scored.sort((a, b) => {
            const aExit = a.kind === 'exit' ? 0 : 1, bExit = b.kind === 'exit' ? 0 : 1;
            if (aExit !== bExit) return aExit - bExit;
            const ds = (b.sigma0?.score || 0) - (a.sigma0?.score || 0);
            if (Math.abs(ds) > 1e-6) return ds;
            return (b.decisionScore || 0) - (a.decisionScore || 0);
          });

          // Step 6: Return top 6 trades (focused, decisive deck)
          const decisive = scored.slice(0, 6);

          // Attach the grounded EDGE badge (market price · our P(YES) · edge after fees ·
          // Brier) — the moat surface. Uses CACHED grounding only, so no LLM call on the
          // render path; ungrounded markets get { grounded:false }.
          try { require('../../lib/kalshi-edge').attachEdges(decisive); }
          catch (e) { console.warn('[Decisive Deck] edge attach failed:', e.message); }

          return sendJson(res, {
            count: decisive.length,
            generatedAt: new Date().toISOString(),
            note: 'Decisive Deck: Σ₀ end-state ranking — risk-adjusted delta per swipe',
            riskAppetite,
            regime_stats: {
              regimes_detected: [...new Set(decisive.map(c => c.regime))],
              strategies_active: strategyIds,
            },
            cards: decisive.map(c => ({
              ...c,
              // Expose regime + strategy info + Σ₀ prediction for human validation
              regime: c.regime,
              best_strategy: c.best_strategy,
              strategy_fitness: c.strategy_fitness,
              sigma0: c.sigma0,
            })),
          }, 200), true;
        } catch (error) {
          console.error('[Decisive Deck] error:', error.message);
          return sendJson(res, { count: 0, cards: [], error: error.message }, 500), true;
        }
      }

      // GET — Observer Engine frontier over current short-window markets
      // Returns KnowabilityFrontier + TemporalBand + ConvergenceStateField snapshot
      if (url.pathname === '/api/trading/kalshi/observer-frontier' && req.method === 'GET') {
        const { createKalshiEngine } = require('../../lib/impossibility-engine');
        const { isShortWindowMarket } = require('../../lib/kalshi-crypto-suggester');
        const { buildKalshiObserver, ConvergenceStateField } = require('../../lib/observer-engine');
        const limit = q.limit ? Number(q.limit) : 50;

        let markets = [];
        const collector = deps.kalshiCollector;
        if (collector) {
          const latest = collector.getLatestMarkets?.();
          if (latest && latest.length > 0) markets = latest.filter(m => isShortWindowMarket(m, Date.now()));
        }
        if (markets.length === 0) {
          const mk = await kalshi.getMarkets({ status: 'open', limit: 500 });
          markets = (mk.data?.markets || []).filter(m => isShortWindowMarket(m, Date.now()));
        }

        // Run IE first — results feed Observer Engine frontier classification
        const engine = createKalshiEngine();
        const ieResults = engine.solveAll(markets).map(({ result }) => result);

        const observer = buildKalshiObserver(markets.slice(0, limit), ieResults);
        const band = observer.emit_band();
        const csf = new ConvergenceStateField([band]);

        return sendJson(res, {
          generatedAt: new Date().toISOString(),
          marketCount: markets.length,
          frontier: observer.frontier.toJSON(),
          band: band.toJSON(),
          csf: csf.toJSON(),
          summary: {
            known:        observer.frontier.known.size,
            recallable:   observer.frontier.recallable.size,
            observable:   observer.frontier.observable.size,
            reachable:    observer.frontier.reachable.size,
            inferable:    observer.frontier.inferable.size,
            discoverable: observer.frontier.discoverable.size,
          },
        }, 200), true;
      }

      // GET — live market data (pass-through query: series_ticker, status, limit, event_ticker)
      if (url.pathname === '/api/trading/kalshi/live-markets' && req.method === 'GET') {
        const r = await kalshi.getMarkets(q);
        return sendJson(res, r.data || { error: r.error }, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/events-list' && req.method === 'GET') {
        const r = await kalshi.getEvents(q);
        return sendJson(res, r.data || { error: r.error }, r.status || 200), true;
      }
      // GET — order book for one market  (?ticker=...&depth=...)
      if (url.pathname === '/api/trading/kalshi/orderbook' && req.method === 'GET') {
        const r = await kalshi.getOrderbook(q.ticker, q.depth ? Number(q.depth) : 10);
        return sendJson(res, r.data || { error: r.error }, r.status || 200), true;
      }
      // GET — authenticated portfolio (balance / positions / orders / fills)
      if (url.pathname === '/api/trading/kalshi/balance' && req.method === 'GET') {
        const r = await kalshi.getBalance();
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/positions' && req.method === 'GET') {
        const r = await kalshi.getPositions(q);
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/portfolio-orders' && req.method === 'GET') {
        const r = await kalshi.getOrders(q);
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      if (url.pathname === '/api/trading/kalshi/fills' && req.method === 'GET') {
        const r = await kalshi.getFills(q);
        return sendJson(res, r.error ? { error: r.error } : r.data, r.status || 200), true;
      }
      // POST — place order (dry-run / kill-switch gated inside placeOrder)
      if (url.pathname === '/api/trading/kalshi/order' && req.method === 'POST') {
        const body = await collectRequestBody(req);
        const o = body ? JSON.parse(body) : {};

        // Cash check before order (#434)
        try {
          const balance = await kalshi.getBalance();
          const availableCash = balance?.buying_power || balance?.cash || 0;
          const orderCost = (o.price || 0) * (o.quantity || 0);

          if (orderCost > 0 && availableCash < orderCost) {
            return sendJson(res, {
              error: 'INSUFFICIENT_FUNDS',
              message: `Insufficient cash: need ${(orderCost / 100).toFixed(2)}, have ${(availableCash / 100).toFixed(2)}`,
              required_cents: orderCost,
              available_cents: availableCash
            }, 402), true;
          }
        } catch (e) {
          console.warn('[trading] Cash check failed:', e.message);
        }

        const result = await kalshi.placeOrder(o);
        const httpStatus = result.mode === 'live' && result.status ? (result.status >= 200 && result.status < 300 ? 200 : result.status) : 200;
        return sendJson(res, result, httpStatus), true;
      }
      // POST — cancel order  { orderId }
      if (url.pathname === '/api/trading/kalshi/order/cancel' && req.method === 'POST') {
        const body = await collectRequestBody(req);
        const { orderId } = body ? JSON.parse(body) : {};
        if (!orderId) return sendJson(res, { error: 'orderId required' }, 400), true;
        const result = await kalshi.cancelOrder(orderId);
        const status = (result.error || result.errorMessage) ? 400 : (result.success === false ? 400 : 200);
        return sendJson(res, result, status), true;
      }

      // ── Paper trading ledger (dry-run position tracking) ───────────────────
      // POST — open a paper position (called after each dry-run "take")
      if (url.pathname === '/api/trading/kalshi/paper-trade' && req.method === 'POST') {
        const paperLedger = require('../../lib/kalshi-paper-ledger');
        const body = await collectRequestBody(req);
        const o = body ? JSON.parse(body) : {};
        // P1-3 (docs/TRADER-ANALYSIS-2026-07.md): close the calibration loop for ALL open
        // paths, not just the terminal UI (which already forwards pPredicted). If a weather
        // position is opened without the model prob stamped (e.g. an autonomous daemon or a
        // client that omits it), the row is silently ungradeable and kalshi-calibration never
        // learns the bias. Best-effort backfill the REAL model prob from the live deck by
        // ticker — never fabricated, never blocking: on any miss we leave it unstamped and the
        // calibrator honestly skips the row.
        try {
          const ticker = String(o.ticker || o.market_ticker || '');
          if (ticker.startsWith('KXHIGH') && !Number.isFinite(Number(o.pPredicted))) {
            const series = ticker.split('-')[0];
            const { getWeatherEdgeDeck } = require('../../lib/kalshi-weather-edge-deck');
            const deck = await getWeatherEdgeDeck({ series, limit: 200, minEdgeCents: 0 });
            const card = (deck.cards || []).find((c) => c.ticker === ticker);
            if (card && Number.isFinite(Number(card.pPredicted))) {
              o.pPredicted = card.pPredicted;
              if (o.pPredictedRaw == null && card.pPredictedRaw != null) o.pPredictedRaw = card.pPredictedRaw;
              if (o.dist == null && card.dist != null) o.dist = card.dist;
              if (o.ladder == null && card.ladder != null) o.ladder = card.ladder;
              o.pPredictedBackfilled = true;
            }
          }
        } catch (e) {
          console.warn('[trading] pPredicted backfill skipped:', e.message);
        }
        // Cash gate: the tinder game spends a virtual bankroll down to zero. Refuse the
        // buy when the paper wallet can't cover the entry cost (entry¢ × contracts).
        const qty = Number(o.qty ?? o.count ?? 1) || 1;
        const entry = Number(o.limitCents ?? o.entryCents ?? 50);
        const costCents = entry * qty;
        const wallet = paperLedger.getWallet();
        if (costCents > wallet.cashCents) {
          return sendJson(res, { error: 'insufficient_paper_cash', costCents, wallet }, 402), true;
        }
        const opened = paperLedger.openPosition(o);
        return sendJson(res, { ...opened, wallet: paperLedger.getWallet() }, 201), true;
      }
      // GET — virtual paper wallet (cash / invested / realized) for the "buy until broke" HUD
      if (url.pathname === '/api/trading/kalshi/paper-wallet' && req.method === 'GET') {
        const paperLedger = require('../../lib/kalshi-paper-ledger');
        return sendJson(res, paperLedger.getWallet(), 200), true;
      }
      // GET — poll open paper positions with live P&L + auto-exit signals
      if (url.pathname === '/api/trading/kalshi/paper-positions' && req.method === 'GET') {
        const paperLedger = require('../../lib/kalshi-paper-ledger');
        const positions = await paperLedger.pollOpen();
        return sendJson(res, { count: positions.length, positions }, 200), true;
      }
      // GET — paper trade history (opened + closed, newest first) for the terminal column
      if (url.pathname === '/api/trading/kalshi/paper-history' && req.method === 'GET') {
        const paperLedger = require('../../lib/kalshi-paper-ledger');
        const limit = q.limit ? Number(q.limit) : 50;
        const trades = paperLedger.getHistory(limit);
        return sendJson(res, { count: trades.length, trades }, 200), true;
      }
      // POST — close a paper position  { id, exitTag?, exitPriceCents?, pnlPct? }
      if (url.pathname === '/api/trading/kalshi/paper-close' && req.method === 'POST') {
        const paperLedger = require('../../lib/kalshi-paper-ledger');
        const body = await collectRequestBody(req);
        const { id, exitTag, exitPriceCents, pnlPct } = body ? JSON.parse(body) : {};
        if (!id) return sendJson(res, { error: 'id required' }, 400), true;

        const result = paperLedger.closePosition(id, { exitTag, exitPriceCents, pnlPct });

        // Σ₀ Phase A: Log trade performance metrics for strategy fitness aggregation
        if (result && result.position) {
          const pos = result.position;
          try {
            // Infer regime from exit tag
            const regime = exitTag === 'STOP-LOSS' ? 'MEAN' : exitTag === 'TAKE-PROFIT' ? 'TREND' : 'PIVOT';
            await logPerformance({
              strategy_id: pos.ticker || pos.market_ticker || 'unknown',
              regime,
              pnl: pnlPct ?? pos.pnlPct ?? 0,
              drawdown: pos.maxDrawdown ?? 0,
              stability: pos.stability ?? 0.5,
              position_id: id,
              market: pos.ticker || pos.market_ticker || 'unknown',
              is_live: false // paper trading
            });
          } catch (err) {
            console.error(`[trading] Failed to log performance for position ${id}:`, err.message);
          }
        }

        return sendJson(res, result, 200), true;
      }

      // ── Σ₀ council (Converge) + PAPER/REPLAY decks ─────────────────────────
      // These surfaces are paper-only: none reach kalshi.placeOrder, so they are
      // intentionally NOT behind the live TRADING-PAUSE gate. The kill-switch keeps
      // the real-order path halted; this is where the loop collects data + trains.

      // GET — Kalshi council snapshot: Brier calibration + per-signal realized edge
      // over the historical-trained outcomes, plus the honest after-fee search verdict.
      if (url.pathname === '/api/trading/kalshi/council' && req.method === 'GET') {
        const kc = require('../../lib/kalshi-council');
        try { return sendJson(res, kc.snapshot(), 200), true; }
        catch (e) { return sendJson(res, { error: 'council failed', details: e.message, graded: 0 }, 200), true; }
      }

      // GET — Replay deck: deterministic swipeable cards rebuilt from the recorded
      // tight-band history, graded instantly vs the known outcome. Always works.
      if (url.pathname === '/api/trading/kalshi/replay-deck' && req.method === 'GET') {
        const kc = require('../../lib/kalshi-council');
        const limit = q.limit ? Number(q.limit) : 20;
        const offset = q.offset ? Number(q.offset) : 0;
        const cards = kc.buildReplayCards(limit, offset);
        return sendJson(res, {
          cards, count: cards.length, mode: 'replay',
          generatedAt: new Date().toISOString(),
          note: 'Replay deck — historical markets, graded vs known outcome. PAPER / training only; live trading remains paused.',
        }, 200), true;
      }

      // POST — grade a swiped replay card against its recorded outcome (Verify→Converge).
      if (url.pathname === '/api/trading/kalshi/replay-grade' && req.method === 'POST') {
        const kc = require('../../lib/kalshi-council');
        const body = await collectRequestBody(req);
        const { ticker, side, entryCents } = body ? JSON.parse(body) : {};
        if (!ticker || !side) return sendJson(res, { error: 'ticker and side required' }, 400), true;
        return sendJson(res, kc.gradeReplay({ ticker, side, entryCents }), 200), true;
      }

      // GET — Paper deck: live candidate markets, paper-only, with honest fee-aware EV
      // (most negative). Empty when Kalshi markets are closed or creds are absent.
      if (url.pathname === '/api/trading/kalshi/paper-deck' && req.method === 'GET') {
        // Crypto suggester intentionally REMOVED (no post-fee taker edge — see
        // kalshi-no-taker-edge). The paper deck is the PRACTICE surface for the one
        // profitable arm: it leads with the Σ₀ weather-edge cards (same model the LIVE
        // deck executes, but paper-only) and backfills with any non-crypto candidate
        // suggestions so there is always something to practice on.
        const suggest = require('../../lib/kalshi-suggest');
        const weatherDeck = require('../../lib/kalshi-weather-edge-deck');
        const fees = require('../../lib/kalshi-fees');
        const kc = require('../../lib/kalshi-council');
        const collector = deps.kalshiCollector || null;
        const limit = q.limit ? Number(q.limit) : 20;
        try {
          const [wx, sug] = await Promise.all([
            weatherDeck.getWeatherEdgeDeck({ limit }).catch(() => ({ cards: [] })),
            suggest.getSuggestions({ limit, collector }).catch(() => ({ cards: [] })),
          ]);
          // Weather-edge cards first (the profitable strat), then non-crypto suggestions.
          const wxCards = (wx.cards || []).map(c => ({ ...c, mode: 'paper' }));
          const sugCards = (sug.cards || [])
            .filter(c => c.kind !== 'exit' && c.kind !== 'position' && c.favAsk != null);
          const seen = new Set();
          const cards = [];
          for (const c of [...wxCards, ...sugCards]) {
            if (seen.has(c.ticker)) continue;
            seen.add(c.ticker);
            // Weather cards already carry a full sigma0 (+ sizing/pPredicted); only
            // synthesize a sigma0 for the plain suggestion cards.
            const pWin = kc.pWinModel(c.favAsk);
            const ev = fees.netEvCents(c.favAsk, pWin);
            cards.push({
              ...c, mode: 'paper',
              sigma0: c.sigma0 || {
                score: ev, end_state: c.favSide === 'yes' ? 'YES' : 'NO', p_win: pWin,
                loss_odds: Math.round((1 - pWin) * 100) / 100, ev_cents: ev,
                reward_cents: 100 - c.favAsk, confidence: pWin,
                verdict: ev > 0 ? 'STRONG' : 'SKIP_NEG_EV',
              },
            });
            if (cards.length >= limit) break;
          }
          // ── Tinder-game composition ──────────────────────────────────────────
          // Hide markets you already hold (no double-buys — "don't show them") and
          // surface your open paper positions as SELL/HOLD cards, so the whole
          // lifecycle (buy → hold → sell/stop) lives in one swipe deck.
          const paperLedger = require('../../lib/kalshi-paper-ledger');
          const held = new Set(paperLedger.getOpen().map(p => p.ticker));
          const buyCards = cards.filter(c => !held.has(c.ticker));
          let positionCards = [];
          try {
            const polled = await paperLedger.pollOpen(); // live P&L + auto-stop already applied
            positionCards = polled
              .filter(p => p.status === 'open' || p.status === 'exit-pending')
              .map(p => ({
                kind: 'position', mode: 'paper',
                ticker: p.ticker, title: p.title || p.ticker,
                side: p.side, favSide: p.side,
                entryCents: p.entryCents, favAsk: p.currentBid != null ? p.currentBid : p.entryCents,
                currentBid: p.currentBid, pnlCents: p.pnlCents, pnlPct: p.pnlPct,
                autoExit: p.autoExit, positionId: p.id, qty: p.qty || p.count || 1,
                minsToClose: p.minsToClose,
              }));
          } catch (_) { /* positions optional */ }
          const gameDeck = [...buyCards, ...positionCards];
          return sendJson(res, {
            cards: gameDeck, count: gameDeck.length, mode: 'paper',
            weatherCards: wxCards.length, buyCards: buyCards.length, positionCards: positionCards.length,
            wallet: paperLedger.getWallet(),
            generatedAt: new Date().toISOString(),
            note: 'Paper deck — buy candidates (held markets hidden) + your open positions to sell/hold. No real orders; live trading remains paused.',
          }, 200), true;
        } catch (e) {
          return sendJson(res, { cards: [], count: 0, mode: 'paper', error: e.message }, 200), true;
        }
      }

      // GET — Grounded deck: the Σ₀ weather-edge deck. DETERMINISTIC, no LLM — every
      // card's fair value is the live NWS-calibrated model (kalshi-weather-edge) against
      // the live KXHIGHNY board, and an edge shows only when it survives the whole
      // calibration band net of fees. This replaced the old LLM suggester, whose cards
      // sat "pending" forever whenever a provider was unfunded. Paper-only; the profitable
      // arm — edge from the >=100°F ceiling the thin market over-prices on extreme days.
      if (url.pathname === '/api/trading/kalshi/grounded-deck' && req.method === 'GET') {
        const weatherDeck = require('../../lib/kalshi-weather-edge-deck');
        const limit = q.limit ? Number(q.limit) : 12;
        try {
          const out = await weatherDeck.getWeatherEdgeDeck({ limit });
          return sendJson(res, out, 200), true;
        } catch (e) {
          return sendJson(res, { cards: [], count: 0, mode: 'grounded', error: e.message }, 200), true;
        }
      }

      // GET — PAPER MLB run-total weather deck. Sibling of grounded-deck for KXMLBTOTAL:
      // NWS game-time conditions per ballpark → run-total tilt (wind/temp/roof/precip) →
      // paper hypotheses on weather TAILS only, net of fees. NOT in live scope (live stays
      // weather-edge-only); logs to data/kalshi/mlb-weather-paper-ledger.jsonl for calibration.
      if (url.pathname === '/api/trading/kalshi/mlb-weather-deck' && req.method === 'GET') {
        const mlbDeck = require('../../lib/kalshi-mlb-weather-deck');
        const limit = q.limit ? Number(q.limit) : 12;
        try {
          const out = await mlbDeck.getMlbWeatherDeck({ limit });
          return sendJson(res, out, 200), true;
        } catch (e) {
          return sendJson(res, { cards: [], count: 0, mode: 'paper', live: false, error: e.message }, 200), true;
        }
      }

      // POST — ground a single market on demand { ticker } (Re-ground button).
      if (url.pathname === '/api/trading/kalshi/ground' && req.method === 'POST') {
        const grounding = require('../../lib/kalshi-grounding');
        const eventSuggester = require('../../lib/kalshi-event-suggester');
        const kapi = require('../../lib/kalshi-api');
        const body = await collectRequestBody(req);
        const { ticker } = body ? JSON.parse(body) : {};
        if (!ticker) return sendJson(res, { error: 'ticker required' }, 400), true;
        try {
          const r = await kapi.getMarket(ticker);
          const m = r && r.data && r.data.market;
          if (!m) return sendJson(res, { error: 'market not found', ticker }, 404), true;
          const g = await grounding.groundMarket(m, { force: true });
          const card = eventSuggester.toCard(m, g, Date.now());
          return sendJson(res, { ticker, grounding: g, card }, 200), true;
        } catch (e) {
          return sendJson(res, { error: e.message, ticker }, 200), true;
        }
      }

      // GET — grade resolved grounded paper picks into the council (forward Verify→Converge).
      if (url.pathname === '/api/trading/kalshi/grounded-sync' && req.method === 'GET') {
        const kc = require('../../lib/kalshi-council');
        try { return sendJson(res, await kc.groundedSync(), 200), true; }
        catch (e) { return sendJson(res, { error: e.message }, 200), true; }
      }

      // GET /api/trading/kalshi/positions-deck?exitsOnly=true
      // Open positions as swipe cards: entry price, current bid, P&L, exit tag.
      // exitsOnly=true: only show positions marked for exit (STOP-LOSS/TAKE-PROFIT/CONVERGENCE)
      // Parallel market fetches so latency = slowest single market, not sum.
      if (url.pathname === '/api/trading/kalshi/positions-deck' && req.method === 'GET') {
        const exitsOnly = q.exitsOnly === 'true';
        const kalshi = require('../../lib/kalshi-api');
      const posRes = await kalshi.getPositions({});
      const rawPositions = (posRes.data && posRes.data.market_positions) || [];

      // Kalshi v2 API returns position:0 (integer) even when position_fp is non-zero
      // (fractional contracts). Fall through to position_fp when the integer rounds to 0.
      const rawCount = p => {
        const pos = p.position;
        if (pos != null && pos !== 0) return parseFloat(pos);
        return parseFloat(p.position_fp ?? p.quantity_fp ?? 0);
      };

      const active = rawPositions.filter(p => {
        const n = rawCount(p);
        if (!Number.isFinite(n) || n === 0) return false;
        // Skip multi-game parlay positions — they can't be individually exited
        const t = p.ticker || p.market_ticker || '';
        if (t.includes('MVESPORTS') || t.includes('MVECROSS') || t.includes('MULTIGAME')) return false;
        return true;
      });

      // Σ₀ Fix: Add timeout protection to prevent hanging on slow Kalshi API responses
      const MARKET_FETCH_TIMEOUT_MS = 5000;
      const mkResults = await Promise.all(
        active.map(p => {
          const ticker = p.ticker || p.market_ticker;
          return new Promise(resolve => {
            const timeoutId = setTimeout(() => {
              console.warn(`[trading] Market fetch timeout for ${ticker} after ${MARKET_FETCH_TIMEOUT_MS}ms`);
              resolve(null);
            }, MARKET_FETCH_TIMEOUT_MS);

            kalshi.getMarket(ticker)
              .then(result => { clearTimeout(timeoutId); resolve(result); })
              .catch(err => { clearTimeout(timeoutId); resolve(null); });
          });
        })
      );

      const nowMs = Date.now();
      const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };

      function entryCents(p, qty) {
        const expD = num(p.market_exposure_dollars);
        if (expD != null && qty > 0) return Math.round((Math.abs(expD) / qty) * 100);
        const exp = num(p.market_exposure);
        if (exp != null && qty > 0) return Math.round(Math.abs(exp) / qty);
        const avg = num(p.average_price_dollars) ?? num(p.avg_price_dollars);
        if (avg != null) return Math.round(avg * 100);
        return null;
      }

      // Kalshi taker fee: round_up(0.07 × C × P × (1-P)) in cents.
      // INX / NASDAQ100 markets use the 0.035 rate per fee schedule (Feb 5, 2026).
      function kalshiFee(contracts, priceCents, ticker = '') {
        const pc = Math.max(1, Math.min(99, priceCents));
        const P = pc / 100;
        const rate = (ticker.startsWith('INX') || ticker.startsWith('NASDAQ100')) ? 0.035 : 0.07;
        return Math.ceil(rate * contracts * P * (1 - P) * 100); // cents
      }

      const cards = [];
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        const m = mkResults[i] && mkResults[i].data && mkResults[i].data.market;
        const ticker = p.ticker || p.market_ticker;
        const count = rawCount(p);
        const heldSide = count > 0 ? 'yes' : 'no';
        const absCount = Math.abs(count);
        // Display qty: round fractional positions up to 1 so the card reads "1 contract"
        const qty = absCount < 1 ? 1 : Math.abs(Math.round(count));
        // Entry price: use raw fractional count so exposure/count gives the correct per-contract cost
        const entry = entryCents(p, absCount || 1) || 50;
        const bidCents = m ? (heldSide === 'yes'
          ? (m.yes_bid ?? Math.round((num(m.yes_bid_dollars) || 0) * 100))
          : (m.no_bid  ?? Math.round((num(m.no_bid_dollars)  || 0) * 100))) : entry;

        const pnlCents = bidCents - entry;
        const pnlPct   = Math.round((pnlCents / entry) * 100);
        const maxPayout = qty * 100; // $1 per contract in cents

        // Fee impact: exit fee you'd pay to sell now; entry fee already paid at open
        const exitFeeCents  = kalshiFee(qty, bidCents, ticker);
        const entryFeeCents = kalshiFee(qty, entry, ticker);
        const grossPnlCents = pnlCents * qty;
        const netPnlCents   = grossPnlCents - entryFeeCents - exitFeeCents;
        const costBasis     = entry * qty + entryFeeCents;
        const netPnlPct     = costBasis > 0 ? Math.round((netPnlCents / costBasis) * 100) : 0;

        const minsToClose = m && m.close_time
          ? Math.round((new Date(m.close_time).getTime() - nowMs) / 60000) : null;

        const yesCents = (m && m.yes_ask != null) ? m.yes_ask : null;
        const conviction = yesCents != null ? Math.min(99, Math.round(
          heldSide === 'yes' ? yesCents * 1.1 : (100 - yesCents) * 1.1
        )) : 50;

        const exitTag = pnlPct <= -30 ? 'STOP-LOSS'
          : pnlPct >= 40 ? 'TAKE-PROFIT'
          : (minsToClose !== null && minsToClose <= 30 && minsToClose >= 0) ? 'FLATTEN'
          : null;

        const pnlSign    = pnlPct >= 0 ? '+' : '';
        const netPnlSign = netPnlPct >= 0 ? '+' : '';
        const reason = `entry ${entry}¢ · bid ${bidCents}¢ · gross ${pnlSign}${pnlPct}% · fee −${exitFeeCents}¢ · net ${netPnlSign}${netPnlPct}%`;

        cards.push({
          kind: 'position', action: 'sell',
          ticker,
          title: (m && m.title) || ticker,
          yesLabel: (m && m.yes_sub_title) || 'YES',
          noLabel:  (m && m.no_sub_title)  || 'NO',
          favSide: heldSide,
          favLabel: heldSide === 'yes' ? ((m && m.yes_sub_title) || 'YES') : ((m && m.no_sub_title) || 'NO'),
          favAsk: bidCents,
          qty, entryCents: entry, currentBidCents: bidCents,
          pnlCents: grossPnlCents, pnlPct,
          netPnlCents, netPnlPct,
          exitFeeCents, entryFeeCents,
          maxPayoutCents: maxPayout,
          conviction, exitTag, minsToClose,
          close: (m && m.close_time) || '',
          reason, yesPct: yesCents, marketFound: m != null,
        });
      }

      // Σ₀ Phase A: Enrich cards with strategy fitness metrics (historical performance)
      for (const card of cards) {
        try {
          // Infer regime from market conditions: TREND if large P&L, MEAN if small, PIVOT if near close
          const regimeScore = Math.abs(card.pnlPct);
          const regime = card.minsToClose !== null && card.minsToClose <= 15 ? 'PIVOT'
            : regimeScore > 20 ? 'TREND'
            : 'MEAN';

          // Query historical performance for this strategy/regime pair
          const fitness = getStrategyFitness(card.ticker, regime);
          if (fitness && fitness.count > 0) {
            card.strategy_fitness = fitness;
          }
        } catch (err) {
          console.error(`[trading] Failed to load strategy fitness for ${card.ticker}:`, err.message);
        }
      }

      // Stop-loss first → flatten → take-profit → worst P&L first
      const urgency = t => t === 'STOP-LOSS' ? 0 : t === 'FLATTEN' ? 1 : t === 'TAKE-PROFIT' ? 2 : 3;
      cards.sort((a, b) => urgency(a.exitTag) - urgency(b.exitTag) || a.pnlPct - b.pnlPct);

      // Filter: show only positions marked for exit if exitsOnly is true
      const filtered = exitsOnly ? cards.filter(c => c.exitTag) : cards;

      return sendJson(res, {
        count: filtered.length,
        totalPositions: cards.length,
        exitsOnly,
        generatedAt: new Date().toISOString(),
        cards: filtered
      }, 200), true;
      }
    } catch (error) {
      return sendJson(res, { error: 'kalshi_api_error', details: error.message }, 502), true;
    }
  }

  // GET /api/trading/kalshi/collector-status
  // Get tight-band collector status and latest snapshot
  if (url.pathname === '/api/trading/kalshi/collector-status' && req.method === 'GET') {
    try {
      const collector = deps.kalshiCollector;
      const latest = collector ? collector.getLatest() : null;
      const collectorStatus = collector?.getStatus?.() || null;
      sendJson(res, {
        running: !!collector,
        backoff: collectorStatus?.backoff || false,
        resumeAt: collectorStatus?.resumeAt || null,
        lastSnapshot: latest ? {
          generatedAt: latest.generatedAt,
          marketCount: latest.markets?.length || 0,
          exitCount: latest.exitCount || 0,
          markets: latest.markets?.slice(0, 5),
        } : null,
      }, 200);
    } catch (error) {
      sendJson(res, { error: 'Collector status check failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/kalshi/observer-status
  // Reports live crypto_live_trader.py observer health and today's snapshot count
  if (url.pathname === '/api/trading/kalshi/observer-status' && req.method === 'GET') {
    try {
      const { fs: dfs, path: dpath, repoRoot: root } = deps;
      const obs = deps.cryptoObserver;
      const today = new Date().toISOString().slice(0, 10);
      const snapshotFile = dpath.join(root, 'data', `crypto-tight-band-${today}.jsonl`);
      let snapshotCount = 0;
      let lastSnapshot = null;
      if (dfs.existsSync(snapshotFile)) {
        const lines = dfs.readFileSync(snapshotFile, 'utf8').split('\n').filter(Boolean);
        snapshotCount = lines.length;
        try { lastSnapshot = JSON.parse(lines[lines.length - 1]).timestamp || null; } catch {}
      }
      const alive = obs ? obs.process.exitCode === null : false;
      sendJson(res, {
        alive,
        pid: obs?.pid || null,
        startedAt: obs?.startedAt || null,
        today,
        snapshotCount,
        lastSnapshot,
        snapshotFile: snapshotFile.replace(root, ''),
      });
    } catch (error) {
      sendJson(res, { error: 'Observer status check failed', details: error.message }, 500);
    }
    return true;
  }

  return false;
};
