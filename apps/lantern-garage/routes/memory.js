/**
 * Memory query endpoint — expose Convergence Core Memory.query() to reasoners.
 * Supports: dream-chat, router, kalshi-suggest queries via REST.
 * wq-008: Phase 2 linkage — reasoners can now query persistent memory.
 */

const { spawn } = require("child_process");
const path = require("path");
const { sendJson, collectRequestBody } = require("../lib/http-utils");

/**
 * Execute Python query() against the Memory store.
 * Returns matching MemoryEntry objects as JSON.
 */
async function queryMemory(params) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "..", "..", "..", "src", "convergence", "memory_query.py");
    const args = [
      "--pattern", params.pattern || "",
      "--min-confidence", (params.min_confidence || 0.5).toString(),
      "--limit", (params.limit || 10).toString(),
    ];

    if (params.order_by) {
      args.push("--order-by", params.order_by);
    }
    if (params.source_filter) {
      args.push("--source-filter", params.source_filter);
    }
    if (params.memory_dir) {
      args.push("--memory-dir", params.memory_dir);  // #2081: isolate the store (tests / alt roots)
    }

    const proc = spawn("python", [script, ...args], {
      cwd: path.join(__dirname, "..", "..", ".."),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`Memory query error: ${stderr}`);
        return reject(new Error(`Memory query failed: ${stderr}`));
      }

      try {
        const results = JSON.parse(stdout);
        resolve(results);
      } catch (e) {
        reject(new Error(`Invalid JSON from memory query: ${e.message}`));
      }
    });
  });
}

/**
 * Cache recent queries to reduce Memory.query() latency.
 * TTL: 30s per query (pattern + filters).
 */
const queryCache = new Map();
const CACHE_TTL = 30000;

function getCacheKey(params) {
  return JSON.stringify({
    pattern: params.pattern || "",
    min_confidence: params.min_confidence || 0.5,
    order_by: params.order_by || null,
    source_filter: params.source_filter || null,
    limit: params.limit || 10,
  });
}

async function queryMemoryCached(params) {
  const key = getCacheKey(params);
  const cached = queryCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.results;
  }

  const results = await queryMemory(params);
  queryCache.set(key, { results, timestamp: Date.now() });

  // Auto-clean cache after TTL
  setTimeout(() => queryCache.delete(key), CACHE_TTL);

  return results;
}

/**
 * HTTP Route handler for memory queries.
 * POST /api/memory/query — Query memory with filters and pattern matching
 */
module.exports = async (req, res, url, deps) => {
  const pathname = url.pathname;

  // POST /api/memory/query — Query memory
  if (pathname === "/api/memory/query" && req.method === "POST") {
    try {
      const body = await collectRequestBody(req);
      const params = JSON.parse(body);

      const results = await queryMemoryCached(params);
      sendJson(res, { success: true, results, count: results.length }, 200);
    } catch (error) {
      console.error(`Memory query error: ${error.message}`);
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }

  // GET /api/memory/stats — Cache statistics
  if (pathname === "/api/memory/stats" && req.method === "GET") {
    sendJson(res, {
      success: true,
      cache_size: queryCache.size,
      cache_ttl_ms: CACHE_TTL,
      description: "Memory query cache statistics",
    }, 200);
    return true;
  }

  return false;
};

// #2081: expose the seam's query helpers so reasoners/tests can call the Remember-stage read
// interface directly (the HTTP route stays the primary entry). queryMemory spawns memory_query.py.
module.exports.queryMemory = queryMemory;
module.exports.queryMemoryCached = queryMemoryCached;
