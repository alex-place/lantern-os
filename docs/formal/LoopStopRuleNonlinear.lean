/-
# The spectral-radius stop rule fails, and the averaged Jacobian

Claim 4 of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`,
§1.2.4 and R2).

Nothing here is new mathematics: the counterexample is a 2 × 2 Jordan-type block, the classical
example of non-normal behaviour (Trefethen & Embree 2005), and the averaged Jacobian is the mean value
theorem in integral form.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopStopRuleNonlinear.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 14 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.InnerProductSpace.PiL2
import Mathlib.MeasureTheory.Integral.IntervalIntegral.FundThmCalculus

/-!
# Claim 4 (b): the spectral-radius stop rule fails;  Claim 4 (c): the averaged Jacobian

**(4b).** On `ℝ²` with the Euclidean norm (`EuclideanSpace ℝ (Fin 2)`), let
`J = [[ρ, a], [0, ρ]]` and `F h = J h` (so `c = 0`, `h⋆ = 0`).  Every complex eigenvalue of `J`
is `ρ` (`J_eigenvalues`), so `ρ(J) = |ρ|`.  The state `hgen ρ a = -(I - J)⁻¹ e₂` has residual
`F h - h = e₂` (norm `1`) and error `‖h - h⋆‖ ≥ |a|/(1 - ρ)²` (`rho_rule_gap`), while the planned
rule certifies `‖Δh‖/(1 - ρ(J)) = 1/(1 - ρ)` for `0 ≤ ρ < 1`.

The instance `ρ = 1/2`, `a = 10` (`rho_rule_fails`): residual `e₂`, error `√1604 > 40`, against
the rule's `2`.  The exact factor is `‖(I - J)⁻¹‖₂ = 20 + 2√101 ≈ 40.10`: it bounds every state
(`demo_sharp_bound`) and is attained (`demo_sharp_attained`).  The map is not a Euclidean
contraction (`Fdemo_not_contraction`), so the classical Lipschitz rule does not apply either.

**(4c).** For `F` differentiable along the segment `[h⋆, h]` with derivative `F'` continuous on
it, `F h - F h⋆ = J̄ (h - h⋆)` with `J̄ = ∫₀¹ F'(h⋆ + t (h - h⋆)) dt` (`secant_eq_integral`).  Hence,
for a fixed point `h⋆`, `h - h⋆ = -(I - J̄)⁻¹ (F h - h)` whenever `I - J̄` is invertible
(`nonlinear_error_identity`).  Only Jacobians on the segment enter (`avg_jacobian_close`), and
`nonlinear_certified_bound` gives the bound from a reference Jacobian `A` without inverting
`I - J̄`.
-/

noncomputable section

namespace Claim4

open Real

/-! ## (4b) -/

/-- `ℝ²` with the Euclidean norm. -/
abbrev E2 := EuclideanSpace ℝ (Fin 2)

lemma E2_ext {x y : E2} (h0 : x 0 = y 0) (h1 : x 1 = y 1) : x = y := by
  refine PiLp.ext (fun i => ?_)
  fin_cases i
  · exact h0
  · exact h1

lemma E2_norm_sq (v : E2) : ‖v‖ ^ 2 = v 0 ^ 2 + v 1 ^ 2 := by
  rw [EuclideanSpace.norm_sq_eq, Fin.sum_univ_two, Real.norm_eq_abs, Real.norm_eq_abs, sq_abs,
    sq_abs]

/-- `F h = J h` (so `c = 0` and `h⋆ = 0`) with `J = [[ρ, a], [0, ρ]]`. -/
def Fgen (ρ a : ℝ) (x : E2) : E2 := !₂[ρ * x 0 + a * x 1, ρ * x 1]

/-- The exhibited state `h = -(I - J)⁻¹ e₂ = -(a/(1-ρ)², 1/(1-ρ))`. -/
def hgen (ρ a : ℝ) : E2 := !₂[-(a * ((1 - ρ)⁻¹) ^ 2), -((1 - ρ)⁻¹)]

theorem Fgen_zero (ρ a : ℝ) : Fgen ρ a 0 = 0 := by
  apply E2_ext
  · show ρ * 0 + a * 0 = 0
    ring
  · show ρ * 0 = 0
    ring

/-- The residual of the exhibited state is the unit vector `e₂`. -/
theorem Fgen_hgen_residual (ρ a : ℝ) (hρ : ρ ≠ 1) :
    Fgen ρ a (hgen ρ a) - hgen ρ a = !₂[0, 1] := by
  have hs : (1 - ρ)⁻¹ * (1 - ρ) = 1 := inv_mul_cancel₀ (sub_ne_zero.mpr (Ne.symm hρ))
  apply E2_ext
  · show ρ * (-(a * ((1 - ρ)⁻¹) ^ 2)) + a * (-((1 - ρ)⁻¹)) - (-(a * ((1 - ρ)⁻¹) ^ 2)) = 0
    linear_combination (a * (1 - ρ)⁻¹) * hs
  · show ρ * (-((1 - ρ)⁻¹)) - (-((1 - ρ)⁻¹)) = 1
    linear_combination hs

theorem norm_e2 : ‖(!₂[0, 1] : E2)‖ = 1 := by
  have h : ‖(!₂[0, 1] : E2)‖ ^ 2 = 1 ^ 2 := by
    rw [E2_norm_sq]
    show (0 : ℝ) ^ 2 + 1 ^ 2 = 1 ^ 2
    norm_num
  exact (sq_eq_sq₀ (norm_nonneg _) zero_le_one).mp h

/-- The error of the exhibited state is at least `|a|/(1-ρ)²`. -/
theorem hgen_norm_ge (ρ a : ℝ) : |a| / (1 - ρ) ^ 2 ≤ ‖hgen ρ a‖ := by
  have hsq : ‖hgen ρ a‖ ^ 2 = (-(a * ((1 - ρ)⁻¹) ^ 2)) ^ 2 + (-((1 - ρ)⁻¹)) ^ 2 :=
    E2_norm_sq _
  have hle : (a * ((1 - ρ)⁻¹) ^ 2) ^ 2 ≤ ‖hgen ρ a‖ ^ 2 := by
    rw [hsq, neg_sq, neg_sq]
    exact le_add_of_nonneg_right (sq_nonneg _)
  have h2 := sq_le_sq.mp hle
  rw [abs_norm, abs_mul, abs_of_nonneg (sq_nonneg ((1 - ρ)⁻¹)), inv_pow, ← div_eq_mul_inv] at h2
  exact h2

/-- Every complex eigenvalue of `J = [[ρ, a], [0, ρ]]` is `ρ` (eigen-equations written out for
`J v = λ v`, `v = (v0, v1) ≠ 0`). -/
theorem J_eigenvalues (ρ a : ℝ) (lam v0 v1 : ℂ) (hv : v0 ≠ 0 ∨ v1 ≠ 0)
    (h0 : (ρ : ℂ) * v0 + (a : ℂ) * v1 = lam * v0) (h1 : (ρ : ℂ) * v1 = lam * v1) :
    lam = (ρ : ℂ) := by
  rcases eq_or_ne v1 0 with hv1 | hv1
  · have hv0 : v0 ≠ 0 := hv.resolve_right (not_not.mpr hv1)
    rw [hv1, mul_zero, add_zero] at h0
    exact (mul_right_cancel₀ hv0 h0).symm
  · exact (mul_right_cancel₀ hv1 h1).symm

/-- `ρ` is an eigenvalue, with eigenvector `(1, 0)`.  Hence the spectrum is `{ρ}`, `ρ(J) = |ρ|`. -/
theorem J_eigenvector (ρ a : ℝ) :
    (ρ : ℂ) * 1 + (a : ℂ) * 0 = (ρ : ℂ) * 1 ∧ (ρ : ℂ) * 0 = (ρ : ℂ) * 0 :=
  ⟨by ring, rfl⟩

/-- **Claim 4b, general `ρ ≠ 1`, `a`.**  The state `hgen ρ a` has residual `e₂` (norm `1`) and
error at least `|a|/(1-ρ)²` from the fixed point `0`. -/
theorem rho_rule_gap (ρ a : ℝ) (hρ : ρ ≠ 1) :
    Fgen ρ a 0 = 0 ∧
    Fgen ρ a (hgen ρ a) - hgen ρ a = !₂[0, 1] ∧
    ‖Fgen ρ a (hgen ρ a) - hgen ρ a‖ = 1 ∧
    |a| / (1 - ρ) ^ 2 ≤ ‖hgen ρ a - 0‖ := by
  refine ⟨Fgen_zero ρ a, Fgen_hgen_residual ρ a hρ, ?_, ?_⟩
  · rw [Fgen_hgen_residual ρ a hρ]
    exact norm_e2
  · rw [sub_zero]
    exact hgen_norm_ge ρ a

/-- The demo map: `ρ = 1/2`, `a = 10`. -/
def Fdemo : E2 → E2 := Fgen (1/2) 10

/-- The exhibited iterate `h = (-40, -2) = -(I - J)⁻¹ e₂`. -/
def hdemo : E2 := !₂[-40, -2]

theorem Fdemo_fixed_unique (x : E2) (hx : Fdemo x = x) : x = 0 := by
  have h0 : (1/2 : ℝ) * x 0 + 10 * x 1 = x 0 := congrArg (fun y : E2 => y 0) hx
  have h1 : (1/2 : ℝ) * x 1 = x 1 := congrArg (fun y : E2 => y 1) hx
  have hx1 : x 1 = 0 := by linarith
  have hx0 : x 0 = 0 := by linarith
  exact E2_ext hx0 hx1

theorem hdemo_residual : Fdemo hdemo - hdemo = !₂[0, 1] := by
  apply E2_ext
  · show (1/2 : ℝ) * (-40) + 10 * (-2) - (-40) = 0
    norm_num
  · show (1/2 : ℝ) * (-2) - (-2) = 1
    norm_num

theorem norm_hdemo : ‖hdemo‖ = √1604 := by
  rw [← Real.sqrt_sq (norm_nonneg hdemo), E2_norm_sq]
  show √((-40 : ℝ) ^ 2 + (-2) ^ 2) = √1604
  norm_num

theorem forty_lt_sqrt1604 : (40 : ℝ) < √1604 := by
  rw [Real.lt_sqrt (by norm_num)]
  norm_num

/-- **Claim 4b, the instance `ρ = 1/2`, `a = 10`.**  `h⋆ = 0` is the unique fixed point; the
exhibited state has `‖Δh‖ = 1` and `‖h - h⋆‖ = √1604 > 40`, while the planned rule
`‖Δh‖/(1 - ρ(J))` gives `2` (with `ρ(J) = 1/2` by `J_eigenvalues`).  The rule under-reports the
error by more than a factor `20`. -/
theorem rho_rule_fails :
    Fdemo 0 = 0 ∧
    (∀ x : E2, Fdemo x = x → x = 0) ∧
    Fdemo hdemo - hdemo = !₂[0, 1] ∧
    ‖Fdemo hdemo - hdemo‖ = 1 ∧
    ‖hdemo - 0‖ = √1604 ∧
    ‖Fdemo hdemo - hdemo‖ / (1 - 1/2) = 2 ∧
    20 * (‖Fdemo hdemo - hdemo‖ / (1 - 1/2)) < ‖hdemo - 0‖ := by
  have hres : ‖Fdemo hdemo - hdemo‖ = 1 := by
    rw [hdemo_residual]
    exact norm_e2
  have herr : ‖hdemo - 0‖ = √1604 := by
    rw [sub_zero]
    exact norm_hdemo
  have hrule : ‖Fdemo hdemo - hdemo‖ / (1 - 1/2) = 2 := by
    rw [hres]
    norm_num
  refine ⟨Fgen_zero (1/2) 10, Fdemo_fixed_unique, hdemo_residual, hres, herr, hrule, ?_⟩
  rw [hrule, herr]
  calc (20 : ℝ) * 2 = 40 := by norm_num
    _ < √1604 := forty_lt_sqrt1604

/-- **The exact a-posteriori constant for the demo.**  For every state `h`,
`‖h - h⋆‖ ≤ (20 + 2√101) ‖F h - h‖`;  `20 + 2√101 = 1/σ_min(I - J) ≈ 40.10`. -/
theorem demo_sharp_bound (x : E2) : ‖x‖ ≤ (20 + 2 * √101) * ‖Fdemo x - x‖ := by
  have hs : √101 ^ 2 = 101 := Real.sq_sqrt (by norm_num)
  have hnx : ‖x‖ ^ 2 = x 0 ^ 2 + x 1 ^ 2 := E2_norm_sq x
  have hnd : ‖Fdemo x - x‖ ^ 2
      = ((1/2 : ℝ) * x 0 + 10 * x 1 - x 0) ^ 2 + ((1/2 : ℝ) * x 1 - x 1) ^ 2 := E2_norm_sq _
  have key : ‖x‖ ^ 2 ≤ ((20 + 2 * √101) * ‖Fdemo x - x‖) ^ 2 := by
    rw [mul_pow, hnx, hnd]
    have hA : (0 : ℝ) < 800 + 80 * √101 := by positivity
    have hid : (800 + 80 * √101) * ((20 + 2 * √101) ^ 2 *
          (((1/2 : ℝ) * x 0 + 10 * x 1 - x 0) ^ 2 + ((1/2 : ℝ) * x 1 - x 1) ^ 2)
          - (x 0 ^ 2 + x 1 ^ 2))
        = ((800 + 80 * √101) * ((1/2 : ℝ) * x 0 + 10 * x 1 - x 0)
            - 80 * ((1/2 : ℝ) * x 1 - x 1)) ^ 2
          + (√101 ^ 2 - 101) * (4 * (800 + 80 * √101) * ((1/2 : ℝ) * x 0 + 10 * x 1 - x 0) ^ 2
            + (320 * √101 + 9600) * ((1/2 : ℝ) * x 1 - x 1) ^ 2) := by
      ring
    have hz : √101 ^ 2 - 101 = 0 := sub_eq_zero.mpr hs
    rw [hz, zero_mul, add_zero] at hid
    have h2 : 0 ≤ (800 + 80 * √101) * ((20 + 2 * √101) ^ 2 *
          (((1/2 : ℝ) * x 0 + 10 * x 1 - x 0) ^ 2 + ((1/2 : ℝ) * x 1 - x 1) ^ 2)
          - (x 0 ^ 2 + x 1 ^ 2)) := by
      rw [hid]
      exact sq_nonneg _
    have h3 := (mul_nonneg_iff_of_pos_left hA).mp h2
    linarith
  exact (sq_le_sq₀ (norm_nonneg _) (by positivity)).mp key

/-- The worst case: `h = -(I - J)⁻¹ v` with `v = (1, 10 + √101)`, the top right singular vector
of `(I - J)⁻¹`. -/
def hworst : E2 := !₂[-(402 + 40 * √101), -(20 + 2 * √101)]

theorem demo_worst_residual : Fdemo hworst - hworst = !₂[1, 10 + √101] := by
  apply E2_ext
  · show (1/2 : ℝ) * (-(402 + 40 * √101)) + 10 * (-(20 + 2 * √101)) - (-(402 + 40 * √101)) = 1
    ring
  · show (1/2 : ℝ) * (-(20 + 2 * √101)) - (-(20 + 2 * √101)) = 10 + √101
    ring

/-- The constant `20 + 2√101` is attained, so it is exactly `‖(I - J)⁻¹‖₂`. -/
theorem demo_sharp_attained :
    ‖hworst‖ = (20 + 2 * √101) * ‖Fdemo hworst - hworst‖ := by
  have hs : √101 ^ 2 = 101 := Real.sq_sqrt (by norm_num)
  have hn1 : ‖hworst‖ ^ 2 = (-(402 + 40 * √101)) ^ 2 + (-(20 + 2 * √101)) ^ 2 := E2_norm_sq _
  have hn2 : ‖Fdemo hworst - hworst‖ ^ 2 = 1 ^ 2 + (10 + √101) ^ 2 := by
    rw [demo_worst_residual]
    exact E2_norm_sq _
  have hsq : ‖hworst‖ ^ 2 = ((20 + 2 * √101) * ‖Fdemo hworst - hworst‖) ^ 2 := by
    rw [mul_pow, hn1, hn2]
    linear_combination (-4 * √101 ^ 2 - 160 * √101 - 1204) * hs
  refine le_antisymm (demo_sharp_bound hworst) ?_
  exact (sq_le_sq₀ (by positivity) (norm_nonneg _)).mp hsq.symm.le

/-- The demo map is not a contraction for the Euclidean norm (`‖J‖₂ > 1`), so the classical
Lipschitz rule `‖Δh‖/(1 - ‖J‖)` is not available either. -/
theorem Fdemo_not_contraction : ‖(!₂[0, 1] : E2)‖ < ‖Fdemo (!₂[0, 1])‖ := by
  rw [norm_e2]
  have h : ‖Fdemo (!₂[0, 1])‖ ^ 2 = 10 ^ 2 + (1/2 : ℝ) ^ 2 := by
    rw [E2_norm_sq]
    show ((1/2 : ℝ) * 0 + 10 * 1) ^ 2 + ((1/2 : ℝ) * 1) ^ 2 = 10 ^ 2 + (1/2 : ℝ) ^ 2
    norm_num
  nlinarith [norm_nonneg (Fdemo (!₂[0, 1]))]

/-! ## (4c) -/

section Analytic

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E] [CompleteSpace E]

/-- **Integral mean-value theorem along the segment.**  Only the derivative on the segment
`{y + t (x - y) : t ∈ [0, 1]}` enters. -/
theorem secant_eq_integral (F : E → E) (F' : E → E →L[ℝ] E) (x y : E)
    (hF : ∀ t ∈ Set.uIcc (0:ℝ) 1, HasFDerivAt F (F' (y + t • (x - y))) (y + t • (x - y)))
    (hcont : ContinuousOn (fun t : ℝ => F' (y + t • (x - y))) (Set.uIcc 0 1)) :
    F x - F y = (∫ t in (0:ℝ)..1, F' (y + t • (x - y))) (x - y) := by
  have hderiv : ∀ t ∈ Set.uIcc (0:ℝ) 1,
      HasDerivAt (fun s : ℝ => F (y + s • (x - y))) (F' (y + t • (x - y)) (x - y)) t := by
    intro t ht
    have hγ : HasDerivAt (fun s : ℝ => y + s • (x - y)) (x - y) t := by
      have h1 : HasDerivAt (fun s : ℝ => y + s • (x - y))
          ((ContinuousLinearMap.toSpanSingleton ℝ (x - y)) 1) t :=
        ((ContinuousLinearMap.toSpanSingleton ℝ (x - y)).hasFDerivAt
          (x := t)).hasDerivAt.const_add y
      rwa [ContinuousLinearMap.toSpanSingleton_apply_one] at h1
    exact (hF t ht).comp_hasDerivAt t hγ
  have hcont2 : ContinuousOn (fun t : ℝ => F' (y + t • (x - y)) (x - y)) (Set.uIcc 0 1) :=
    hcont.clm_apply continuousOn_const
  have hint : IntervalIntegrable (fun t : ℝ => F' (y + t • (x - y)) (x - y))
      MeasureTheory.volume 0 1 :=
    hcont2.intervalIntegrable
  have hyx : y + (x - y) = x := by abel
  rw [ContinuousLinearMap.intervalIntegral_apply
      (hcont.intervalIntegrable (μ := MeasureTheory.volume)) (x - y),
    intervalIntegral.integral_eq_sub_of_hasDerivAt hderiv hint]
  simp [hyx]

/-- **Claim 4c.**  For `F` differentiable along `[h⋆, h]` with derivative continuous there and
`F h⋆ = h⋆`, put `J̄ = ∫₀¹ F'(h⋆ + t (h - h⋆)) dt`.  If `I - J̄` is invertible (`↑u = 1 - J̄`),
then `h - h⋆ = -(I - J̄)⁻¹ (F h - h)` exactly. -/
theorem nonlinear_error_identity (F : E → E) (F' : E → E →L[ℝ] E) (x xstar : E)
    (hfix : F xstar = xstar)
    (hF : ∀ t ∈ Set.uIcc (0:ℝ) 1,
      HasFDerivAt F (F' (xstar + t • (x - xstar))) (xstar + t • (x - xstar)))
    (hcont : ContinuousOn (fun t : ℝ => F' (xstar + t • (x - xstar))) (Set.uIcc 0 1))
    (u : (E →L[ℝ] E)ˣ)
    (hu : (u : E →L[ℝ] E) = 1 - ∫ t in (0:ℝ)..1, F' (xstar + t • (x - xstar))) :
    x - xstar = -((↑u⁻¹ : E →L[ℝ] E) (F x - x)) := by
  have hsec := secant_eq_integral F F' x xstar hF hcont
  have key : F x - x = -((u : E →L[ℝ] E) (x - xstar)) := by
    rw [hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply, ← hsec, hfix]
    abel
  rw [key, map_neg, neg_neg, ← ContinuousLinearMap.mul_apply, Units.inv_mul,
    ContinuousLinearMap.one_apply]

/-- The corresponding bound `‖h - h⋆‖ ≤ ‖(I - J̄)⁻¹‖ ‖F h - h‖`. -/
theorem nonlinear_error_bound (F : E → E) (F' : E → E →L[ℝ] E) (x xstar : E)
    (hfix : F xstar = xstar)
    (hF : ∀ t ∈ Set.uIcc (0:ℝ) 1,
      HasFDerivAt F (F' (xstar + t • (x - xstar))) (xstar + t • (x - xstar)))
    (hcont : ContinuousOn (fun t : ℝ => F' (xstar + t • (x - xstar))) (Set.uIcc 0 1))
    (u : (E →L[ℝ] E)ˣ)
    (hu : (u : E →L[ℝ] E) = 1 - ∫ t in (0:ℝ)..1, F' (xstar + t • (x - xstar))) :
    ‖x - xstar‖ ≤ ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖F x - x‖ := by
  rw [nonlinear_error_identity F F' x xstar hfix hF hcont u hu, norm_neg]
  exact ContinuousLinearMap.le_opNorm _ _

/-- **Locality.**  If every Jacobian on the segment is within `η` of a reference `A`, so is the
averaged Jacobian `J̄`. -/
theorem avg_jacobian_close (F' : E → E →L[ℝ] E) (x xstar : E) (A : E →L[ℝ] E) (η : ℝ)
    (hcont : ContinuousOn (fun t : ℝ => F' (xstar + t • (x - xstar))) (Set.uIcc 0 1))
    (hη : ∀ t ∈ Set.uIcc (0:ℝ) 1, ‖F' (xstar + t • (x - xstar)) - A‖ ≤ η) :
    ‖(∫ t in (0:ℝ)..1, F' (xstar + t • (x - xstar))) - A‖ ≤ η := by
  have hconst : IntervalIntegrable (fun _ : ℝ => A) MeasureTheory.volume 0 1 :=
    continuousOn_const.intervalIntegrable
  have hsub : (∫ t in (0:ℝ)..1, F' (xstar + t • (x - xstar))) - A
      = ∫ t in (0:ℝ)..1, (F' (xstar + t • (x - xstar)) - A) := by
    rw [intervalIntegral.integral_sub (hcont.intervalIntegrable (μ := MeasureTheory.volume))
      hconst, intervalIntegral.integral_const]
    simp
  rw [hsub]
  have hbound := intervalIntegral.norm_integral_le_of_norm_le_const (a := 0) (b := 1) (C := η)
    (f := fun t : ℝ => F' (xstar + t • (x - xstar)) - A)
    (fun t ht => hη t (Set.uIoc_subset_uIcc ht))
  simpa using hbound

omit [CompleteSpace E] in
/-- Perturbation lemma (Banach-lemma form): `‖x‖ ≤ M ‖(I - A) x‖`, `‖J̄ - A‖ ≤ η`, `M η < 1`
give `‖x‖ ≤ M/(1 - M η) ‖(I - J̄) x‖`.  (Same statement as in `LoopStopRule.lean`.) -/
theorem lower_bound_perturb (A Jbar : E →L[ℝ] E) (M η : ℝ)
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

/-- **Claim 4c, certified form.**  If every Jacobian on the segment `[h⋆, h]` is within `η` of a
reference `A` with `‖v‖ ≤ M ‖(I - A) v‖` and `M η < 1`, then `‖h - h⋆‖ ≤ M/(1 - M η) ‖F h - h‖`.
No inverse of `I - J̄` is needed; only Jacobians on the segment enter. -/
theorem nonlinear_certified_bound (F : E → E) (F' : E → E →L[ℝ] E) (x xstar : E)
    (hfix : F xstar = xstar)
    (hF : ∀ t ∈ Set.uIcc (0:ℝ) 1,
      HasFDerivAt F (F' (xstar + t • (x - xstar))) (xstar + t • (x - xstar)))
    (hcont : ContinuousOn (fun t : ℝ => F' (xstar + t • (x - xstar))) (Set.uIcc 0 1))
    (A : E →L[ℝ] E) (M η : ℝ) (hM : ∀ v, ‖v‖ ≤ M * ‖(1 - A) v‖)
    (hη : ∀ t ∈ Set.uIcc (0:ℝ) 1, ‖F' (xstar + t • (x - xstar)) - A‖ ≤ η)
    (hMη : M * η < 1) (hM0 : 0 ≤ M) :
    ‖x - xstar‖ ≤ M / (1 - M * η) * ‖F x - x‖ := by
  have hsec := secant_eq_integral F F' x xstar hF hcont
  have hJ := avg_jacobian_close F' x xstar A η hcont hη
  have key : (1 - ∫ t in (0:ℝ)..1, F' (xstar + t • (x - xstar))) (x - xstar) = -(F x - x) := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply, ← hsec, hfix]
    abel
  have h1 := lower_bound_perturb A _ M η hM hJ hMη hM0 (x - xstar)
  rwa [key, norm_neg] at h1

end Analytic

end Claim4

#print axioms Claim4.Fgen_hgen_residual
#print axioms Claim4.hgen_norm_ge
#print axioms Claim4.J_eigenvalues
#print axioms Claim4.J_eigenvector
#print axioms Claim4.rho_rule_gap
#print axioms Claim4.rho_rule_fails
#print axioms Claim4.demo_sharp_bound
#print axioms Claim4.demo_sharp_attained
#print axioms Claim4.Fdemo_not_contraction
#print axioms Claim4.secant_eq_integral
#print axioms Claim4.nonlinear_error_identity
#print axioms Claim4.nonlinear_error_bound
#print axioms Claim4.avg_jacobian_close
#print axioms Claim4.nonlinear_certified_bound
