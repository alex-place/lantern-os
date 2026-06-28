// Σ₀ collapse canary for the live chat serving path (#1010).
//
// The Σ₀ §1 spectral certificate (src/cio_sde, src/sigma0/loop_lm.py) can detect
// collapsing / repeating / diverging generation, but it lives in Python and is not
// bound to the Node serving loop — so the cert can read "healthy" while a live reply
// is in loop-collapse. This is a lightweight, dependency-free TEXT canary that runs
// per reply on the serving path: it computes surface collapse signals (self-repeat,
// n-gram echo, lexical diversity) into a single `proximity` in [0,1] and, when that
// crosses threshold, emits a logged `canary_*` signal. It is a passive OBSERVER —
// no behavior change when healthy, and it feeds the existing certificate concept
// rather than adding a parallel decision layer.
//
// Signals (per convergence-plan-refinement.md, Refinement B — the cheap surface track):
//   - selfRepeatRatio : fraction of duplicated whole lines/sentences (literal loop)
//   - ngramEchoRatio  : 1 − unique(trigrams)/total(trigrams) (phrase echo)
//   - typeTokenRatio  : unique tokens / total tokens (lexical contraction; low = bad)
//   - longestRunRatio : longest immediate token-repeat run / total tokens

const { tokenize, splitUnits } = require("./canary-util");

const MIN_TOKENS = 12; // below this there isn't enough signal — don't cry collapse

function selfRepeatRatio(text) {
  // literal self-repeat: case-folded sentence/line units
  const units = splitUnits(text, { lower: true });
  if (units.length < 2) return 0;
  const seen = new Set();
  let dup = 0;
  for (const u of units) {
    if (seen.has(u)) dup++;
    else seen.add(u);
  }
  return dup / units.length;
}

function ngramEchoRatio(tokens, n = 3) {
  if (tokens.length < n + 1) return 0;
  const total = tokens.length - n + 1;
  const seen = new Set();
  for (let i = 0; i < total; i++) {
    seen.add(tokens.slice(i, i + n).join(" "));
  }
  return 1 - seen.size / total;
}

function longestRunRatio(tokens) {
  if (tokens.length < 2) return 0;
  let max = 1;
  let run = 1;
  for (let i = 1; i < tokens.length; i++) {
    run = tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run > max) max = run;
  }
  return (max - 1) / tokens.length;
}

// #1342: longest unbroken text segment, in tokens, splitting on sentence-enders
// AND newlines. This catches the "rambling run-on" collapse mode the repetition
// signals above MISS entirely — a fluent, lexically-diverse but topically-incoherent
// stream of words with no sentence boundaries (observed: a reply degenerating into
// hundreds of comma-less words drifting across languages/topics). Splitting on
// newlines too means code blocks and bullet lists (which lack periods but break on
// newlines) score LOW and never false-trigger. Evidence: real gibberish segments
// measured at 72-77+ tokens vs healthy prose / code / lists all ≤ 11.
function longestSegmentTokens(text) {
  let max = 0;
  for (const seg of String(text).split(/[.!?\n]+/)) {
    const n = seg.trim().split(/\s+/).filter(Boolean).length;
    if (n > max) max = n;
  }
  return max;
}

/**
 * Score a completed reply for collapse proximity.
 * @returns {{proximity:number, collapsed:boolean, signals:object, reason?:string}}
 */
function scoreReplyCollapse(text, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const tokens = tokenize(text);
  const signals = {
    tokens: tokens.length,
    selfRepeatRatio: 0,
    ngramEchoRatio: 0,
    typeTokenRatio: tokens.length ? new Set(tokens).size / tokens.length : 1,
    longestRunRatio: 0,
    longestSegmentTokens: 0,
  };

  if (tokens.length < MIN_TOKENS) {
    return { proximity: 0, collapsed: false, signals, reason: "too_short" };
  }

  signals.selfRepeatRatio = selfRepeatRatio(text);
  signals.ngramEchoRatio = ngramEchoRatio(tokens);
  signals.longestRunRatio = longestRunRatio(tokens);
  signals.longestSegmentTokens = longestSegmentTokens(text);

  // Lexical-contraction penalty: healthy prose sits well above ~0.45 TTR; map the
  // shortfall below that floor into [0,1].
  const ttrFloor = 0.45;
  const ttrPenalty = Math.max(0, (ttrFloor - signals.typeTokenRatio) / ttrFloor);

  // #1342: run-on penalty for the rambling-collapse mode. Nothing legitimate lives
  // between ~11 (healthy max) and ~70 (gibberish floor) tokens of unbroken segment,
  // so ramp 45→95: a 45-token unbroken run is still 0 (a long-but-legit sentence),
  // 95+ is full collapse. Orthogonal to the repetition signals, so it's MAX-combined
  // below rather than averaged in (a run-on alone is enough; averaging would dilute it).
  const runOnPenalty = Math.max(0, Math.min(1, (signals.longestSegmentTokens - 45) / 50));

  // Weighted blend of the repetition signals — any single strong one raises proximity.
  const repetitionBlend =
    0.4 * signals.ngramEchoRatio +
    0.3 * ttrPenalty +
    0.2 * signals.selfRepeatRatio +
    0.1 * Math.min(1, signals.longestRunRatio * 5);

  // The two failure modes (repetition vs run-on rambling) are independent — take the
  // worse of the two rather than blending, so neither masks the other.
  const proximity = Math.min(1, Math.max(repetitionBlend, runOnPenalty));

  return {
    proximity: Number(proximity.toFixed(4)),
    collapsed: proximity >= threshold,
    signals,
  };
}

/**
 * Build the logged canary signal payload for a collapsed reply. The recommended
 * action mirrors the §1 anti_collapse_signal vocabulary but is advisory here — the
 * canary stays passive on the serving path.
 */
function antiCollapseSignal(score) {
  let action = "inject_novelty";
  if (score.signals.longestSegmentTokens >= 70) {
    // run-on rambling: the model has lost sentence structure — stop it (#1342)
    action = "truncate_output";
  } else if (score.signals.selfRepeatRatio >= 0.5 || score.signals.longestRunRatio >= 0.2) {
    action = "truncate_context";
  } else if (score.signals.typeTokenRatio < 0.2) {
    action = "switch_agent";
  }
  return {
    event: "canary_collapse",
    proximity: score.proximity,
    action,
    signals: score.signals,
  };
}

module.exports = {
  scoreReplyCollapse,
  antiCollapseSignal,
  MIN_TOKENS,
};
