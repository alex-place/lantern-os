// Σ₀ Council — one review, two faces, a disagreement scalar (Δ), and a 3-way answerability
// gate (grounded / seam-open / pin).
//
// The council already existed, split across the loop:
//   - Reason-face: lib/swarm-orchestrator.js swarmCouncil() — member lenses debate, a
//     synthesizer folds them and records `dissent[]` (Reason stage, pre-Act).
//   - Verify-face: lib/canary.js runCanaries() — two ORTHOGONAL axes (collapse #1010,
//     groundedness #1260) score the finished reply, kept separate because they anticorrelate.
//
// councilReview() folds both into Δ = cross-lens disagreement, then routes Δ through the
// answerability gate the Question Machine's theorem demands (src/cio_sde/question.py:23-29):
//
//   "When forward and backward AGREE the question score → 0 — but two mirrors agreeing can be
//    jointly wrong. Consolidation makes the trajectory COHERENT, not CORRECT… the dead 42-state
//    if the loop is ungrounded. The escape is an EXTERNAL terminal condition."
//
// So the dangerous failure has the LOWEST disagreement (a coherent, confident, jointly-wrong
// mirror). Δ alone would let it through. The gate fixes that with two facts the seam math
// makes load-bearing:
//   1. Δ is a max(), NEVER an average — the 42-state escapes on the anchor axis (grounded.risk),
//      not on disagreement; averaging would bury it. Coherence is free; correctness costs a check.
//   2. There are FOUR answers, not two — gated on REACHABILITY (CAP able / NAP allowed, the
//      question.py gate) and on whether an EXECUTION check actually ran:
//        grounded  : an external check passed (test green) OR Δ < τ → answer (cite if anchored)
//        refuted   : an execution check RAN and FAILED → retry, self-correcting against the
//                    failure output. The strongest signal there is — "wrong, with proof" — and
//                    it goes back to the model, NOT to the operator (it's how long-horizon
//                    self-correction reopens the seam: OracleChannel returned NO).
//        seam_open : Δ ≥ τ AND reachable          → surface / escalate; a tool or the operator
//                                                   (a CallbackChannel) CAN ground it
//        pin       : Δ ≥ τ AND NOT reachable      → name the unknown; escalating to someone who
//                                                   also can't reach it is the bluff the Oracle
//                                                   refuses ("what was before the big bang").
//
//   3. EXECUTION OVERRIDES TEXT. A run test is ground truth; the canaries are proxies. When an
//      execution verdict is supplied it decides grounded-vs-refuted REGARDLESS of the text Δ —
//      "correctness costs an external check", and the check beats the mirror every time.
//
// Passive + model-agnostic: scoring never mutates a reply, no provider is hardcoded. The only
// side effect is one append-only council record so the operator-escalation backtest accrues a
// labeled history (experiments/council_escalation_backtest.py).

const path = require("path");
const { runCanaries } = require("./canary");
const { appendJsonlQueued } = require("./file-queue");

const repoRoot = path.resolve(__dirname, "../../../");
const COUNCIL_REVIEWS = path.resolve(repoRoot, "data/convergence/council-reviews.jsonl");

// Dissent count at which the Reason-face contributes a maxed-out disagreement. Three
// substantive disagreements between member lenses is already "highly contested".
const DISSENT_SCALE = 3;

/**
 * Review one decision/reply across both council faces, derive Δ, and classify answerability.
 *
 * @param {string} reply  the finished reply / proposed action text
 * @param {object} [opts]
 * @param {string[]} [opts.dissent]  Reason-face dissent[] from swarmCouncil (member disagreements).
 * @param {string} [opts.groundingContext]  external grounding that fired upstream (web/KB/repo).
 * @param {number} [opts.threshold=0.5]  Δ at/above which the decision is contested.
 * @param {boolean|Function} [opts.reachable=true]  is there a reachable external check for this
 *        claim — a tool (run code / retrieve), an oracle, or the operator as a CallbackChannel?
 *        false ⇒ no external referent (offline + unanchorable, or NAP-denied) ⇒ a pin.
 * @param {{ran:boolean, passed:boolean, output?:string}} [opts.execVerdict]  result of an
 *        EXECUTION check (ran the tests / the code). When ran, it is ground truth and overrides
 *        the text Δ: passed ⇒ grounded, failed ⇒ refuted (retry against output).
 * @param {object} [opts.context]  metadata for the record (surface, provider, decisionId, ...).
 * @param {boolean} [opts.emit=true]  append a council record.
 * @returns {{
 *   delta:number, verdict:'grounded'|'refuted'|'seam_open'|'pin',
 *   recommend:'answer'|'retry'|'escalate'|'name_unknown', escalated:boolean,
 *   anchored:boolean, reachable:boolean, groundedBy:'execution'|'anchor'|'low_delta'|'none',
 *   deltaVerify:number, deltaReason:number, collapse:object, grounded:object, dissent:string[]
 * }}
 */
function councilReview(reply, opts = {}) {
  const text = reply || "";
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const dissent = Array.isArray(opts.dissent) ? opts.dissent.filter(Boolean) : [];

  // Verify-face: reuse the canary harness. emit:false — councilReview writes its OWN record.
  const { collapse, grounded } = runCanaries(text, {
    groundingContext: opts.groundingContext,
    emit: false,
  });

  // Verify-face disagreement: either axis signalling "don't trust" raises contestedness.
  // max() (not average) so the 42-state (fluent but unanchored: low collapse, high grounded
  // risk) and the parrot loop (high collapse, low grounded risk) BOTH escalate — neither
  // hides inside the other. This is the seam math's first load-bearing fact.
  const deltaVerify = Math.max(collapse.proximity, grounded.risk);

  // Reason-face disagreement: how much the member lenses disagreed. Saturates at DISSENT_SCALE.
  const deltaReason = Math.min(1, dissent.length / DISSENT_SCALE);

  const delta = Number(Math.max(deltaVerify, deltaReason).toFixed(4));
  const contested = delta >= threshold;

  // Reachability — the axis the QuestionMachine gates on (CAP able / NAP allowed). A question
  // you can't reach an external referent for is a PIN, not a thing to escalate. Default true:
  // the operator is the universal CallbackChannel, usually reachable.
  const reachable = typeof opts.reachable === "function" ? !!opts.reachable() : opts.reachable !== false;

  // Execution verdict, if a check actually ran. Ground truth — overrides the text Δ.
  const exec = opts.execVerdict && opts.execVerdict.ran ? opts.execVerdict : null;

  // The answerability gate. Execution decides grounded-vs-refuted when it ran; otherwise the
  // text Δ + reachability decide grounded / seam_open / pin.
  let verdict, recommend, groundedBy;
  if (exec) {
    if (exec.passed) { verdict = "grounded"; recommend = "answer"; groundedBy = "execution"; }
    else { verdict = "refuted"; recommend = "retry"; groundedBy = "execution"; } // wrong, with proof
  } else if (!contested) {
    verdict = "grounded"; recommend = "answer";
    groundedBy = grounded.anchored ? "anchor" : "low_delta";
  } else if (reachable) {
    verdict = "seam_open"; recommend = "escalate"; groundedBy = "none";
  } else {
    verdict = "pin"; recommend = "name_unknown"; groundedBy = "none";
  }

  const escalated = verdict === "seam_open"; // only seam-open routes to the operator; pin/refuted don't

  const review = {
    delta,
    verdict,
    recommend,
    escalated,
    groundedBy,                           // how it grounded: execution > anchor > low_delta > none
    anchored: grounded.anchored,          // answer-with-cite hint for the grounded verdict
    reachable,
    deltaVerify: Number(deltaVerify.toFixed(4)),
    deltaReason: Number(deltaReason.toFixed(4)),
    collapse,
    grounded,
    dissent,
  };

  if (opts.emit !== false) {
    recordCouncilReview({
      delta,
      verdict,
      recommend,
      escalated,
      groundedBy,
      reachable,
      anchored: grounded.anchored,
      execRan: !!exec,
      execPassed: exec ? !!exec.passed : null,
      deltaVerify: review.deltaVerify,
      deltaReason: review.deltaReason,
      dissentCount: dissent.length,
      collapse: { proximity: collapse.proximity },
      grounded: { risk: grounded.risk, anchored: grounded.anchored },
      text_length: text.length,
      // outcome is filled LATER by the backtest labeller (revert / operator action). This
      // slot is what turns the append-only log into measurable escalation history.
      outcome: null,
      ...(opts.context || {}),
    });
  }

  return review;
}

/**
 * Append one council record to the single council-review stream. Append-only, queued, and
 * never throws into the caller (a logging failure must never break a reply).
 */
function recordCouncilReview(rec) {
  try {
    return appendJsonlQueued(COUNCIL_REVIEWS, {
      ts: new Date().toISOString(),
      type: "council_review",
      ...rec,
    });
  } catch {
    return Promise.resolve();
  }
}

module.exports = { councilReview, recordCouncilReview, COUNCIL_REVIEWS, DISSENT_SCALE };
