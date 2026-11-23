/-
# A dense certificate: an approximate inverse bounds ‖B⁻¹‖

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: the Banach lemma (Golub & Van Loan 2013, §2.3.3), the Schur test
(Schur 1911), and the residual check of verified numerics (Rump 2011; Higham 2002 for the rounding).

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopStopDense.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 6 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Normed.Operator.NormedSpace
import Mathlib.Topology.Algebra.Module.FiniteDimension
import Mathlib.LinearAlgebra.FiniteDimensional.Basic
import Mathlib.Algebra.Order.BigOperators.Ring.Finset

/-!
# A4. The deterministic dense certificate: an approximate inverse bounds `‖B⁻¹‖`

* `approx_inverse_lower`: `‖I - X B‖ ≤ θ` gives `(1 - θ) ‖v‖ ≤ ‖X‖ ‖B v‖` for every `v`
  (no invertibility assumed, no Neumann series needed).
* `approx_inverse_injective`: hence `B` is injective when `θ < 1`.
* `approx_inverse_norm_bound`: for invertible `B`, `‖B⁻¹‖ ≤ ‖X‖ / (1 - θ)`.
* `approx_inverse_certificate`: in finite dimension, `‖I - X B‖ ≤ θ < 1` alone PROVES that `B` is
  invertible, with `‖B⁻¹‖ ≤ ‖X‖ / (1 - θ)`.
* `frobenius_bound`, `schur_bound`: cheap rigorous bounds on the Euclidean operator norm of a
  matrix `Y`: `‖Y v‖₂² ≤ ‖Y‖_F² ‖v‖₂²` and `‖Y v‖₂² ≤ ‖Y‖₁ ‖Y‖∞ ‖v‖₂²` (Schur test), written in
  coordinates: `R` bounds every row sum of `|Y|` (`‖Y‖∞`), `C` every column sum (`‖Y‖₁`).
-/

noncomputable section

namespace A4

section Operator

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E]

lemma unit_apply_inv_apply (u : (E →L[ℝ] E)ˣ) (y : E) :
    (u : E →L[ℝ] E) ((↑u⁻¹ : E →L[ℝ] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.mul_inv, ContinuousLinearMap.one_apply]

/-- `‖I - X B‖ ≤ θ` gives `(1 - θ) ‖v‖ ≤ ‖X‖ ‖B v‖`. -/
theorem approx_inverse_lower (X B : E →L[ℝ] E) (θ : ℝ) (hθ : ‖1 - X * B‖ ≤ θ) (v : E) :
    (1 - θ) * ‖v‖ ≤ ‖X‖ * ‖B v‖ := by
  have hsplit : v = X (B v) + (1 - X * B) v := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply,
      ContinuousLinearMap.mul_apply]
    abel
  have h2 : ‖v‖ ≤ ‖X‖ * ‖B v‖ + θ * ‖v‖ :=
    calc ‖v‖ = ‖X (B v) + (1 - X * B) v‖ := by rw [← hsplit]
      _ ≤ ‖X (B v)‖ + ‖(1 - X * B) v‖ := norm_add_le _ _
      _ ≤ ‖X‖ * ‖B v‖ + θ * ‖v‖ := add_le_add (X.le_opNorm _)
          ((ContinuousLinearMap.le_opNorm _ _).trans
            (mul_le_mul_of_nonneg_right hθ (norm_nonneg _)))
  linarith

theorem approx_inverse_injective (X B : E →L[ℝ] E) (θ : ℝ) (hθ : ‖1 - X * B‖ ≤ θ)
    (hθ1 : θ < 1) : Function.Injective B := by
  intro v w hvw
  have h := approx_inverse_lower X B θ hθ (v - w)
  rw [map_sub, hvw, sub_self, norm_zero, mul_zero] at h
  have h0 : ‖v - w‖ ≤ 0 := by nlinarith [norm_nonneg (v - w)]
  exact sub_eq_zero.mp (norm_le_zero_iff.mp h0)

/-- **A4.**  For invertible `B` (`↑u = B`) and `‖I - X B‖ ≤ θ < 1`: `‖B⁻¹‖ ≤ ‖X‖ / (1 - θ)`. -/
theorem approx_inverse_norm_bound (X : E →L[ℝ] E) (u : (E →L[ℝ] E)ˣ) (θ : ℝ)
    (hθ : ‖1 - X * (u : E →L[ℝ] E)‖ ≤ θ) (hθ1 : θ < 1) :
    ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ ‖X‖ / (1 - θ) := by
  have hpos : 0 < 1 - θ := sub_pos.mpr hθ1
  refine ContinuousLinearMap.opNorm_le_bound _ (div_nonneg (norm_nonneg _) hpos.le) (fun y => ?_)
  have h := approx_inverse_lower X (u : E →L[ℝ] E) θ hθ ((↑u⁻¹ : E →L[ℝ] E) y)
  rw [unit_apply_inv_apply] at h
  rw [div_mul_eq_mul_div, le_div_iff₀ hpos]
  linarith [h]

/-- **A4, finite dimension.**  `‖I - X B‖ ≤ θ < 1` proves that `B` is invertible, and
`‖B⁻¹‖ ≤ ‖X‖ / (1 - θ)`. -/
theorem approx_inverse_certificate [FiniteDimensional ℝ E] (X B : E →L[ℝ] E) (θ : ℝ)
    (hθ : ‖1 - X * B‖ ≤ θ) (hθ1 : θ < 1) :
    ∃ u : (E →L[ℝ] E)ˣ, (u : E →L[ℝ] E) = B ∧ ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ ‖X‖ / (1 - θ) := by
  have hinj : Function.Injective (B : E →ₗ[ℝ] E) := approx_inverse_injective X B θ hθ hθ1
  let e : E ≃L[ℝ] E :=
    (LinearEquiv.ofInjectiveEndo (B : E →ₗ[ℝ] E) hinj).toContinuousLinearEquiv
  have he : ((ContinuousLinearEquiv.toUnit e : (E →L[ℝ] E)ˣ) : E →L[ℝ] E) = B := by
    ext v
    rfl
  refine ⟨ContinuousLinearEquiv.toUnit e, he, ?_⟩
  exact approx_inverse_norm_bound X (ContinuousLinearEquiv.toUnit e) θ (by rw [he]; exact hθ) hθ1

end Operator

section Matrix

variable {ι : Type*} [Fintype ι]

/-- Frobenius bound: `‖Y v‖₂² ≤ ‖Y‖_F² ‖v‖₂²`. -/
theorem frobenius_bound (Y : ι → ι → ℝ) (v : ι → ℝ) :
    ∑ i, (∑ j, Y i j * v j) ^ 2 ≤ (∑ i, ∑ j, Y i j ^ 2) * ∑ j, v j ^ 2 := by
  calc ∑ i, (∑ j, Y i j * v j) ^ 2 ≤ ∑ i, (∑ j, Y i j ^ 2) * ∑ j, v j ^ 2 :=
        Finset.sum_le_sum (fun i _ => Finset.sum_mul_sq_le_sq_mul_sq _ _ _)
    _ = (∑ i, ∑ j, Y i j ^ 2) * ∑ j, v j ^ 2 := by rw [Finset.sum_mul]

/-- Schur test: if every row sum of `|Y|` is `≤ R` and every column sum is `≤ C`, then
`‖Y v‖₂² ≤ R C ‖v‖₂²`, i.e. `‖Y‖₂ ≤ √(‖Y‖₁ ‖Y‖∞)`. -/
theorem schur_bound (Y : ι → ι → ℝ) (v : ι → ℝ) (R C : ℝ)
    (hR : ∀ i, ∑ j, |Y i j| ≤ R) (hC : ∀ j, ∑ i, |Y i j| ≤ C) :
    ∑ i, (∑ j, Y i j * v j) ^ 2 ≤ R * C * ∑ j, v j ^ 2 := by
  rcases isEmpty_or_nonempty ι with hι | ⟨⟨i₀⟩⟩
  · simp [Finset.univ_eq_empty]
  have hR0 : 0 ≤ R := (Finset.sum_nonneg (fun j _ => abs_nonneg (Y i₀ j))).trans (hR i₀)
  have hrow : ∀ i, (∑ j, Y i j * v j) ^ 2 ≤ R * ∑ j, |Y i j| * v j ^ 2 := by
    intro i
    have h1 : (∑ j, Y i j * v j) ^ 2 ≤ (∑ j, |Y i j| * |v j|) ^ 2 := by
      have habs : |∑ j, Y i j * v j| ≤ ∑ j, |Y i j| * |v j| := by
        have := Finset.abs_sum_le_sum_abs (fun j => Y i j * v j) Finset.univ
        simpa only [abs_mul] using this
      have hab := abs_le.mp habs
      exact sq_le_sq' hab.1 hab.2
    have h2 : (∑ j, |Y i j| * |v j|) ^ 2 ≤ (∑ j, |Y i j|) * ∑ j, |Y i j| * v j ^ 2 :=
      Finset.sum_sq_le_sum_mul_sum_of_sq_eq_mul _ (fun j _ => abs_nonneg _)
        (fun j _ => mul_nonneg (abs_nonneg _) (sq_nonneg _))
        (fun j _ => by rw [mul_pow, sq_abs (v j)]; ring)
    have h3 : (∑ j, |Y i j|) * ∑ j, |Y i j| * v j ^ 2 ≤ R * ∑ j, |Y i j| * v j ^ 2 :=
      mul_le_mul_of_nonneg_right (hR i)
        (Finset.sum_nonneg (fun j _ => mul_nonneg (abs_nonneg _) (sq_nonneg _)))
    linarith
  calc ∑ i, (∑ j, Y i j * v j) ^ 2 ≤ ∑ i, R * ∑ j, |Y i j| * v j ^ 2 :=
        Finset.sum_le_sum (fun i _ => hrow i)
    _ = R * ∑ j, (∑ i, |Y i j|) * v j ^ 2 := by
        rw [← Finset.mul_sum, Finset.sum_comm]
        simp_rw [Finset.sum_mul]
    _ ≤ R * ∑ j, C * v j ^ 2 := by
        apply mul_le_mul_of_nonneg_left _ hR0
        exact Finset.sum_le_sum (fun j _ => mul_le_mul_of_nonneg_right (hC j) (sq_nonneg _))
    _ = R * C * ∑ j, v j ^ 2 := by rw [← Finset.mul_sum]; ring

end Matrix

end A4

#print axioms A4.approx_inverse_lower
#print axioms A4.approx_inverse_injective
#print axioms A4.approx_inverse_norm_bound
#print axioms A4.approx_inverse_certificate
#print axioms A4.frobenius_bound
#print axioms A4.schur_bound
