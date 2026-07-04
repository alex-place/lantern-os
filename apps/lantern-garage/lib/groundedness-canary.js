// Σ₀ groundedness canary for the live chat serving path (42-state guardrail).
//
// The collapse canary (./collapse-canary.js, #1010) catches one Σ₀ failure mode:
// textual *degeneration* — a reply that repeats, echoes, or contracts lexically.
// It does NOT catch the other, more dangerous mode the Collapse Certificate proves
// (docs/SIGMA0-COLLAPSE-CERTIFICATE.md §2, the "42-state"): a reply that is fluent,
// varied, and internally coherent — yet asserts confident claims with ZERO external
// anchor. That is exactly the ungrounded "mirror loop" the Question Machine demo
// shows: internally coherent (seam → 0) but factually adrift. A degeneration canary
// reads such a reply as perfectly healthy.
//
// This is the missing axis. It is a lightweight, dependency-free TEXT+CONTEXT canary
// that runs per reply on the serving path and answers one question:
//
//     Is this reply confidently asserting things it never grounded?
//
// It is a passive OBSERVER — no behavior change when healthy. It enforces, in the
// serving loop, the EXTERNAL REALITY RULE from the Σ₀ briefing:
//     "Every important claim must have [claim, evidence, confidence, source]."
//
// risk = assertiveness × (1 − anchor)
//   - assertiveness : how confidently the reply makes factual claims, net of hedging.
//                     An honest "I'm not sure, but maybe…" is NOT a 42-state — low
//                     assertiveness → low risk even with no anchor.
//   - anchor        : did anything external pin the reply? external grounding context
//                     that fired (web/KB/repo), or in-text sources (links, URLs,
//                     file:line citations). Anchored → low risk regardless of tone.
//
// High risk = high assertiveness AND no anchor = the 42-state signature.

const { tokenize, splitUnits } = require("./canary-util");
const { toUncertainty, calibrationFor } = require("./token-surprise");

const MIN_TOKENS = 16; // below this there isn't enough signal — don't cry ungrounded

// How much model-internal surprise may sharpen the 42-state risk (raise-only).
// 0.5 = a confident, fully-unanchored, maximally-uncertain reply gets up to +50% risk —
// enough to push a borderline case over threshold, never enough to dominate the text signal.
const SURPRISE_ALPHA = 0.5;

// case-preserving sentence units (entity capitalization must survive)
function splitSentences(text) {
  return splitUnits(text, { lower: false });
}

// A sentence asserts a *checkable* fact when it carries a verifiable specific —
// a number/date, or a NAMED ENTITY (a capitalized word that is not merely the
// sentence's first word). We deliberately do NOT count bare copulas ("is/are/was")
// or sentence-initial capitals: ordinary reflective prose is full of those, and
// counting them flags healthy replies. The 42-state is dense with checkable
// specifics it never sourced — that density is the signal.
const NUMERIC = /\d/;
const ENTITY = /^[\p{Lu}][\p{L}]{2,}$/u;

function hasCheckableSpecific(sentence) {
  if (NUMERIC.test(sentence)) return true;
  const words = sentence.split(/\s+/);
  // skip word 0 — sentence-initial capitalization is grammar, not an entity
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^\p{L}\p{N}]+$/u, "").replace(/^[^\p{L}\p{N}]+/u, "");
    if (ENTITY.test(w)) return true;
  }
  return false;
}

function assertionDensity(sentences) {
  if (!sentences.length) return 0;
  let assertive = 0;
  for (const s of sentences) {
    if (hasCheckableSpecific(s)) assertive++;
  }
  return assertive / sentences.length;
}

// Hedges signal honest uncertainty — they EXCUSE the absence of an anchor, because
// the reply is not claiming certainty it can't back. They damp assertiveness.
const HEDGE = /\b(i think|i believe|i'm not sure|i am not sure|not certain|might|maybe|perhaps|possibly|i don't know|i do not know|i can't verify|i cannot verify|as far as i know|i'm not certain|unsure|it seems|it appears|i'd guess|i would guess|no information|i don't have|i do not have)\b/gi;

function hedgeDamping(text) {
  const hits = (String(text || "").match(HEDGE) || []).length;
  // One honest caveat shouldn't fully excuse paragraphs of confident claims;
  // saturate gently.
  return Math.min(1, hits * 0.5);
}

// Self-declared ungroundedness — the reply EXPLICITLY admits it did not ground its
// claims: no access to the referent, or it is filling in a placeholder / assumption.
// This is distinct from the assertiveness×(1−anchor) risk axis, which only catches
// *confident* unanchored claims (the 42-state). A reply that honestly hedges
// ("I don't have direct access to its codebase… I'll create a placeholder") scores
// LOW risk (hedging damps assertiveness) yet is self-evidently ungrounded. The council
// must never stamp such a reply "✓ Σ₀ grounded" (#1924) — absence of confident
// over-claiming is not the same as presence of evidence. High-precision, first-person
// framed to avoid flagging legitimate technical uses ("use a placeholder value").
const SELF_UNGROUNDED = new RegExp(
  [
    "\\bi (?:don'?t|do not|can'?t|cannot|didn'?t|did not) (?:have |get )?(?:direct |real |live |actual )?access\\b",
    "\\bwithout (?:direct |real |live )?access to\\b",
    "\\bi (?:can'?t|cannot|couldn'?t|could not) (?:see|read|open|reach|access|view|inspect) (?:the|your|its|this|their)\\b",
    "\\b(?:i'?ll|i will|let me|i'?m going to|i am going to|going to) (?:create|make|use|add|put|insert|generate) (?:a |an )?placeholder\\b",
    "\\bplaceholder (?:entry|value|record|data|content|answer|response)\\b",
    "\\bas a placeholder\\b",
    "\\bi'?ll assume\\b", "\\bi will assume\\b", "\\bi'?m assuming\\b", "\\bi am assuming\\b",
    "\\b(?:making|based on|i'?m making) (?:an? )?assumption\\b",
  ].join("|"),
  "i",
);

function selfDeclaredUngrounded(text) {
  return SELF_UNGROUNDED.test(String(text || ""));
}

// In-text anchors: markdown links, bare URLs, or file:line / src-path citations.
const MD_LINK = /\[[^\]]+\]\(\s*(?:https?:\/\/|\/|\.{0,2}\/)[^)]+\)/;
const BARE_URL = /\bhttps?:\/\/\S+/;
const FILE_CITE = /\b[\w./-]+\.[a-z]{1,5}:\d+\b|\b(?:src|apps|lib|docs|tests)\/[\w./-]+/;

function inTextAnchor(text) {
  if (MD_LINK.test(text)) return 0.8;
  if (BARE_URL.test(text)) return 0.7;
  if (FILE_CITE.test(text)) return 0.6;
  return 0;
}

/**
 * Score a completed reply for 42-state proximity (confident + unanchored).
 *
 * @param {string} text  the completed reply
 * @param {object} opts
 * @param {string} [opts.groundingContext]  external grounding that fired upstream
 *        (web search / KB / repo). Non-empty = strong external anchor.
 * @param {number} [opts.threshold=0.5]
 * @param {number|object|Array} [opts.tokenSurprise]  OPTIONAL model-internal surprise:
 *        an uncertainty scalar [0,1], a surpriseField summary, or a [{bits}] array
 *        (see ./token-surprise.js). Present only when the provider exposes per-token
 *        logprobs (local / OpenAI-style); absent (cloud) → behaves exactly as before.
 * @param {string} [opts.surpriseModel]  OPTIONAL model id → per-model calibration of the
 *        surprise→uncertainty MAGNITUDE (#1681). Unknown/absent → default (unchanged).
 * @param {{center:number,gain:number}} [opts.surpriseCalibration]  OPTIONAL explicit override.
 * @returns {{risk:number, ungrounded:boolean, anchored:boolean, signals:object, reason?:string}}
 */
function scoreReplyGroundedness(text, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const tokens = tokenize(text);
  const sentences = splitSentences(text);
  const signals = {
    tokens: tokens.length,
    assertionDensity: 0,
    hedgeDamping: 0,
    assertiveness: 0,
    externalGrounding: false,
    inTextAnchor: 0,
    anchor: 0,
    modelUncertainty: 0,
    selfUngrounded: false,
  };

  // Self-declared ungroundedness is checked FIRST and independently of length: a short
  // "I don't have access to the repo, so I'll use a placeholder" is exactly the reply
  // the #1924 badge must not call grounded, even below the assertiveness MIN_TOKENS floor.
  signals.selfUngrounded = selfDeclaredUngrounded(text);

  if (tokens.length < MIN_TOKENS) {
    return {
      risk: 0, ungrounded: false, anchored: false,
      selfUngrounded: signals.selfUngrounded, signals, reason: "too_short",
    };
  }

  signals.assertionDensity = assertionDensity(sentences);
  signals.hedgeDamping = hedgeDamping(text);
  // Hedging removes up to 70% of assertiveness — a fully hedged reply is honest,
  // not a 42-state, but a single hedge can't neutralise sustained confident claims.
  signals.assertiveness = signals.assertionDensity * (1 - 0.7 * signals.hedgeDamping);

  const ext = !!(opts.groundingContext && String(opts.groundingContext).trim().length);
  signals.externalGrounding = ext;
  signals.inTextAnchor = inTextAnchor(text);
  signals.anchor = Math.max(ext ? 0.85 : 0, signals.inTextAnchor);

  // Optional model-internal corroboration. High token-surprise on a confident,
  // unanchored reply = the model was uncertain about the very specifics it asserted
  // (semantic-entropy hallucination signal). RAISE-ONLY, and only inside the 42-state
  // corner (assertive × unanchored): it never fabricates risk in a hedged/anchored/
  // reflective reply (base risk ≈ 0 there → sharpen has nothing to multiply), and an
  // absent signal (cloud, no logprobs) leaves the score byte-identical to before.
  // #1681: per-model calibration so the scalar's MAGNITUDE is meaningful (not just ranked).
  // Explicit surpriseCalibration wins; else resolve from surpriseModel; else default (unchanged).
  const surpriseCalib = opts.surpriseCalibration || calibrationFor(opts.surpriseModel);
  signals.modelUncertainty = opts.tokenSurprise != null ? toUncertainty(opts.tokenSurprise, surpriseCalib) : 0;
  const sharpen = 1 + SURPRISE_ALPHA * signals.modelUncertainty * (1 - signals.anchor);

  const risk = Math.min(1, signals.assertiveness * (1 - signals.anchor) * sharpen);

  return {
    risk: Number(risk.toFixed(4)),
    ungrounded: risk >= threshold,
    anchored: signals.anchor > 0,
    selfUngrounded: signals.selfUngrounded,
    signals,
  };
}

/**
 * Build the logged advisory payload for an ungrounded reply. Mirrors the
 * antiCollapseSignal shape; advisory only — the canary stays passive on serving.
 */
function ungroundedSignal(score) {
  return {
    event: "canary_ungrounded",
    risk: score.risk,
    action: "ground_or_flag", // surface the highest-leverage question, or label as unverified
    signals: score.signals,
  };
}

/**
 * ADR-0012 step 4 — turn a groundedness score into a serving-path routing hint.
 *
 * Symmetric to collapse-canary's collapseRoutingHint: a confident-but-unanchored
 * (ungrounded) local reply should escalate to a stronger (cloud) tier rather than ship.
 * Pure and additive — the PRODUCER side of the ADR-0012 step-4 routing hint; the serving
 * path consumes it behind a flag, with the live-serving cost/latency measured first.
 *
 * @param score  the object returned by scoreReplyGroundedness()
 * @param opts.routeThreshold  optional risk to escalate at; when set, escalates on
 *   risk >= routeThreshold. When omitted, escalates exactly when the canary already
 *   flagged `ungrounded`, keeping the module's own threshold the single source of truth.
 * @param opts.escalateTier  tier label to route to when escalating (default "cloud").
 */
function groundednessRoutingHint(score, opts = {}) {
  const risk = score && typeof score.risk === "number" ? score.risk : 0;
  const escalate = opts.routeThreshold != null
    ? risk >= opts.routeThreshold
    : !!(score && score.ungrounded);
  return {
    escalate,
    tier: escalate ? (opts.escalateTier || "cloud") : "local",
    reason: escalate ? "ungrounded" : "none",
    risk,
  };
}

module.exports = {
  scoreReplyGroundedness,
  ungroundedSignal,
  groundednessRoutingHint,
  selfDeclaredUngrounded,
  MIN_TOKENS,
};
