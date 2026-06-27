/**
 * Generalized PCSF leaderboard for multi-domain ranking.
 *
 * Supports multi-key candidate selection, time-decay outcome weighting, and
 * domain-scoped (per-user/per-domain) leaderboard namespacing. Shared core
 * used by feed exploration and model routing to rank candidates consistently.
 *
 * Domains: "feed" (explore-feed.js), "model-routing" (provider-routing.js).
 * Each domain can configure its own cold-start priors and candidate sets.
 */

const { getTopAgentsForTask, recordAgentCallFromConvergenceReceipt } = require("./agent-performance");

// The local coding model — always a candidate for work. Defaults to the Σ₀ Ouro
// looped coder (ouro:latest on :11434). The legacy Qwen `lantern-sigma0-coder-v2`
// is DEPRECATED (Ollama sunset #811/#823); ouro_serve still accepts that name for
// back-compat, but new routing prefers ouro:latest. Override with OLLAMA_MODEL.

/**
 * Domain-scoped leaderboard state: {[domain]: {[scope]: {[key]: {score, decay, outcomes}}}}.
 * domain = "feed" or "model-routing" (or custom).
 * scope = per-user/per-domain namespace (e.g., userId, feedId, or "global").
 * key = candidate identifier (model name, provider name, or custom key).
 * Enables feed and routing to maintain separate rankings while sharing core logic.
 */
const domainLeaderboards = {};

/**
 * Initialize or get a domain leaderboard scope.
 */
function getDomainScope(domain, scope = "global") {
  if (!domainLeaderboards[domain]) domainLeaderboards[domain] = {};
  if (!domainLeaderboards[domain][scope]) domainLeaderboards[domain][scope] = {};
  return domainLeaderboards[domain][scope];
}

/**
 * Clear a domain scope (for testing or reset).
 */
function clearDomainScope(domain, scope = "global") {
  if (domainLeaderboards[domain]) delete domainLeaderboards[domain][scope];
}

function preferredLocalModel() {
  return process.env.OLLAMA_MODEL || "ouro:latest";
}

// ── Bounded scoring constants ────────────────────────────────────────────────
// compositeScore is a WIN RATE in [0,1], never an unbounded accumulator. A
// repeatedly-engaged source converges to 1.0 instead of climbing forever (the
// source:Flourishing→10000 bug, #1315 follow-up).
//
// PRIOR_* implement Laplace smoothing toward the 0.5 cold prior: with no
// evidence the score IS 0.5 (matches the cold-start prior in rankCandidates), so
// a single click/dwell nudges a source up rather than saturating it to 1.0, and a
// single dismiss nudges down rather than nuking it to 0.0.
const PRIOR_MEAN = 0.5;   // the cold prior every unscored candidate starts at
const PRIOR_WEIGHT = 1;   // pseudo-observations of that prior (smoothing strength)
// Per-call average cost (USD) is subtracted so cheaper candidates rank above
// equally-reliable expensive ones. Bounded because it multiplies the per-call
// MEAN cost, not a running SUM (the old `totalCost * 0.1` grew without limit).
// Local models ($0) pay nothing; cloud pays a small, bounded penalty.
const COST_PENALTY = 0.5;
// Raw outcomes are kept only as a bounded debug tail — the score is derived from
// O(1) running aggregates, so the array never needs to grow with traffic.
const MAX_OUTCOMES = 50;

/**
 * Record an outcome with optional time-decay weighting.
 * domain = "feed" or "model-routing" (or custom).
 * scope = per-user/per-domain namespace (e.g., userId, feedId, or "global").
 * key = candidate identifier.
 * success = boolean outcome.
 * latencyMs, costUsd = optional metrics for compositeScore.
 * decayFactor = recency retention (0..1, default 1.0). 1.0 = a plain win rate over
 *   all outcomes; <1 exponentially down-weights older outcomes (recency-weighted).
 *
 * Score is a Laplace-smoothed, decay-weighted win rate in [0,1] minus a bounded
 * per-call cost penalty — NOT a raw success count. Bounded by construction:
 * successes/total can never exceed 1, so repeated wins converge to 1.0.
 */
function recordOutcomeWithDecay(domain, scope, key, success, latencyMs = 0, costUsd = 0, decayFactor = 1.0) {
  const domainScope = getDomainScope(domain, scope);
  if (!domainScope[key]) {
    // wSuccess/wTotal/wCost are decay-weighted running aggregates; score is the
    // bounded win rate derived from them on every update.
    domainScope[key] = { score: PRIOR_MEAN, decay: 1.0, wSuccess: 0, wTotal: 0, wCost: 0, outcomes: [] };
  }
  const entry = domainScope[key];

  // retain ∈ [0,1]: how much prior evidence survives this update. With retain=1
  // (the default) wTotal is the plain outcome count; with retain<1 older outcomes
  // decay geometrically. Either way winRate = wSuccess/wTotal stays in [0,1].
  const retain = Math.max(0, Math.min(1, decayFactor));
  entry.wSuccess = entry.wSuccess * retain + (success ? 1 : 0);
  entry.wTotal = entry.wTotal * retain + 1;
  entry.wCost = entry.wCost * retain + Math.max(0, costUsd || 0);
  entry.decay = Math.max(0, Math.min(1, entry.decay * decayFactor));

  // Laplace-smoothed win rate toward the 0.5 cold prior, minus a bounded per-call
  // cost penalty. Clamped to [0,1] so the score can never run away.
  const winRate = (entry.wSuccess + PRIOR_MEAN * PRIOR_WEIGHT) / (entry.wTotal + PRIOR_WEIGHT);
  const avgCost = entry.wTotal > 0 ? entry.wCost / entry.wTotal : 0;
  entry.score = Math.max(0, Math.min(1, winRate - avgCost * COST_PENALTY));

  // Bounded debug tail only — trim oldest so memory never grows with traffic.
  entry.outcomes.push({ success, latencyMs, costUsd, timestamp: Date.now() });
  if (entry.outcomes.length > MAX_OUTCOMES) entry.outcomes.splice(0, entry.outcomes.length - MAX_OUTCOMES);
  return entry;
}

/**
 * Rank candidates by domain-scoped leaderboard score.
 * candidates = [{key, ...}, ...] or [{provider, model, key?}, ...].
 * domain = "feed" or "model-routing".
 * scope = per-user/per-domain namespace.
 * opts = {coldStart, cloudSet, taskType} for cold-start priors and filtering.
 * Returns candidates sorted best-first with {score, scored, decay} annotated.
 */
async function rankCandidatesByDomain(candidates, domain, scope = "global", opts = {}) {
  const { coldStart = 0.5, cloudSet = null, taskType = "default" } = opts;
  const domainScope = getDomainScope(domain, scope);

  // Also check agent-performance leaderboard for fallback/bootstrap.
  let agentScores = {};
  try {
    const ranked = await getTopAgentsForTask(taskType, 30, 1);
    // Use the bounded successRate (∈ [0,1]) as the cold/restart fallback prior,
    // NOT the raw compositeScore. compositeScore is an unbounded latency/cost-
    // weighted metric — a fast, free, always-successful source scores
    // (1.0 * 10) / (0.1 * 0.01) = 10000 — on a completely different scale from the
    // in-memory win rate and the 0.5 cold prior. Sorting them in the same
    // comparison let one agent-performance row blow the feed out (the live
    // source:Flourishing=10000). successRate is the same [0,1] win-rate scale, so
    // the fallback ranks comparably. Clamp defensively.
    for (const r of ranked) {
      const s = typeof r.successRate === "number" ? r.successRate : r.compositeScore;
      agentScores[r.agentId] = Math.max(0, Math.min(1, s));
    }
  } catch { /* no signal */ }

  return (Array.isArray(candidates) ? candidates : [])
    .map((c, i) => {
      const key = c.key || c.model || c.provider || String(c);
      const domainEntry = domainScope[key];
      const agentScore = agentScores[key];
      const has = domainEntry || agentScore != null;
      const score = domainEntry ? domainEntry.score : (agentScore != null ? agentScore : coldStart);
      const decay = domainEntry ? domainEntry.decay : 1.0;
      return { ...c, key, score, decay, scored: has, _i: i };
    })
    .sort((a, b) => (b.score - a.score) || (a._i - b._i));
}

/**
 * Order a static Ollama model chain by leaderboard rank for this task.
 * Models with leaderboard wins come first (best compositeScore first); the
 * rest keep their static order. The preferred local model is guaranteed to be
 * a candidate (prepended for coding/work tasks if absent).
 */
async function orderChainByLeaderboard(staticChain, taskType) {
  const chain = Array.isArray(staticChain) ? [...staticChain] : [];
  const pref = preferredLocalModel();

  // Guarantee the trained local model is in the running for coding/work tasks.
  const workish = ["coding", "reasoning", "default", "repo", "task"].some((t) => String(taskType || "").includes(t));
  if (workish && !chain.includes(pref)) chain.unshift(pref);

  // Use model-routing domain with global scope for backward compatibility.
  const ranked = await rankCandidatesByDomain(
    chain.map((m) => ({ key: m })),
    "model-routing",
    "global",
    { taskType }
  );
  return ranked.map((r) => r.key);
}

/**
 * Record a model/provider outcome so the leaderboard learns which is best.
 * agentId = the model OR provider name (so local models and cloud providers
 * rank in the same table). costUsd defaults to 0 (local = $0, boosts score);
 * cloud passes a real cost so the ranking is cost-aware.
 */
function recordModelOutcome(model, taskType, success, latencyMs, costUsd = 0) {
  try {
    // Record to domain leaderboard (model-routing, global scope).
    recordOutcomeWithDecay("model-routing", "global", model, success, latencyMs, costUsd, 1.0);
    // Also record to agent-performance for backward compatibility.
    return recordAgentCallFromConvergenceReceipt(
      { source: "chat", model },
      model,                      // agentId = the model/provider name
      taskType || "default",
      !!success,                  // validationPassed
      latencyMs || 0,
      costUsd || 0,
    );
  } catch (e) {
    return Promise.resolve();
  }
}

/**
 * Rank a global candidate set (local models + cloud providers) by leaderboard
 * compositeScore for this task. Each candidate is {provider, model, key?} — key
 * is the leaderboard agentId to score by (defaults to model, then provider).
 * Unscored candidates get a cold-start prior (cloud slightly above local so it
 * is explored, generating the comparison data; real scores then take over).
 * Returns the candidates sorted best-first with {score, scored} annotated.
 */
async function rankCandidates(candidates, taskType, opts = {}) {
  const { coldCloud = 0.6, coldLocal = 0.5, cloudSet = null } = opts;
  // Delegate to domain-scoped ranking with model-routing domain, global scope.
  const ranked = await rankCandidatesByDomain(candidates, "model-routing", "global", {
    coldStart: coldLocal,
    cloudSet,
    taskType,
  });
  // Adjust cold-start for cloud if cloudSet provided.
  if (cloudSet) {
    for (const r of ranked) {
      if (!r.scored && cloudSet.has(String(r.provider).toLowerCase())) {
        r.score = coldCloud;
      }
    }
  }
  return ranked;
}

module.exports = {
  orderChainByLeaderboard,
  recordModelOutcome,
  preferredLocalModel,
  rankCandidates,
  rankCandidatesByDomain,
  recordOutcomeWithDecay,
  getDomainScope,
  clearDomainScope,
};
