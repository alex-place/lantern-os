"use strict";

/**
 * Loop Reasoner — Sigma 0 implementation of looped LLM reasoning.
 *
 * Inspired by:
 *   [1] "Scaling Latent Reasoning via Looped Language Models" (Ouro, arXiv 2510.25741)
 *       — weight-shared looped transformer with entropy-regularized adaptive exit.
 *   [2] "Training LLMs to Reason in a Continuous Latent Space" (Coconut, arXiv 2412.06769)
 *       — continuous thought: last hidden state feeds back as next input embedding,
 *         enabling BFS-like latent search instead of greedy CoT.
 *
 * Our API-level replication:
 *   Each "loop" passes the previous response back as a structured context prefix so the
 *   LLM can refine its answer without generating a new chain-of-thought from scratch.
 *   The entropy-based exit condition from Ouro is approximated by tracking how much the
 *   confidence and claim change across loops — low delta = converged = exit.
 *
 * CDF exit (mimicking Ouro's exit gate):
 *   We model confidence as a CDF over loop depth.  Exit when:
 *     (a) confidence >= CDF_THRESHOLD  (sufficient certainty reached), or
 *     (b) |Δconfidence| < CONVERGENCE_EPS  (confidence has plateaued), or
 *     (c) loop_n >= MAX_LOOPS  (compute budget exhausted).
 *
 * Usage:
 *   const { loopedReason, cdfExit } = require('./loop-reasoner');
 *   const result = await loopedReason({ prompt, callLLM, maxLoops: 3 });
 *   // result: { reply, loop_n, confidence, exit_reason, history }
 */

const MAX_LOOPS = 4;          // Ouro r4 uses 4 recurrent steps
const CDF_THRESHOLD = 0.85;   // exit when confidence ≥ this
const CONVERGENCE_EPS = 0.04; // exit when Δconfidence < this (plateaued)

// ── CDF-based exit condition ────────────────────────────────────────────────
// confidenceHistory: float[] of confidence values across loop iterations.
// Returns {exit, loop_n, confidence, reason}.
function cdfExit(confidenceHistory, threshold = CDF_THRESHOLD, maxLoops = MAX_LOOPS) {
  const n = confidenceHistory.length;
  if (!n) return { exit: false, loop_n: 0, confidence: 0, reason: "no_data" };

  const latest = confidenceHistory[n - 1];

  // (a) threshold met
  if (latest >= threshold)
    return { exit: true, loop_n: n, confidence: latest, reason: "threshold_met" };

  // (b) convergence: Δ between last two loops is tiny — like Ouro's entropy plateau
  if (n >= 2) {
    const delta = Math.abs(latest - confidenceHistory[n - 2]);
    if (delta < CONVERGENCE_EPS)
      return { exit: true, loop_n: n, confidence: latest, reason: "converged" };
  }

  // (c) compute budget (honors the caller's maxLoops, not just the module default)
  if (n >= maxLoops)
    return { exit: true, loop_n: n, confidence: latest, reason: "max_loops" };

  return { exit: false, loop_n: n, confidence: latest, reason: "continuing" };
}

// ── Confidence extraction ───────────────────────────────────────────────────
// Parse a Confidence: field from the coder-gate output contract, or estimate
// from structural signals (presence of evidence, claim clarity).
function extractConfidence(text) {
  if (!text) return 0.3;
  const pct = text.match(/Confidence:\s*(\d+(?:\.\d+)?)\s*%/i);
  if (pct) return Math.min(1, parseFloat(pct[1]) / 100);
  const dec = text.match(/Confidence:\s*(0?\.\d+|\d+(?:\.\d+)?)/i);
  if (dec) {
    const v = parseFloat(dec[1]);
    return Math.min(1, v > 1 ? v / 100 : v);
  }
  // Heuristic: count structural evidence markers
  const signals = [
    /Evidence:/i.test(text),
    /Source:/i.test(text),
    /Verification:/i.test(text),
    text.length > 200,
    /\d/.test(text),
  ].filter(Boolean).length;
  return 0.3 + signals * 0.1;
}

// ── Latent context prefix (Coconut-inspired) ────────────────────────────────
// Condenses the previous response into a structured prefix for the next loop.
// Mirrors Coconut's "continuous thought" — the prior hidden state as next input.
function buildLoopContext(loopN, prevReply, prevConfidence) {
  return [
    `[Loop ${loopN} context — prior reasoning below. Refine or confirm.]`,
    `Prior confidence: ${(prevConfidence * 100).toFixed(0)}%`,
    `Prior response summary: ${prevReply.slice(0, 600).replace(/\n+/g, " ")}`,
    `[End loop context. Now produce a refined response with the same 5-field output contract.]`,
  ].join("\n");
}

// ── Main looped reasoning entry point ──────────────────────────────────────
/**
 * Run the LLM in a loop until the CDF exit condition is met.
 *
 * @param {object} opts
 *   prompt     {string}   The user's message / task
 *   systemPrompt {string} Base system prompt (will be extended with loop context)
 *   callLLM    {async fn} async (prompt, systemPrompt) => string — the LLM caller
 *   maxLoops   {number}   Override MAX_LOOPS (default 4)
 *   cdfThreshold {number} Override CDF_THRESHOLD (default 0.85)
 *   onLoop     {fn}       Optional callback: (loopN, confidence, reply) => void
 *
 * @returns {Promise<{reply, loop_n, confidence, exit_reason, history}>}
 *   reply       Final refined response
 *   loop_n      Number of loops used
 *   confidence  Final confidence value
 *   exit_reason Why the loop exited
 *   history     [{loop_n, confidence, reply_excerpt}] for the convergence panel
 */
async function loopedReason({ prompt, systemPrompt = "", callLLM, maxLoops = MAX_LOOPS, cdfThreshold = CDF_THRESHOLD, onLoop }) {
  const confidenceHistory = [];
  const history = [];
  let currentSystem = systemPrompt;
  let currentPrompt = prompt;
  let lastReply = "";
  let loopN = 0;

  while (true) {
    loopN++;
    const reply = await callLLM(currentPrompt, currentSystem);
    lastReply = reply || "";

    const conf = extractConfidence(lastReply);
    confidenceHistory.push(conf);
    history.push({ loop_n: loopN, confidence: conf, reply_excerpt: lastReply.slice(0, 120) });

    if (onLoop) onLoop(loopN, conf, lastReply);

    const exitCheck = cdfExit(confidenceHistory, cdfThreshold, maxLoops);
    if (exitCheck.exit) {
      return {
        reply: lastReply,
        loop_n: loopN,
        confidence: conf,
        exit_reason: exitCheck.reason,
        history,
      };
    }

    // Prepare next loop: inject continuous-thought context prefix (Coconut style)
    const loopCtx = buildLoopContext(loopN, lastReply, conf);
    currentSystem = [systemPrompt, loopCtx].filter(Boolean).join("\n\n");
    // Keep the original prompt — next loop sees both the task and the prior reasoning
    currentPrompt = prompt;
  }
}

// ── Simple one-shot wrapper (no looping, returns same shape) ────────────────
async function singleReason({ prompt, systemPrompt = "", callLLM }) {
  const reply = await callLLM(prompt, systemPrompt);
  const conf = extractConfidence(reply || "");
  return { reply, loop_n: 1, confidence: conf, exit_reason: "single_pass", history: [{ loop_n: 1, confidence: conf, reply_excerpt: (reply || "").slice(0, 120) }] };
}

module.exports = { loopedReason, singleReason, cdfExit, extractConfidence, MAX_LOOPS, CDF_THRESHOLD, CONVERGENCE_EPS };
