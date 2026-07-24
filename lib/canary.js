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

const repoRoot = path.resolve(__dirname, ".");
const CANARY_EVENTS = path.resolve(repoRoot, "data/convergence/canary-events.jsonl");

// The risk above which a confident-unanchored reply is "must-verify" (red) rather
// than "offer-to-verify" (amber). Env-tunable; default 0.7. The amber floor is the
// groundedness canary's own ungrounded threshold (default 0.5), so:
//   green = anchored / not assertive enough to worry
//   amber = ungrounded, 0.5 ≤ risk < HIGH      → offer a manual re-ground
//   red   = ungrounded, risk ≥ HIGH            → auto-escalate to a grounding pass
const GROUND_HIGH = (() => {
  const v = Number(process.env.KEYSTONE_GROUND_HIGH);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.7;
})();

// Derive the 3-band verdict from the groundedness sub-score. Pure function of the
// canary output — the band is the single source of truth the UI thresholds on, so
// client logic stays dumb and the cutoff stays server-owned + configurable.
function groundednessBand(grounded) {
  if (!grounded.ungrounded) return "green";
  return grounded.risk >= GROUND_HIGH ? "red" : "amber";
}

// ── Per-generation signal trajectories (#2791 / M6) ────────────────────────────
// The lasing-threshold claim needs the RUN-UP to a canary firing, not just the
// terminal snapshot — and healthy trajectories too (both-class, like the record
// ledger). Opt-in via CANARY_TRACE=1 because it (a) samples the collapse scorer
// mid-stream where a scorer already runs, and (b) emits an event for HEALTHY
// replies as well (tripped: []), which grows the event stream. Bounded points,
// never throws, exact no-op when the flag is off.
const TRACE_MAX_POINTS = 48;

function traceEnabled() {
  return process.env.CANARY_TRACE === "1"; // read at call time — testable, toggleable
}

function createCanaryTrace() {
  if (!traceEnabled()) return { enabled: false, points: null, push() {}, reset() {} };
  const points = [];
  return {
    enabled: true,
    points,
    push(len, sc) {
      if (points.length >= TRACE_MAX_POINTS || !sc) return;
      const s = sc.signals || {};
      points.push({
        len,
        prox: sc.proximity,
        rep: s.selfRepeatRatio,
        echo: s.ngramEchoRatio,
        ttr: s.typeTokenRatio,
      });
    },
    reset() { points.length = 0; },
  };
}

/**
 * Run both canary axes over a completed reply.
 *
 * @param {string} reply  the finished reply text
 * @param {object} [opts]
 * @param {string} [opts.groundingContext]  external grounding that fired upstream
 *        (web/KB/repo) — the groundedness anchor.
 * @param {number|object|Array} [opts.tokenSurprise]  OPTIONAL model-internal surprise
 *        (per-token logprobs → uncertainty), forwarded to the groundedness axis. Absent
 *        for providers that don't expose logprobs (e.g. Anthropic) → no behavior change.
 * @param {string} [opts.surpriseModel]  OPTIONAL model id → per-model calibration of the
 *        surprise→uncertainty magnitude (#1681), forwarded to the groundedness axis.
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
  const grounded = scoreReplyGroundedness(text, {
    groundingContext: opts.groundingContext,
    tokenSurprise: opts.tokenSurprise,
    surpriseModel: opts.surpriseModel,             // #1681: per-model calibration of the magnitude
    surpriseCalibration: opts.surpriseCalibration, // (explicit override; else resolved from the model id)
  });

  const tripped = [];
  // Preserve the exact done-signature fields the two former blocks set, so nothing
  // downstream that reads them changes behavior.
  const signaturePatch = {
    sigma0_proximity: collapse.proximity,
    sigma0_grounding: { risk: grounded.risk, anchored: grounded.anchored },
    // 3-band groundedness verdict (green/amber/red) — the active-gate input the UI
    // reads to decide: pass · offer re-ground · auto-escalate. Stamped on every
    // reply (green when healthy); additive, never mutates the reply.
    groundedness: {
      band: groundednessBand(grounded),
      risk: grounded.risk,
      anchored: grounded.anchored,
      highThreshold: GROUND_HIGH,
    },
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

  // #2791: with CANARY_TRACE=1, emit for healthy replies too (tripped: []) so the
  // event stream carries BOTH classes of trajectory — the lead-time analysis needs
  // non-fired baselines. Without the flag, behavior is exactly as before.
  const trace = opts.trace && opts.trace.enabled && opts.trace.points && opts.trace.points.length
    ? opts.trace.points.slice() : null;
  if ((tripped.length || trace) && opts.emit !== false) {
    recordCanaryEvent({
      tripped,
      collapse: { proximity: collapse.proximity, signals: collapse.signals },
      grounded: { risk: grounded.risk, anchored: grounded.anchored, signals: grounded.signals },
      text_length: text.length,
      ...(trace ? { trace } : {}),
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

module.exports = { runCanaries, recordCanaryEvent, createCanaryTrace, CANARY_EVENTS };
