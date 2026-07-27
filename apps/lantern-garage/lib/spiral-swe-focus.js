"use strict";

/**
 * Spiral focus — the SWE-shaped rotation (#2974).
 *
 * The harness's DEFAULT_FOCI (`outline / edge-cases / fix-failing / simplify / regressions`)
 * describes "write one function". A repository task has a different natural shape, and the
 * order is not cosmetic — each phase exists to make the next one cheaper:
 *
 *   localize  — find the file/function. This is the half small open models are measurably
 *               GOOD at; code editing is the reported bottleneck, not code localization.
 *   reproduce — write/run something that fails the way the issue describes. This is the
 *               load-bearing one: our own measurement puts frustration at phi-hat 0.80 on
 *               weak-verification workloads vs 0.092 with unit tests. A reproduction turns
 *               SWE-bench from the first regime into the second — after it exists, a wrong
 *               edit is caught immediately instead of hiding until the end.
 *   patch     — the actual change. Cheapest when the first two have already happened.
 *   regress   — run the PASS_TO_PASS subset. Catches a "fix" that broke something else.
 *   reflect   — say what the last observation actually meant before acting again.
 *
 * ROTATION IS STATE-AWARE, NOT A CLOCK. A blind `turn % 5` cycle would order a patch
 * before anything had been read and then move on from `reproduce` whether or not a
 * reproduction exists. Phase is therefore derived from what is in memory: the loop stays in
 * a phase until the evidence for leaving it is there, and falls back to advancing on turn
 * count only so a model that never satisfies a phase cannot wedge the run.
 *
 * ON REFLECTION — an honest note. Live-SWE-agent reports +3-5pp absolute from "interleaved
 * reflection after every step", where reflection is folded into the step prompt rather than
 * spent as its own turn. `focusGuidance()` reflects that: every phase's guidance opens by
 * asking what the last observation meant. The standalone `reflect` phase here is a
 * *stronger* dose used only where it is most likely to pay — after repeated failure — and
 * it does cost a turn. It is our adaptation, not their measured result, and it should not
 * be reported as reproducing their number.
 */

const SWE_FOCI = ["localize", "reproduce", "patch", "regress", "reflect"];

/** Did the model actually look at anything yet? */
function _hasExplored(memory) {
  return memory.some((m) => m && (m.observationOnly || m.action));
}

/** Heuristic evidence that a reproduction exists: a test file was touched or run. */
function _hasReproduced(memory) {
  return memory.some((m) => {
    const a = String((m && m.action) || "");
    const f = (m && m.files) || [];
    return /\btest|pytest|reproduce|repro\b/i.test(a) || f.some((x) => /test/i.test(String(x)));
  });
}

/** Has any edit actually landed on disk? */
function _hasPatched(memory) {
  return memory.some((m) => m && (m.edit || (m.files && m.files.length)));
}

/**
 * Build a rotation function for runSpiral's `rotate` slot.
 *
 * @param {object} opts
 *   reflectAfterStalls {number} consecutive unproductive turns before forcing a `reflect`
 *                               turn (default 2). 0 disables the standalone reflect phase.
 *   maxPhaseTurns      {number} hard cap on turns spent in one phase before advancing
 *                               regardless of evidence (default 4) — the anti-wedge.
 * @returns {function(turn, memory): string}
 */
function makeSweRotation(opts = {}) {
  const { reflectAfterStalls = 2, maxPhaseTurns = 4 } = opts;
  let phase = "localize";
  let phaseTurns = 0;
  let lastMemorySize = -1;
  let unproductive = 0;

  return function rotate(turn, memoryArg) {
    const memory = Array.isArray(memoryArg) ? memoryArg : [];

    // A turn that grew memory produced something; one that didn't was a stall or a
    // rejected duplicate. `rotate` is called before the turn runs, so this reads the
    // PREVIOUS turn's outcome — which is exactly what should steer this one.
    if (turn > 0) {
      if (memory.length > lastMemorySize) unproductive = 0;
      else unproductive += 1;
    }
    lastMemorySize = memory.length;

    if (reflectAfterStalls > 0 && unproductive >= reflectAfterStalls) {
      unproductive = 0;
      phaseTurns = 0;
      return "reflect"; // do not advance `phase`: reflect, then resume where we were
    }

    const advance = (next) => { phase = next; phaseTurns = 0; };
    phaseTurns += 1;
    const stuck = phaseTurns > maxPhaseTurns;

    switch (phase) {
      case "localize":
        if (_hasExplored(memory) || stuck) advance("reproduce");
        break;
      case "reproduce":
        if (_hasReproduced(memory) || stuck) advance("patch");
        break;
      case "patch":
        if (_hasPatched(memory) || stuck) advance("regress");
        break;
      case "regress":
        // The cycle's floor: an unsolved problem after a regression run goes back to
        // patching, not back to browsing. Localization was already paid for.
        if (stuck) advance("patch");
        break;
      default:
        advance("patch");
    }
    return phase;
  };
}

/** Per-phase instruction text for the tier prompt. */
const GUIDANCE = {
  localize:
    "Find where the bug lives. Read the issue, then use ONE command to search or read code (grep/find/sed -n). Do not edit anything yet.",
  reproduce:
    "Make the failure observable: write or run a test that fails the way the issue describes. A failing reproduction is worth more than a guess at the fix.",
  patch:
    "Make the smallest change that fixes the root cause you localized. Edit the source, not the test.",
  regress:
    "Run the existing test suite (or the closest fast subset) and check nothing that used to pass now fails.",
  reflect:
    "The last attempts did not advance. State in one line what the last observation actually told you and what assumption it contradicts, then take a DIFFERENT action than the ones already tried.",
};

/**
 * The prompt fragment for a phase. Every phase opens with the interleaved-reflection ask,
 * which is where Live-SWE-agent's gain comes from — the standalone `reflect` phase is the
 * escalated version, not the mechanism itself.
 */
function focusGuidance(focus) {
  const g = GUIDANCE[focus] || GUIDANCE.patch;
  if (focus === "reflect") return g;
  return `First, in one short line, say what the last observation told you. Then: ${g}`;
}

module.exports = { SWE_FOCI, makeSweRotation, focusGuidance, GUIDANCE };
