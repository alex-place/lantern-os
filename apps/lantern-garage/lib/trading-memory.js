/**
 * Trading CSF Memory Writer (Trading Phase 2, issue #323)
 *
 * Writes order fills and agent signals into data/csf_memory/raw.jsonl
 * as Tier.TRACE MemoryRecord objects readable by Python's MemoryEngine,
 * AND into the local trading-store JSONL files (orders.jsonl / agent-log.jsonl)
 * for the dashboard endpoints.
 *
 * Dedup: in-memory seen-set keyed by order/signal id. JSONL appends are
 * idempotent for downstream consumers that dedupe by memory_id.
 */

const path = require("path");
const crypto = require("crypto");
const { appendJsonlQueued } = require("./file-queue");
const tradingStore = require("./trading-store");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CSF_MEMORY_REGISTRY = path.join(REPO_ROOT, "data", "csf_memory", "raw.jsonl");

const _seenOrders = new Set();
const _seenSignals = new Set();

function _now() {
  return new Date().toISOString();
}

function _shortHash(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex").slice(0, 12);
}

function _csfRecord(tier, content, tags, keywords, memoryId) {
  const now = _now();
  const base = {
    memory_id: memoryId,
    tier,
    created_at: now,
    updated_at: now,
    content,
    confidence: 0.75,
    privacy_scope: "internal",
    source_surface: "trading-dashboard",
    promoted_from: null,
    promotion_chain: [],
    cube_partition: "raw",
    tags: tags.filter(Boolean),
    agents: ["trading-memory"],
    checksum: "",
    vector_embedding: null,
    keywords: keywords.filter(Boolean),
    entities: [],
    metadata: {},
    actor_id: "trading-system",
    actor_type: "system",
    confidence_reasoning: "",
    staleness_signals: [],
  };
  const payload = Object.fromEntries(
    Object.entries(base).filter(([k]) => k !== "checksum")
  );
  base.checksum = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
  return base;
}

/** Normalise whatever shape the route sends into a flat array. */
function _toArray(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  if (payload && typeof payload === "object" && Object.keys(payload).length) {
    return [payload];
  }
  return [];
}

/**
 * Write a single order to CSF memory + local store. No-ops on repeat ids.
 * @param {object} order
 */
async function recordOrder(order) {
  const key = String(order.id || order.order_id || JSON.stringify(order)).slice(0, 64);
  if (_seenOrders.has(key)) return order;
  _seenOrders.add(key);

  const memId = `trading_order_${_shortHash(key)}`;
  const rec = _csfRecord(
    "trace",
    {
      order_id: key,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      status: order.status,
      filled_at: order.filled_at || null,
      price: order.price || order.filled_avg_price || null,
      raw: order,
    },
    ["trading", "order", String(order.symbol || ""), String(order.side || ""), String(order.status || "")],
    [String(order.symbol || ""), "order"],
    memId,
  );
  await appendJsonlQueued(CSF_MEMORY_REGISTRY, rec);
  return order;
}

/**
 * Write a single signal/log entry to CSF memory + local store. No-ops on repeat ids.
 * @param {object} signal
 */
async function recordSignal(signal) {
  const key = String(
    signal.id || signal.signal_id || signal.timestamp || JSON.stringify(signal)
  ).slice(0, 64);
  if (_seenSignals.has(key)) return signal;
  _seenSignals.add(key);

  const memId = `trading_signal_${_shortHash(key)}`;
  const rec = _csfRecord(
    "trace",
    {
      signal_id: key,
      agent: signal.agent || signal.agent_type || signal.type || "",
      action: signal.action || signal.signal || signal.body || "",
      symbol: signal.symbol || "",
      confidence: signal.confidence || null,
      timestamp: signal.timestamp || signal.time || null,
      raw: signal,
    },
    ["trading", "signal", String(signal.agent || signal.agent_type || signal.type || ""), String(signal.symbol || "")],
    [String(signal.symbol || ""), "signal", String(signal.agent || "")],
    memId,
  );
  await appendJsonlQueued(CSF_MEMORY_REGISTRY, rec);
  return signal;
}

/**
 * Called from POST /api/trading/orders. Writes each new order to the local
 * trading store and to CSF memory.
 * @param {object[]} orders
 * @returns {Promise<object[]>} orders that were written (deduped)
 */
async function recordNewOrders(orders) {
  const written = [];
  for (const order of orders) {
    const key = String(order.id || order.order_id || "").slice(0, 64);
    const alreadySeen = key && _seenOrders.has(key);
    const stored = await tradingStore.appendOrder(order);
    if (!alreadySeen) {
      await recordOrder(order).catch(() => {});
    }
    written.push(stored);
  }
  return written;
}

/**
 * Called from POST /api/trading/agent-log. Writes each new signal to the
 * local trading store and to CSF memory.
 * @param {{ logs: object[] }} param0
 * @returns {Promise<object[]>} entries that were written
 */
async function recordNewSignals({ logs = [] } = {}) {
  const written = [];
  for (const entry of logs) {
    const stored = await tradingStore.appendLogEntry(entry);
    await recordSignal(entry).catch(() => {});
    written.push(stored);
  }
  return written;
}

/**
 * Read recent trading CSF records from the raw registry.
 * @param {{ limit?: number, kind?: 'order'|'signal' }} options
 * @returns {object[]} records newest-first
 */
async function queryRecent({ limit = 50, kind } = {}) {
  return queryRecentTradingRecords(limit, kind);
}

/**
 * Synchronous version used by GET /api/trading/csf-records.
 * @param {number} limit
 * @param {'order'|'signal'|undefined} kind
 * @returns {object[]}
 */
function queryRecentTradingRecords(limit = 50, kind) {
  const fs = require("fs");
  try {
    const lines = fs.readFileSync(CSF_MEMORY_REGISTRY, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => {
        if (!r || !Array.isArray(r.tags) || !r.tags.includes("trading")) return false;
        if (kind === "order") return r.tags.includes("order");
        if (kind === "signal") return r.tags.includes("signal");
        return true;
      })
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Convenience batch ingest (used by the proxy intercept in trading routes).
 */
async function ingestTradingData({ orders = [], signals = [] } = {}) {
  const results = { orders_written: 0, signals_written: 0, errors: [] };
  for (const o of orders) {
    try {
      const before = _seenOrders.size;
      await recordOrder(o);
      if (_seenOrders.size > before) results.orders_written++;
    } catch (e) { results.errors.push(e.message); }
  }
  for (const s of signals) {
    try {
      const before = _seenSignals.size;
      await recordSignal(s);
      if (_seenSignals.size > before) results.signals_written++;
    } catch (e) { results.errors.push(e.message); }
  }
  return results;
}

module.exports = {
  _toArray,
  recordOrder,
  recordSignal,
  recordNewOrders,
  recordNewSignals,
  queryRecent,
  queryRecentTradingRecords,
  ingestTradingData,
};
