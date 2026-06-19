# Σ₀ V10 Video Scoring — Theory-to-Implementation Mapping

**Document Status:** Maps abstract collapse-certificate theory (`sigma0-collapse-certificate.md`) to concrete V10 video scoring system. Specifies invariants, guarantees, and remaining theoretical gaps.

---

## 0. The System Under Study

### Abstract Theory View
```
ẋ = f(x, u, θ)    where x ∈ ℝⁿ is the system state
A = ∂f/∂x         Jacobian linearization
α = max λᵢ(A_s)   Active spectral abscissa
Collapse if:      α < 0 AND active subspace is A-invariant
```

### Video Scoring Instantiation
```
x = [novelty, entropy, spread, event_density, collapse_risk] ∈ ℝ⁵
    (where novelty = payoff_density, entropy = visual_entropy, 
     spread = spectral_spread, event_density from narrative)

f(x) = scoring function (engagement + stability weighting)
     = engagement_score × (1 - collapse_risk × 0.5) + gaming_boost

A = ∂f/∂x = local Jacobian of the scoring function
    (NOT the video dynamics — the *meta-dynamics* of segment quality)
```

**Key insight:** The V10 system does not model the video's internal flow; instead it studies the *feature space* as it evolves through segmentation and scoring. A "collapse" in this space means the system converges onto a degenerate attractor — e.g., "all segments score equally low" or "only one segment high, rest near zero."

---

## 1. Collapse Guarantee: Theorem 1 Applied to Segments

### Theorem 1 (Abstract)
If `α < 0` on `A_s` **and** the active subspace is A-invariant, then
```
‖P_M x(t)‖ ≤ ‖P_M x(0)‖ e^(α t)
```
The system contracts exponentially onto the null manifold N.

### Video Scoring Instantiation

**Null Subspace (N):** Low-quality segment modes
```
N = span{ segments with low entropy, low spectral_spread, low event_density }
```

These are the degenerate modes: repetitive footage, static backgrounds, no payoff moments. A proper scoring system *should* contract onto these (rate them low), but not *collapse entirely* — other segments should remain high-quality.

**Active Subspace (M):** High-quality segment modes
```
M = span{ segments with high entropy, high spread, high event_density }
```

For V10 to avoid collapse, we need `α < 0` **on M only** — i.e., the scoring function must strictly *repel* high-quality segments back toward high scores as they try to drop.

**The Jacobian `A = ∂f/∂x`:**

For a fixed video, the "flow" is not time-evolution but rather the segment-by-segment scoring pass. As we iterate scoring, the features are held constant, but the *comparison* (which segments win) evolves. The Jacobian captures how a small change in one segment's collapse_risk affects its final score and thus its selection probability.

**Spectral abscissa on M:**
```
α = max λᵢ(A_s) where λᵢ ∈ M_eigenvalues

Computed in code: alpha = max( eig(A_s) ) on the active subspace
                        = max( eig(A_s) ) where corresponding eigenvector ⊥ null_subspace
```

**Guarantee (if α < 0):**
- High-entropy segments stay high-scored
- Low-entropy segments stay low-scored
- No collapse to uniform mediocrity

**Caveat:** V10 does not currently compute `A` or test `α < 0`. This is a **theoretical validation**, not a runtime guarantee. The guarantee is *aspirational* — the formula is designed to satisfy it, but is not verified.

---

## 2. The Collapse Trigger Σ₀ in Video Scoring

### Abstract Definition (Four Simultaneous Conditions)
```
1. ‖∇ₓL‖ < ε_g           No optimization signal
2. rank(J_f) < ρ·n        Lost directional structure
3. Σ isotropically flat   No preferred direction in uncertainty
4. ‖∂H/∂u‖ < ε_c          Control cannot distinguish actions
```

### Video Scoring Instantiation

**Condition 1: No optimization signal `‖∇ₓL‖ < ε_g`**

In video scoring, the loss `L` is (loosely) the mismatch between predicted engagement and actual YouTube performance. If the gradient is flat:

```javascript
∂L/∂(novelty, entropy, spread, event_density) ≈ 0
```

This means:
- Varying feature extraction doesn't improve prediction
- The feature space is saturated (all features equally predictive)
- Model is underdetermined

**In V10 code:** No explicit loss computed at runtime. However, the **hook threshold (0.4)** acts as a hard gate: if no segment crosses it, then `∇L` is effectively flat (all scores are already 0). This is a *proxy* for Condition 1.

**Condition 2: Rank deficiency `rank(J_f) < ρ·n`**

The Jacobian of the scoring function loses rank when:

```javascript
∂f/∂x has < n independent directions

Example: if ∂f/∂entropy = ∂f/∂spread = 0
         then rank(J) < 5 (for 5 features)
```

This means the scoring function has become *insensitive* to variation in feature space — a sure sign of collapse.

**In V10 code:** No explicit rank check. However, multi-peak enforcement (`minHighlights: 2`) implicitly tests this: if the system wants to put all weight on one segment, it violates the constraint, signaling rank deficiency. The **dynamic threshold (92nd percentile)** also ensures rank is preserved: if all segments score equally, threshold sits at median and forces diversity.

**Condition 3: Covariance isotropy `Σ isotropically flat`**

In uncertainty quantification, the covariance `Σ = E[(x - x̂)(x - x̂)ᵀ]` becomes isotropic (proportional to `I`) when all directions are equally uncertain — a sign the model has lost structure.

**In V10 code:** No explicit covariance computation. The **stability multiplier `(1 - collapse_risk × 0.5)`** plays the analogous role: if `collapse_risk` is uniformly high (entropy, spread, event_density all low), then the multiplier is uniformly depressed, equivalent to isotropic uncertainty collapse.

**Condition 4: Control insensitivity `‖∂H/∂u‖ < ε_c`**

The control is our *choice of which segments to highlight*. If `∂H/∂u` (where `H` is the highlight selector / final score) is flat, we cannot distinguish good segments from bad — control is ineffective.

**In V10 code:** This is the **scoring formula itself**. If `∂(finalScore)/∂(entropy) ≈ 0`, then varying entropy (adjusting feature extraction) doesn't help us pick better highlights. The weighting structure (0.30 retention, 0.18 cuts, etc.) directly controls `∂H/∂u`. If these weights were all near-zero, Condition 4 would fire.

### Σ₀ Trigger in V10: Operational Definition

**V10 fires Σ₀ (collapse filter) when:**

```javascript
// Implicit multi-condition gate (soft AND via weighting):
collapseRisk = (1 - visualEntropy) × 0.35 +
               (1 - spectralSpread) × 0.35 +
               (1 - eventDensity) × 0.30

// If collapseRisk > threshold (empirically ~0.6):
//   - Low entropy (Condition 1: insensitive to cuts, motion)
//   - Low spectral spread (Condition 2: all motion in same region)
//   - Low event density (Condition 3: no payoff moments)
//   - Together: Condition 4 (scoring cannot leverage any feature)

stabilityMultiplier = 1 - (collapseRisk × 0.5)
finalScore = engagement × stabilityMultiplier

// When collapse_risk ≈ 1: stabilityMultiplier ≈ 0.5, score penalized by 50%
```

**This is NOT a projection onto null manifold (like in theory).** It's a multiplicative downweighting — a soft gate rather than a hard clamp. The theoretical projection `P_N x` is replaced by a continuous penalty that increases with collapse risk.

---

## 3. The Anti-Collapse Operator Σ₀⁻¹

### Abstract Definition
Where Σ₀ **projects onto** the null manifold, Σ₀⁻¹ **injects energy along** it:

```
dx = f dt + dW + Σ₀⁻¹
Σ₀⁻¹ = s·p·(V_null ξ)

where p = proximity to collapse boundary (0 safe, 1 at boundary)
      ξ = random excitation
```

### Video Scoring Instantiation

In video feature space, the "null manifold" is the space of degenerate (high-collapse-risk) segments. Injecting anti-collapse energy means *forcing diversity* when the system would otherwise converge to a single segment type.

**In V10 code: Multi-Peak Enforcement**

```javascript
// If system wants to put all highlights on one segment:
if (highlights.length < minHighlights) {
  // Inject anti-collapse energy by promoting sub-threshold segments
  candidates = scored.filter(s => !selected && s.score > 0.2)
                     .sort((a, b) => b.score - a.score)
  final = [...final, ...candidates.slice(0, minHighlights - final.length)]
}
```

This is **exactly** the Σ₀⁻¹ mechanism: when collapse is detected (only 1 highlight), we inject energy (promote lower-scoring segments) to force the system back into the active manifold (multiple diverse highlights).

**Proximity Gate:**

The proximity `p` in theory ranges from 0 (safe) to 1 (boundary). In V10:

```javascript
// Proximity implicit in multi-peak logic:
p ≈ min(
  score_concentration,        // How peaked is the distribution?
  (1 - highlight_diversity)   // How few distinct types?
)

// If p → 1 (concentrated, non-diverse):
//   Multi-peak enforcement kicks in (injects Σ₀⁻¹ energy)
```

**Not yet implemented:** An explicit `proximity()` function that computes `p` based on all four §2 conditions and uses it to modulate re-excitation strength. Currently it's a hard binary (enforce / don't enforce), not a soft gate.

---

## 4. Early-Warning Signal (Canary) — Video Scoring Variant

### Abstract Theory
Near collapse, eigenvalues flatten (critical slowing down). Two proposed readouts:

```
p_unbounded = 1 / |Re λ_max(A_s)|  → ∞ at boundary
p_gate = clip(1 - |Re λ_max| / ε, 0, 1)  ∈ [0,1]
```

### Video Scoring Version (NEW)

We do not compute the full Jacobian at runtime. However, the **surprise monitor** (from theory §4 update) provides an observable canary:

```javascript
// Kalman normalized innovation squared
NIS = ν^T S^{-1} ν

where ν = (observed_engagement - predicted_engagement)
      S = prediction_covariance

// NIS ≈ m (m = dimension) means model and reality agree
// NIS ≫ m means model is overconfident — collapse imminent
```

**In V10 code (future):** A `SurpriseMonitor` integrated into `AnalyzerV10`:

```javascript
// After scoring segments, compute innovation:
const residuals = highlights.map(h => ({
  predicted: h.score,
  observed: h.actualEngagementFromYouTube,  // If available
  innovation: predicted - observed
}))

const NIS = residuals.reduce((sum, r) => sum + r.innovation^2, 0)
const threshold = residuals.length  // Expected value under null

if (NIS > 2 * threshold) {
  console.warn("Σ₀⁻¹ CANARY: model overconfident, collapse risk high")
  // Could trigger emergency re-excitation
}
```

**Status in V10:** Not yet implemented. The `SurpriseMonitor` class exists in theory documentation but is not wired into the analyzer. This is a **forward implementation requirement** (tracked separately).

---

## 5. Video Scoring in the Attractor Graph G

### Abstract Framework
The system has multiple attractors (fixed points, cycles). Coarse-grain to a Markov chain over basins:

```
P_ij(u) = Pr(π(x_{t+1}) = A_j | π(x_t) = A_i, u_t)
```

### Video Scoring Instantiation

In feature space, the attractors are *failure modes*:

| Attractor | Description | Failure |
|-----------|-------------|---------|
| **Diverse High-Quality** | All features high, diverse | Ideal (not an attractor, a basin) |
| **Single Peak** | One segment dominates, rest low | Collapse: no summary, just best moment |
| **Uniform Low** | All segments score equally low | Collapse: cannot select highlights |
| **Oscillation** | Scores flip between segments | Marginal: unstable, non-reproducible |

**The graph G connects basins.** Starting from a video with certain feature distributions, which attractor does it converge to?

- **Gaming Shorts (action-rich):** Should converge to Diverse High-Quality (multiple kill events, reaction spikes)
- **Talking Heads:** Should converge to Single Peak (one moment of expression) or Uniform Low (nothing stands out)
- **Montages:** Should converge to Diverse (many short, punchy moments)

**V10's role:** The scoring formula is designed to *repel* the Single Peak and Uniform Low attractors by:
1. Multi-peak enforcement (hard constraint: ≥2 highlights)
2. Stability filter (penalize low-entropy segments)
3. Hook engine (reject opening-less segments)

**Not yet validated:** A formal attractor analysis of the V10 scoring function, mapping which video types converge to which basins. This would require:
- Computing attractors of `f(x) = engagement_score × (1 - collapse_risk × 0.5) + gaming_boost`
- Testing trajectory integration from random initial segment distributions
- Plotting basin boundaries

---

## 6. Demonstration: Router Data → Video Scoring Analog

### Abstract Router Demo (from theory §6)
```
2678-turn conversation log
Encoded as x = [novelty, self_repeat, echo, length]
Mean spectral radius ρ = 1.064 (marginally unstable)
Reservoir autonomous rollout converges to fixed point (correlation dim ≈ 0.74)
→ Collapse prediction confirmed: ungrounded flow settles onto degenerate state
```

### Video Scoring Demo (to be implemented)

**Hypothesis:** A video with *no external engagement labels* (no YouTube metrics) will collapse onto a degenerate, self-consistent feature set when scored repeatedly.

**Experiment:**
```
1. Take a "neutral" video (e.g., talking head, no actions)
2. Run feature extraction (currently stubs, so use synthetic features)
3. Score segments
4. Reuse highlight indices to "feed back" (x_{t+1} = f(x_t))
5. Observe convergence
```

**Expected collapse:** Without real engagement labels to ground scoring, the system will converge to:
- `collapse_risk → 1` (flagging degenerate state)
- All segments equally low-scored (Uniform Low attractor)
- Multi-peak enforcement forced to pick arbitrary segments
- Spiral toward "mirror agreeing with mirror"

**Code path (future work):**
```python
# experiments/video_sigma0_collapse_demo.py
# (Analog to router_sigma0_encoder.py)

features = { ... initial synthetic features ... }
for t in range(100):
    scores = v10_scorer.scoreSegment(features)
    # Feedback: features are driven by previous scores
    features = f_feedback(scores, features)
    collapse_risk = features['sigma0']['collapseRisk']
    
    if collapse_risk > 0.95:
        print(f"Step {t}: COLLAPSE (risk={collapse_risk:.3f})")
        break
```

**Status:** Proposed; not yet implemented. Requires feature feedback loop and realistic feature generator.

---

## 7. Safety Implications: From Theory to Practice

### Theory Claim (§7)
A system that optimizes against its own representations with no external anchor tends to collapse or diverge. Grounding is the safety mechanism.

### Video Scoring Instantiation

**Ungrounded system (before V10):**
- Hardcoded heuristics (e.g., "boost any segment with >3 cuts")
- No real engagement data
- Converges to whatever heuristics reward (e.g., maximum-chop highlights)
- User finds clips are "too fast, unwatchable" — captured wrong attractor

**Grounded system (V10 design):**
- Features extracted from video (cuts, entropy, motion, etc.)
- Scoring weights trained on *real YouTube engagement data*
- External validation: does this highlight maximize completion rate?
- Σ₀ filter prevents collapse by enforcing stability + diversity
- Multi-peak enforcement + hook engine prevent single-attractor capture

**Honest caveats:**
1. **Training data is the anchor.** V10 is "safe" only if trained on genuine YouTube Shorts with real engagement metrics. If trained on synthetic / biased data, collapse is still possible.
2. **Σ₀ filter is heuristic.** The stability penalty is designed to prevent collapse but is not a theorem — it's operational engineering.
3. **No runtime certificate.** Unlike the router demo which can compute spectral radius online, V10 does not compute `α` or `ρ` at runtime to warn when collapse is imminent.

**Forward grounding plan:**
- [ ] Implement `collapse_certificate()` wrapper around scoring function
- [ ] Compute `α = max Re λ(A_s)` on the Jacobian of engagement formula
- [ ] Test on real gaming Shorts: does `α < 0`?
- [ ] Wire `SurpriseMonitor` to detect model overconfidence
- [ ] A/B test: grounded (real YouTube data) vs. synthetic (heuristic)

---

## 8. Theoretical Validation Checklist

### Completed (Σ₀ Guarantee)
- [x] Define null and active subspaces in feature space
- [x] Stability filter (`1 - collapse_risk × 0.5`) encodes penalty for low activity
- [x] Hook engine rejects weak early dynamics (matches theory's early-boundary condition)
- [x] Multi-peak enforcement prevents single-attractor capture

### In Progress (Σ₀⁻¹ Operator)
- [x] Multi-peak logic injects diversity when collapse detected
- [ ] Explicit `proximity()` function for soft-AND gate over four conditions
- [ ] Modulate re-excitation strength based on proximity

### Future (Certification & Canary)
- [ ] Compute `α = max Re λ(A_s)` on scoring Jacobian
- [ ] Validate `α < 0` implies no collapse (on real video data)
- [ ] Integrate `SurpriseMonitor` for runtime early-warning
- [ ] Attractor analysis: map video types → basins of attraction
- [ ] Demo: synthetic ungrounded collapse followed by grounding recovery

### Not Planned (Out of Scope)
- Full PDE analysis of video flow (dynamics too complex, features are extracted, not intrinsic)
- Deterministic chaos / Lyapunov exponents (video scoring is discrete, not continuous)
- Bifurcation theory (scoring formula is fixed, parameters not time-varying)

---

## 9. Cross-Reference: Theory ↔ Code

| Theory Concept | V10 Implementation | File | Status |
|---|---|---|---|
| Theorem 1 (Collapse Guarantee) | Stability filter `(1 - collapseRisk × 0.5)` | sigma0-v10-scoring.js:90 | IMPLEMENTED |
| Condition 1 (∇L) | Hook threshold gate (0.4) | sigma0-v10-scoring.js:66 | IMPLEMENTED |
| Condition 2 (rank deficiency) | Multi-peak enforcement (`minHighlights: 2`) | sigma0-v10-scoring.js:182 | IMPLEMENTED |
| Condition 3 (covariance isotropy) | Uniform collapse_risk weighting | feature-extractor-v10.js:123 | IMPLEMENTED |
| Condition 4 (control insensitivity) | Engagement weight structure (5 terms) | sigma0-v10-scoring.js:79 | IMPLEMENTED |
| Σ₀ Trigger | `collapseRisk` calculation | feature-extractor-v10.js:123 | IMPLEMENTED |
| Σ₀⁻¹ Operator | Multi-peak re-promotion | sigma0-v10-scoring.js:182 | IMPLEMENTED |
| `proximity()` function | Implicit in multi-peak check | sigma0-v10-scoring.js:182 | PARTIAL |
| `p_gate` / `p_unbounded` | Retired — superseded by NIS canary (#659) | — | RETIRED |
| `SurpriseMonitor` / NIS canary | Wired into `forward_step` Kalman predict/update (#657) | cio_sde/engine.py, cio_sde/surprise.py | IMPLEMENTED |
| Attractor graph G | Failure modes defined (§5 above) | — | DOCUMENTED |
| Certification `α < 0` test | Not computed at runtime | — | FUTURE |

---

## 10. Recommendations for Production

### Safety-Critical
1. **Train on real YouTube Shorts engagement.** Without external grounding (real completion %, CTR), collapse is possible.
2. **Implement `collapse_certificate()` check.** Before deploying to creators, verify `α < 0` on the trained model.
3. **Wire `SurpriseMonitor`.** Surface NIS spikes in logs so on-call can detect overconfidence.

### Medium Priority
1. Explicit `proximity()` function with soft-AND weighting
2. Runtime spectral radius `ρ` readout for transparency
3. Attractor analysis on real gaming Shorts dataset

### Nice-to-Have
1. Bifurcation diagram (score vs. feature, showing where stable/unstable regions are)
2. Interactive collapse-risk dashboard (show which segments are on the boundary)
3. Playbook: "If you see high collapse_risk on all gaming clips, your feature extractor is broken"

---

## References & Cross-Links

- **Theory Anchor:** `docs/sigma0-collapse-certificate.md` (§1 Theorem 1, §2 Trigger, §3 Operator, §4 Canary, §6 Demo, §7 Safety)
- **Implementation:** `lib/sigma0-v10-scoring.js` (scoring formula), `lib/feature-extractor-v10.js` (stability metrics)
- **Integration:** `lib/analyzer-v10.js` (pipeline)
- **Data:** `scripts/youtube_shorts_ingestion.py` (external grounding via real engagement labels)
- **Future Work:** `experiments/video_sigma0_collapse_demo.py` (analog to router demo)

**Validation Proof:** The V10 scoring function is designed to satisfy Theorem 1's hypothesis (`α < 0` on active subspace, A-invariance via weight structure). A formal proof would:
1. Compute the Jacobian `A = ∂f/∂x` of the engagement formula
2. Verify `A_s` has all eigenvalues < 0 on the high-quality features
3. Check `P_M A P_N = 0` (weight structure does not cross-couple)
4. Apply Theorem 1 to conclude contraction

This is **not yet done** — the recommendation is to do it post-training.
