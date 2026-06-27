// Σ₀ serving-path canary harness — ONE call, TWO orthogonal axes, ONE event stream.
//
// Why two axes (and why they must NOT be merged into one score):
//   - collapse  (#1010)      fires when output diversity is too LOW — repetition,
//                            phrase-echo, lexical contraction (the parrot loop).
//   - groundedness (#1260)   fires when output diversity is HIGH (fluent, varied)
//                            but the reply asserts confident claims with NO external
//                            anchor (the "42-state" — SIGMA0-COLLAPSE-CERTIFICATE §2).
// The two partially ANTICORRELATE: a 42-state reply scores great on the collapse
// axis, so a single blended number would let each failure mode hide inside the
// other. We keep two sub-scores; this harness just unifies the shared plumbing
// (the duplicated tokenizer/threshold lived in canary-util.js) and the integration:
// one runCanaries() call instead of two ad-hoc blocks in stream-chat, and one
// append-only event stream instead of two console.warn-only paths that never logged.
//
// Passive: scoring never mutates a reply. The caller decides what to do with the
// returned signaturePatch; the only side effect here is the append-only event log.

const path = require("path");
const { scoreReplyCollapse, antiCollapseSignal } = require("./collapse-canary");
const { scoreReplyGroundedness, ungroundedSignal } = require("./groundedness-canary");
const { appendJsonlQueued } = require("./file-queue");

const repoRoot = path.resolve(__dirname, "../../../");
const CANARY_EVENTS = path.resolve(repoRoot, "data/convergence/canary-events.jsonl");

/**
 * Run both canary axes over a completed reply.
 *
 * @param {string} reply  the finished reply text
 * @param {object} [opts]
 * @param {string} [opts.groundingContext]  external grounding that fired upstream
 *        (web/KB/repo) — the groundedness anchor.
 * @param {object} [opts.context]  metadata for the event log (source, provider, agent, surface)
 * @param {boolean} [opts.emit=true]  append a canary event when either axis trips
 * @returns {{
 *   collapse: object, grounded: object, tripped: string[],
 *   signaturePatch: object  // Object.assign onto the done-signature to preserve prior behavior
 * }}
 */
function runCanaries(reply, opts = {}) {
  const text = reply || "";
  const collapse = scoreReplyCollapse(text);
  const grounded = scoreReplyGroundedness(text, { groundingContext: opts.groundingContext });

  const tripped = [];
  // Preserve the exact done-signature fields the two former blocks set, so nothing
  // downstream that reads them changes behavior.
  const signaturePatch = {
    sigma0_proximity: collapse.proximity,
    sigma0_grounding: { risk: grounded.risk, anchored: grounded.anchored },
  };
  if (collapse.collapsed) {
    tripped.push("collapse");
    signaturePatch.canary = antiCollapseSignal(collapse);
  }
  if (grounded.ungrounded) {
    tripped.push("grounded");
    signaturePatch.ungrounded = true;
    signaturePatch.ungroundedSignal = ungroundedSignal(grounded);
  }

  if (tripped.length && opts.emit !== false) {
    recordCanaryEvent({
      tripped,
      collapse: { proximity: collapse.proximity, signals: collapse.signals },
      grounded: { risk: grounded.risk, anchored: grounded.anchored, signals: grounded.signals },
      text_length: text.length,
      ...(opts.context || {}),
    });
  }

  return { collapse, grounded, tripped, signaturePatch };
}

/**
 * Append one canary event to the single event stream. Append-only, queued (avoids
 * concurrent-write corruption), and never throws into the caller.
 */
function recordCanaryEvent(evt) {
  try {
    return appendJsonlQueued(CANARY_EVENTS, { ts: new Date().toISOString(), type: "canary", ...evt });
  } catch {
    return Promise.resolve(); // canary logging must never break a reply
  }
}

module.exports = { runCanaries, recordCanaryEvent, CANARY_EVENTS };
