/**
 * Local trading state store (Trading Phase 2, issue #323) — LanternOS-native.
 *
 * Orders and agent/signal log entries are appended to local JSONL files
 * under data/lantern-garage/trading/ (override with
 * LANTERN_TRADING_DATA_PATH, e.g. for test isolation). This is the
 * system of record for GET /api/trading/dashboard/orders and
 * GET /api/trading/dashboard/agent-log — no external dashboard service
 * is required.
 *
 * Appends are funneled through file-queue.js's enqueueFileWrite() to
 * avoid concurrent-write corruption.
 */

const path = require("path");

const { appendJsonlQueued } = require("./file-queue");
const { readJsonlCached } = require("./jsonl-cache");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function dataDir() {
  if (process.env.LANTERN_TRADING_DATA_PATH) {
    return path.resolve(process.env.LANTERN_TRADING_DATA_PATH);
  }
  return path.join(repoRoot, "data", "lantern-garage", "trading");
}

function ordersPath() {
  return path.join(dataDir(), "orders.jsonl");
}

function agentLogPath() {
  return path.join(dataDir(), "agent-log.jsonl");
}

// mtime-cached: orders.jsonl / agent-log.jsonl only change via appendJsonlQueued,
// so re-parsing the whole file on every dashboard GET is wasted work (#1889).
// Returns a shared read-only array; listOrders/listLogEntries copy via .slice.
function _readAll(filePath) {
  return readJsonlCached(filePath);
}

/** Append a single order to the local store. Returns the stored order. */
async function appendOrder(order) {
  await appendJsonlQueued(ordersPath(), order);
  return order;
}

/** Append a single agent-log/signal entry to the local store. */
async function appendLogEntry(entry) {
  await appendJsonlQueued(agentLogPath(), entry);
  return entry;
}

/** Read all stored orders (oldest first), optionally limited to the most recent N. */
function listOrders({ limit } = {}) {
  const all = _readAll(ordersPath());
  return limit ? all.slice(-limit) : all;
}

/** Read all stored agent-log entries (oldest first), optionally limited to the most recent N. */
function listLogEntries({ limit } = {}) {
  const all = _readAll(agentLogPath());
  return limit ? all.slice(-limit) : all;
}

module.exports = {
  dataDir,
  ordersPath,
  agentLogPath,
  appendOrder,
  appendLogEntry,
  listOrders,
  listLogEntries,
};
