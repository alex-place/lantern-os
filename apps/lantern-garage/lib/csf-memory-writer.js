/**
 * CSF Memory writer/query for trading orders & agent signals
 * (Trading Phase 2, issue #323) — LanternOS-native, pure JS.
 *
 * Writes CSF MemoryRecord-shaped JSON records (same on-disk schema as
 * src/csf/memory_engine.py's MemoryEngine) directly to
 * data/csf_memory/<cube_partition>/<tier>/<memory_id>.json plus the
 * append-only registry data/csf_memory/<cube_partition>.jsonl.
 *
 * This is the runtime implementation used by apps/lantern-garage routes:
 * it requires no Python process and no external service. The Python
 * module src/csf/trading_memory.py implements the same record shape
 * (Tier.TRACE, tags ["trading", "order"|"signal", ...], PrivacyScope.
 * INTERNAL, CubePartition.RAW) and is used by the Python test suite as a
 * reference implementation — both write to the same
 * data/csf_memory/raw.jsonl registry format, so records from either are
 * queryable by MemoryEngine.query() and by queryRecent() here.
 *
 * Records written here compute their own checksum via a JS-native
 * canonical-JSON + SHA-256 scheme (see _checksum/_canonicalJson). This
 * is self-consistent (verifyRecord() round-trips), but is not byte-for-
 * byte identical to MemoryRecord._compute_checksum()'s Python
 * json.dumps()-based canonical form (Python and JS format numbers like
 * `1.0` vs `1` differently). Field names, tiers, tags, and partitions
 * match exactly, so MemoryEngine.read()/query() can load these records
 * (MemoryRecord.from_dict() does not re-verify checksums on load).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { appendJsonlQueued } = require("./file-queue");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

// Tickers the trading UI watches by default, plus common index/ETF
// tickers. Used to disambiguate real tickers from other all-caps tokens
// (agent names, "RSI", "VIX", etc.) when scanning agent-log free text for
// entities. Best-effort heuristic, not exhaustive.
const KNOWN_TICKERS = new Set([
  "AAPL", "AMZN", "INTC", "AMD", "SHOP", "SPY", "TSLA", "NVDA", "ASML",
  "META", "MSFT", "JPM", "GLD", "QQQ", "VIXY",
]);

// Generic crypto pairs (BTCUSD, ETHUSD, SOLUSD, ...) and any 2-5 letter
// all-caps token immediately followed by "USD".
const CRYPTO_RE = /\b[A-Z]{2,5}USD\b/g;
const TOKEN_RE = /\b[A-Z]{1,5}\b/g;

/** Best-effort extraction of ticker symbols from free-text agent log bodies. */
function extractTickers(texts, limit = 5) {
  const found = [];
  for (const text of texts || []) {
    if (!text) continue;
    for (const m of String(text).match(CRYPTO_RE) || []) {
      if (!found.includes(m)) found.push(m);
    }
    for (const m of String(text).match(TOKEN_RE) || []) {
      if (KNOWN_TICKERS.has(m) && !found.includes(m)) found.push(m);
    }
    if (found.length >= limit) break;
  }
  return found.slice(0, limit);
}

function _csfMemoryPath(basePath) {
  if (basePath) return path.resolve(basePath);
  if (process.env.CSF_MEMORY_PATH) return path.resolve(process.env.CSF_MEMORY_PATH);
  return path.join(repoRoot, "data", "csf_memory");
}

function _nowIso() {
  return new Date().toISOString();
}

function _tsStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function _genMemoryId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}_${_tsStamp()}`;
}

/** Deterministic canonical JSON: object keys sorted recursively. */
function _canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(_canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_canonicalJson(value[k])}`).join(",")}}`;
}

function _checksum(record) {
  const payload = { ...record };
  delete payload.checksum;
  return crypto.createHash("sha256").update(_canonicalJson(payload), "utf8").digest("hex");
}

/** Recompute and compare the checksum (mirrors MemoryRecord.verify()). */
function verifyRecord(record) {
  return record.checksum === _checksum(record);
}

function _recordDir(basePath, record) {
  return path.join(_csfMemoryPath(basePath), record.cube_partition, record.tier);
}

function _recordPath(basePath, record) {
  return path.join(_recordDir(basePath, record), `${record.memory_id}.json`);
}

async function _persist(basePath, record) {
  const dir = _recordDir(basePath, record);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(_recordPath(basePath, record), JSON.stringify(record, null, 2), "utf8");
  await appendJsonlQueued(path.join(_csfMemoryPath(basePath), `${record.cube_partition}.jsonl`), record, { rotate: true }); // #872 per-partition
  return record;
}

/**
 * Build + persist a Tier.TRACE record (mirrors MemoryRecord.to_dict()'s
 * field set, with cube_partition="raw", privacy_scope="internal").
 */
async function _writeTrace({ content, tags, keywords, entities, confidence, sourceSurface }, opts = {}) {
  const now = _nowIso();
  const record = {
    memory_id: _genMemoryId("trace"),
    tier: "trace",
    created_at: now,
    updated_at: now,
    content,
    confidence,
    privacy_scope: "internal",
    source_surface: sourceSurface,
    promoted_from: null,
    promotion_chain: [],
    cube_partition: "raw",
    tags,
    agents: [],
    checksum: "",
    vector_embedding: null,
    keywords,
    entities,
    metadata: {},
    actor_id: "",
    actor_type: "system",
    confidence_reasoning: "",
    staleness_signals: [],
  };
  record.checksum = _checksum(record);
  await _persist(opts.basePath, record);
  return { memory_id: record.memory_id, path: _recordPath(opts.basePath, record), record };
}

/** Write a single order (from the local trading store) as a CSF trace record. */
async function recordOrder(order, opts = {}) {
  order = order || {};
  const symbol = String(order.symbol || "").toUpperCase();
  const side = String(order.side || "").toLowerCase();
  const status = String(order.status || "").toLowerCase();
  const qty = order.qty;
  const orderId = order.id || "";

  const summary = `Order ${orderId}: ${side} ${qty} ${symbol} (${status})`.trim();

  const tags = ["trading", "order"];
  if (status) tags.push(status);

  const keywords = [symbol.toLowerCase(), side, status, "order"].filter(Boolean);
  const entities = symbol ? [symbol] : [];

  const content = {
    text: summary,
    session_id: "trading",
    timestamp: _nowIso(),
    surface: "trading",
    role: "system",
    raw_input: summary,
    event: "order",
    ...order,
  };

  return _writeTrace({ content, tags, keywords, entities, confidence: 1.0, sourceSurface: "trading" }, opts);
}

/** Write a single agent-log/signal entry as a CSF trace record. */
async function recordSignal(entry, opts = {}) {
  entry = entry || {};
  const agent = String(entry.agent || "");
  const entryType = String(entry.type || "");
  const body = String(entry.body || "");

  const tags = ["trading", "signal"];
  if (entryType) tags.push(entryType.toLowerCase());

  const keywords = [agent.toLowerCase(), entryType.toLowerCase(), "signal"].filter(Boolean);
  const entities = extractTickers([body, agent]);

  const text = body || `${agent}: (no message)`;
  const content = {
    text,
    session_id: "trading",
    timestamp: _nowIso(),
    surface: "trading",
    role: "agent",
    raw_input: text,
    event: "signal",
    ...entry,
  };

  return _writeTrace({ content, tags, keywords, entities, confidence: 0.6, sourceSurface: "trading" }, opts);
}

/**
 * Return the most recent trading trace records (orders and/or signals),
 * newest first. `kind`, if given, should be "order" or "signal" — filters
 * to records carrying that tag.
 */
function queryRecent({ limit = 20, kind, basePath } = {}) {
  const registryPath = path.join(_csfMemoryPath(basePath), "raw.jsonl");
  let lines = [];
  try {
    lines = fs.readFileSync(registryPath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  let records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.tier === "trace" && Array.isArray(rec.tags) && rec.tags.includes("trading")) {
        records.push(rec);
      }
    } catch {
      // skip malformed lines
    }
  }
  if (kind) records = records.filter((r) => r.tags.includes(kind));
  records.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return records.slice(0, limit);
}

module.exports = {
  KNOWN_TICKERS,
  extractTickers,
  recordOrder,
  recordSignal,
  queryRecent,
  verifyRecord,
  // Shared canonical-checksum primitives. trading-memory.js / trading-news.js
  // import these so every JS writer stamps records with the SAME recursive
  // canonical-JSON + SHA-256 scheme (see _canonicalJson). Do NOT reintroduce a
  // per-writer checksum — that is how data/csf_memory diverged into three
  // incompatible schemes (see tests/test_csf_memory_integrity.py).
  _checksum,
  _canonicalJson,
  _csfMemoryPath,
};
