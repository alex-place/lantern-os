/-
# How long a norm-threshold canary takes to see an unstable mode

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, R2).

Nothing here is new mathematics: a left eigenvector and the Cauchy–Schwarz inequality.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/KreissCanaryLatency.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 9 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.InnerProductSpace.LinearMap
import Mathlib.Analysis.SpecialFunctions.Log.Basic

/-!
# C3: an upper bound on the canary's detection latency, and its attainment

`E` is an inner product space over `𝕜 = ℝ` or `ℂ`.  A left eigenvector of `A` for `μ` is `w` with
`w* A = μ w*`, i.e. `⟪w, A x⟫ = μ ⟪w, x⟫` for every `x` (for real `A` and real `μ`: `wᵀ A = μ wᵀ`).

Main results
* `inner_pow_apply`     : `⟪w, A^t x⟫ = μ^t ⟪w, x⟫`.
* `left_eigen_lower`    : `|μ|^t |⟪w, x⟫| ≤ ‖w‖ ‖A^t x‖`  (Cauchy–Schwarz).
* `fires_of_alignment`  : with `cos θ = |⟪w, x⟫| / (‖w‖ ‖x‖)`, if `|μ|^t cos θ > τ` then
                          `‖A^t x‖ > τ ‖x‖`: the canary has fired by step `t`.
* `latency_bound`       : `t > log(τ / cos θ) / log|μ|` (with `|μ| > 1`) implies `|μ|^t cos θ > τ`.
* `rankOne_pow_apply`, `latency_attained` : for the normal rank-one map `A = μ ⟪u, ·⟫ u` (`‖u‖ = 1`),
                          `‖A^t x‖ = |μ|^t |⟪u, x⟫|` for `t ≥ 1`: the bound is attained, so the
                          alignment factor `cos θ` is a real cost, not slack in the proof.
-/

noncomputable section

namespace KreissC

section Latency

variable {𝕜 : Type*} [RCLike 𝕜] {E : Type*} [NormedAddCommGroup E] [InnerProductSpace 𝕜 E]

local notation "⟪" x ", " y "⟫" => inner 𝕜 x y

theorem inner_pow_apply (A : E →L[𝕜] E) (w : E) (μ : 𝕜) (hw : ∀ x, ⟪w, A x⟫ = μ * ⟪w, x⟫)
    (t : ℕ) (x : E) : ⟪w, (A ^ t) x⟫ = μ ^ t * ⟪w, x⟫ := by
  induction t with
  | zero => simp
  | succ n ih =>
    rw [pow_succ', ContinuousLinearMap.mul_apply, hw, ih]
    ring

/-- **C3, the lower bound.** `|μ|^t |⟪w, x⟫| ≤ ‖w‖ ‖A^t x‖`. -/
theorem left_eigen_lower (A : E →L[𝕜] E) (w : E) (μ : 𝕜) (hw : ∀ x, ⟪w, A x⟫ = μ * ⟪w, x⟫)
    (t : ℕ) (x : E) : ‖μ‖ ^ t * ‖⟪w, x⟫‖ ≤ ‖w‖ * ‖(A ^ t) x‖ := by
  have h := norm_inner_le_norm (𝕜 := 𝕜) w ((A ^ t) x)
  rwa [inner_pow_apply A w μ hw, norm_mul, norm_pow] at h

/-- **C3, the firing criterion.** If `|μ|^t cos θ > τ`, the canary has fired at step `t`. -/
theorem fires_of_alignment (A : E →L[𝕜] E) (w : E) (μ : 𝕜)
    (hw : ∀ x, ⟪w, A x⟫ = μ * ⟪w, x⟫) (hw0 : w ≠ 0) {x : E} (hx : x ≠ 0) (t : ℕ) (τ : ℝ)
    (hfire : τ < ‖μ‖ ^ t * (‖⟪w, x⟫‖ / (‖w‖ * ‖x‖))) : τ * ‖x‖ < ‖(A ^ t) x‖ := by
  have hw' : 0 < ‖w‖ := norm_pos_iff.mpr hw0
  have hx' : 0 < ‖x‖ := norm_pos_iff.mpr hx
  have h := left_eigen_lower A w μ hw t x
  have h2 : τ * ‖x‖ < ‖μ‖ ^ t * ‖⟪w, x⟫‖ / ‖w‖ := by
    calc τ * ‖x‖ < ‖μ‖ ^ t * (‖⟪w, x⟫‖ / (‖w‖ * ‖x‖)) * ‖x‖ := mul_lt_mul_of_pos_right hfire hx'
      _ = ‖μ‖ ^ t * ‖⟪w, x⟫‖ / ‖w‖ * (‖x‖ / ‖x‖) := by ring
      _ = ‖μ‖ ^ t * ‖⟪w, x⟫‖ / ‖w‖ := by rw [div_self hx'.ne', mul_one]
  have h3 : ‖μ‖ ^ t * ‖⟪w, x⟫‖ / ‖w‖ ≤ ‖(A ^ t) x‖ := by
    rw [div_le_iff₀ hw']
    calc ‖μ‖ ^ t * ‖⟪w, x⟫‖ ≤ ‖w‖ * ‖(A ^ t) x‖ := h
      _ = ‖(A ^ t) x‖ * ‖w‖ := mul_comm _ _
  exact h2.trans_le h3

/-- The rank-one normal map `x ↦ μ ⟪u, x⟫ u`. -/
def rankOne (μ : 𝕜) (u : E) : E →L[𝕜] E := μ • (innerSL 𝕜 u).smulRight u

lemma rankOne_apply (μ : 𝕜) (u x : E) : rankOne μ u x = (μ * ⟪u, x⟫) • u := by
  simp only [rankOne, ContinuousLinearMap.smul_apply, ContinuousLinearMap.smulRight_apply,
    innerSL_apply_apply, smul_smul]

lemma inner_self_of_norm_one {u : E} (hu : ‖u‖ = 1) : ⟪u, u⟫ = 1 := by
  rw [inner_self_eq_norm_sq_to_K, hu]
  simp

/-- `u` is a left eigenvector of `rankOne μ u` for `μ` when `‖u‖ = 1`. -/
theorem rankOne_left_eigen (μ : 𝕜) {u : E} (hu : ‖u‖ = 1) (x : E) :
    ⟪u, rankOne μ u x⟫ = μ * ⟪u, x⟫ := by
  rw [rankOne_apply, inner_smul_right, inner_self_of_norm_one hu, mul_one]

theorem rankOne_pow_apply (μ : 𝕜) {u : E} (hu : ‖u‖ = 1) (x : E) (n : ℕ) :
    ((rankOne μ u) ^ (n + 1)) x = (μ ^ (n + 1) * ⟪u, x⟫) • u := by
  induction n with
  | zero => rw [zero_add, pow_one, pow_one, rankOne_apply]
  | succ m ih =>
    rw [pow_succ' (rankOne μ u) (m + 1), ContinuousLinearMap.mul_apply, ih, rankOne_apply,
      inner_smul_right, inner_self_of_norm_one hu, mul_one, pow_succ' μ (m + 1)]
    congr 1
    ring

/-- **C3, attainment.** For the rank-one normal map, `‖A^t x‖ = |μ|^t |⟪u, x⟫|` for `t ≥ 1`, so
`‖A^t x‖ / ‖x‖ = |μ|^t cos θ` exactly and the canary with threshold `τ` fires at step `t` iff
`|μ|^t cos θ > τ`. -/
theorem latency_attained (μ : 𝕜) {u : E} (hu : ‖u‖ = 1) (x : E) (n : ℕ) :
    ‖((rankOne μ u) ^ (n + 1)) x‖ = ‖μ‖ ^ (n + 1) * ‖⟪u, x⟫‖ := by
  rw [rankOne_pow_apply μ hu, norm_smul, hu, mul_one, norm_mul, norm_pow]

end Latency

/-- **C3, latency in steps.** With `|μ| > 1`, `τ > 0` and `cos θ > 0`, every
`t > log(τ / cos θ) / log |μ|` has `|μ|^t cos θ > τ`. -/
theorem latency_bound {m τ c : ℝ} (hm : 1 < m) (hτ : 0 < τ) (hc : 0 < c) (t : ℕ)
    (ht : Real.log (τ / c) / Real.log m < t) : τ < m ^ t * c := by
  have hl : 0 < Real.log m := Real.log_pos hm
  have h1 : Real.log (τ / c) < t * Real.log m := by rwa [div_lt_iff₀ hl] at ht
  have h2 : Real.log (τ / c) < Real.log (m ^ t) := by rwa [Real.log_pow]
  have h3 : τ / c < m ^ t :=
    (Real.log_lt_log_iff (div_pos hτ hc) (pow_pos (by linarith) t)).mp h2
  rwa [div_lt_iff₀ hc] at h3

end KreissC

#print axioms KreissC.inner_pow_apply
#print axioms KreissC.left_eigen_lower
#print axioms KreissC.fires_of_alignment
#print axioms KreissC.rankOne_apply
#print axioms KreissC.inner_self_of_norm_one
#print axioms KreissC.rankOne_left_eigen
#print axioms KreissC.rankOne_pow_apply
#print axioms KreissC.latency_attained
#print axioms KreissC.latency_bound
