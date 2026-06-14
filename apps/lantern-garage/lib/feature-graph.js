/**
 * feature-graph.js — FeatureNode model and PCSF-driven activation evaluator.
 *
 * Each feature is a graph node with activation conditions:
 *   flag:          static on/off gate (env or config)
 *   minHealth:     minimum provider health required (0–1)
 *   maxLatencyMs:  maximum acceptable provider latency
 *   devOnly:       only activate in development mode
 *
 * PCSF.evaluate(features, systemState) → activeFeatureIds
 *
 * Feature Graph Schema (FGS):
 * {
 *   id:             string,   // unique feature identifier
 *   label:          string,   // human-readable name
 *   href:           string,   // navigation target (optional)
 *   icon:           string,   // emoji or icon class
 *   activation: {
 *     flag:         string,   // env var name — truthy value enables
 *     minHealth:    number,   // 0.0–1.0
 *     maxLatencyMs: number,
 *     devOnly:      boolean,
 *   },
 *   implementation: string,   // hot-swap implementation id
 *   priority:       number,   // lower = higher priority
 * }
 */

"use strict";

// ── Default feature registry ───────────────────────────────────────────────────

const DEFAULT_FEATURES = [
  {
    id: "dream-journal",
    label: "Dream Journal",
    href: "/dream-chat.html",
    icon: "🌙",
    activation: { flag: null, minHealth: 0.0, maxLatencyMs: 60000, devOnly: false },
    implementation: "dream-journal-v1",
    priority: 1,
  },
  {
    id: "panels",
    label: "Agent Panels",
    href: "/operations.html",
    icon: "⚙️",
    activation: { flag: "PANELS_ENABLED", minHealth: 0.5, maxLatencyMs: 5000, devOnly: true },
    implementation: "panels-v1",
    priority: 10,
  },
  {
    id: "cockpit",
    label: "Cockpit",
    href: "/cockpit.html",
    icon: "🚀",
    activation: { flag: "COCKPIT_ENABLED", minHealth: 0.7, maxLatencyMs: 3000, devOnly: false },
    implementation: "cockpit-v1",
    priority: 5,
  },
  {
    id: "trading",
    label: "Trading",
    href: "/trading.html",
    icon: "📈",
    activation: { flag: "TRADING_ENABLED", minHealth: 0.3, maxLatencyMs: 10000, devOnly: false },
    implementation: "trading-v1",
    priority: 8,
  },
  {
    id: "flourishing",
    label: "Flourishing",
    href: "/flourishing.html",
    icon: "🌱",
    activation: { flag: "HFF_ENABLED", minHealth: 0.0, maxLatencyMs: 60000, devOnly: false },
    implementation: "hff-v1",
    priority: 7,
  },
  {
    id: "debug",
    label: "Debug View",
    href: "/debug.html",
    icon: "🔬",
    activation: { flag: "DEBUG_ENABLED", minHealth: 0.0, maxLatencyMs: 60000, devOnly: true },
    implementation: "debug-v1",
    priority: 20,
  },
];

// ── System state builder ───────────────────────────────────────────────────────

/**
 * Build a minimal SystemState from environment and optional PCSF data.
 * @returns {{ health: number, latencyMs: number, isDev: boolean, flags: Object }}
 */
function buildSystemState() {
  const isDev = process.env.NODE_ENV !== "production";
  const health = parseFloat(process.env.PROVIDER_HEALTH || "1.0");
  const latencyMs = parseFloat(process.env.PROVIDER_LATENCY_MS || "500");

  // Read feature flags from environment
  const flags = {};
  for (const f of DEFAULT_FEATURES) {
    if (f.activation.flag) {
      flags[f.activation.flag] = !!(
        process.env[f.activation.flag] === "true" ||
        process.env[f.activation.flag] === "1"
      );
    }
  }

  return { health, latencyMs, isDev, flags };
}

// ── PCSF evaluator ─────────────────────────────────────────────────────────────

/**
 * Evaluate which features are active given the system state.
 *
 * Activation requires ALL conditions to pass:
 *   1. flag gate: if flag defined, env[flag] must be truthy
 *   2. health gate: systemState.health >= minHealth
 *   3. latency gate: systemState.latencyMs <= maxLatencyMs
 *   4. dev gate: if devOnly=true, must be in dev mode
 *
 * @param {Array} features - feature registry
 * @param {Object} systemState - { health, latencyMs, isDev, flags }
 * @returns {Array} active features with state="active"|"inactive"
 */
function evaluateFeatures(features, systemState) {
  return features
    .sort((a, b) => a.priority - b.priority)
    .map((f) => {
      const act = f.activation || {};
      let active = true;
      let reason = null;

      if (act.flag && !systemState.flags[act.flag]) {
        active = false;
        reason = `flag ${act.flag} not set`;
      } else if (systemState.health < (act.minHealth || 0)) {
        active = false;
        reason = `health ${systemState.health.toFixed(2)} < min ${act.minHealth}`;
      } else if (systemState.latencyMs > (act.maxLatencyMs || 60000)) {
        active = false;
        reason = `latency ${systemState.latencyMs}ms > max ${act.maxLatencyMs}ms`;
      } else if (act.devOnly && !systemState.isDev) {
        active = false;
        reason = "devOnly — not in dev mode";
      }

      return {
        ...f,
        state: active ? "active" : "inactive",
        reason: active ? null : reason,
      };
    });
}

// ── Hot-swap registry ─────────────────────────────────────────────────────────

/**
 * In-memory hot-swap registry.
 * Maps implementation id → handler function or metadata.
 * σ: old_impl → new_impl without page reload.
 */
const _swapRegistry = new Map();

function registerImplementation(id, handler) {
  _swapRegistry.set(id, { id, handler, registeredAt: Date.now() });
}

function getImplementation(id) {
  return _swapRegistry.get(id) || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_FEATURES,
  buildSystemState,
  evaluateFeatures,
  registerImplementation,
  getImplementation,
};
