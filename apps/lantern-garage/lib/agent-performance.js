/**
 * Agent Performance Tracking
 * Measures which agents perform best on which task types
 * Uses real Convergence loop receipts as training data (no separate benchmarks)
 */

const fs = require("fs");
const path = require("path");
const { appendJsonlQueued, readJsonl } = require("./file-queue");

const AGENT_PERF_PATH = path.resolve(__dirname, "..", "..", "data", "agent-performance.jsonl");
const AGENT_PERF_REL_PATH = "apps/data/agent-performance.jsonl"; // Relative path for readJsonl (from repo root)
const LOOKBACK_DAYS = 7;

// In-memory cache of agent performance (loaded from JSONL)
const _performanceCache = {}; // {agentId_taskType: {successRate, latency, cost, trend, ...}}
let _cacheLoadedAt = 0;

/**
 * Record an agent call from a Convergence receipt
 * Called after a convergence step completes
 * @param {object} receipt - Step receipt from convergence_io_engine.py
 * @param {string} agentId - Which agent performed this step
 * @param {string} taskType - "repo_inspection"|"source_scout"|"manifest_reader"|etc.
 * @param {boolean} validationPassed - Did convergence validation pass?
 * @param {number} latencyMs - How long did the step take?
 * @param {number} costUsd - Cost of LLM call (from provider-router logs)
 */
async function recordAgentCallFromConvergenceReceipt(
  receipt,
  agentId,
  taskType,
  validationPassed,
  latencyMs,
  costUsd
) {
  const entry = {
    timestamp: new Date().toISOString(),
    agentId,
    taskType,
    success: validationPassed, // Binary: validation pass = success
    latencyMs,
    costUsd,
    convergenceStep: receipt.step,
    convergenceStepName: receipt.stepName,
  };

  try {
    await appendJsonlQueued(AGENT_PERF_PATH, entry, { rotate: true }); // #872
    // Invalidate cache so next query reloads
    _cacheLoadedAt = 0;
  } catch (err) {
    console.error("[agent-performance] Failed to record call:", err.message);
  }
}

/**
 * Get top-performing agents for a task type (sorted by composite score)
 * Composite score = (successRate * qualityImplied) / (latency * cost)
 * @param {string} taskType - Task type to rank for
 * @param {number} lookbackDays - How far back to look (default 7)
 * @param {number} limit - Max results to return
 * @returns {Promise<Array>} [{agentId, successRate, latencyMs, costUsd, calls, trend}, ...]
 */
async function getTopAgentsForTask(taskType, lookbackDays = LOOKBACK_DAYS, limit = 3) {
  // Load performance data if not cached
  if (Date.now() - _cacheLoadedAt > 60_000) {
    await _loadPerformanceCache();
  }

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  // taskType "all"/"*"/empty aggregates across every task type.
  const matchAll = !taskType || taskType === "all" || taskType === "*";

  // Aggregate stats per agent. Group by the record's own agentId/taskType fields
  // rather than parsing the joined cache key — agentIds and taskTypes can both
  // contain underscores (e.g. "dream_chat", "…Q4_K_M"), which broke key splitting.
  const agentStats = {};

  for (const calls of Object.values(_performanceCache)) {
    for (const call of calls) {
      if (!matchAll && call.taskType !== taskType) continue;
      if (new Date(call.timestamp).getTime() < cutoff) continue;

      const agentId = call.agentId || "unknown";
      if (!agentStats[agentId]) {
        agentStats[agentId] = { successes: 0, totalCalls: 0, totalLatency: 0, totalCost: 0, calls: [] };
      }
      agentStats[agentId].totalCalls++;
      agentStats[agentId].totalLatency += call.latencyMs || 0;
      agentStats[agentId].totalCost += call.costUsd || 0;
      if (call.success) agentStats[agentId].successes++;
      agentStats[agentId].calls.push(call);
    }
  }

  // Compute scores
  const scored = Object.entries(agentStats)
    .filter(([_, stats]) => stats.totalCalls >= 3) // Minimum sample size
    .map(([agentId, stats]) => {
      const successRate = stats.successes / stats.totalCalls;
      const avgLatency = stats.totalLatency / stats.totalCalls;
      const avgCost = stats.totalCost / stats.totalCalls;
      const compositeScore = (successRate * 10) / (Math.max(avgLatency / 1000, 0.1) * (avgCost + 0.01));

      return {
        agentId,
        successRate: Math.round(successRate * 100) / 100,
        avgLatencyMs: Math.round(avgLatency),
        avgCostUsd: Math.round(avgCost * 10000) / 10000,
        totalCalls: stats.totalCalls,
        trend: _computeTrend(stats.calls),
        compositeScore,
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, limit);

  return scored;
}

/**
 * Adjust agent parameters based on convergence feedback
 * Conservative: only adjust if feedback is consistent (3+ occurrences)
 * @param {string} agentId
 * @param {string} taskType
 * @param {string} feedback - "too_verbose"|"hallucinating"|"too_brief"|"slow"|"fast"
 */
async function adjustParametersBasedOnFeedback(agentId, taskType, feedback) {
  // Load current params (from future agent-performance record)
  const key = `${agentId}_${taskType}`;
  const calls = _performanceCache[key] || [];

  // Count feedback occurrences in last 3 days
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const recentFeedback = calls.filter(
    (c) => c.feedback === feedback && new Date(c.timestamp) > new Date(cutoff)
  );

  // Only adjust if 3+ consistent feedback signals
  if (recentFeedback.length < 3) {
    return null; // Not enough data
  }

  // Compute parameter adjustments
  const adjustments = {};
  switch (feedback) {
    case "hallucinating":
      adjustments.temperature = Math.max(0.1, 0.7 - 0.1); // Assume default 0.7
      break;
    case "too_verbose":
      adjustments.maxTokens = Math.floor((2048 * 0.85) / 100) * 100; // Round to nearest 100
      break;
    case "too_brief":
      adjustments.maxTokens = Math.ceil((2048 * 1.15) / 100) * 100;
      break;
    case "slow":
      adjustments.temperature = Math.min(1.0, 0.7 + 0.1);
      adjustments.topP = Math.max(0.8, 0.95 - 0.05);
      break;
  }

  // Log adjustment (would be persisted in real implementation)
  console.log(`[agent-performance] Adjusted ${agentId} for ${feedback}:`, adjustments);
  return adjustments;
}

/**
 * Mark an agent as retired for a task type
 * @param {string} agentId
 * @param {string} taskType
 * @param {string} reason - "beaten_by_newer_model"|"repeated_failures"|"cost_too_high"
 */
async function retireAgent(agentId, taskType, reason) {
  const entry = {
    timestamp: new Date().toISOString(),
    agentId,
    taskType,
    action: "retire",
    reason,
  };

  try {
    await appendJsonlQueued(AGENT_PERF_PATH, entry, { rotate: true }); // #872
    _cacheLoadedAt = 0; // Invalidate cache
    console.log(`[agent-performance] Retired ${agentId} for ${taskType}: ${reason}`);
  } catch (err) {
    console.error("[agent-performance] Failed to record retirement:", err.message);
  }
}

/**
 * Load performance data from JSONL into cache
 * @private
 */
async function _loadPerformanceCache() {
  try {
    // readJsonl expects a relative path and loads from repo root
    const records = readJsonl(AGENT_PERF_REL_PATH, 1000) || [];

    // Clear cache before loading
    Object.keys(_performanceCache).forEach(k => delete _performanceCache[k]);

    for (const record of records) {
      if (record.parseError) continue; // Skip parsing errors
      const key = `${record.taskType}_${record.agentId}`;
      if (!_performanceCache[key]) {
        _performanceCache[key] = [];
      }
      _performanceCache[key].push(record);
    }
    _cacheLoadedAt = Date.now();
    console.log(`[agent-performance] Loaded cache: ${Object.keys(_performanceCache).length} agent-task combinations, ${records.length} total records`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[agent-performance] Failed to load cache:", err.message);
    }
    _cacheLoadedAt = Date.now();
  }
}

/**
 * Compute trend (improving|stable|declining) over last 7 days
 * @private
 */
function _computeTrend(calls) {
  if (calls.length < 2) return "unknown";

  const sorted = calls.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const mid = Math.floor(sorted.length / 2);

  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);

  const sr1 = firstHalf.filter((c) => c.success).length / firstHalf.length;
  const sr2 = secondHalf.filter((c) => c.success).length / secondHalf.length;

  if (sr2 > sr1 + 0.1) return "improving";
  if (sr2 < sr1 - 0.1) return "declining";
  return "stable";
}

module.exports = {
  recordAgentCallFromConvergenceReceipt,
  getTopAgentsForTask,
  adjustParametersBasedOnFeedback,
  retireAgent,
};
