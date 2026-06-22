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

const MIN_TOKENS = 12; // below this there isn't enough signal — don't cry collapse

function tokenize(text) {
  const m = String(text || "").toLowerCase().match(/[\p{L}\p{N}']+/gu);
  return m || [];
}

function splitUnits(text) {
  // sentence/line units for literal self-repeat detection
  return String(text || "")
    .split(/[\n.!?]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 8);
}

function selfRepeatRatio(text) {
  const units = splitUnits(text);
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
  };

  if (tokens.length < MIN_TOKENS) {
    return { proximity: 0, collapsed: false, signals, reason: "too_short" };
  }

  signals.selfRepeatRatio = selfRepeatRatio(text);
  signals.ngramEchoRatio = ngramEchoRatio(tokens);
  signals.longestRunRatio = longestRunRatio(tokens);

  // Lexical-contraction penalty: healthy prose sits well above ~0.45 TTR; map the
  // shortfall below that floor into [0,1].
  const ttrFloor = 0.45;
  const ttrPenalty = Math.max(0, (ttrFloor - signals.typeTokenRatio) / ttrFloor);

  // Weighted blend — any single strong signal is enough to raise proximity.
  const proximity = Math.min(
    1,
    0.4 * signals.ngramEchoRatio +
      0.3 * ttrPenalty +
      0.2 * signals.selfRepeatRatio +
      0.1 * Math.min(1, signals.longestRunRatio * 5)
  );

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
  if (score.signals.selfRepeatRatio >= 0.5 || score.signals.longestRunRatio >= 0.2) {
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
