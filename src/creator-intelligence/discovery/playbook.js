// Editing Discovery Engine — playbook
// Turns discovered patterns into reusable editing techniques (named steps), and
// composes per-beat highlight records. The "verified" status of every technique
// is inherited straight from the pattern's gated performance — a technique is
// never promoted to "verified" without enough real outcome-labeled examples.
//
// See docs/creator-v10/ (editing discovery engine)

"use strict";

// Plain-language step copy for the roles in a technique's sequence.
const STEP_TEXT = {
  hook: "Open with a strong hook (question / claim / cold open)",
  build: "Build context or tension",
  surprise: "Land a surprise — a novel or multi-signal spike",
  payoff: "Deliver the payoff",
  cta: "Add the call-to-action",
};

/**
 * One highlight record per the spec, composed from measured signals only.
 * visual/editing patterns come from real tags; emotion only from A3 speech.
 */
function highlightRecord(beat, speech) {
  const tags = Array.isArray(beat.tags) ? beat.tags : [];
  const editing = [];
  if (tags.includes("scene")) editing.push("cut");
  if (tags.includes("novel")) editing.push("stands_out");
  if (tags.includes("combat")) editing.push("action_spike");
  const emotion = (speech && speech.measured && beat.role === "hook" && speech.hookStyle &&
                   speech.hookStyle !== "unknown") ? speech.hookStyle : null;
  return {
    timestamp: beat.t,
    role: beat.role,
    reason: beat.role,
    visualPattern: tags.includes("motion") ? "motion" : null,
    editingPattern: editing.length ? editing.join("+") : null,
    emotion,
    confidence: null, // measured per-clip confidence is attached upstream when available
  };
}

/**
 * Build playbook techniques from discovered patterns.
 * @param {Array} patterns  minePatterns().patterns
 * @param {Object} opts  { limit=10 }
 * @returns {{ techniques: Array, generatedAt, note }}
 */
function buildPlaybook(patterns, opts = {}) {
  const limit = opts.limit ?? 10;
  const techniques = (patterns || []).slice(0, limit).map((p) => {
    const perf = p.performance || { status: "insufficient_data" };
    return {
      id: "tech-" + p.id.replace(/^pat-/, ""),
      technique: p.label,
      sequence: p.sequence,
      steps: p.sequence.map((r, i) => `${i + 1}. ${STEP_TEXT[r] || r}`),
      // The technique's status mirrors the pattern's GATED performance.
      status: perf.status === "ok" ? (perf.calibrated ? "calibrated" : "directional") : "insufficient_data",
      performance: perf,
      frequency: p.frequency,
      structuralConfidence: p.structuralConfidence,
      examples: p.exampleClipIds,
      // "Best for" needs labeled, segmented-by-context outcomes we don't have yet.
      bestFor: { status: "insufficient_data" },
    };
  });

  return {
    techniques,
    generatedAt: new Date().toISOString(),
    note: "Techniques are STRUCTURAL discoveries (by frequency). 'status' reflects gated " +
          "performance: insufficient_data until enough outcome-labeled examples exist.",
  };
}

module.exports = { buildPlaybook, highlightRecord, STEP_TEXT };
