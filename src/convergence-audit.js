/**
 * Convergence Audit Logger
 * 
 * Tracks every operation: [timestamp, operation, provider, tokens_saved, cache_hit_rate]
 * Target: 90% local operations, 10% Claude/GPT
 * Stores in data/convergence-audit.jsonl
 */

const fs = require("fs");
const path = require("path");

const AUDIT_PATH = path.join(process.cwd(), "data", "convergence-audit.jsonl");

/**
 * Ensure audit file exists
 */
function ensureAuditFile() {
  const dir = path.dirname(AUDIT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(AUDIT_PATH)) {
    fs.writeFileSync(AUDIT_PATH, "");
  }
}

/**
 * Log an operation to the audit trail
 * 
 * @param {object} entry - Audit entry
 * @param {string} entry.operation - Operation type (e.g., "chat", "rag", "cache_hit")
 * @param {string} entry.provider - Provider used (e.g., "gemini", "claude", "local")
 * @param {number} entry.tokens_saved - Number of tokens saved by caching/local
 * @param {number} entry.cache_hit_rate - Cache hit rate (0-1)
 * @param {string} [entry.context] - Additional context
 */
function logOperation(entry) {
  ensureAuditFile();
  
  const auditEntry = {
    timestamp: new Date().toISOString(),
    operation: entry.operation || "unknown",
    provider: entry.provider || "unknown",
    tokens_saved: entry.tokens_saved || 0,
    cache_hit_rate: entry.cache_hit_rate || 0,
    context: entry.context || null,
  };
  
  const line = JSON.stringify(auditEntry) + "\n";
  fs.appendFileSync(AUDIT_PATH, line);
  
  return auditEntry;
}

/**
 * Get audit statistics
 */
function getAuditStats() {
  ensureAuditFile();
  
  if (!fs.existsSync(AUDIT_PATH)) {
    return {
      total_operations: 0,
      local_operations: 0,
      cloud_operations: 0,
      tokens_saved: 0,
      avg_cache_hit_rate: 0,
      by_provider: {},
      by_operation: {},
    };
  }
  
  const content = fs.readFileSync(AUDIT_PATH, "utf8");
  const lines = content.trim().split("\n").filter(l => l.length > 0);
  
  let localOps = 0;
  let cloudOps = 0;
  let totalTokensSaved = 0;
  let totalCacheHitRate = 0;
  const byProvider = {};
  const byOperation = {};
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      
      // Count local vs cloud
      if (entry.provider === "local" || entry.provider === "cache") {
        localOps++;
      } else {
        cloudOps++;
      }
      
      // Aggregate tokens saved
      totalTokensSaved += entry.tokens_saved || 0;
      totalCacheHitRate += entry.cache_hit_rate || 0;
      
      // By provider
      byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;
      
      // By operation
      byOperation[entry.operation] = (byOperation[entry.operation] || 0) + 1;
    } catch (e) {
      // Skip malformed lines
    }
  }
  
  const totalOps = lines.length;
  const localRate = totalOps > 0 ? (localOps / totalOps) * 100 : 0;
  const avgCacheRate = totalOps > 0 ? (totalCacheHitRate / totalOps) * 100 : 0;
  
  return {
    total_operations: totalOps,
    local_operations: localOps,
    cloud_operations: cloudOps,
    local_operation_rate: localRate,
    tokens_saved: totalTokensSaved,
    avg_cache_hit_rate: avgCacheRate,
    by_provider: byProvider,
    by_operation: byOperation,
    target_local_rate: 90,
    target_met: localRate >= 90,
  };
}

/**
 * Get recent audit entries
 */
function getRecentEntries(limit = 100) {
  ensureAuditFile();
  
  if (!fs.existsSync(AUDIT_PATH)) {
    return [];
  }
  
  const content = fs.readFileSync(AUDIT_PATH, "utf8");
  const lines = content.trim().split("\n").filter(l => l.length > 0);
  
  const entries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(e => e !== null);
  
  // Return last N entries
  return entries.slice(-limit);
}

module.exports = {
  logOperation,
  getAuditStats,
  getRecentEntries,
};
