"use strict";
// #2764 — a TRUST signal for a (local-model) answer + the "I'm not sure — want me to verify?"
// affordance, computed from the cheap signals we ALREADY measure.
//
// Honest framing: the raw unsupervised gates on the local model are weak (token-logprob AUROC
// ~0.56, canary ~0.66 — barely better than a coin flip), so this is a HEURISTIC fusion, NOT a
// calibrated probability. The strong signal — a supervised hidden-state honesty probe (~0.99) —
// is the real fix but needs the serving path; it plugs in here via `probe` and DOMINATES when
// present. Until then we lean on the two signals that are actually informative: the per-key
// historical calibration (Beta posterior from grounding-calibration) and whether external
// grounding actually fired this turn (measured to cut hallucination 0.55→0.20 when it does),
// plus evidence corroboration (#2844) and the grounding-weakness confidence ceiling.
//
// The load-bearing output is `offerVerify`: when trust is low, the assistant should proactively
// offer to verify / escalate rather than assert. Pure; never throws.

const HIGH = 0.7; // ≥ → "high" band
const LOW = 0.45; // ≥ → "medium"; below → "low"
const OFFER_VERIFY_BELOW = LOW; // below this, proactively offer to verify/escalate

function _c01(x) {
  x = Number(x);
  return x < 0 ? 0 : x > 1 ? 1 : x || 0;
}
function _band(t) {
  return t >= HIGH ? "high" : t >= LOW ? "medium" : "low";
}

/**
 * @param {object} s
 *   confidence           {number}       model/record self-confidence 0..1 (default 0.5)
 *   allowedMaxConfidence {number|null}  grounding-weakness ceiling (#2844 / ConvergenceRecord)
 *   calibrationTrust     {number|null}  per-key Beta posterior from grounding-calibration.trust()
 *   grounded             {boolean}      did external grounding actually fire this turn?
 *   corroboration        {number}       count of external corroborating docs (#2844)
 *   probe                {number|null}  hidden-state honesty probe 0..1 if wired (strong signal)
 * @returns {{trust,band,offerVerify,strongSignal,reasons}}
 */
function answerTrust(s = {}) {
  // The strong probe, once wired, dominates — it is the ~0.99 signal the weak gates approximate.
  if (s.probe != null) {
    const p = _c01(s.probe);
    return {
      trust: Number(p.toFixed(3)), band: _band(p), offerVerify: p < OFFER_VERIFY_BELOW,
      strongSignal: true, reasons: [`hidden-state probe ${p.toFixed(2)}`],
    };
  }

  const reasons = [];
  let t = _c01(s.confidence == null ? 0.5 : s.confidence);

  // grounding-weakness ceiling can only LOWER trust (weak grounding ⇒ don't over-trust)
  if (s.allowedMaxConfidence != null) {
    const ceil = _c01(s.allowedMaxConfidence);
    if (ceil < t) {
      t = ceil;
      reasons.push("confidence ceiling (weak grounding)");
    }
  }
  // per-key historical calibration — the strongest cheap signal — pulls trust toward measured reliability
  if (s.calibrationTrust != null) {
    const c = _c01(s.calibrationTrust);
    t = 0.5 * t + 0.5 * c;
    reasons.push(`key calibration ${c.toFixed(2)}`);
  }
  // external grounding fired this turn → a real, measured lift
  if (s.grounded) {
    t = _c01(t + 0.15);
    reasons.push("externally grounded this turn");
  } else {
    reasons.push("not externally grounded");
  }
  // corroborating literature (#2844) → small capped bump
  const corr = Number(s.corroboration) || 0;
  if (corr > 0) {
    t = _c01(t + Math.min(0.1, 0.03 * corr));
    reasons.push(`${corr} corroborating source(s)`);
  }

  t = _c01(t);
  return {
    trust: Number(t.toFixed(3)), band: _band(t), offerVerify: t < OFFER_VERIFY_BELOW,
    strongSignal: false, reasons,
  };
}

/** The user-facing affordance line for a low-trust answer (empty when trust is adequate). */
function verifyAffordance(res) {
  if (!res || !res.offerVerify) return "";
  return "I'm not fully sure about this — want me to verify it against sources or escalate to a stronger model?";
}

module.exports = { answerTrust, verifyAffordance, HIGH, LOW, OFFER_VERIFY_BELOW };
