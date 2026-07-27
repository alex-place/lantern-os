"use strict";

/**
 * Spiral harness — Phase 0 of ADR-0029 (the verified-cascade spiral).
 *
 * This is the CLAUDE.md convergence loop (Observe → Remember → Reason → Act →
 * Verify → Converge) run on ONE problem for as long as it keeps advancing. It is a
 * HARNESS, not a model: no new weights. It reassembles parts we already shipped —
 * the live verified cascade (experiments/verified_cascade_live.py, #2800), the
 * constraint-aware cheap-tier picker (lib/local-model-registry.js selectCheapStandin,
 * #2814), and the Fix-Rate verifier metric (lib/spiral-fix-rate.js) — into a loop.
 *
 * Each turn is a VERIFIED CASCADE (the cascade research applied per step, cf.
 * Policy-Guided Stepwise Routing arXiv 2605.06116; Cluster-Route-Escalate 2606.27457;
 * escalation decision-theory 2605.06350):
 *
 *     1. the CHEAP owned tier proposes the next step
 *     2. the verifier (M4 Fix Rate) gates it — did it advance?
 *     3. only on a stall do we ESCALATE that step to the frontier tier,
 *        inheriting the full accumulated memory (progress preserved, not restarted)
 *     4. a verified step commits to growing memory (M1); an unverified one de-ratchets
 *
 * Why the cascade matters here (ADR-0029 §4.5): most steps are easy, the cheap tier
 * clears them (sufficiency regime → the long horizon stays affordable), and every
 * ESCALATED step is a frontier demonstration on a problem the cheap tier could not
 * advance — i.e. a perfect distillation target. The harness emits those as the
 * escalation corpus; VTD later trains the cheap tier on them so the one governing
 * number, the escalation rate, only falls.
 *
 * Cascade policy (cross-domain prior art, fielded for decades outside LLMs):
 *   - STOP-ON-STALL (ECC iterative decoders, US6518892B2/US8301987B2): halt after
 *     `stallLimit` consecutive non-advancing turns, and a state-hash spots a generator
 *     that is cycling (halt "loop") — instead of grinding to the fixed turn cap.
 *   - PASS-TERMINATES / cheapest-check-first (hierarchical assay, US6013436A): a
 *     candidate identical to one that already stalled (or to the current best) is
 *     never re-verified — the zero-cost hash check runs before the paid one, and a
 *     pass at any rung ends the turn's spend.
 *   - BIDIRECTIONAL TIERING (call-routing, US7254641B2): after a fully-stalled turn
 *     the next turn starts at the frontier rung (skip the doomed cheap try); any
 *     commit drops back to cheap — de-escalate when the hard part is over.
 *
 * The four core objects map cleanly: Memory = the growing verified memory; Task = the
 * problem; Tool = the tier calls; Convergence Record = each committed verified step.
 * Nothing here is a separate engine — it is the loop, focused.
 *
 * Everything crossing the I/O boundary is INJECTED (tiers, verifier, corpus sink,
 * clock) so the loop is pure and unit-testable without a server or a GPU. Prod wires
 * real model tiers + the exec-verify sandbox; tests wire stubs.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { fixRate, summarize } = require("./spiral-fix-rate");

let _repoRoot;
try {
  _repoRoot = require("./app-paths").repoRoot;
} catch {
  _repoRoot = path.resolve(__dirname, "..", "..", "..");
}

// M3 focus rotation — a cheap hint that makes each turn attend a *different aspect*
// so the cheap tier does not propose the same failing patch every turn (the design's
// rotational anti-collapse, reduced to a scheduler; the coRNN dynamics are Phase 2).
const DEFAULT_FOCI = ["outline", "edge-cases", "fix-failing", "simplify", "regressions"];

/** Default escalation-corpus sink: append JSONL under data/eval/spiral/. */
function _defaultCorpus(runId) {
  const dir = path.join(_repoRoot, "data", "eval", "spiral");
  const file = path.join(dir, `spiral-${runId}.jsonl`);
  return {
    file,
    append(row) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(file, JSON.stringify(row) + "\n");
      } catch {
        /* best-effort telemetry — never fail the loop on a log write */
      }
    },
  };
}

const noop = () => {};

/**
 * Run the spiral on one problem.
 *
 * @param {object} args
 *   problem   {object}   REQUIRED. { id, prompt, tests? } — the one problem.
 *   tiers     {object}   REQUIRED. { cheap(ctx), escalate(ctx) } → Promise<{ text, cost?, model? }>.
 *                        `ctx` = { problem, memory, focus, y, turn, avoid }. `escalate` is
 *                        optional; if absent, a cheap stall simply de-ratchets.
 *   verify    {function} REQUIRED. async (candidateText, { problem, memory, before }) =>
 *                        either a Fix-Rate result ({ advanced, solved, ... }) OR a raw
 *                        test-result set (array/counts) which we score with fixRate().
 *   memory    {Array}    optional seed of verified steps (default []).
 *   maxTurns  {number}   safety cap on the unbounded loop (default 12).
 *   stallLimit {number}  consecutive non-advancing turns before halting "stalled"
 *                        (default 3). 0 disables stop-on-stall AND the loop-halt
 *                        (duplicate proposals still skip the paid verify).
 *   stickyTiers {boolean} bidirectional rung movement (default true): a fully-stalled
 *                        turn starts the NEXT turn at the frontier rung; any commit
 *                        returns to cheap.
 *   failureCache {object|null} #2869 failure-mode cache ({avoidFor, recordFailures});
 *                        opt-in — when set, known-failed approaches for the task
 *                        signature ride into every tiers ctx as `avoid`, and an
 *                        unsolved halt records this run's verified failures.
 *   escalationContract {boolean} contractive-escalation enforcement (#2867, default
 *                        true): a verified escalation that fails to advance halts the
 *                        run ("escalation-noncontractive") — every frontier spend must
 *                        measurably help or the loop stops honestly.
 *   answerability {function} optional async (ctx) => number ∈ [0,1]; halt "honest can't"
 *                        when it declines below `answerabilityFloor` (M5).
 *   answerabilityFloor {number} default 0.15.
 *   rotate    {function} optional (turn, memory) => focus hint (M3). Default: cycle DEFAULT_FOCI.
 *   onStep    {function} optional (event) => void — the dream-chat progress hook.
 *   corpus    {object}   optional { append(row) } sink. Default: JSONL under data/eval/spiral/.
 *   runId     {string}   optional id for the corpus file/run.
 *   now       {function} optional () => ms clock (injectable for deterministic tests).
 *
 * @returns {Promise<{
 *   solved:boolean, haltReason:string, turns:number, escalations:number,
 *   cost:number, y:(string|null), memory:Array, corpusRows:Array,
 *   escalationRate:number, corpusFile:(string|null), confidence:number
 * }>}
 *   haltReason ∈ "solved" | "stalled" | "loop" | "escalation-noncontractive" |
 *                "answerability" | "maxTurns".
 *   confidence is the whole-answer score (see _wholeAnswerConfidence), decoupled
 *   from where the loop stopped.
 */
async function runSpiral(args) {
  const {
    problem,
    tiers,
    verify,
    memory: seed = [],
    maxTurns = 12,
    stallLimit = 3,
    stickyTiers = true,
    escalationContract = true,
    failureCache = null,
    answerability = null,
    answerabilityFloor = 0.15,
    rotate = null,
    onStep = noop,
    corpus: corpusArg = null,
    runId: runIdArg = null,
    now = () => Date.now(),
  } = args || {};

  if (!problem || typeof problem !== "object") throw new Error("runSpiral: problem is required");
  if (!tiers || typeof tiers.cheap !== "function") throw new Error("runSpiral: tiers.cheap is required");
  if (typeof verify !== "function") throw new Error("runSpiral: verify is required");

  const runId = runIdArg || `${problem.id || "problem"}-${now()}`;
  const corpus = corpusArg || _defaultCorpus(runId);
  const rotateFn = rotate || ((t) => DEFAULT_FOCI[t % DEFAULT_FOCI.length]);

  const memory = Array.isArray(seed) ? seed.slice() : [];
  const corpusRows = [];
  let best = memory.length ? memory[memory.length - 1].results || null : null; // best-so-far results (ratchet baseline)
  let y = memory.length ? memory[memory.length - 1].text || null : null;
  let cost = 0;
  let escalations = 0;
  let solved = false;
  let haltReason = "maxTurns";

  // Stop-on-stall + loop detection + the sticky cascade rung. `seenStalled` holds
  // state-hashes of candidates that failed to advance — re-proposing one is loop
  // evidence, and never worth paying the verifier for again.
  // #2869 failure-mode cache: known-failed approaches for this task signature are
  // injected as avoid-constraints BEFORE the cheap tier proposes (negative space
  // only), and this run's verified failures are recorded on an unsolved halt.
  const fcache = failureCache || null; // opt-in: prod call sites pass the real cache
  const avoid = fcache ? fcache.avoidFor(problem) : [];
  const stalledForCache = [];

  let consecutiveStalls = 0;
  let consecutiveDupTurns = 0;
  let rung = "cheap";
  const seenStalled = new Set();

  // Coerce a verify() return into a Fix-Rate result. If verify already returned a
  // scored result (has `advanced`), trust it; else treat it as a raw test-result set
  // and score it against the best-so-far baseline. We stash the raw set on `_results`
  // so that COMMITTING an advancing step advances the ratchet baseline to it — without
  // that, every turn would be graded against turn 0 and regressions couldn't be seen.
  const score = (raw, before) => {
    if (raw && typeof raw === "object" && typeof raw.advanced === "boolean") return raw;
    const r = fixRate(before, raw);
    r._results = raw;
    return r;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    const focus = rotateFn(turn, memory);
    onStep({ type: "turn_start", turn, focus, memorySize: memory.length });

    // M5 (pre-step): honest-can't halt — if the model can no longer justify an
    // answer, stop rather than bluff. Checked before spending a tier call.
    if (answerability) {
      const a = await answerability({ problem, memory, y, turn, focus });
      if (Number.isFinite(a) && a < answerabilityFloor) {
        haltReason = "answerability";
        onStep({ type: "halt", reason: haltReason, turns: turn, solved, answerability: a });
        break;
      }
    }

    // ── M2: the per-turn verified cascade, entered at the current rung ─────
    // Pass-terminates / cheapest-check-first: the zero-cost identity check runs
    // before the paid verifier — a candidate identical to the current best, or to
    // one that already stalled, cannot advance the ratchet, so it is scored as the
    // stall it is without spending an exec run.
    let dupsThisTurn = 0;
    const evaluate = async (c) => {
      const h = _stateHash(c && c.text);
      if (seenStalled.has(h) || (y != null && String(c && c.text) === String(y))) {
        dupsThisTurn += 1;
        onStep({ type: "verify_skipped", turn, reason: "duplicate-candidate" });
        return { advanced: false, solved: false, fixRate: 0, penalizedFixRate: 0, _dup: true };
      }
      const out = score(await verify(c.text, { problem, memory, before: best }), best);
      // #2869: a REAL-verified candidate that failed to advance is repeatable error
      // for this task signature — collected for the failure cache on unsolved halt.
      if (!out.advanced) {
        const results = out._results || out.results || [];
        stalledForCache.push({
          text: String(c && c.text) || "",
          failingTests: (Array.isArray(results) ? results : []).filter((t) => !t.passed).map((t) => String(t.name)),
        });
      }
      return out;
    };

    const canEscalate = typeof tiers.escalate === "function";
    let tier = "cheap";
    let cand;
    let v;
    let triedTiers = 1;
    if (stickyTiers && canEscalate && rung === "escalated") {
      // Bidirectional tiering, the rise direction: the last turn stalled at BOTH
      // rungs, so the cheap try is proven futile right now — start this turn at the
      // frontier, inheriting the accumulated memory. Any commit drops back to cheap.
      tier = "escalated";
      escalations += 1;
      onStep({ type: "escalate", turn, reason: "sticky rung: cheap stalled last turn" });
      cand = await tiers.escalate({ problem, memory, focus, y, turn, avoid });
      cost += Number(cand && cand.cost) || 0;
      v = await evaluate(cand);
      onStep({ type: "verify", turn, tier, advanced: v.advanced, solved: v.solved, fixRate: v.fixRate, penalizedFixRate: v.penalizedFixRate });
    } else {
      cand = await tiers.cheap({ problem, memory, focus, y, turn, avoid });
      cost += Number(cand && cand.cost) || 0;
      onStep({ type: "cheap_try", turn, model: cand && cand.model, cost });
      v = await evaluate(cand);
      onStep({ type: "verify", turn, tier, advanced: v.advanced, solved: v.solved, fixRate: v.fixRate, penalizedFixRate: v.penalizedFixRate });

      if (!v.advanced && canEscalate) {
        // Cheap stalled → escalate THIS step to the frontier, inheriting the full
        // accumulated memory (progress preserved). This is the only time we spend big.
        if (!v._dup) seenStalled.add(_stateHash(cand && cand.text));
        onStep({ type: "escalate", turn, from: cand && cand.model, reason: "cheap stalled the verifier" });
        tier = "escalated";
        escalations += 1;
        triedTiers = 2;
        cand = await tiers.escalate({ problem, memory, focus, y, turn, avoid });
        cost += Number(cand && cand.cost) || 0;
        v = await evaluate(cand);
        onStep({ type: "verify", turn, tier, advanced: v.advanced, solved: v.solved, fixRate: v.fixRate, penalizedFixRate: v.penalizedFixRate });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const row = {
      runId,
      problemId: problem.id || null,
      turn,
      tier,
      focus,
      advanced: v.advanced,
      solved: !!v.solved,
      fixRate: v.fixRate,
      penalizedFixRate: v.penalizedFixRate,
      cost: Number(cand && cand.cost) || 0,
      // The escalated + advancing steps are the VTD distillation targets: a frontier
      // demonstration on a step the cheap tier could not do. Flagged for the trainer.
      distillTarget: tier === "escalated" && v.advanced,
      verifySkipped: !!v._dup,
      ts: new Date(now()).toISOString(),
    };
    corpus.append(row);
    corpusRows.push(row);

    if (v.advanced) {
      // Commit the verified, (in Phase 2) decorrelated step → grow the radius (M1).
      const step = { turn, tier, text: cand.text, focus, results: v._results || v.results || null, fixRate: v.fixRate, solved: !!v.solved };
      // Preserve the raw results so the next turn's ratchet baseline is this best.
      if (!step.results && Array.isArray(v.fixedTests)) step.results = null;
      memory.push(step);
      best = _bestResults(best, v, cand);
      y = cand.text;
      // De-escalation (the fall direction): the hard step cleared, so the next turn
      // probes the cheap rung again — a long session drifts back to the cheap tier.
      rung = "cheap";
      consecutiveStalls = 0;
      consecutiveDupTurns = 0;
      onStep({ type: "commit", turn, tier, fixRate: v.fixRate, solved: !!v.solved, memorySize: memory.length });
      if (v.solved) {
        solved = true;
        haltReason = "solved";
        onStep({ type: "halt", reason: haltReason, turns: turn + 1, solved: true, cost, escalations });
        break;
      }
    } else {
      // Neither tried rung advanced — de-ratchet (rotate focus / ground externally
      // next turn), never freeze. Nothing commits to memory (the ratchet holds).
      if (!v._dup) seenStalled.add(_stateHash(cand && cand.text));
      consecutiveStalls += 1;
      consecutiveDupTurns = dupsThisTurn >= triedTiers ? consecutiveDupTurns + 1 : 0;
      // Rise: the frontier was tried this turn and still no advance — starting the
      // next turn at the cheap rung would repeat a proven-futile call.
      if (stickyTiers && tier === "escalated") rung = "escalated";
      onStep({ type: "stall", turn, tier });
      // Contractive-escalation enforcement (#2867, the ILC ρ<1 condition,
      // US7345448B2/US8094405B1): a REAL verified escalation that failed to advance
      // means the expensive tier is non-contractive on this problem right now —
      // paying frontier rates for a plateau is exactly the runaway spend the
      // contract forbids. Halt honestly. (A dup-skipped escalation carried no new
      // information and does not trigger the contract; the loop detector owns it.)
      if (escalationContract && tier === "escalated" && !v._dup) {
        haltReason = "escalation-noncontractive";
        onStep({ type: "halt", reason: haltReason, turns: turn + 1, solved, cost, escalations });
        break;
      }
      // Stop-on-stall: a run of turns with zero real progress will not be saved by
      // more of the same — halt honestly instead of grinding out the turn cap.
      if (stallLimit > 0 && consecutiveDupTurns >= 2) {
        haltReason = "loop";
        onStep({ type: "halt", reason: haltReason, turns: turn + 1, solved, cost, escalations });
        break;
      }
      if (stallLimit > 0 && consecutiveStalls >= stallLimit) {
        haltReason = "stalled";
        onStep({ type: "halt", reason: haltReason, turns: turn + 1, solved, cost, escalations });
        break;
      }
    }
  }

  if (haltReason === "maxTurns") onStep({ type: "halt", reason: haltReason, turns: maxTurns, solved, cost, escalations });

  // #2869: an unsolved halt writes this run's verified failures back to the cache
  // (repeatable error, pre-subtracted next time). Solved runs record nothing.
  if (fcache && !solved && stalledForCache.length) {
    try {
      fcache.recordFailures({ problem, haltReason, stalledCandidates: stalledForCache });
    } catch { /* best-effort — never fail the run on a cache write */ }
  }

  const turns = corpusRows.length;
  return {
    solved,
    haltReason,
    turns,
    escalations,
    escalationRate: turns ? escalations / turns : 0,
    cost,
    y,
    memory,
    corpusRows,
    corpusFile: corpus.file || null,
    confidence: _wholeAnswerConfidence(best, solved),
  };
}

// Cheap content hash for the stop-on-stall loop detector: two proposals with the
// same text are the same state. Not security — just identity.
function _stateHash(text) {
  return crypto.createHash("sha1").update(String(text == null ? "" : text)).digest("hex");
}

/**
 * Whole-answer confidence: computed from the FULL final verified state — the
 * fraction of tests the best committed candidate passes — never inferred from where
 * the loop happened to stop (a "stalled" halt with 3/4 tests passing is 0.75, not
 * zero; a lucky early exit is not 1.0 unless every test passes). Solved ⇒ 1;
 * nothing ever committed ⇒ 0.
 */
function _wholeAnswerConfidence(best, solved) {
  if (solved) return 1;
  if (best == null) return 0;
  const s = summarize(best);
  return s.total > 0 ? s.passed / s.total : 0;
}

/**
 * Best-so-far test results after an advancing step. If verify() surfaced a raw result
 * set we ratchet against it; otherwise we keep the prior best (the score was
 * pre-computed and we can't reconstruct per-test identity). Kept tiny + explicit.
 */
function _bestResults(prevBest, v, cand) {
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v._results)) return v._results;
  if (cand && Array.isArray(cand.results)) return cand.results;
  return prevBest;
}

module.exports = { runSpiral, DEFAULT_FOCI };
