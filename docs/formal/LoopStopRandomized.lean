/-
# A randomized certificate for ‖(I − J)⁻¹‖ from a few Gaussian probes

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: it is the Gaussian-probe norm bound of Dixon (1983) and of Halko,
Martinsson & Tropp (2011, Lemma 4.1; proof in Woolfe, Liberty, Rokhlin & Tygert 2008), applied to
the inverse through approximate solves, with each solve's residual accounted for.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopStopRandomized.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 20 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.InnerProductSpace.Adjoint
import Mathlib.Analysis.Normed.Module.FiniteDimension
import Mathlib.Analysis.InnerProductSpace.PiL2
import Mathlib.Probability.Distributions.Gaussian.Real
import Mathlib.MeasureTheory.Measure.CharacteristicFunction
import Mathlib.MeasureTheory.Constructions.Pi
import Mathlib.Topology.Order.Compact

-- Some lemmas hold without every section hypothesis; the linter would ask to `omit` each one.
set_option linter.unusedSectionVars false

/-!
# A3 (full). Randomized certificates for `‖B⁻¹‖`, unconditional on `ℝ^d`

The one-solve-per-probe certificate, the standard Gaussian marginals, and a power-step version with two solves
per probe (`B x ≈ g`, `Bᵀ y ≈ x`): with `C = (B⁻¹)ᵀ B⁻¹`, `‖C‖ = ‖B⁻¹‖²` and
`C g = y + (B⁻¹)ᵀ r₂ + C r₁`, so on the event `t ≤ |⟪w, g⟫|`,
`‖B⁻¹‖² (t - ‖r₁‖) ≤ ‖y‖ + ‖B⁻¹‖ ‖r₂‖`, and `‖B⁻¹‖ ≤ rootBound (t - ‖r₁‖) ‖r₂‖ ‖y‖`.
The final theorems `randomized_certificate_Rd`, `randomized_power_certificate_Rd` hold for the
standard Gaussian on `ℝ^d`, any `d ≥ 1`, with no distributional hypothesis left.
-/

noncomputable section

open MeasureTheory ProbabilityTheory
open scoped RealInnerProductSpace ENNReal NNReal

namespace A3full

section A3part

open Real

section Core

variable {E : Type*} [NormedAddCommGroup E] [InnerProductSpace ℝ E] [FiniteDimensional ℝ E]

omit [FiniteDimensional ℝ E] in
lemma inv_apply_unit_apply (u : (E →L[ℝ] E)ˣ) (y : E) :
    (↑u⁻¹ : E →L[ℝ] E) ((u : E →L[ℝ] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.inv_mul, ContinuousLinearMap.one_apply]

/-- In finite dimension a continuous linear map attains its operator norm on the unit ball. -/
theorem exists_opNorm_attained (A : E →L[ℝ] E) : ∃ v : E, ‖v‖ ≤ 1 ∧ ‖A v‖ = ‖A‖ := by
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

/-- **A3 core (a).**  For every `T` there is a unit vector `w` with `‖T‖ |⟪w, g⟫| ≤ ‖T g‖` for all
`g`.  (For `T = B⁻¹`, `w` is a top right singular vector of `B⁻¹`.) -/
theorem exists_dominating_direction [Nontrivial E] (T : E →L[ℝ] E) :
    ∃ w : E, ‖w‖ = 1 ∧ ∀ g : E, ‖T‖ * |⟪w, g⟫| ≤ ‖T g‖ := by
  by_cases hT : ‖T‖ = 0
  · obtain ⟨v, hv⟩ := exists_ne (0 : E)
    refine ⟨‖v‖⁻¹ • v, ?_, fun g => ?_⟩
    · rw [norm_smul, norm_inv, norm_norm, inv_mul_cancel₀ (norm_ne_zero_iff.mpr hv)]
    · rw [hT, zero_mul]
      exact norm_nonneg _
  · obtain ⟨v, hv1, hvT⟩ := exists_opNorm_attained (ContinuousLinearMap.adjoint T)
    have hTa : ‖ContinuousLinearMap.adjoint T‖ = ‖T‖ := LinearIsometryEquiv.norm_map _ _
    have hn : ‖ContinuousLinearMap.adjoint T v‖ = ‖T‖ := hvT.trans hTa
    refine ⟨‖T‖⁻¹ • ContinuousLinearMap.adjoint T v, ?_, fun g => ?_⟩
    · rw [norm_smul, norm_inv, norm_norm, hn, inv_mul_cancel₀ hT]
    · have h1 : ⟪‖T‖⁻¹ • ContinuousLinearMap.adjoint T v, g⟫ = ‖T‖⁻¹ * ⟪v, T g⟫ := by
        rw [real_inner_smul_left, ContinuousLinearMap.adjoint_inner_left]
      have h2 : |⟪v, T g⟫| ≤ ‖T g‖ := by
        calc |⟪v, T g⟫| ≤ ‖v‖ * ‖T g‖ := abs_real_inner_le_norm _ _
          _ ≤ 1 * ‖T g‖ := mul_le_mul_of_nonneg_right hv1 (norm_nonneg _)
          _ = ‖T g‖ := one_mul _
      rw [h1, abs_mul, abs_inv, abs_norm, ← mul_assoc, mul_inv_cancel₀ hT, one_mul]
      exact h2

omit [FiniteDimensional ℝ E] in
/-- **A3 core (b).**  If `‖B⁻¹‖ |⟪w, g⟫| ≤ ‖B⁻¹ g‖` for all `g`, then for ANY `x`, with
`r = g - B x`: `t ≤ |⟪w, g⟫|` and `‖r‖ < t` give `‖B⁻¹‖ ≤ ‖x‖ / (t - ‖r‖)`. -/
theorem residual_certificate (u : (E →L[ℝ] E)ˣ) (w : E)
    (hdom : ∀ g, ‖(↑u⁻¹ : E →L[ℝ] E)‖ * |⟪w, g⟫| ≤ ‖(↑u⁻¹ : E →L[ℝ] E) g‖)
    (g x : E) (t : ℝ) (ht : t ≤ |⟪w, g⟫|) (hr : ‖g - (u : E →L[ℝ] E) x‖ < t) :
    ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ ‖x‖ / (t - ‖g - (u : E →L[ℝ] E) x‖) := by
  have hTg : (↑u⁻¹ : E →L[ℝ] E) g = x + (↑u⁻¹ : E →L[ℝ] E) (g - (u : E →L[ℝ] E) x) := by
    rw [map_sub, inv_apply_unit_apply]
    abel
  have h1 : ‖(↑u⁻¹ : E →L[ℝ] E) g‖
      ≤ ‖x‖ + ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖g - (u : E →L[ℝ] E) x‖ := by
    rw [hTg]
    exact (norm_add_le _ _).trans (add_le_add le_rfl (ContinuousLinearMap.le_opNorm _ _))
  have h2 := (hdom g).trans h1
  have hpos : 0 < t - ‖g - (u : E →L[ℝ] E) x‖ := sub_pos.mpr hr
  rw [le_div_iff₀ hpos]
  have h3 := mul_le_mul_of_nonneg_left ht (norm_nonneg ((↑u⁻¹ : E →L[ℝ] E)))
  nlinarith [h2, h3]

/-- **A3 core (c), `m` probes.**  If some probe has `t ≤ |⟪w, gᵢ⟫|`, every residual is `< t`, and
`C` bounds every `‖xᵢ‖ / (t - ‖rᵢ‖)`, then `‖B⁻¹‖ ≤ C`. -/
theorem multi_probe_certificate {m : ℕ} (u : (E →L[ℝ] E)ˣ) (w : E)
    (hdom : ∀ g, ‖(↑u⁻¹ : E →L[ℝ] E)‖ * |⟪w, g⟫| ≤ ‖(↑u⁻¹ : E →L[ℝ] E) g‖)
    (g x : Fin m → E) (t C : ℝ) (hgood : ∃ i, t ≤ |⟪w, g i⟫|)
    (hr : ∀ i, ‖g i - (u : E →L[ℝ] E) (x i)‖ < t)
    (hC : ∀ i, ‖x i‖ / (t - ‖g i - (u : E →L[ℝ] E) (x i)‖) ≤ C) :
    ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ C := by
  obtain ⟨i, hi⟩ := hgood
  exact (residual_certificate u w hdom (g i) (x i) t hi (hr i)).trans (hC i)


omit [FiniteDimensional ℝ E] in
lemma unit_apply_inv_apply' (u : (E →L[ℝ] E)ˣ) (y : E) :
    (u : E →L[ℝ] E) ((↑u⁻¹ : E →L[ℝ] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.mul_inv, ContinuousLinearMap.one_apply]

/-- `(B⁻¹)ᵀ Bᵀ = I`. -/
lemma adjoint_inv_adjoint_apply (u : (E →L[ℝ] E)ˣ) (y : E) :
    ContinuousLinearMap.adjoint (↑u⁻¹ : E →L[ℝ] E)
      (ContinuousLinearMap.adjoint (u : E →L[ℝ] E) y) = y := by
  have h1 : (u : E →L[ℝ] E).comp (↑u⁻¹ : E →L[ℝ] E) = ContinuousLinearMap.id ℝ E := by
    ext v
    exact unit_apply_inv_apply' u v
  have h : (ContinuousLinearMap.adjoint (↑u⁻¹ : E →L[ℝ] E)).comp
      (ContinuousLinearMap.adjoint (u : E →L[ℝ] E)) = ContinuousLinearMap.id ℝ E := by
    rw [← ContinuousLinearMap.adjoint_comp, h1, ContinuousLinearMap.adjoint_id]
  have h2 := congrArg (fun L : E →L[ℝ] E => L y) h
  simpa using h2

/-- `C = (B⁻¹)ᵀ B⁻¹`, whose norm is `‖B⁻¹‖²`. -/
def Cop (u : (E →L[ℝ] E)ˣ) : E →L[ℝ] E :=
  (ContinuousLinearMap.adjoint (↑u⁻¹ : E →L[ℝ] E)).comp (↑u⁻¹ : E →L[ℝ] E)

theorem norm_Cop (u : (E →L[ℝ] E)ˣ) :
    ‖Cop u‖ = ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖(↑u⁻¹ : E →L[ℝ] E)‖ :=
  ContinuousLinearMap.norm_adjoint_comp_self _

/-- One power step with two approximate solves: `r₁ = g - B x`, `r₂ = x - Bᵀ y` give
`C g = y + (B⁻¹)ᵀ r₂ + C r₁` exactly. -/
theorem power_step_identity (u : (E →L[ℝ] E)ˣ) (g x y : E) :
    Cop u g = y + ContinuousLinearMap.adjoint (↑u⁻¹ : E →L[ℝ] E)
        (x - ContinuousLinearMap.adjoint (u : E →L[ℝ] E) y) + Cop u (g - (u : E →L[ℝ] E) x) := by
  simp only [Cop, ContinuousLinearMap.comp_apply, map_sub, inv_apply_unit_apply,
    adjoint_inv_adjoint_apply]
  abel

/-- **Power-step certificate (deterministic core).**  If `w` dominates `C` and
`t ≤ |⟪w, g⟫|`, then `N² (t - ‖r₁‖) ≤ ‖y‖ + N ‖r₂‖` with `N = ‖B⁻¹‖`. -/
theorem power_step_quadratic (u : (E →L[ℝ] E)ˣ) (w : E)
    (hdom : ∀ g, ‖Cop u‖ * |⟪w, g⟫| ≤ ‖Cop u g‖) (g x y : E) (t : ℝ) (ht : t ≤ |⟪w, g⟫|) :
    ‖(↑u⁻¹ : E →L[ℝ] E)‖ ^ 2 * (t - ‖g - (u : E →L[ℝ] E) x‖)
      ≤ ‖y‖ + ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖x - ContinuousLinearMap.adjoint (u : E →L[ℝ] E) y‖ := by
  have hTa : ‖ContinuousLinearMap.adjoint (↑u⁻¹ : E →L[ℝ] E)‖ = ‖(↑u⁻¹ : E →L[ℝ] E)‖ :=
    LinearIsometryEquiv.norm_map _ _
  have hbound : ‖Cop u g‖ ≤ ‖y‖ + ‖(↑u⁻¹ : E →L[ℝ] E)‖
        * ‖x - ContinuousLinearMap.adjoint (u : E →L[ℝ] E) y‖
      + ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖(↑u⁻¹ : E →L[ℝ] E)‖ * ‖g - (u : E →L[ℝ] E) x‖ := by
    rw [power_step_identity u g x y]
    refine (norm_add_le _ _).trans (add_le_add ((norm_add_le _ _).trans (add_le_add le_rfl ?_)) ?_)
    · exact (ContinuousLinearMap.le_opNorm _ _).trans (by rw [hTa])
    · exact (ContinuousLinearMap.le_opNorm _ _).trans (by rw [norm_Cop])
  have h1 := hdom g
  rw [norm_Cop] at h1
  have h2 := mul_le_mul_of_nonneg_left ht
    (mul_nonneg (norm_nonneg ((↑u⁻¹ : E →L[ℝ] E))) (norm_nonneg ((↑u⁻¹ : E →L[ℝ] E))))
  nlinarith [h1, h2, hbound]

/-- The positive root of `a N² = b N + c` bounds every `N` with `a N² ≤ b N + c` (`a > 0`). -/
theorem quadratic_root_bound (N a b c : ℝ) (ha : 0 < a) (h : N ^ 2 * a ≤ c + N * b) :
    N ≤ (b + √(b ^ 2 + 4 * a * c)) / (2 * a) := by
  have h4 := mul_le_mul_of_nonneg_left h (by linarith : (0:ℝ) ≤ 4 * a)
  have h1 : (2 * a * N - b) ^ 2 ≤ b ^ 2 + 4 * a * c := by nlinarith [h4]
  have h2 : 2 * a * N - b ≤ √(b ^ 2 + 4 * a * c) := (le_abs_self _).trans (Real.abs_le_sqrt h1)
  rw [le_div_iff₀ (by linarith : (0:ℝ) < 2 * a)]
  linarith

/-- The certificate value of one power step. -/
def rootBound (a b c : ℝ) : ℝ := (b + √(b ^ 2 + 4 * a * c)) / (2 * a)

/-- **Power-step certificate, `m` probes.** -/
theorem multi_probe_power_certificate {m : ℕ} (u : (E →L[ℝ] E)ˣ) (w : E)
    (hdom : ∀ g, ‖Cop u‖ * |⟪w, g⟫| ≤ ‖Cop u g‖)
    (g x y : Fin m → E) (t C : ℝ) (hgood : ∃ i, t ≤ |⟪w, g i⟫|)
    (hr : ∀ i, ‖g i - (u : E →L[ℝ] E) (x i)‖ < t)
    (hC : ∀ i, rootBound (t - ‖g i - (u : E →L[ℝ] E) (x i)‖)
      ‖x i - ContinuousLinearMap.adjoint (u : E →L[ℝ] E) (y i)‖ ‖y i‖ ≤ C) :
    ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ C := by
  obtain ⟨i, hi⟩ := hgood
  have hq := power_step_quadratic u w hdom (g i) (x i) (y i) t hi
  have ha : 0 < t - ‖g i - (u : E →L[ℝ] E) (x i)‖ := sub_pos.mpr (hr i)
  refine le_trans ?_ (hC i)
  unfold rootBound
  apply quadratic_root_bound _ _ _ _ ha
  linarith [hq]

end Core

section Probability

/-- The standard normal density is at most `1/√(2π)`. -/
theorem gaussianPDFReal_le (x : ℝ) : gaussianPDFReal 0 1 x ≤ (√(2 * π))⁻¹ := by
  simp only [gaussianPDFReal, NNReal.coe_one, mul_one, sub_zero]
  have h1 : rexp (-x ^ 2 / 2) ≤ 1 := by
    rw [Real.exp_le_one_iff]
    have := sq_nonneg x
    linarith
  exact mul_le_of_le_one_right (inv_nonneg.mpr (Real.sqrt_nonneg _)) h1

/-- **Small-ball bound.**  `P(|Z| < t) ≤ t √(2/π)` for `Z ~ N(0, 1)`. -/
theorem gaussian_small_ball (t : ℝ) :
    gaussianReal 0 1 {z | |z| < t} ≤ ENNReal.ofReal (t * √(2 / π)) := by
  have hset : {z : ℝ | |z| < t} = Set.Ioo (-t) t := by
    ext z
    simp only [Set.mem_setOf_eq, Set.mem_Ioo, abs_lt]
  have hc : 0 ≤ (√(2 * π))⁻¹ := inv_nonneg.mpr (Real.sqrt_nonneg _)
  have hreal : (√(2 * π))⁻¹ * (t - -t) = t * √(2 / π) := by
    have hs2 : √2 * √2 = 2 := Real.mul_self_sqrt (by norm_num)
    have ha : √2 ≠ 0 := by positivity
    rw [Real.sqrt_mul (by norm_num : (0:ℝ) ≤ 2) π, Real.sqrt_div (by norm_num : (0:ℝ) ≤ 2) π,
      mul_inv, div_eq_mul_inv]
    have e1 : t - -t = √2 * √2 * t := by rw [hs2]; ring
    rw [e1]
    calc (√2)⁻¹ * (√π)⁻¹ * (√2 * √2 * t) = ((√2)⁻¹ * √2) * (√2 * (√π)⁻¹ * t) := by ring
      _ = t * (√2 * (√π)⁻¹) := by rw [inv_mul_cancel₀ ha, one_mul]; ring
  rw [hset, gaussianReal_apply 0 one_ne_zero]
  calc ∫⁻ x in Set.Ioo (-t) t, gaussianPDF 0 1 x
      ≤ ∫⁻ x in Set.Ioo (-t) t, ENNReal.ofReal (√(2 * π))⁻¹ :=
        lintegral_mono (fun x => ENNReal.ofReal_le_ofReal (gaussianPDFReal_le x))
    _ = ENNReal.ofReal (√(2 * π))⁻¹ * volume (Set.Ioo (-t) t) := setLIntegral_const _ _
    _ = ENNReal.ofReal ((√(2 * π))⁻¹ * (t - -t)) := by
        rw [Real.volume_Ioo, ← ENNReal.ofReal_mul hc]
    _ = ENNReal.ofReal (t * √(2 / π)) := by rw [hreal]

variable {E : Type*} [NormedAddCommGroup E] [InnerProductSpace ℝ E] [FiniteDimensional ℝ E]
  [MeasurableSpace E] [BorelSpace E]

/-- **`m` independent probes.**  If the law of `⟪w, g⟫` is `N(0, 1)`, then under the `m`-fold
product, `P(∀ i, |⟪w, gᵢ⟫| < t) ≤ (t √(2/π))^m`. -/
theorem probes_all_small {m : ℕ} (μ : Measure E) [IsProbabilityMeasure μ] (w : E)
    (hμ : μ.map (fun g => ⟪w, g⟫) = gaussianReal 0 1) (t : ℝ) :
    (Measure.pi (fun _ : Fin m => μ)) {gs | ∀ i, |⟪w, gs i⟫| < t}
      ≤ ENNReal.ofReal (t * √(2 / π)) ^ m := by
  have hmeas : Measurable (fun g : E => ⟪w, g⟫) :=
    (continuous_const.inner continuous_id).measurable
  have hset : {gs : Fin m → E | ∀ i, |⟪w, gs i⟫| < t}
      = Set.pi Set.univ (fun _ => (fun g : E => ⟪w, g⟫) ⁻¹' {z | |z| < t}) := by
    ext gs
    simp
  have h1 : μ ((fun g : E => ⟪w, g⟫) ⁻¹' {z | |z| < t}) ≤ ENNReal.ofReal (t * √(2 / π)) := by
    rw [← Measure.map_apply hmeas (isOpen_lt continuous_abs continuous_const).measurableSet, hμ]
    exact gaussian_small_ball t
  rw [hset, Measure.pi_pi]
  calc ∏ i : Fin m, μ ((fun g : E => ⟪w, g⟫) ⁻¹' {z | |z| < t})
      ≤ ENNReal.ofReal (t * √(2 / π)) ^ (Finset.univ : Finset (Fin m)).card :=
        Finset.prod_le_pow_card _ _ _ (fun i _ => h1)
    _ = ENNReal.ofReal (t * √(2 / π)) ^ m := by rw [Finset.card_univ, Fintype.card_fin]

/-- **A3, the randomized certificate.**  `μ` is a probability measure on `E` all of whose
marginals `⟪w, g⟫`, `‖w‖ = 1`, are `N(0, 1)` (the standard Gaussian).  Probes `g₁ … g_m` are
i.i.d. `μ`, drawn independently of `B` (`B` is fixed before the draw: it is a parameter here).
Then the probability that there EXIST approximate solves `x₁ … x_m` with every residual
`‖gᵢ - B xᵢ‖ < t` and a number `C ≥ maxᵢ ‖xᵢ‖ / (t - ‖gᵢ - B xᵢ‖)` with `C < ‖B⁻¹‖` is at most
`(t √(2/π))^m`.  So the certificate is wrong with probability at most `(t √(2/π))^m`, whatever
solver produced the `xᵢ`. -/
theorem randomized_certificate [Nontrivial E] {m : ℕ} (μ : Measure E) [IsProbabilityMeasure μ]
    (hμ : ∀ w : E, ‖w‖ = 1 → μ.map (fun g => ⟪w, g⟫) = gaussianReal 0 1)
    (u : (E →L[ℝ] E)ˣ) (t : ℝ) :
    (Measure.pi (fun _ : Fin m => μ))
      {gs | ∃ xs : Fin m → E, ∃ C : ℝ,
        (∀ i, ‖gs i - (u : E →L[ℝ] E) (xs i)‖ < t) ∧
        (∀ i, ‖xs i‖ / (t - ‖gs i - (u : E →L[ℝ] E) (xs i)‖) ≤ C) ∧
        C < ‖(↑u⁻¹ : E →L[ℝ] E)‖}
      ≤ ENNReal.ofReal (t * √(2 / π)) ^ m := by
  obtain ⟨w, hw1, hdom⟩ := exists_dominating_direction (↑u⁻¹ : E →L[ℝ] E)
  refine le_trans (measure_mono ?_) (probes_all_small μ w (hμ w hw1) t)
  rintro gs ⟨xs, C, hr, hC, hlt⟩
  show ∀ i, |⟪w, gs i⟫| < t
  intro i
  by_contra hcon
  push_neg at hcon
  exact absurd (multi_probe_certificate u w hdom gs xs t C ⟨i, hcon⟩ hr hC) (not_le.mpr hlt)


/-- **A3, power-step version.**  Two approximate solves per probe (`B x ≈ g`, `Bᵀ y ≈ x`); the
probability that some choice of solves with all `‖gᵢ - B xᵢ‖ < t` yields a certificate
`C ≥ maxᵢ rootBound(t - ‖r₁ᵢ‖, ‖r₂ᵢ‖, ‖yᵢ‖)` with `C < ‖B⁻¹‖` is at most `(t √(2/π))^m`. -/
theorem randomized_power_certificate [Nontrivial E] {m : ℕ} (μ : Measure E)
    [IsProbabilityMeasure μ]
    (hμ : ∀ w : E, ‖w‖ = 1 → μ.map (fun g => ⟪w, g⟫) = gaussianReal 0 1)
    (u : (E →L[ℝ] E)ˣ) (t : ℝ) :
    (Measure.pi (fun _ : Fin m => μ))
      {gs | ∃ xs ys : Fin m → E, ∃ C : ℝ,
        (∀ i, ‖gs i - (u : E →L[ℝ] E) (xs i)‖ < t) ∧
        (∀ i, rootBound (t - ‖gs i - (u : E →L[ℝ] E) (xs i)‖)
          ‖xs i - ContinuousLinearMap.adjoint (u : E →L[ℝ] E) (ys i)‖ ‖ys i‖ ≤ C) ∧
        C < ‖(↑u⁻¹ : E →L[ℝ] E)‖}
      ≤ ENNReal.ofReal (t * √(2 / π)) ^ m := by
  obtain ⟨w, hw1, hdom⟩ := exists_dominating_direction (Cop u)
  refine le_trans (measure_mono ?_) (probes_all_small μ w (hμ w hw1) t)
  rintro gs ⟨xs, ys, C, hr, hC, hlt⟩
  show ∀ i, |⟪w, gs i⟫| < t
  intro i
  by_contra hcon
  push_neg at hcon
  exact absurd (multi_probe_power_certificate u w hdom gs xs ys t C ⟨i, hcon⟩ hr hC)
    (not_le.mpr hlt)

end Probability

end A3part

section StdGaussian

open Complex

/-- The standard Gaussian measure on `ℝ^d`. -/
def stdGaussianE (d : ℕ) : Measure (EuclideanSpace ℝ (Fin d)) :=
  (Measure.pi (fun _ : Fin d => gaussianReal 0 1)).map (WithLp.toLp 2)

instance isProbabilityMeasure_stdGaussianE (d : ℕ) : IsProbabilityMeasure (stdGaussianE d) :=
  Measure.isProbabilityMeasure_map (WithLp.measurable_toLp 2 (Fin d → ℝ)).aemeasurable

/-- The characteristic function of `N(0, 1)`, as a real exponential. -/
lemma charFun_std (s : ℝ) :
    charFun (gaussianReal 0 1) s = ((Real.exp (-(s ^ 2 / 2)) : ℝ) : ℂ) := by
  rw [charFun_gaussianReal, Complex.ofReal_exp]
  congr 1
  push_cast
  ring

/-- **The marginal of the standard Gaussian along a unit vector is `N(0, 1)`.** -/
theorem stdGaussianE_marginal {d : ℕ} (w : EuclideanSpace ℝ (Fin d)) (hw : ‖w‖ = 1) :
    (stdGaussianE d).map (fun g => ⟪w, g⟫) = gaussianReal 0 1 := by
  have hmeasf : Measurable (fun g : EuclideanSpace ℝ (Fin d) => ⟪w, g⟫) :=
    (continuous_const.inner continuous_id).measurable
  haveI : IsProbabilityMeasure (stdGaussianE d) := isProbabilityMeasure_stdGaussianE d
  haveI : IsProbabilityMeasure ((stdGaussianE d).map (fun g => ⟪w, g⟫)) :=
    Measure.isProbabilityMeasure_map hmeasf.aemeasurable
  have hw2 : ∑ i, (w i) ^ 2 = 1 := by
    have h := EuclideanSpace.norm_sq_eq w
    rw [hw, one_pow] at h
    simp only [Real.norm_eq_abs, sq_abs] at h
    exact h.symm
  have hR : ∀ t : ℝ, ∑ i, -((t * w i) ^ 2 / 2) = -(t ^ 2 / 2) := by
    intro t
    rw [Finset.sum_neg_distrib, ← Finset.sum_div]
    congr 2
    simp_rw [mul_pow]
    rw [← Finset.mul_sum, hw2, mul_one]
  apply Measure.ext_of_charFun
  funext t
  have hL : charFun ((stdGaussianE d).map (fun g => ⟪w, g⟫)) t
      = charFun (stdGaussianE d) (t • w) := by
    rw [charFun_apply_real, integral_map hmeasf.aemeasurable
      (by fun_prop : Continuous (fun x : ℝ => cexp (↑t * ↑x * I))).aestronglyMeasurable,
      charFun_apply]
    congr 1
    funext g
    rw [real_inner_smul_right, real_inner_comm w g, Complex.ofReal_mul]
  rw [hL, stdGaussianE, charFun_pi]
  simp_rw [charFun_std]
  rw [← Complex.ofReal_prod, ← Real.exp_sum]
  congr 2
  simp only [PiLp.smul_apply, smul_eq_mul]
  exact hR t

end StdGaussian

section RdPart

open Real

section Rd

/-- **A3 on `ℝ^d`, unconditional.**  Probes i.i.d. standard Gaussian on `ℝ^d`. -/
theorem randomized_certificate_Rd {d m : ℕ} [Nontrivial (EuclideanSpace ℝ (Fin d))]
    (u : (EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d))ˣ) (t : ℝ) :
    (Measure.pi (fun _ : Fin m => stdGaussianE d))
      {gs | ∃ xs : Fin m → EuclideanSpace ℝ (Fin d), ∃ C : ℝ,
        (∀ i, ‖gs i - (u : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d)) (xs i)‖ < t) ∧
        (∀ i, ‖xs i‖ / (t - ‖gs i - (u : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d))
          (xs i)‖) ≤ C) ∧
        C < ‖(↑u⁻¹ : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d))‖}
      ≤ ENNReal.ofReal (t * √(2 / π)) ^ m :=
  randomized_certificate (stdGaussianE d) (fun w hw => stdGaussianE_marginal w hw) u t

/-- **A3 power-step version on `ℝ^d`, unconditional.** -/
theorem randomized_power_certificate_Rd {d m : ℕ} [Nontrivial (EuclideanSpace ℝ (Fin d))]
    (u : (EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d))ˣ) (t : ℝ) :
    (Measure.pi (fun _ : Fin m => stdGaussianE d))
      {gs | ∃ xs ys : Fin m → EuclideanSpace ℝ (Fin d), ∃ C : ℝ,
        (∀ i, ‖gs i - (u : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d)) (xs i)‖ < t) ∧
        (∀ i, rootBound (t - ‖gs i - (u : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d))
            (xs i)‖)
          ‖xs i - ContinuousLinearMap.adjoint
            (u : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d)) (ys i)‖ ‖ys i‖ ≤ C) ∧
        C < ‖(↑u⁻¹ : EuclideanSpace ℝ (Fin d) →L[ℝ] EuclideanSpace ℝ (Fin d))‖}
      ≤ ENNReal.ofReal (t * √(2 / π)) ^ m :=
  randomized_power_certificate (stdGaussianE d) (fun w hw => stdGaussianE_marginal w hw) u t

end Rd

end RdPart

end A3full

#print axioms A3full.exists_opNorm_attained
#print axioms A3full.exists_dominating_direction
#print axioms A3full.residual_certificate
#print axioms A3full.multi_probe_certificate
#print axioms A3full.adjoint_inv_adjoint_apply
#print axioms A3full.norm_Cop
#print axioms A3full.power_step_identity
#print axioms A3full.power_step_quadratic
#print axioms A3full.quadratic_root_bound
#print axioms A3full.multi_probe_power_certificate
#print axioms A3full.gaussianPDFReal_le
#print axioms A3full.gaussian_small_ball
#print axioms A3full.probes_all_small
#print axioms A3full.randomized_certificate
#print axioms A3full.randomized_power_certificate
#print axioms A3full.isProbabilityMeasure_stdGaussianE
#print axioms A3full.charFun_std
#print axioms A3full.stdGaussianE_marginal
#print axioms A3full.randomized_certificate_Rd
#print axioms A3full.randomized_power_certificate_Rd
