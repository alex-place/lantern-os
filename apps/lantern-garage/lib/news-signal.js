// news-signal.js — join the EXISTING trading news feed (data/lantern-garage/trading/news.jsonl,
// via trading-news.queryRecentNews) onto Kalshi market cards so the Observe stage
// (news) feeds the Reason stage (decisive deck). This is the v1.9 "news → signal"
// slice: a deterministic ticker/title join, NOT the semantic-embedding engine.
//
// Competitive note (grounded 2026-07): Verso's news engine maps 30k+ articles →
// Kalshi contracts via LLM embeddings + GPT-5 impact scoring (73% catalyst accuracy).
// This module is the local, zero-dependency PARITY floor; the embedding upgrade is
// tracked as a separate v1.9 issue. The wedge we keep is local + CSF trade memory.
//
// Σ₀: this strengthens Observe→Reason. No new data collection, no new store — it reads
// the news the collector already writes and annotates cards the deck already builds.

const tradingNews = require('./trading-news');

// Company-KPI Kalshi series → the equity ticker whose news actually moves that market.
// Kalshi is expanding into programmatically-settled company-KPI markets (Tesla
// production, DoorDash deliveries, Netflix subs) via the Kalshi–Fiscal.ai partnership;
// their series tickers embed the issuer. Hand-maintained — small at current market count.
const KPI_ISSUER_MAP = {
  KXTSLA: 'TSLA', KXTSLAQ: 'TSLA', KXTSLADEL: 'TSLA',
  KXNFLX: 'NFLX', KXNFLXSUB: 'NFLX',
  KXDASH: 'DASH', KXDASHDEL: 'DASH',
  KXAAPL: 'AAPL', KXNVDA: 'NVDA', KXMETA: 'META',
  KXAMZN: 'AMZN', KXGOOGL: 'GOOGL', KXMSFT: 'MSFT',
};

// Weather series get NO news join — headlines don't settle KXHIGH* markets; the
// weather oracle does. Listed so we skip them explicitly rather than mis-matching.
const WEATHER_PREFIXES = ['KXHIGH', 'KXLOW', 'KXTEMP', 'KXRAIN', 'KXSNOW'];

function isWeatherMarket(ticker = '') {
  const t = String(ticker).toUpperCase();
  return WEATHER_PREFIXES.some((p) => t.startsWith(p));
}

// Pull the candidate equity symbols a Kalshi market's news would be filed under.
// 1) exact KPI-issuer map on the series prefix, 2) any known equity symbol that
// appears as a whole word in the market title.
function candidateSymbols(market = {}, knownSymbols) {
  const ticker = String(market.ticker || market.event_ticker || '').toUpperCase();
  if (!ticker || isWeatherMarket(ticker)) return [];

  const out = new Set();
  // Match the longest KPI prefix first (KXTSLADEL before KXTSLA).
  const prefixes = Object.keys(KPI_ISSUER_MAP).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (ticker.startsWith(p)) { out.add(KPI_ISSUER_MAP[p]); break; }
  }

  // Title token match against symbols that actually appear in the news corpus.
  const title = String(market.title || market.subtitle || market.name || '').toUpperCase();
  if (title && knownSymbols) {
    for (const sym of knownSymbols) {
      if (sym.length >= 2 && new RegExp(`\\b${sym}\\b`).test(title)) out.add(sym);
    }
  }
  return [...out];
}

// Recency weight: full weight < 6h old, linear decay to 0 at 48h.
function recencyWeight(publishedIso, nowMs) {
  const t = Date.parse(publishedIso);
  if (!Number.isFinite(t)) return 0.3;
  const ageH = (nowMs - t) / 3.6e6;
  if (ageH <= 6) return 1;
  if (ageH >= 48) return 0;
  return 1 - (ageH - 6) / 42;
}

/**
 * Compute a news signal for one market from the existing news feed.
 * @param {object} market  a Kalshi market/card ({ ticker, title, ... })
 * @param {object} [opts]  { news?: object[], nowMs?: number, maxHeadlines?: number }
 * @returns {null | { symbols, count, impact, sentiment, score, freshestTs, headlines }}
 *   score ∈ [0,1] = recency-weighted impact; null when nothing matches.
 */
function getNewsSignal(market = {}, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const news = opts.news || tradingNews.queryRecentNews({ limit: 300 });
  if (!news.length) return null;

  const knownSymbols = new Set();
  for (const n of news) for (const s of (n.symbols || [])) knownSymbols.add(String(s).toUpperCase());

  const syms = candidateSymbols(market, knownSymbols);
  if (!syms.length) return null;
  const symSet = new Set(syms);

  const matched = news.filter((n) => (n.symbols || []).some((s) => symSet.has(String(s).toUpperCase())));
  if (!matched.length) return null;

  let weightedImpact = 0, totalW = 0, freshestTs = 0;
  const sentTally = { high: 0, medium: 0, low: 0 };
  for (const n of matched) {
    const w = recencyWeight(n.published, nowMs);
    const impact = Number(n.impact ?? n.impact_score ?? 0);
    weightedImpact += impact * w;
    totalW += w;
    const ts = Date.parse(n.published) || 0;
    if (ts > freshestTs) freshestTs = ts;
    if (sentTally[n.sentiment] != null) sentTally[n.sentiment] += w;
  }
  // score: normalize weighted mean impact (impact is 0..100) to 0..1.
  const meanImpact = totalW > 0 ? weightedImpact / totalW : 0;
  const score = Math.max(0, Math.min(1, meanImpact / 100));
  const sentiment = Object.keys(sentTally).sort((a, b) => sentTally[b] - sentTally[a])[0];

  const headlines = matched
    .slice(0, opts.maxHeadlines || 3)
    .map((n) => ({ headline: n.headline, source: n.source, url: n.url, published: n.published, impact: n.impact }));

  return {
    symbols: syms,
    count: matched.length,
    impact: Math.round(meanImpact),
    sentiment,
    score: Number(score.toFixed(3)),
    freshestTs: freshestTs ? new Date(freshestTs).toISOString() : null,
    headlines,
  };
}

/**
 * Enrich a deck of cards with a `.news` signal in one pass (loads news once).
 * @param {object[]} cards
 * @param {object} [opts] { nowMs?, boost?: number } boost = max fractional nudge to
 *   decisionScore/sigma0 score when a fresh high-impact headline backs the card.
 * @returns {object[]} the same cards, mutated with `.news` (and a small score nudge).
 */
function enrichDeckWithNews(cards = [], opts = {}) {
  if (!cards.length) return cards;
  const nowMs = opts.nowMs || Date.now();
  const boost = opts.boost ?? 0.15;
  const news = tradingNews.queryRecentNews({ limit: 300 });
  if (!news.length) return cards;

  for (const card of cards) {
    const sig = getNewsSignal(card, { news, nowMs });
    if (!sig) continue;
    card.news = sig;
    // Nudge, never override: fresh high-impact news amplifies conviction slightly.
    const factor = 1 + boost * sig.score;
    if (typeof card.decisionScore === 'number') card.decisionScore *= factor;
    if (card.sigma0 && typeof card.sigma0.score === 'number') card.sigma0.score *= factor;
  }
  return cards;
}

module.exports = { getNewsSignal, enrichDeckWithNews, candidateSymbols, isWeatherMarket, KPI_ISSUER_MAP };
