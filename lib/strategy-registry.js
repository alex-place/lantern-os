"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const REGISTRY_FILE = path.join(repoRoot, "data", "csf_memory", "strategy-registry.json");

// Default registry: known strategy versions
const DEFAULT_REGISTRY = {
  strategies: [
    {
      strategy_id: "2026-06-10-conviction-v3",
      commit_hash: "f2b97bd",
      status: "active",
      regime_tags: ["Conviction_Trend", "Reversion"],
      created_at: "2026-06-10T00:00:00Z",
      description: "Conviction-based entry scoring with regime awareness",
    },
    {
      strategy_id: "2026-06-12-decisive-deck-v1",
      commit_hash: "c59ac39",
      status: "active",
      regime_tags: ["Conviction_Trend", "Shock"],
      created_at: "2026-06-12T00:00:00Z",
      description: "Consolidated one-action-per-market with time weighting",
    },
  ],
};

/**
 * Load strategy registry from disk, or create default
 */
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      const content = fs.readFileSync(REGISTRY_FILE, "utf8");
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn("[StrategyRegistry] Failed to load registry:", error.message);
  }

  // Return default and save it
  saveRegistry(DEFAULT_REGISTRY);
  return DEFAULT_REGISTRY;
}

/**
 * Save registry to disk
 */
function saveRegistry(registry) {
  try {
    const dir = path.dirname(REGISTRY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("[StrategyRegistry] Failed to save registry:", error.message);
    return false;
  }
}

/**
 * Register a new strategy
 *
 * @param {Object} strategy
 *   - strategy_id (e.g. "2026-06-14-model-v1")
 *   - commit_hash (git SHA)
 *   - status ("active" | "retired" | "elite")
 *   - regime_tags (array of regimes this strategy works in)
 *   - description (optional)
 */
function registerStrategy(strategy) {
  const registry = loadRegistry();

  // Check if already exists
  const existing = registry.strategies.find(s => s.strategy_id === strategy.strategy_id);
  if (existing) {
    console.warn(`[StrategyRegistry] Strategy ${strategy.strategy_id} already registered`);
    return existing;
  }

  // Add with defaults
  const newStrategy = {
    strategy_id: strategy.strategy_id,
    commit_hash: strategy.commit_hash,
    status: strategy.status || "active",
    regime_tags: strategy.regime_tags || [],
    created_at: strategy.created_at || new Date().toISOString(),
    description: strategy.description || "",
  };

  registry.strategies.push(newStrategy);
  saveRegistry(registry);
  return newStrategy;
}

/**
 * Get all active strategies
 */
function getActiveStrategies() {
  const registry = loadRegistry();
  return registry.strategies.filter(s => s.status === "active");
}

/**
 * Get strategies for a specific regime
 */
function getStrategiesForRegime(regime) {
  const registry = loadRegistry();
  return registry.strategies.filter(
    s => s.status === "active" && (s.regime_tags.length === 0 || s.regime_tags.includes(regime))
  );
}

/**
 * Update strategy status
 */
function updateStrategyStatus(strategy_id, newStatus) {
  const registry = loadRegistry();
  const strategy = registry.strategies.find(s => s.strategy_id === strategy_id);

  if (!strategy) {
    console.warn(`[StrategyRegistry] Strategy ${strategy_id} not found`);
    return null;
  }

  strategy.status = newStatus;
  saveRegistry(registry);
  return strategy;
}

/**
 * Get strategy by ID
 */
function getStrategy(strategy_id) {
  const registry = loadRegistry();
  return registry.strategies.find(s => s.strategy_id === strategy_id);
}

module.exports = {
  loadRegistry,
  saveRegistry,
  registerStrategy,
  getActiveStrategies,
  getStrategiesForRegime,
  updateStrategyStatus,
  getStrategy,
};
