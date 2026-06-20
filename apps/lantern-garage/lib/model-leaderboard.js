/**
 * Model leaderboard routing (PCSF-preferred).
 *
 * Makes the local Ollama model chain LEADERBOARD-DRIVEN instead of static:
 * the best-performing model for a task (by agent-performance compositeScore)
 * is tried first, so the continually-trained local model (OLLAMA_MODEL, e.g.
 * lantern-sigma0-coder-v2) rises to the top of "work / units / tasks" as it
 * proves itself. Falls back to the static chain when there's no signal yet.
 */

const { getTopAgentsForTask, recordAgentCallFromConvergenceReceipt } = require("./agent-performance");

// The continually-trained local coding model. Always a candidate for work.
function preferredLocalModel() {
  return process.env.OLLAMA_MODEL || "lantern-sigma0-coder-v2";
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

  let ranked = [];
  try {
    ranked = await getTopAgentsForTask(taskType, 7, 10); // [{agentId, compositeScore,...}]
  } catch { /* no signal yet — keep static order */ }

  if (!ranked.length) return chain;

  const score = {};
  for (const r of ranked) score[r.agentId] = r.compositeScore;

  // Stable sort: leaderboard-scored models first (desc), unscored keep position.
  return chain
    .map((m, i) => ({ m, i, s: score[m] }))
    .sort((a, b) => {
      if (a.s != null && b.s != null) return b.s - a.s;
      if (a.s != null) return -1;
      if (b.s != null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.m);
}

/**
 * Record a model/provider outcome so the leaderboard learns which is best.
 * agentId = the model OR provider name (so local models and cloud providers
 * rank in the same table). costUsd defaults to 0 (local = $0, boosts score);
 * cloud passes a real cost so the ranking is cost-aware.
 */
function recordModelOutcome(model, taskType, success, latencyMs, costUsd = 0) {
  try {
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
  let ranked = [];
  try { ranked = await getTopAgentsForTask(taskType, 30, 1); } catch { /* no signal */ }
  const score = {};
  for (const r of ranked) score[r.agentId] = r.compositeScore;
  const isCloud = (p) => (cloudSet ? cloudSet.has(String(p).toLowerCase()) : false);
  return (Array.isArray(candidates) ? candidates : [])
    .map((c, i) => {
      const key = c.key || c.model || c.provider;
      const has = score[key] != null;
      return { ...c, key, score: has ? score[key] : (isCloud(c.provider) ? coldCloud : coldLocal), scored: has, _i: i };
    })
    .sort((a, b) => (b.score - a.score) || (a._i - b._i));
}

module.exports = { orderChainByLeaderboard, recordModelOutcome, preferredLocalModel, rankCandidates };
