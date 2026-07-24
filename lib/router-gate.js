/**
 * Router Gate — conversation-dynamics escalation signal.
 *
 * The existing task-detector classifies a single message by *topic* keywords.
 * This gate adds the orthogonal axis the router was missing: the *state of the
 * conversation*. It decides whether a turn is breaking new ground (escalate to
 * the Claude-first "reasoning" chain) or is repetitive / parroting / trivial
 * (keep it on the local-first chain, where Ollama answers for free).
 *
 * HONEST SCOPE — read this before believing the name:
 *   - This is a threshold on four interpretable token statistics, ported from
 *     experiments/router_sigma0_encoder.py. It is NOT the 200-unit reservoir
 *     and NOT a learned model. The thresholds below are hand-tuned heuristics,
 *     not fitted. They are a sensible default, not a validated controller.
 *   - The only routing effect is: escalate === true  ->  taskType "reasoning".
 *     When false, the caller's keyword-derived taskType is left untouched.
 *   - It never *blocks* Claude. A downstream provider can always be requested
 *     explicitly; the gate only changes the default chain ordering.
 *
 * Features (per latest user turn, given prior turns):
 *   novelty      fraction of tokens new vs the running vocabulary   (new ground)
 *   self_repeat  max cosine to prior same-role turns                (looping)
 *   echo         cosine to the immediately previous turn            (parroting)
 *   length       latest turn length normalized by LENGTH_REF        (substance)
 */

"use strict";

const TOKEN = /[a-z0-9]+/g;
const LENGTH_REF = 600; // chars at which `length` saturates to 1.0 (heuristic)

// Decision thresholds — heuristic, tunable. Documented, not fitted.
const ESCALATE_SCORE = 0.45; // score above this => escalate to reasoning chain
const LOOP_SELF_REPEAT = 0.85; // self_repeat above this => degenerate / stuck
const LOOP_NOVELTY = 0.2; // ...combined with novelty below this

function tokens(text) {
  const counts = new Map();
  const matches = String(text || "").toLowerCase().match(TOKEN);
  if (!matches) return counts;
  for (const t of matches) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) dot += v * w;
  }
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Compute encoder features for the latest turn given conversation history.
 * @param {Array<{role?:string, text?:string, content?:string}>} messages
 * @returns {{novelty:number, self_repeat:number, echo:number, length:number}}
 */
function features(messages) {
  const turns = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && (m.text != null || m.content != null)
  );
  if (turns.length === 0) {
    return { novelty: 0, self_repeat: 0, echo: 0, length: 0 };
  }

  const textOf = (m) => String(m.text != null ? m.text : m.content);
  const last = turns[turns.length - 1];
  const prior = turns.slice(0, -1);

  // running vocabulary over all prior turns
  const vocab = new Set();
  for (const m of prior) {
    for (const k of tokens(textOf(m)).keys()) vocab.add(k);
  }

  const lastTok = tokens(textOf(last));
  let newCount = 0;
  let total = 0;
  for (const [k, c] of lastTok) {
    total += c;
    if (!vocab.has(k)) newCount += c;
  }
  const novelty = total > 0 ? newCount / total : (prior.length ? 0 : 1);

  // self_repeat: max cosine vs prior turns of the same role
  const lastRole = last.role || "?";
  let self_repeat = 0;
  for (const m of prior) {
    if ((m.role || "?") === lastRole) {
      self_repeat = Math.max(self_repeat, cosine(lastTok, tokens(textOf(m))));
    }
  }

  // echo: cosine vs the immediately previous turn (any role)
  const echo = prior.length
    ? cosine(lastTok, tokens(textOf(prior[prior.length - 1])))
    : 0;

  const length = Math.min(1, textOf(last).length / LENGTH_REF);

  return { novelty, self_repeat, echo, length };
}

/**
 * Decide whether this turn should escalate to the reasoning (Claude-first) chain.
 * @param {Array} messages - conversation history; last entry is the new turn
 * @param {object} [opts]
 * @param {number} [opts.escalateScore=ESCALATE_SCORE]
 * @returns {{escalate:boolean, score:number, taskTypeOverride:(string|null),
 *            reason:string, features:object}}
 */
function gateDecision(messages, opts = {}) {
  const f = features(messages);
  const threshold = opts.escalateScore != null ? opts.escalateScore : ESCALATE_SCORE;

  // Degenerate / looping turn: high self-similarity, little new ground.
  // Don't burn the big model on a conversation that's spinning in place.
  if (f.self_repeat >= LOOP_SELF_REPEAT && f.novelty <= LOOP_NOVELTY) {
    return {
      escalate: false,
      score: 0,
      taskTypeOverride: null,
      reason: `looping(self_repeat=${f.self_repeat.toFixed(2)},novelty=${f.novelty.toFixed(2)})`,
      features: f,
    };
  }

  // New ground pushes up; repetition (echo / self_repeat) pushes down.
  //
  // novelty is TEMPERED by substance: a 3-word new-topic question and a long,
  // genuinely-new turn both have novelty~1, but only the latter should reach for
  // the big model. We scale novelty by (0.3 + 0.7*length) so short novel turns
  // keep a 0.3 floor and long ones keep full weight. This is what stops the
  // score distribution from collapsing to a "did new words appear" binary
  // (see scripts/calibrate-router-gate.js — without it, ~55% of turns escalate).
  const substance = 0.3 + 0.7 * f.length;
  const score = f.novelty * substance - 0.5 * f.echo - 0.5 * f.self_repeat;
  const escalate = score >= threshold;

  return {
    escalate,
    score,
    taskTypeOverride: escalate ? "reasoning" : null,
    reason: escalate
      ? `new_ground(score=${score.toFixed(2)}>=${threshold})`
      : `local_ok(score=${score.toFixed(2)}<${threshold})`,
    features: f,
  };
}

module.exports = { gateDecision, features, tokens, cosine, LENGTH_REF };
