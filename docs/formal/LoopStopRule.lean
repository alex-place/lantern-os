/-
# The stop rule needs `(I - J)⁻¹`, not the spectral radius

Claim 4 of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`,
§1.2.4 and R2). `LoopStopRuleNonlinear.lean` has the counterexample to the spectral-radius rule
and the averaged Jacobian.

Nothing here is new mathematics: the a-posteriori error identity of fixed-point iteration and the
Banach-lemma perturbation bound are textbook (Ortega & Rheinboldt 1970; Kelley 1995).

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopStopRule.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 13 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Normed.Operator.NormedSpace
import Mathlib.Topology.MetricSpace.ProperSpace
import Mathlib.Topology.Order.Compact

/-!
# Claim 4 (a), and the algebraic core of (c): the stop rule needs `(I - J)⁻¹`, not `ρ`

A looped model iterates `h_{k+1} = F h_k`.  The stop rule certifies `‖h_k - h⋆‖` from the last
step `Δh_k = F h_k - h_k`.

We work with continuous linear maps on a normed space `E` over a nontrivially normed field `𝕜`
(for `ℝ^d` take `E = EuclideanSpace ℝ (Fin d)`).  "`1` is not an eigenvalue of `J`" is expressed
as: `I - J` is a unit `u` of the ring `E →L[𝕜] E`, i.e. `↑u = 1 - J`; then `↑u⁻¹ = (I - J)⁻¹`.

Main results
* `error_identity`  : for `F h = J h + c` and any fixed point `h⋆`,
                      `h - h⋆ = -(I - J)⁻¹ (F h - h)` for every `h` (exact).
* `error_bound`     : `‖h - h⋆‖ ≤ ‖(I - J)⁻¹‖ * ‖F h - h‖`  (no dimension factor).
* `residual_le`     : `‖F h - h‖ ≤ ‖I - J‖ * ‖h - h⋆‖` (converse direction).
* `fixedPt_spec`, `fixedPt_unique` : `h⋆ = (I - J)⁻¹ c` is the unique fixed point.
* `error_bound_attained` : in a proper (e.g. finite-dimensional) real space the bound is
                      attained by some `h` with `F h ≠ h`, so the factor cannot be improved.
* `inv_norm_inverse_isLeast` : `‖(I - J)⁻¹‖⁻¹ = min_{‖x‖ = 1} ‖(I - J) x‖`
                      (for the Euclidean norm this minimum is `σ_min(I - J)`).
* `inverse_norm_le_of_norm_lt_one` : if `‖J‖ < 1` then `‖(I - J)⁻¹‖ ≤ (1 - ‖J‖)⁻¹`: the
                      Lipschitz rule `‖Δh‖/(1 - ‖J‖)` is valid but never sharper.
* `secant_error_identity`, `secant_error_bound` : for ANY map `F` with fixed point `h⋆` and any
                      linear `J̄` with `F h - F h⋆ = J̄ (h - h⋆)` and `I - J̄` invertible,
                      `h - h⋆ = -(I - J̄)⁻¹ (F h - h)`.  (For C¹ `F`, `J̄` is the averaged
                      Jacobian; that analytic step is in `LoopStopRuleNonlinear.lean`.)
* `lower_bound_perturb`, `secant_error_bound_perturb` : a computable version: from a reference
                      `A` with `‖x‖ ≤ M ‖(I - A) x‖` and `‖J̄ - A‖ ≤ η`, `M η < 1`,
                      `‖h - h⋆‖ ≤ M/(1 - M η) ‖F h - h‖`.
-/

namespace Claim4

section General

variable {𝕜 : Type*} [NontriviallyNormedField 𝕜]
variable {E : Type*} [NormedAddCommGroup E] [NormedSpace 𝕜 E]

/-- The fixed point `h⋆ = (I - J)⁻¹ c` of `h ↦ J h + c`, where `↑u = I - J`. -/
def fixedPt (u : (E →L[𝕜] E)ˣ) (c : E) : E := (↑u⁻¹ : E →L[𝕜] E) c

lemma unit_apply_inv_apply (u : (E →L[𝕜] E)ˣ) (y : E) :
    (u : E →L[𝕜] E) ((↑u⁻¹ : E →L[𝕜] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.mul_inv, ContinuousLinearMap.one_apply]

lemma inv_apply_unit_apply (u : (E →L[𝕜] E)ˣ) (y : E) :
    (↑u⁻¹ : E →L[𝕜] E) ((u : E →L[𝕜] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.inv_mul, ContinuousLinearMap.one_apply]

/-- `(I - J)⁻¹ c` is a fixed point of `F h = J h + c`. -/
theorem fixedPt_spec (J : E →L[𝕜] E) (u : (E →L[𝕜] E)ˣ) (hu : (u : E →L[𝕜] E) = 1 - J)
    (c : E) : J (fixedPt u c) + c = fixedPt u c := by
  have h1 : (u : E →L[𝕜] E) (fixedPt u c) = c := unit_apply_inv_apply u c
  rw [hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply] at h1
  calc J (fixedPt u c) + c = J (fixedPt u c) + (fixedPt u c - J (fixedPt u c)) := by rw [h1]
    _ = fixedPt u c := by abel

/-- **Claim 4a, the exact identity.** For `F h = J h + c` with `I - J` invertible and any fixed
point `x` (`J x + c = x`), every state `h` satisfies `h - x = -(I - J)⁻¹ (F h - h)`. -/
theorem error_identity (J : E →L[𝕜] E) (u : (E →L[𝕜] E)ˣ) (hu : (u : E →L[𝕜] E) = 1 - J)
    (c x h : E) (hfix : J x + c = x) :
    h - x = -((↑u⁻¹ : E →L[𝕜] E) (J h + c - h)) := by
  have hc : c = x - J x := eq_sub_of_add_eq ((add_comm c (J x)).trans hfix)
  have key : J h + c - h = -((u : E →L[𝕜] E) (h - x)) := by
    rw [hc, hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply, map_sub]
    abel
  rw [key, map_neg, neg_neg, inv_apply_unit_apply]

/-- The fixed point is unique: it is `(I - J)⁻¹ c`. -/
theorem fixedPt_unique (J : E →L[𝕜] E) (u : (E →L[𝕜] E)ˣ) (hu : (u : E →L[𝕜] E) = 1 - J)
    (c x : E) (hfix : J x + c = x) : x = fixedPt u c := by
  have h1 := error_identity J u hu c (fixedPt u c) x (fixedPt_spec J u hu c)
  rw [hfix, sub_self, map_zero, neg_zero] at h1
  exact sub_eq_zero.mp h1

/-- **Claim 4a, the bound.** `‖h - h⋆‖ ≤ ‖(I - J)⁻¹‖ ‖F h - h‖`, with no dimension factor. -/
theorem error_bound (J : E →L[𝕜] E) (u : (E →L[𝕜] E)ˣ) (hu : (u : E →L[𝕜] E) = 1 - J)
    (c x h : E) (hfix : J x + c = x) :
    ‖h - x‖ ≤ ‖(↑u⁻¹ : E →L[𝕜] E)‖ * ‖J h + c - h‖ := by
  rw [error_identity J u hu c x h hfix, norm_neg]
  exact ContinuousLinearMap.le_opNorm _ _

/-- The converse direction: `‖F h - h‖ ≤ ‖I - J‖ ‖h - h⋆‖`. -/
theorem residual_le (J : E →L[𝕜] E) (c x h : E) (hfix : J x + c = x) :
    ‖J h + c - h‖ ≤ ‖(1 - J : E →L[𝕜] E)‖ * ‖h - x‖ := by
  have hc : c = x - J x := eq_sub_of_add_eq ((add_comm c (J x)).trans hfix)
  have key : J h + c - h = -((1 - J : E →L[𝕜] E) (h - x)) := by
    rw [hc, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply, map_sub]
    abel
  rw [key, norm_neg]
  exact ContinuousLinearMap.le_opNorm _ _

/-- In a nontrivial space the inverse of a unit has positive norm. -/
lemma inv_norm_pos [Nontrivial E] (u : (E →L[𝕜] E)ˣ) : 0 < ‖(↑u⁻¹ : E →L[𝕜] E)‖ := by
  obtain ⟨y, hy⟩ := exists_ne (0 : E)
  refine norm_pos_iff.mpr (fun h0 => hy ?_)
  have h1 := inv_apply_unit_apply u y
  rw [h0, ContinuousLinearMap.zero_apply] at h1
  exact h1.symm

/-- If `‖J‖ < 1`, the classical Lipschitz/contraction rule is valid:
`‖(I - J)⁻¹‖ ≤ (1 - ‖J‖)⁻¹`.  So the exact factor `‖(I - J)⁻¹‖` is never worse than it. -/
theorem inverse_norm_le_of_norm_lt_one (J : E →L[𝕜] E) (u : (E →L[𝕜] E)ˣ)
    (hu : (u : E →L[𝕜] E) = 1 - J) (hJ : ‖J‖ < 1) :
    ‖(↑u⁻¹ : E →L[𝕜] E)‖ ≤ (1 - ‖J‖)⁻¹ := by
  have hpos : 0 < 1 - ‖J‖ := sub_pos.mpr hJ
  refine ContinuousLinearMap.opNorm_le_bound _ (inv_nonneg.mpr hpos.le) (fun y => ?_)
  have hux : (u : E →L[𝕜] E) ((↑u⁻¹ : E →L[𝕜] E) y) = y := unit_apply_inv_apply u y
  generalize hxdef : (↑u⁻¹ : E →L[𝕜] E) y = x at hux ⊢
  rw [hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply] at hux
  have hx : x = J x + y := by rw [← hux]; abel
  have h1 : ‖x‖ ≤ ‖J‖ * ‖x‖ + ‖y‖ := by
    calc ‖x‖ = ‖J x + y‖ := by rw [← hx]
      _ ≤ ‖J x‖ + ‖y‖ := norm_add_le _ _
      _ ≤ ‖J‖ * ‖x‖ + ‖y‖ := add_le_add (J.le_opNorm x) le_rfl
  have h2 : (1 - ‖J‖) * ‖x‖ ≤ ‖y‖ := by nlinarith [h1]
  calc ‖x‖ = (1 - ‖J‖)⁻¹ * ((1 - ‖J‖) * ‖x‖) := by
        rw [← mul_assoc, inv_mul_cancel₀ hpos.ne', one_mul]
    _ ≤ (1 - ‖J‖)⁻¹ * ‖y‖ := mul_le_mul_of_nonneg_left h2 (inv_nonneg.mpr hpos.le)

/-- **Claim 4c, algebraic core.** Let `F` be any map with fixed point `h⋆` and `J̄` any
continuous linear map with `F h - F h⋆ = J̄ (h - h⋆)` (for C¹ `F`: the averaged Jacobian
`J̄ = ∫₀¹ DF(h⋆ + t (h - h⋆)) dt`).  If `I - J̄` is invertible then
`h - h⋆ = -(I - J̄)⁻¹ (F h - h)` exactly. -/
theorem secant_error_identity (F : E → E) (hstar h : E) (hfix : F hstar = hstar)
    (Jbar : E →L[𝕜] E) (hsec : F h - F hstar = Jbar (h - hstar))
    (u : (E →L[𝕜] E)ˣ) (hu : (u : E →L[𝕜] E) = 1 - Jbar) :
    h - hstar = -((↑u⁻¹ : E →L[𝕜] E) (F h - h)) := by
  have key : F h - h = -((u : E →L[𝕜] E) (h - hstar)) := by
    rw [hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply, ← hsec, hfix]
    abel
  rw [key, map_neg, neg_neg, inv_apply_unit_apply]

/-- The corresponding bound, `‖h - h⋆‖ ≤ ‖(I - J̄)⁻¹‖ ‖F h - h‖`. -/
theorem secant_error_bound (F : E → E) (hstar h : E) (hfix : F hstar = hstar)
    (Jbar : E →L[𝕜] E) (hsec : F h - F hstar = Jbar (h - hstar))
    (u : (E →L[𝕜] E)ˣ) (hu : (u : E →L[𝕜] E) = 1 - Jbar) :
    ‖h - hstar‖ ≤ ‖(↑u⁻¹ : E →L[𝕜] E)‖ * ‖F h - h‖ := by
  rw [secant_error_identity F hstar h hfix Jbar hsec u hu, norm_neg]
  exact ContinuousLinearMap.le_opNorm _ _

/-- Perturbation lemma (Banach-lemma form, no inverse needed): if `‖x‖ ≤ M ‖(I - A) x‖` for all
`x`, `‖J̄ - A‖ ≤ η` and `M η < 1`, then `‖x‖ ≤ M/(1 - M η) ‖(I - J̄) x‖` for all `x`. -/
theorem lower_bound_perturb (A Jbar : E →L[𝕜] E) (M η : ℝ)
    (hM : ∀ x, ‖x‖ ≤ M * ‖(1 - A) x‖) (hη : ‖Jbar - A‖ ≤ η) (hMη : M * η < 1)
    (hM0 : 0 ≤ M) (x : E) : ‖x‖ ≤ M / (1 - M * η) * ‖(1 - Jbar) x‖ := by
  have hsplit : (1 - A) x = (1 - Jbar) x + (Jbar - A) x := by
    simp only [ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply]
    abel
  have h1 : ‖(1 - A) x‖ ≤ ‖(1 - Jbar) x‖ + η * ‖x‖ := by
    rw [hsplit]
    calc ‖(1 - Jbar) x + (Jbar - A) x‖ ≤ ‖(1 - Jbar) x‖ + ‖(Jbar - A) x‖ := norm_add_le _ _
      _ ≤ ‖(1 - Jbar) x‖ + η * ‖x‖ :=
        add_le_add le_rfl ((ContinuousLinearMap.le_opNorm _ _).trans
          (mul_le_mul_of_nonneg_right hη (norm_nonneg _)))
  have h2 : ‖x‖ ≤ M * ‖(1 - Jbar) x‖ + M * η * ‖x‖ := by
    calc ‖x‖ ≤ M * ‖(1 - A) x‖ := hM x
      _ ≤ M * (‖(1 - Jbar) x‖ + η * ‖x‖) := mul_le_mul_of_nonneg_left h1 hM0
      _ = M * ‖(1 - Jbar) x‖ + M * η * ‖x‖ := by ring
  have hpos : 0 < 1 - M * η := sub_pos.mpr hMη
  rw [div_mul_eq_mul_div, le_div_iff₀ hpos]
  nlinarith [h2]

/-- **Claim 4c, computable form.** With `F h - F h⋆ = J̄ (h - h⋆)` and a reference `A` (e.g. the
Jacobian at the current iterate) satisfying the perturbation hypotheses,
`‖h - h⋆‖ ≤ M/(1 - M η) ‖F h - h‖`. -/
theorem secant_error_bound_perturb (F : E → E) (hstar h : E) (hfix : F hstar = hstar)
    (Jbar A : E →L[𝕜] E) (hsec : F h - F hstar = Jbar (h - hstar)) (M η : ℝ)
    (hM : ∀ x, ‖x‖ ≤ M * ‖(1 - A) x‖) (hη : ‖Jbar - A‖ ≤ η) (hMη : M * η < 1)
    (hM0 : 0 ≤ M) : ‖h - hstar‖ ≤ M / (1 - M * η) * ‖F h - h‖ := by
  have key : (1 - Jbar) (h - hstar) = -(F h - h) := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply, ← hsec, hfix]
    abel
  have h1 := lower_bound_perturb A Jbar M η hM hη hMη hM0 (h - hstar)
  rwa [key, norm_neg] at h1

end General

section Real

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E]

/-- In a proper space (e.g. any finite-dimensional real normed space) a continuous linear map
attains its operator norm on the closed unit ball. -/
theorem exists_opNorm_attained [ProperSpace E] (A : E →L[ℝ] E) :
    ∃ v : E, ‖v‖ ≤ 1 ∧ ‖A v‖ = ‖A‖ := by
  obtain ⟨x₀, hx₀, hmax⟩ := (isCompact_closedBall (0 : E) 1).exists_isMaxOn
    ⟨0, Metric.mem_closedBall_self zero_le_one⟩ A.continuous.norm.continuousOn
  have hx₀' : ‖x₀‖ ≤ 1 := by simpa using hx₀
  have hbound : ∀ x : E, ‖A x‖ ≤ ‖A x₀‖ * ‖x‖ := by
    intro x
    rcases eq_or_ne x 0 with rfl | hx
    · simp
    · have hxpos : 0 < ‖x‖ := norm_pos_iff.mpr hx
      have hn : ‖‖x‖⁻¹ • x‖ = 1 := by
        rw [norm_smul, norm_inv, norm_norm, inv_mul_cancel₀ hxpos.ne']
      have hmem : ‖x‖⁻¹ • x ∈ Metric.closedBall (0 : E) 1 :=
        Metric.mem_closedBall.mpr (le_of_eq (by rw [dist_zero_right, hn]))
      have h1 : ‖A (‖x‖⁻¹ • x)‖ ≤ ‖A x₀‖ := (isMaxOn_iff.mp hmax) _ hmem
      rw [map_smul, norm_smul, norm_inv, norm_norm] at h1
      calc ‖A x‖ = ‖x‖ * (‖x‖⁻¹ * ‖A x‖) := by
            rw [← mul_assoc, mul_inv_cancel₀ hxpos.ne', one_mul]
        _ ≤ ‖x‖ * ‖A x₀‖ := mul_le_mul_of_nonneg_left h1 (norm_nonneg _)
        _ = ‖A x₀‖ * ‖x‖ := mul_comm _ _
  have hle : ‖A‖ ≤ ‖A x₀‖ := A.opNorm_le_bound (norm_nonneg _) hbound
  have hge : ‖A x₀‖ ≤ ‖A‖ :=
    calc ‖A x₀‖ ≤ ‖A‖ * ‖x₀‖ := A.le_opNorm x₀
      _ ≤ ‖A‖ * 1 := mul_le_mul_of_nonneg_left hx₀' (norm_nonneg _)
      _ = ‖A‖ := mul_one _
  exact ⟨x₀, hx₀', le_antisymm hge hle⟩

/-- A norm-attaining vector of `(I - J)⁻¹` in the unit ball has norm exactly `1`. -/
lemma attained_norm_one [Nontrivial E] (u : (E →L[ℝ] E)ˣ) {v : E} (hv1 : ‖v‖ ≤ 1)
    (hvR : ‖(↑u⁻¹ : E →L[ℝ] E) v‖ = ‖(↑u⁻¹ : E →L[ℝ] E)‖) : ‖v‖ = 1 := by
  have hRpos := inv_norm_pos (𝕜 := ℝ) u
  refine le_antisymm hv1 ?_
  have h1 : ‖(↑u⁻¹ : E →L[ℝ] E)‖ * 1 ≤ ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖v‖ := by
    rw [mul_one]
    calc ‖(↑u⁻¹ : E →L[ℝ] E)‖ = ‖(↑u⁻¹ : E →L[ℝ] E) v‖ := hvR.symm
      _ ≤ ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖v‖ := ContinuousLinearMap.le_opNorm _ v
  exact le_of_mul_le_mul_left h1 hRpos

/-- **Claim 4a, sharpness.** In a proper nontrivial real space (e.g. `ℝ^d`, any norm), the bound
`‖h - h⋆‖ ≤ ‖(I - J)⁻¹‖ ‖F h - h‖` is attained by some `h` with `F h ≠ h`. -/
theorem error_bound_attained [ProperSpace E] [Nontrivial E] (J : E →L[ℝ] E)
    (u : (E →L[ℝ] E)ˣ) (hu : (u : E →L[ℝ] E) = 1 - J) (c : E) :
    ∃ h : E, J h + c - h ≠ 0 ∧
      ‖h - fixedPt u c‖ = ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖J h + c - h‖ := by
  obtain ⟨v, hv1, hvR⟩ := exists_opNorm_attained (↑u⁻¹ : E →L[ℝ] E)
  have hvnorm : ‖v‖ = 1 := attained_norm_one u hv1 hvR
  have hres : ∀ w : E, (u : E →L[ℝ] E) w = c - v → J w + c - w = v := by
    intro w hw
    rw [hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply] at hw
    have hJw : J w = w - (c - v) := by rw [← hw]; abel
    rw [hJw]
    abel
  have hux : (u : E →L[ℝ] E) (fixedPt u c - (↑u⁻¹ : E →L[ℝ] E) v) = c - v := by
    rw [map_sub, fixedPt, unit_apply_inv_apply, unit_apply_inv_apply]
  have hres' := hres _ hux
  refine ⟨fixedPt u c - (↑u⁻¹ : E →L[ℝ] E) v, ?_, ?_⟩
  · rw [hres']
    intro hv0
    rw [hv0, norm_zero] at hvnorm
    exact zero_ne_one hvnorm
  · rw [hres', sub_sub_cancel_left, norm_neg, hvR, hvnorm, mul_one]

/-- `‖(I - J)⁻¹‖⁻¹` is the minimum of `‖(I - J) x‖` over the unit sphere.  For the Euclidean
norm that minimum is the smallest singular value, so `‖(I - J)⁻¹‖₂ = 1/σ_min(I - J)`. -/
theorem inv_norm_inverse_isLeast [ProperSpace E] [Nontrivial E] (u : (E →L[ℝ] E)ˣ) :
    IsLeast {r : ℝ | ∃ x : E, ‖x‖ = 1 ∧ r = ‖(u : E →L[ℝ] E) x‖}
      ‖(↑u⁻¹ : E →L[ℝ] E)‖⁻¹ := by
  have hRpos := inv_norm_pos (𝕜 := ℝ) u
  constructor
  · obtain ⟨v, hv1, hvR⟩ := exists_opNorm_attained (↑u⁻¹ : E →L[ℝ] E)
    have hvnorm : ‖v‖ = 1 := attained_norm_one u hv1 hvR
    have hwpos : 0 < ‖(↑u⁻¹ : E →L[ℝ] E) v‖ := by rw [hvR]; exact hRpos
    refine ⟨‖(↑u⁻¹ : E →L[ℝ] E) v‖⁻¹ • (↑u⁻¹ : E →L[ℝ] E) v, ?_, ?_⟩
    · rw [norm_smul, norm_inv, norm_norm, inv_mul_cancel₀ hwpos.ne']
    · rw [map_smul, unit_apply_inv_apply, norm_smul, norm_inv, norm_norm, hvnorm, mul_one, hvR]
  · rintro r ⟨x, hx, rfl⟩
    have h1 : ‖x‖ ≤ ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖(u : E →L[ℝ] E) x‖ := by
      calc ‖x‖ = ‖(↑u⁻¹ : E →L[ℝ] E) ((u : E →L[ℝ] E) x)‖ := by rw [inv_apply_unit_apply]
        _ ≤ _ := ContinuousLinearMap.le_opNorm _ _
    rw [hx] at h1
    calc ‖(↑u⁻¹ : E →L[ℝ] E)‖⁻¹ = ‖(↑u⁻¹ : E →L[ℝ] E)‖⁻¹ * 1 := (mul_one _).symm
      _ ≤ ‖(↑u⁻¹ : E →L[ℝ] E)‖⁻¹ * (‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖(u : E →L[ℝ] E) x‖) :=
          mul_le_mul_of_nonneg_left h1 (inv_nonneg.mpr hRpos.le)
      _ = ‖(u : E →L[ℝ] E) x‖ := by rw [← mul_assoc, inv_mul_cancel₀ hRpos.ne', one_mul]

end Real

end Claim4

#print axioms Claim4.fixedPt_spec
#print axioms Claim4.fixedPt_unique
#print axioms Claim4.error_identity
#print axioms Claim4.error_bound
#print axioms Claim4.residual_le
#print axioms Claim4.inverse_norm_le_of_norm_lt_one
#print axioms Claim4.secant_error_identity
#print axioms Claim4.secant_error_bound
#print axioms Claim4.lower_bound_perturb
#print axioms Claim4.secant_error_bound_perturb
#print axioms Claim4.exists_opNorm_attained
#print axioms Claim4.error_bound_attained
#print axioms Claim4.inv_norm_inverse_isLeast
