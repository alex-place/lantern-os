"use strict";
// #2857 (Converge, meta) — the UNIFIED CONTROL LAW that composes the owned Σ₀ math (M1/M2/M4/M5/M6)
// into one per-step decision, giving the convergence + bounded-cost guarantees the drift/snowball
// literature lacks.
//
// The thesis it encodes: self-improvement loops SATURATE (Gödel/DGM/STOP; 2607.04277). Introspection
// alone cannot raise *justified* confidence — by M1 that's a supermartingale unless external
// evidence arrives. So the ONLY unbounded improvement term is M1's external-evidence influx, and
// the control law's job is to (a) KILL the confident-unanchored runaway (M6 lasing), (b) HALT at a
// stable fixed point (M4), (c) route to GROUNDING whenever improvement has saturated on
// introspection (M1+M2) as long as it's affordable (M5), and (d) otherwise keep looping.
//
// Pure decision core; never throws. Priority order is deliberate: anti-runaway before halt before
// ground before continue.
//
// M7 (attribution loss — docs/research/2026-07-24-owned-math-m7-attribution.md): M6's kill side
// condition is PER-MODE ("zero external-innovation coupling"), but `evidenceInflux` is a global
// per-step bit. Testing the global bit admits evidence laundering — an unrelated feed item every
// step suppresses the kill while a mode snowballs unanchored (two-world impossibility, Lemma 3).
// The keyed signal `evidenceForMode` closes it; omitted, the legacy global fallback applies.
//
// @typedef {Object} ConvergeSignals
//   gainOverLeak   {number}  M6: per-mode G/L; > 1 = lasing (runaway gain)
//   evidenceInflux {boolean} M1: did external evidence arrive this step? (the only unbounded term)
//   evidenceForMode {boolean} M7 keyed anchor (optional): did evidence ATTRIBUTED TO the mode whose
//                             gainOverLeak is reported arrive this step? Ledger vocabulary: the
//                             mode's PAID confidence mass moved (M1 paid/free split). When omitted,
//                             rule 1 falls back to the global evidenceInflux bit — laundering-blind.
//   confidenceRising {boolean} M1: is justified confidence increasing?
//   fixedPoint     {boolean} M4: latent fixed point reached (accel/converge exit)
//   stable         {boolean} M4/JSRR: ρ(A) < 1 (no non-normal transient escape)
//   groundingDue   {boolean} M2: EOQ re-grounding cadence elapsed for this key
//   budgetRemaining{number}  M5: grounding/compute budget left this step (≤0 = can't afford to ground)

const LASING = 1.0; // G/L > 1 → lasing

/**
 * @param {ConvergeSignals} s
 * @returns {{action:("kill"|"halt_converged"|"halt_saturated"|"ground"|"continue"), reason:string, improving:boolean, saturated:boolean}}
 */
function convergeControl(s = {}) {
  const gainOverLeak = Number(s.gainOverLeak);
  const evidenceInflux = !!s.evidenceInflux;
  const confidenceRising = !!s.confidenceRising;
  const fixedPoint = !!s.fixedPoint;
  const stable = !!s.stable;
  const groundingDue = !!s.groundingDue;
  const budget = Number(s.budgetRemaining);
  const haveBudget = Number.isFinite(budget) ? budget > 0 : true; // unknown budget → assume affordable

  // The engine is only truly IMPROVING when external evidence is arriving (M1's unbounded term).
  const improving = evidenceInflux && confidenceRising;
  // SATURATED = raising confidence by introspection alone (no evidence influx) and not converged —
  // the regime the saturation literature says is asymptotically flat.
  const saturated = !evidenceInflux && !fixedPoint;

  // 1) Anti-runaway FIRST: a lasing mode (G/L > 1) with no external anchor is the confident-
  //    unanchored snowball — kill it regardless of everything else (M6). The anchor must be
  //    KEYED to the lasing mode when the caller can attribute it (M7); global influx is the
  //    legacy fallback and is provably launderable (Lemma 3).
  const modeAnchored = s.evidenceForMode === undefined ? evidenceInflux : !!s.evidenceForMode;
  if (Number.isFinite(gainOverLeak) && gainOverLeak > LASING && !modeAnchored) {
    const laundered = evidenceInflux && s.evidenceForMode !== undefined;
    return {
      action: "kill",
      reason: `M6 lasing: G/L=${gainOverLeak} > 1 and mode-unanchored${laundered ? " (global evidence present but none attributed to this mode — M7 laundering guard)" : ""}`,
      improving, saturated,
    };
  }

  // 2) HALT at a stable latent fixed point with nothing pending to re-ground (M4 + JSRR).
  if (fixedPoint && stable && !groundingDue) {
    return { action: "halt_converged", reason: "M4 fixed point reached and JSRR-stable", improving, saturated };
  }

  // 3) GROUND when re-grounding is due (M2) or improvement has saturated on introspection — but
  //    only if we can afford it (M5). Grounding is the ONLY way to legitimately raise confidence.
  if (groundingDue || saturated) {
    if (haveBudget) {
      return {
        action: "ground",
        reason: groundingDue ? "M2 re-grounding cadence elapsed" : "saturated on introspection — only external evidence can improve (M1)",
        improving, saturated,
      };
    }
    // Out of budget: bounded-cost halt — can't buy the evidence this branch needs. Two distinct
    // states land here and the record must not conflate them (M7 finding F2): truly saturated
    // (introspection-flat, not converged) vs converged-but-stale (fixed point reached, cadence
    // elapsed, re-anchor unaffordable). Action stays "halt_saturated" — conservative: neither
    // state has a fresh anchor, so neither earns the trust of "halt_converged".
    return {
      action: "halt_saturated",
      reason: saturated
        ? "saturated and grounding budget exhausted (M5) — bounded-cost halt"
        : "grounding due but budget exhausted (M5) — bounded-cost halt without a fresh anchor (stale, not saturated)",
      improving, saturated,
    };
  }

  // 4) Otherwise keep looping (still making grounded progress, or converging toward a fixed point).
  return { action: "continue", reason: improving ? "improving on external evidence" : "converging", improving, saturated };
}

module.exports = { convergeControl, LASING };
