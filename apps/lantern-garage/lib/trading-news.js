/**
 * Trading News CSF Integration (Trading Phase 3, issue #324)
 *
 * Persists each news item as a CSF Entity record (data/csf_memory/raw.jsonl)
 * with asset tags + impact score. Records news→trade influence relations when
 * a trade/signal occurs within a configurable window for the same ticker.
 */

const path = require("path");
const crypto = require("crypto");
const { appendJsonlQueued } = require("./file-queue");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CSF_MEMORY_REGISTRY = path.join(REPO_ROOT, "data", "csf_memory", "raw.jsonl");
const NEWS_REGISTRY = path.join(REPO_ROOT, "data", "lantern-garage", "trading", "news.jsonl");
const RELATIONS_REGISTRY = path.join(REPO_ROOT, "data", "lantern-garage", "trading", "news-relations.jsonl");

const _seenNews = new Set();

function _now() {
  return new Date().toISOString();
}

function _shortHash(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex").slice(0, 12);
}

function _impactToSentiment(impact) {
  if (impact >= 70) return "high";
  if (impact >= 40) return "medium";
  return "low";
}

function _csfEntityRecord(item, memoryId) {
  const now = _now();
  const sentiment = _impactToSentiment(item.impact || 0);
  const symbols = Array.isArray(item.symbols) ? item.symbols : [];
  const base = {
    memory_id: memoryId,
    tier: "entity",
    created_at: item.published || now,
    updated_at: now,
    content: {
      news_id: item.id || memoryId,
      headline: item.headline || item.title || "",
      source: item.source || "",
      url: item.url || "",
      published: item.published || item.date || now,
      date: item.date || (item.published ? item.published.slice(0, 10) : now.slice(0, 10)),
      symbols,
      impact: item.impact || 0,
      sentiment,
      impact_score: item.impact || 0,
      summary: item.summary || "",
      raw: item,
    },
    confidence: Math.min(0.5 + (item.impact || 0) / 200, 0.99),
    privacy_scope: "internal",
    source_surface: "trading-news",
    promoted_from: null,
    promotion_chain: [],
    cube_partition: "raw",
    tags: ["trading", "news", sentiment, ...symbols].filter(Boolean),
    agents: ["trading-news"],
    checksum: "",
    vector_embedding: null,
    keywords: [item.headline || "", ...symbols, sentiment].filter(Boolean),
    entities: symbols,
    metadata: { impact: item.impact || 0, sentiment },
    actor_id: "trading-system",
    actor_type: "system",
    confidence_reasoning: `impact=${item.impact || 0}`,
    staleness_signals: [],
  };
  const payload = Object.fromEntries(Object.entries(base).filter(([k]) => k !== "checksum"));
  base.checksum = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
  return base;
}

/**
 * Record a single news item into CSF + local news registry. Deduped by item.id.
 * @param {object} item — news object from the dashboard news-feed
 */
async function recordNewsItem(item) {
  const key = String(item.id || item.url || item.headline || JSON.stringify(item)).slice(0, 80);
  const memId = `trading_news_${_shortHash(key)}`;
  
  // Check existing file for deduplication (prevents race condition)
  const fs = require("fs");
  try {
    const existingLines = fs.readFileSync(NEWS_REGISTRY, "utf8").trim().split("\n").filter(Boolean);
    for (const line of existingLines) {
      try {
        const existing = JSON.parse(line);
        if (existing.memory_id === memId) {
          // Already exists, skip
          return existing;
        }
      } catch {}
    }
  } catch (e) {
    // File doesn't exist yet, continue
  }
  
  // Also check in-memory set for fast path
  if (_seenNews.has(key)) return;
  _seenNews.add(key);

  const rec = _csfEntityRecord(item, memId);

  await Promise.all([
    appendJsonlQueued(CSF_MEMORY_REGISTRY, rec),
    appendJsonlQueued(NEWS_REGISTRY, { ...rec.content, memory_id: memId, recorded_at: _now() }),
  ]);
  return rec;
}

/**
 * Record a news→trade influence relation when a trade follows a news item
 * for the same ticker within the given window.
 * @param {{ newsId, orderId, ticker, windowMinutes }} opts
 */
async function linkNewsTrade({ newsId, orderId, ticker, windowMinutes = 10 }) {
  const relId = `news_trade_rel_${_shortHash(`${newsId}:${orderId}`)}`;
  const relation = {
    memory_id: relId,
    tier: "relation",
    created_at: _now(),
    from_id: `trading_news_${_shortHash(newsId)}`,
    to_id: `trading_order_${_shortHash(orderId)}`,
    relation_type: "news_to_trade_influence",
    ticker: ticker || "",
    window_minutes: windowMinutes,
    tags: ["trading", "news", "relation", ticker || ""].filter(Boolean),
  };
  await appendJsonlQueued(RELATIONS_REGISTRY, relation);
  return relation;
}

/**
 * Query recent news CSF records, newest first.
 * @param {{ limit?: number, ticker?: string, sentiment?: string }} opts
 * @returns {object[]}
 */
function queryRecentNews({ limit = 50, ticker = "", sentiment = "" } = {}) {
  const fs = require("fs");
  try {
    const lines = fs.readFileSync(NEWS_REGISTRY, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => {
        if (!r) return false;
        if (ticker && !(r.symbols || []).includes(ticker.toUpperCase())) return false;
        if (sentiment && r.sentiment !== sentiment) return false;
        return true;
      })
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Query news→trade relations.
 * @param {{ ticker?: string, limit?: number }} opts
 */
function queryNewsTradeRelations({ ticker = "", limit = 50 } = {}) {
  const fs = require("fs");
  try {
    const lines = fs.readFileSync(RELATIONS_REGISTRY, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && (!ticker || r.ticker === ticker.toUpperCase()))
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

module.exports = {
  recordNewsItem,
  linkNewsTrade,
  queryRecentNews,
  queryNewsTradeRelations,
};
