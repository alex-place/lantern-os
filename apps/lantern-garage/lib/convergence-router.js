/**
 * Convergence Router — Deterministic Tool Routing
 *
 * Maps tool calls to local MCP endpoints, cached patterns, or unisona.ai agents.
 * Avoids external API calls by using convergence IO patterns.
 *
 * Goal: Execute 90% of work locally; Claude/GPT for edge cases only.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const CONVERGENCE_MODEL = path.join(KALSHI_DIR, "convergence-model.json");
const PATTERN_CACHE = path.resolve(__dirname, "../../../.claude/memory/pattern_cache.json");

// Flywheel taxonomy (see caad/architecture flywheel design): classify each route
// outcome by how much "recirculation" it cost.
//   lockup — served from the flywheel (cache/template/deterministic), no recompute
//   stall  — genuinely needs the external model (the only true LLM cost)
//   slip   — everything else: had to recompute fresh or fall back locally
const LOCKUP_SOURCES = new Set([
  "cache", "cache_validated", "template_cache", "deterministic_route"
]);
const STALL_SOURCES = new Set(["needs_llm"]);

class ConvergenceRouter {
  constructor() {
    this.patterns = this.loadPatternCache();
    this.convergenceModel = this.loadConvergenceModel();
    this.metrics = this.freshMetrics();
  }

  /**
   * Initialize the runtime flywheel counters. These measure live routing
   * outcomes (the "~90% local" figure was previously asserted, never counted).
   */
  freshMetrics() {
    return {
      total: 0, lockup: 0, slip: 0, stall: 0,
      bySurface: {},            // surface → {total, lockup, slip, stall}
      since: new Date().toISOString()
    };
  }

  /**
   * Record one route outcome and return the result unchanged. Additive only —
   * it never alters routing behavior, just counts it.
   */
  _emit(result, surface) {
    const src = (result && result.source) || "unknown";
    const klass = LOCKUP_SOURCES.has(src) ? "lockup"
                : STALL_SOURCES.has(src) ? "stall" : "slip";
    const m = this.metrics;
    m.total += 1;
    m[klass] += 1;
    const s = m.bySurface[surface] || (m.bySurface[surface] = { total: 0, lockup: 0, slip: 0, stall: 0 });
    s.total += 1;
    s[klass] += 1;
    return result;
  }

  /**
   * Load pattern cache (learned from prior sessions).
   */
  loadPatternCache() {
    try {
      if (fs.existsSync(PATTERN_CACHE)) {
        return JSON.parse(fs.readFileSync(PATTERN_CACHE, "utf8"));
      }
    } catch (e) {
      console.warn("[ConvergenceRouter] Failed to load pattern cache:", e.message);
    }

    return {
      version: 1,
      marketPatterns: {},       // ticker → {trend, catalyst, confidence, timestamp}
      intentPatterns: {},       // intent_hash → {agent_id, confidence}
      codePatterns: {},         // file_type+scope → {template, tokens_saved}
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Load local convergence model (no API call).
   */
  loadConvergenceModel() {
    try {
      if (fs.existsSync(CONVERGENCE_MODEL)) {
        return JSON.parse(fs.readFileSync(CONVERGENCE_MODEL, "utf8"));
      }
    } catch (e) {
      console.warn("[ConvergenceRouter] Failed to load convergence model");
    }
    return { markets: {}, marketTypes: {} };
  }

  /**
   * Route market search → local cache or mock (no WebSearch API).
   */
  async routeMarketSearch(ticker) {
    // Check cache hit
    if (this.patterns.marketPatterns[ticker]) {
      const cached = this.patterns.marketPatterns[ticker];
      if (Date.now() - new Date(cached.timestamp).getTime() < 3600000) { // 1 hour
        return this._emit({ source: "cache", data: cached }, "market");
      }
    }

    // Fall through to convergence-enhancer mock (no external API)
    return this._emit({ source: "local_mock", data: { trend: "neutral", catalyst: "none" } }, "market");
  }

  /**
   * Route intent → unisona.ai agent (deterministic, 6 personas).
   *
   * Map intent_class → agent_id without calling Claude.
   * Uses regex patterns + keyword scoring.
   *
   * Σ₀ Fix: Validate cached agent against fresh scores to prevent stale routing.
   */
  async routeIntent(message, context = {}) {
    const intentHash = this.hashIntent(message);
    const agents = ["lantern", "blinkbug", "keystone", "waterfall", "xenon", "founder"];
    const scores = this.scoreAgents(message, agents);
    const winner = agents.reduce((a, b) => scores[a] > scores[b] ? a : b);
    const freshConfidence = Math.min(100, scores[winner]);

    // Check cache BUT validate against fresh scores
    if (this.patterns.intentPatterns[intentHash]) {
      const cached = this.patterns.intentPatterns[intentHash];
      const cachedAgentScore = scores[cached.agent_id] || 0;

      // Return cached only if: (1) high confidence AND (2) cached agent still matches fresh scores
      if (cached.confidence > 0.7 && cachedAgentScore >= scores[winner] * 0.8) {
        return this._emit({
          agent: cached.agent_id,
          confidence: cached.confidence,
          source: "cache_validated",
          cacheHit: true
        }, "intent");
      } else if (cached.confidence > 0.7 && cachedAgentScore < scores[winner] * 0.8) {
        // Cache stale: cached agent lost to fresh computation
        return this._emit({
          agent: winner,
          confidence: freshConfidence,
          source: "cache_stale",
          cacheHit: false,
          cachedAgent: cached.agent_id,
          reasonStale: `${cached.agent_id} scored ${cachedAgentScore}, ${winner} scored ${scores[winner]}`
        }, "intent");
      }
    }

    // No cache or cache invalid: use fresh scores
    const result = {
      agent: winner,
      confidence: freshConfidence,
      source: "keystone_routing",
      scores,
      cacheHit: false
    };

    // Update cache with fresh routing
    this.patterns.intentPatterns[intentHash] = {
      agent_id: winner,
      confidence: freshConfidence,
      lastValidated: new Date().toISOString()
    };
    this.savePatternCache();

    return this._emit(result, "intent");
  }

  /**
   * Route code generation → template lookup (avoid LLM call).
   *
   * Instead of calling Claude to generate code, return a cached template
   * that's been used successfully before.
   */
  async routeCodeGeneration(fileType, scope, keywords = []) {
    const patternKey = `${fileType}:${scope}`;

    // Check cache
    if (this.patterns.codePatterns[patternKey]) {
      const cached = this.patterns.codePatterns[patternKey];
      return this._emit({
        source: "template_cache",
        template: cached.template,
        tokensSaved: cached.tokens_saved,
        examples: cached.examples
      }, "code");
    }

    // No cached template — would normally call Claude here
    // For now, return a sentinel indicating LLM call needed
    return this._emit({
      source: "needs_llm",
      fileType,
      scope,
      keywords,
      reason: "Pattern not yet cached; first occurrence"
    }, "code");
  }

  /**
   * Route task → local MCP endpoint or unisona.ai agent.
   *
   * Tasks with known routing go directly to MCP; novel tasks go to unisona.ai.
   */
  async routeTask(taskType, payload) {
    const routes = {
      "market_analysis":           "/api/trading/kalshi/convergence/train",
      "position_monitoring":       "/api/trading/kalshi/monitor/positions",
      "win_rate_check":            "/api/trading/kalshi/winrate-stats",
      "pack_research_tesseract":   "/api/csf/tesseract/pack",
      "unpack_research_tesseract": "/api/csf/tesseract/unpack",
    };

    if (routes[taskType]) {
      return this._emit({ endpoint: routes[taskType], method: "GET", source: "deterministic_route" }, "task");
    }

    // Unknown task → route via unisona.ai for dynamic handling
    return this._emit({
      handler: "keystone_dispatcher",
      source: "dynamic_route",
      taskType,
      payload
    }, "task");
  }

  /**
   * Score how well each agent handles a given message.
   * Deterministic, no LLM call.
   */
  scoreAgents(message, agents) {
    const scores = {};
    const lowerMsg = message.toLowerCase();

    const agentKeywords = {
      lantern: ["dream", "journal", "memory", "freeform"],
      blinkbug: ["debug", "trace", "breakpoint", "log"],
      keystone: ["route", "intent", "classify", "dispatch"],
      waterfall: ["cascade", "flow", "stream", "pipe"],
      xenon: ["signal", "detect", "pattern", "convergence"],
      founder: ["vision", "goal", "plan", "strategic"]
    };

    for (const agent of agents) {
      const keywords = agentKeywords[agent] || [];
      scores[agent] = keywords.reduce((sum, kw) => sum + (lowerMsg.includes(kw) ? 10 : 0), 1);
    }

    return scores;
  }

  /**
   * Generate a deterministic hash for an intent (for caching).
   */
  hashIntent(message) {
    // Simple hash: first 3 words + message length
    const words = message.toLowerCase().split(/\s+/).slice(0, 3).join("_");
    const hash = require("crypto").createHash("md5");
    hash.update(words + "_" + message.length);
    return hash.digest("hex").slice(0, 12);
  }

  /**
   * Save pattern cache to disk.
   */
  savePatternCache() {
    try {
      const dir = path.dirname(PATTERN_CACHE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.patterns.generatedAt = new Date().toISOString();
      fs.writeFileSync(PATTERN_CACHE, JSON.stringify(this.patterns, null, 2), "utf8");
    } catch (e) {
      console.error("[ConvergenceRouter] Failed to save pattern cache:", e.message);
    }
  }

  /**
   * Get routing statistics (for monitoring token efficiency).
   */
  getStats() {
    return {
      cachedMarketPatterns: Object.keys(this.patterns.marketPatterns).length,
      cachedIntentPatterns: Object.keys(this.patterns.intentPatterns).length,
      cachedCodePatterns: Object.keys(this.patterns.codePatterns).length,
      totalCachedRoutes: Object.keys(this.patterns.intentPatterns).length + Object.keys(this.patterns.codePatterns).length,
      generatedAt: this.patterns.generatedAt
    };
  }

  /**
   * Live flywheel metrics — measured, not asserted.
   *
   *   lockupRate   fraction of routes served from the flywheel (no recompute)
   *   slippageRate fraction that had to recompute or fall back locally
   *   stallRate    fraction that genuinely needs the external model
   *
   * Replaces the un-measured "~90% local hit" claim with real counters.
   */
  getFlywheelMetrics() {
    const m = this.metrics;
    const pct = (x) => (m.total ? Math.round((x / m.total) * 1000) / 10 : 0);
    const surfaces = {};
    for (const [name, s] of Object.entries(m.bySurface)) {
      surfaces[name] = {
        total: s.total,
        lockupRate: s.total ? Math.round((s.lockup / s.total) * 1000) / 10 : 0,
        slippageRate: s.total ? Math.round(((s.slip + s.stall) / s.total) * 1000) / 10 : 0
      };
    }
    return {
      total: m.total,
      lockup: m.lockup, slip: m.slip, stall: m.stall,
      lockupRate: pct(m.lockup),
      slippageRate: pct(m.slip + m.stall),
      stallRate: pct(m.stall),
      bySurface: surfaces,
      since: m.since
    };
  }

  /** Reset the live counters (e.g. per measurement window). */
  resetFlywheelMetrics() {
    this.metrics = this.freshMetrics();
  }
}

let router = null;

function getRouter() {
  if (!router) {
    router = new ConvergenceRouter();
  }
  return router;
}

module.exports = {
  getRouter,
  ConvergenceRouter
};
