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
const { readJsonlCached } = require("./jsonl-cache");
const tradingStore = require("./trading-store");
const csfWriter = require("./csf-memory-writer");

// Resolve the registry lazily so CSF_MEMORY_PATH (honoured by the Python
// MemoryEngine and csf-memory-writer.js) also isolates this writer's writes —
// previously this path was frozen at require() time to the repo's real data/
// dir, so even tests polluted data/csf_memory/raw.jsonl.
function _registryPath() {
  return path.join(csfWriter._csfMemoryPath(), "raw.jsonl");
}

// Dedup sets are bounded so a long-running server can't leak memory as
// orders/signals accumulate forever (#1889). Sets preserve insertion order, so
// once past the cap we evict the oldest key (FIFO) — the only cost is that a
// re-submission of a very old id would re-write once, which downstream memory_id
// dedup absorbs. `_remember` returns whether the key was newly seen.
const _SEEN_MAX = 10000;
const _seenOrders = new Set();
const _seenSignals = new Set();

function _remember(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > _SEEN_MAX) set.delete(set.values().next().value); // evict oldest
  return true;
}

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
  // Use the shared canonical checksum (recursive key-sort over the whole
  // record, nested content included). The previous
  // `JSON.stringify(payload, Object.keys(payload).sort())` form passed the key
  // list as a *replacer allowlist*, not a sort — so nested content.* (the
  // actual order/signal payload) was excluded from the hash, and the digest
  // matched neither the Python nor the other JS writer. See
  // tests/test_csf_memory_integrity.py.
  base.checksum = csfWriter._checksum(base);
  return base;
}

/** Normalise whatever shape the route sends into a flat array. */
function _toArray(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  if (Object.keys(payload).length) return [payload];
  return [];
}

/**
 * Write a single order to CSF memory + local store. No-ops on repeat ids.
 * @param {object} order
 */
async function recordOrder(order) {
  const key = String(order.id || order.order_id || JSON.stringify(order)).slice(0, 64);
  if (!_remember(_seenOrders, key)) return order;

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
  await appendJsonlQueued(_registryPath(), rec);
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
  if (!_remember(_seenSignals, key)) return signal;

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
  await appendJsonlQueued(_registryPath(), rec);
  return signal;
}

/**
 * Called from POST /api/trading/orders. Writes each new order to the local
 * trading store and to CSF memory. Accepts a bare array, a `{ orders: [...] }`
 * wrapper, or a single order object — all normalised via `_toArray` so a
 * wrapped payload neither throws ("orders is not iterable") nor silently
 * no-ops (the PR #338 payload-shape contract).
 * @param {object[]|{orders:object[]}|object} payload
 * @returns {Promise<object[]>} orders that were written (deduped)
 */
async function recordNewOrders(payload) {
  const orders = _toArray(payload, ["orders"]);
  const written = [];
  for (const order of orders) {
    const key = String(order.id || order.order_id || "").slice(0, 64);
    if (key && _seenOrders.has(key)) continue;
    const stored = await tradingStore.appendOrder(order);
    await recordOrder(order).catch(() => {});
    written.push(stored);
  }
  return written;
}

/**
 * Called from POST /api/trading/agent-log. Writes each new signal to the
 * local trading store and to CSF memory. Accepts a `{ logs: [...] }`,
 * `{ agentLog: [...] }`, or `{ agent_log: [...] }` wrapper, a bare array,
 * or a single entry — all normalised via `_toArray` so alternate wrapper
 * keys don't silently write 0 records (the PR #338 payload-shape contract).
 * @param {object[]|{logs?:object[],agentLog?:object[],agent_log?:object[]}|object} payload
 * @returns {Promise<object[]>} entries that were written
 */
async function recordNewSignals(payload) {
  const logs = _toArray(payload, ["logs", "agentLog", "agent_log"]);
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
  // mtime-cached parse of the append-only CSF registry — previously this read +
  // JSON.parsed the entire raw.jsonl (potentially 100k+ lines) just to return
  // the last ~20 records, on every GET /api/trading/csf-records (#1889).
  return readJsonlCached(_registryPath())
    .filter((r) => {
      if (!r || !Array.isArray(r.tags) || !r.tags.includes("trading")) return false;
      if (kind === "order") return r.tags.includes("order");
      if (kind === "signal") return r.tags.includes("signal");
      return true;
    })
    .slice(-limit)
    .reverse();
}

/**
 * Convenience batch ingest (used by the proxy intercept in trading routes).
 */
async function ingestTradingData({ orders = [], signals = [] } = {}) {
  const results = { orders_written: 0, signals_written: 0, errors: [] };
  // Count newness up front (size-delta is unreliable once the bounded set starts
  // evicting: a new add + an eviction leaves size unchanged). Mirrors the key
  // derivation in recordOrder/recordSignal.
  for (const o of orders) {
    try {
      const key = String(o.id || o.order_id || JSON.stringify(o)).slice(0, 64);
      const isNew = !_seenOrders.has(key);
      await recordOrder(o);
      if (isNew) results.orders_written++;
    } catch (e) { results.errors.push(e.message); }
  }
  for (const s of signals) {
    try {
      const key = String(s.id || s.signal_id || s.timestamp || JSON.stringify(s)).slice(0, 64);
      const isNew = !_seenSignals.has(key);
      await recordSignal(s);
      if (isNew) results.signals_written++;
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
