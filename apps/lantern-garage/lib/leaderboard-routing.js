"use strict";
// Global leaderboard routing (PCSF, cloud + local) + Ouro loss-training capture.
//
// The PCSF leaderboard (model-leaderboard.js) historically ranked only LOCAL
// Ollama models. This makes it GLOBAL: cloud providers compete in the same
// compositeScore ranking, so "Auto" picks the best provider on merit — and when
// the local Ouro model LOSES (cloud is preferred or local fails), we capture the
// turn as distillation training data so Ouro can learn why it lost.
//
// All of this is gated by LEADERBOARD_ROUTING=1 at the call sites; this module is
// pure helpers and writes only append-only JSONL.

const path = require("path");
const { appendJsonlQueued } = require("./file-queue");
const { recordModelOutcome } = require("./model-leaderboard");

const LOSS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "convergence", "ouro-losses.jsonl");
// Flat per-call cost signal for cloud so $0 local stays advantaged unless cloud
// clearly wins on quality (compositeScore is cost-aware). Override per env.
const CLOUD_FLAT_COST_USD = Number(process.env.CLOUD_FLAT_COST_USD || 0.01);

const CLOUD_PROVIDERS = new Set([
  "gemini", "anthropic", "openai", "xai", "mistral", "cohere", "deepseek", "perplexity", "openrouter",
]);

function isCloudProvider(provider) {
  return CLOUD_PROVIDERS.has(String(provider || "").toLowerCase());
}

/**
 * Record a provider outcome into the SAME leaderboard the local models use.
 * Cloud carries a flat cost so the leaderboard is cost-aware; local stays $0.
 */
function recordProviderOutcome(provider, taskType, success, latencyMs) {
  const cost = isCloudProvider(provider) ? CLOUD_FLAT_COST_USD : 0;
  try {
    return recordModelOutcome(provider, taskType || "default", !!success, latencyMs || 0, cost);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Capture an Ouro "loss": a cloud provider answered a turn the local model was
 * skipped on (leaderboard outscored it) or failed. The winner's reply is the
 * distillation target — (prompt -> better answer) pairs to train Ouro on why it
 * lost. Append-only; never throws.
 */
async function recordOuroLoss(entry) {
  try {
    await appendJsonlQueued(LOSS_PATH, {
      timestamp: new Date().toISOString(),
      task_type: entry.taskType || "default",
      prompt: String(entry.prompt || "").slice(0, 2000),
      local_model: entry.localModel || null,
      local_reply: entry.localReply != null ? String(entry.localReply).slice(0, 2000) : null,
      winner_provider: entry.winnerProvider || null,
      winner_model: entry.winnerModel || entry.winnerProvider || null,
      winner_reply: String(entry.winnerReply || "").slice(0, 4000),
      reason: entry.reason || "cloud_preferred",
    }, { rotate: true }); // #872
  } catch {
    /* non-fatal */
  }
}

module.exports = { recordProviderOutcome, recordOuroLoss, isCloudProvider, CLOUD_PROVIDERS, LOSS_PATH };
