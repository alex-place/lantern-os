/**
 * Trading routes — news group.
 *
 * Split out of routes/trading.js (behavior-preserving). Branch bodies are
 * verbatim; the only change is require('../lib/...') -> require('../../lib/...')
 * because this file lives one directory deeper. All shared module-level
 * bindings arrive via the ctx object built in trading.js.
 */

module.exports = async function newsRoutes(req, res, url, ctx) {
  const { deps, sendJson, collectRequestBody, tradingNews } = ctx;


  // ── Trading Phase 3: News CSF integration (#324) ─────────────────────────

  // GET /api/trading/news/recent?limit=50&ticker=SPY&sentiment=high
  // Recent news items persisted as CSF Entity records, newest first.
  if (url.pathname === '/api/trading/news/recent' && req.method === 'GET') {
    try {
      const limit = Number(url.searchParams.get('limit')) || 50;
      const ticker = url.searchParams.get('ticker') || '';
      const sentiment = url.searchParams.get('sentiment') || '';
      const records = tradingNews.queryRecentNews({ limit, ticker, sentiment });
      sendJson(res, { records, count: records.length }, 200);
    } catch (error) {
      sendJson(res, { error: 'News query failed', details: error.message, records: [] }, 500);
    }
    return true;
  }

  // GET /api/trading/news/article?id=<news_id> — one story plus OUR summary of it
  // (2026-10-11). The reader clicks a headline and lands on our page, not the
  // publisher's; the original is one clearly-labelled link away from there.
  //
  // The summary is generated on first view and cached on disk by news id, so a story
  // costs one fetch and one model call for its whole life. A failure is cached too and
  // reported as a failure — never papered over with a summary invented from the
  // headline, which would be a plausible lie about a real story.
  if (url.pathname === '/api/trading/news/article' && req.method === 'GET') {
    try {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) { sendJson(res, { error: 'id required' }, 400); return true; }
      // Find it in the recent window the feed itself serves — the same rows the home
      // page and the symbol view link from, so a link can never point at a story the
      // reader could not have seen.
      const records = tradingNews.queryRecentNews({ limit: 400 });
      const rec = records.find((r) => String(r.news_id || r.id) === id);
      if (!rec) { sendJson(res, { error: 'not_found' }, 404); return true; }

      // TWO CALLS, ON PURPOSE. Without ?summarize=1 this returns instantly with whatever
      // summary is already cached, so the story itself never waits on a network fetch of
      // somebody else's website. The page renders, THEN asks for the summary.
      //
      // That split is not a micro-optimisation: measured 2026-10-11, every publisher in
      // the current feed refuses an automated fetch (Yahoo — 100% of our stories — stalls
      // until timeout; Reuters 401; AP 403). Blocking the article on that would have made
      // every headline a 15-second wait for a failure.
      const { summarize, readCached } = require('../../lib/news-summary');
      const wants = url.searchParams.get('summarize') === '1';
      const sum = wants
        ? await summarize(rec)
        : (readCached(rec.news_id || rec.id) || { pending: true });
      sendJson(res, {
        article: {
          id: rec.news_id || rec.id,
          headline: rec.headline || rec.text || '',
          url: rec.url || '',
          source: rec.source || '',
          published: rec.published || rec.date || null,
          symbols: Array.isArray(rec.symbols) ? rec.symbols.slice(0, 8) : [],
          direction: rec.direction || 'neutral',
          impact: Number.isFinite(Number(rec.impact)) ? Number(rec.impact) : null,
        },
        summary: sum,
      }, 200);
    } catch (error) {
      sendJson(res, { error: 'article_failed', details: error.message }, 500);
    }
    return true;
  }

  // GET /api/trading/news/sentiment?ticker=SPY&windowHours=48
  // Directional (bullish/bearish) news sentiment for a symbol over a recent window
  // — the Reason/Verify input the trader can weight. Omit ticker for the whole
  // watchlist (one aggregate per ticker).
  if (url.pathname === '/api/trading/news/sentiment' && req.method === 'GET') {
    try {
      const windowHours = Number(url.searchParams.get('windowHours')) || 48;
      const ticker = (url.searchParams.get('ticker') || '').trim();
      if (ticker) {
        sendJson(res, tradingNews.symbolSentiment(ticker, { windowHours }), 200);
        return true;
      }
      // No ticker → aggregate across the watchlist.
      const fs = require('fs'); const path = require('path');
      const wlPath = require('../../lib/app-paths').migratedDataPath(path.resolve(__dirname, '..', '..', '..', 'data', 'lantern-garage', 'trading', 'watchlist.json'), 'lantern-garage', 'trading', 'watchlist.json');
      let tickers = [];
      try { tickers = (JSON.parse(fs.readFileSync(wlPath, 'utf8')).tickers || []); } catch { /* empty */ }
      tickers = tickers.filter((t) => /^[A-Z]{1,5}$/.test(t));
      const symbols = tickers.map((t) => tradingNews.symbolSentiment(t, { windowHours }));
      sendJson(res, { window_hours: windowHours, symbols }, 200);
    } catch (error) {
      sendJson(res, { error: 'sentiment query failed', details: error.message }, 500);
    }
    return true;
  }

  // POST /api/trading/news/record
  // Explicitly record a news item into CSF (used by the UI or external ingestion).
  if (url.pathname === '/api/trading/news/record' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const item = body ? JSON.parse(body) : {};
      await tradingNews.recordNewsItem(item);
      sendJson(res, { ok: true }, 201);
    } catch (error) {
      sendJson(res, { error: 'News record failed', details: error.message }, 400);
    }
    return true;
  }

  // POST /api/trading/news/link-trade
  // Record a news→trade influence relation when a trade follows a news item
  // for the same ticker within the configured window.
  if (url.pathname === '/api/trading/news/link-trade' && req.method === 'POST') {
    try {
      const body = await collectRequestBody(req);
      const { newsId, orderId, ticker, windowMinutes } = body ? JSON.parse(body) : {};
      if (!newsId || !orderId) {
        sendJson(res, { error: 'newsId and orderId required' }, 400);
        return true;
      }
      await tradingNews.linkNewsTrade({ newsId, orderId, ticker, windowMinutes });
      sendJson(res, { ok: true, relation: `${newsId} → ${orderId}` }, 201);
    } catch (error) {
      sendJson(res, { error: 'Link failed', details: error.message }, 400);
    }
    return true;
  }

  // GET /api/trading/crypto/news
  // Returns latest crypto news from CoinGecko trending endpoint
  if (url.pathname === '/api/trading/crypto/news' && req.method === 'GET') {
    try {
      const cryptoCollector = deps.cryptoCollector;
      if (!cryptoCollector) {
        return sendJson(res, { error: 'Crypto collector not initialized' }, 503), true;
      }
      const news = cryptoCollector.getLatestNews();
      sendJson(res, { timestamp: new Date().toISOString(), news }, 200);
    } catch (error) {
      sendJson(res, { error: 'Failed to fetch crypto news', details: error.message }, 500);
    }
    return true;
  }

  return false;
};
