/-
# The finite-horizon Kreiss bound ‖A^t‖ ≤ (t+1)^(t+1)/t^t · K

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, R2).
`KreissSharpLowerBound.lean` shows that no smaller constant works.

Nothing here is new mathematics: the finite-horizon Kreiss bound with its sharp constant is
Lemma 4.1 of Nguyen-Cung & Nguyen (arXiv:2608.29823), credited there to Toh & Trefethen (1999); it
underlies the Kreiss matrix theorem (LeVeque & Trefethen 1984; Spijker 1991). This proof averages
over roots of unity instead of integrating over a contour.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/KreissFiniteHorizon.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 9 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Normed.Algebra.GelfandFormula
import Mathlib.RingTheory.RootsOfUnity.Complex
import Mathlib.Analysis.SpecialFunctions.Pow.NNReal
import Mathlib.Analysis.SpecificLimits.Basic

-- Some lemmas hold without every section hypothesis; the linter would ask to `omit` each one.
set_option linter.unusedSectionVars false

/-!
# C5: the finite-horizon Kreiss bound `‖A^t‖ ≤ (t+1)^(t+1)/t^t · K`

`E` is a nontrivial complex Banach space and `A : E →L[ℂ] E` satisfies Kreiss's resolvent
condition with constant `K` (`ResolventCond A K`, i.e. `𝒦(A) ≤ K`).

The proof avoids contour integrals: it averages the resolvent over the `N`-th roots of unity on the
circle `|z| = r` (a discrete Cauchy formula).  With `z_j = r ω^j` and
`Q(z) = Σ_{i<N} z^i A^(N-1-i)` one has, exactly, for `t < N`,
`N r^N A^t = Σ_j z_j^(t+1) Q(z_j)` and `Q(z_j) = (r^N - A^N) (z_j - A)⁻¹`, so
`‖A^t‖ ≤ r^(t+1)/(r-1) · K · (1 + ‖A^N‖/r^N)`.  Gelfand's formula (the spectrum lies in the closed
unit disk) makes `‖A^N‖/r^N → 0`.  Taking `r = 1 + 1/t` gives the sharp constant
`C_t = (t+1)^(t+1)/t^t < e(t+1)`; `KreissSharpLowerBound.lean` shows no smaller constant works.

Main results
* `roots_sum`, `unique_multiple`, `avg_identity`, `Q_mul` : the algebra of the discrete average.
* `spectrum_subset_disk`, `eventually_pow_lt` : `σ(A) ⊆ closed unit disk`, and `‖A^n‖ < q^n`
                       eventually, for every `q > 1` (Gelfand).
* `kreiss_avg_bound`  : `‖A^t‖ ≤ r^(t+1)/(r-1) · K · (1 + ‖A^N‖/r^N)` for `t < N`, `r > 1`.
* `kreiss_radius_bound` : `‖A^t‖ ≤ r^(t+1)/(r-1) · K` for every `r > 1`.
* `kreiss_finite_horizon` : `‖A^t‖ ≤ (t+1)^(t+1)/t^t · K` for `t ≥ 1`.
-/

noncomputable section

namespace KreissC

open Finset Filter Topology
open scoped NNReal ENNReal

/-! ## Roots of unity -/

lemma roots_sum {ω : ℂ} {N : ℕ} (hω : IsPrimitiveRoot ω N) (p : ℕ) :
    ∑ j ∈ range N, (ω ^ p) ^ j = if N ∣ p then (N : ℂ) else 0 := by
  split_ifs with h
  · have h1 : ω ^ p = 1 := (hω.pow_eq_one_iff_dvd p).mpr h
    simp [h1]
  · have h1 : ω ^ p ≠ 1 := fun h' => h ((hω.pow_eq_one_iff_dvd p).mp h')
    have h2 : (ω ^ p) ^ N = 1 := by
      rw [← pow_mul, mul_comm, pow_mul, hω.pow_eq_one, one_pow]
    have h3 := geom_sum_mul (ω ^ p) N
    rw [h2, sub_self] at h3
    exact (mul_eq_zero.mp h3).resolve_right (sub_ne_zero.mpr h1)

lemma unique_multiple {N t i : ℕ} (htN : t < N) (hi : i < N) (h : N ∣ t + 1 + i) :
    i = N - 1 - t := by
  by_contra hne
  rcases lt_or_gt_of_ne (show t + 1 + i ≠ N by omega) with hlt | hgt
  · have := Nat.eq_zero_of_dvd_of_lt h hlt
    omega
  · have h2 : N ∣ t + 1 + i - N := Nat.dvd_sub h (dvd_refl N)
    have h3 : t + 1 + i - N < N := by omega
    have := Nat.eq_zero_of_dvd_of_lt h2 h3
    omega

section Algebra

variable {𝒜 : Type*} [Ring 𝒜] [Algebra ℂ 𝒜]

/-- `Q(z) (z - a) = z^N - a^N` with `Q(z) = Σ_{i<N} z^i a^(N-1-i)`. -/
lemma Q_mul (a : 𝒜) (z : ℂ) (N : ℕ) :
    (∑ i ∈ range N, z ^ i • a ^ (N - 1 - i)) * (z • (1 : 𝒜) - a) = z ^ N • (1 : 𝒜) - a ^ N := by
  have hc : Commute (z • (1 : 𝒜)) a := (Commute.one_left a).smul_left z
  have h := hc.geom_sum₂_mul N
  have e : ∀ i, (z • (1 : 𝒜)) ^ i * a ^ (N - 1 - i) = z ^ i • a ^ (N - 1 - i) := by
    intro i
    rw [smul_pow, one_pow, smul_mul_assoc, one_mul]
  simp only [e] at h
  rw [h, smul_pow, one_pow]

/-- The discrete Cauchy formula: averaging `z^(t+1) Q(z)` over `z_j = r ω^j` extracts `a^t`. -/
lemma avg_identity (a : 𝒜) {N t : ℕ} (htN : t < N) {ω : ℂ} (hω : IsPrimitiveRoot ω N) (r : ℂ) :
    ∑ j ∈ range N, ((r * ω ^ j) ^ (t + 1)) • (∑ i ∈ range N, (r * ω ^ j) ^ i • a ^ (N - 1 - i))
      = ((N : ℂ) * r ^ N) • a ^ t := by
  have h1 : ∀ j, ((r * ω ^ j) ^ (t + 1)) • (∑ i ∈ range N, (r * ω ^ j) ^ i • a ^ (N - 1 - i))
      = ∑ i ∈ range N, (r ^ (t + 1 + i) * (ω ^ (t + 1 + i)) ^ j) • a ^ (N - 1 - i) := by
    intro j
    rw [Finset.smul_sum]
    refine Finset.sum_congr rfl fun i _ => ?_
    rw [smul_smul]
    congr 1
    ring
  rw [Finset.sum_congr rfl (fun j _ => h1 j), Finset.sum_comm]
  simp_rw [← Finset.sum_smul, ← Finset.mul_sum, roots_sum hω]
  rw [Finset.sum_eq_single (N - 1 - t)]
  · have e1 : t + 1 + (N - 1 - t) = N := by omega
    have e2 : N - 1 - (N - 1 - t) = t := by omega
    rw [e1, e2, if_pos (dvd_refl N), mul_comm]
  · intro i hi hne
    rw [if_neg (fun hd => hne (unique_multiple htN (Finset.mem_range.mp hi) hd)), mul_zero,
      zero_smul]
  · intro h
    exact absurd (Finset.mem_range.mpr (by omega)) h

end Algebra

/-! ## The bound -/

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℂ E]

/-- Kreiss's resolvent condition with constant `K` (vector form). -/
def ResolventCond (A : E →L[ℂ] E) (K : ℝ) : Prop :=
  ∀ z : ℂ, 1 < ‖z‖ → ∃ R : E →L[ℂ] E, (z • 1 - A) * R = 1 ∧ R * (z • 1 - A) = 1 ∧
    ∀ y, (‖z‖ - 1) * ‖R y‖ ≤ K * ‖y‖

/-- The resolvent condition puts the spectrum in the closed unit disk. -/
theorem spectrum_subset_disk {A : E →L[ℂ] E} {K : ℝ} (hRC : ResolventCond A K) :
    ∀ z ∈ spectrum ℂ A, ‖z‖ ≤ 1 := by
  intro z hz
  by_contra h
  push_neg at h
  obtain ⟨R, h1, h2, _⟩ := hRC z h
  apply (spectrum.mem_iff.mp hz)
  rw [Algebra.algebraMap_eq_smul_one]
  exact ⟨⟨z • 1 - A, R, h1, h2⟩, rfl⟩

variable [CompleteSpace E] [Nontrivial E]

/-- Gelfand: for every `q > 1`, eventually `‖A^n‖ < q^n`. -/
theorem eventually_pow_lt {A : E →L[ℂ] E} {K : ℝ} (hRC : ResolventCond A K) (q : ℝ≥0)
    (hq : 1 < q) : ∀ᶠ n : ℕ in atTop, ‖A ^ n‖ < (q : ℝ) ^ n := by
  have hlt : spectralRadius ℂ A < (q : ℝ≥0∞) := by
    apply spectrum.spectralRadius_lt_of_forall_lt
    intro z hz
    have h1 := spectrum_subset_disk hRC z hz
    have h2 : (‖z‖₊ : ℝ) ≤ 1 := by rw [coe_nnnorm]; exact h1
    have h3 : ‖z‖₊ ≤ 1 := by exact_mod_cast h2
    exact lt_of_le_of_lt h3 hq
  have hg := spectrum.pow_nnnorm_pow_one_div_tendsto_nhds_spectralRadius A
  filter_upwards [hg.eventually_lt_const hlt, eventually_ge_atTop 1] with n hn hn1
  have hn0 : (0 : ℝ) < n := by exact_mod_cast hn1
  rw [← ENNReal.coe_rpow_of_nonneg _ (by positivity), ENNReal.coe_lt_coe, one_div,
    NNReal.rpow_inv_lt_iff hn0, NNReal.rpow_natCast] at hn
  have h4 := NNReal.coe_lt_coe.mpr hn
  rwa [coe_nnnorm, NNReal.coe_pow] at h4

/-- **The discrete-average bound.** For `t < N` and `r > 1`:
`‖A^t‖ ≤ r^(t+1)/(r-1) · K · (1 + ‖A^N‖/r^N)`. -/
theorem kreiss_avg_bound {A : E →L[ℂ] E} {K : ℝ} (hK : 0 ≤ K) (hRC : ResolventCond A K)
    {t N : ℕ} (htN : t < N) {r : ℝ} (hr : 1 < r) :
    ‖A ^ t‖ ≤ r ^ (t + 1) / (r - 1) * K * (1 + ‖A ^ N‖ / r ^ N) := by
  have hN0 : N ≠ 0 := by omega
  obtain ⟨ω, hω⟩ : ∃ ω : ℂ, IsPrimitiveRoot ω N := ⟨_, Complex.isPrimitiveRoot_exp N hN0⟩
  have hωn : ‖ω‖ = 1 := hω.norm'_eq_one hN0
  have hr0 : 0 < r := by linarith
  have hr1 : 0 < r - 1 := by linarith
  have hzn : ∀ j : ℕ, ‖(r : ℂ) * ω ^ j‖ = r := by
    intro j
    rw [norm_mul, norm_pow, hωn, one_pow, mul_one, Complex.norm_of_nonneg hr0.le]
  have hz : ∀ j : ℕ, 1 < ‖(r : ℂ) * ω ^ j‖ := fun j => by rw [hzn j]; exact hr
  choose R hR1 hR2 hR3 using fun j : ℕ => hRC ((r : ℂ) * ω ^ j) (hz j)
  have hRn : ∀ j, ‖R j‖ ≤ K / (r - 1) := by
    intro j
    refine ContinuousLinearMap.opNorm_le_bound _ (div_nonneg hK hr1.le) (fun y => ?_)
    have h := hR3 j y
    rw [hzn j] at h
    rw [div_mul_eq_mul_div, le_div_iff₀ hr1]
    linarith [h]
  have hQ : ∀ j, (∑ i ∈ range N, ((r : ℂ) * ω ^ j) ^ i • A ^ (N - 1 - i)) =
      (((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N) * R j := by
    intro j
    have hzN : ((r : ℂ) * ω ^ j) ^ N = (r : ℂ) ^ N := by
      rw [mul_pow, ← pow_mul, mul_comm j N, pow_mul, hω.pow_eq_one, one_pow, mul_one]
    calc (∑ i ∈ range N, ((r : ℂ) * ω ^ j) ^ i • A ^ (N - 1 - i))
        = (∑ i ∈ range N, ((r : ℂ) * ω ^ j) ^ i • A ^ (N - 1 - i)) *
            ((((r : ℂ) * ω ^ j) • (1 : E →L[ℂ] E) - A) * R j) := by rw [hR1 j, mul_one]
      _ = ((∑ i ∈ range N, ((r : ℂ) * ω ^ j) ^ i • A ^ (N - 1 - i)) *
            (((r : ℂ) * ω ^ j) • (1 : E →L[ℂ] E) - A)) * R j := (mul_assoc _ _ _).symm
      _ = (((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N) * R j := by rw [Q_mul, hzN]
  have hid : ((N : ℂ) * (r : ℂ) ^ N) • A ^ t =
      ∑ j ∈ range N, ((r : ℂ) * ω ^ j) ^ (t + 1) •
        ((((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N) * R j) := by
    rw [← avg_identity A htN hω (r : ℂ)]
    exact Finset.sum_congr rfl fun j _ => by rw [hQ j]
  have h1n : ‖(1 : E →L[ℂ] E)‖ = 1 := norm_one
  have hterm : ∀ j, ‖((r : ℂ) * ω ^ j) ^ (t + 1) •
      ((((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N) * R j)‖
      ≤ r ^ (t + 1) * ((r ^ N + ‖A ^ N‖) * (K / (r - 1))) := by
    intro j
    rw [norm_smul, norm_pow, hzn j]
    refine mul_le_mul_of_nonneg_left ?_ (pow_nonneg hr0.le _)
    have hsub : ‖((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N‖ ≤ r ^ N + ‖A ^ N‖ := by
      calc ‖((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N‖
          ≤ ‖((r : ℂ) ^ N) • (1 : E →L[ℂ] E)‖ + ‖A ^ N‖ := norm_sub_le _ _
        _ = r ^ N + ‖A ^ N‖ := by
          rw [norm_smul, h1n, mul_one, norm_pow, Complex.norm_of_nonneg hr0.le]
    calc ‖(((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N) * R j‖
        ≤ ‖((r : ℂ) ^ N) • (1 : E →L[ℂ] E) - A ^ N‖ * ‖R j‖ := norm_mul_le _ _
      _ ≤ (r ^ N + ‖A ^ N‖) * (K / (r - 1)) :=
          mul_le_mul hsub (hRn j) (norm_nonneg _) (add_nonneg (pow_nonneg hr0.le N) (norm_nonneg _))
  have hsum : ‖((N : ℂ) * (r : ℂ) ^ N) • A ^ t‖ ≤
      N * (r ^ (t + 1) * ((r ^ N + ‖A ^ N‖) * (K / (r - 1)))) := by
    rw [hid]
    refine (norm_sum_le _ _).trans ((Finset.sum_le_sum fun j _ => hterm j).trans ?_)
    simp only [Finset.sum_const, Finset.card_range, nsmul_eq_mul, le_refl]
  rw [norm_smul, norm_mul, Complex.norm_natCast, norm_pow, Complex.norm_of_nonneg hr0.le] at hsum
  have hNr : 0 < (N : ℝ) * r ^ N := mul_pos (Nat.cast_pos.mpr (Nat.pos_of_ne_zero hN0)) (pow_pos hr0 N)
  have hrN : r ^ N ≠ 0 := (pow_pos hr0 N).ne'
  have e : r ^ N * (1 + ‖A ^ N‖ / r ^ N) = r ^ N + ‖A ^ N‖ := by
    rw [mul_add, mul_one, mul_div_assoc', mul_div_cancel_left₀ _ hrN]
  have key : (N : ℝ) * r ^ N * ‖A ^ t‖ ≤
      (N : ℝ) * r ^ N * (r ^ (t + 1) / (r - 1) * K * (1 + ‖A ^ N‖ / r ^ N)) := by
    calc (N : ℝ) * r ^ N * ‖A ^ t‖ ≤ N * (r ^ (t + 1) * ((r ^ N + ‖A ^ N‖) * (K / (r - 1)))) := hsum
      _ = (N : ℝ) * (r ^ (t + 1) / (r - 1) * K) * (r ^ N + ‖A ^ N‖) := by ring
      _ = (N : ℝ) * (r ^ (t + 1) / (r - 1) * K) * (r ^ N * (1 + ‖A ^ N‖ / r ^ N)) := by rw [e]
      _ = (N : ℝ) * r ^ N * (r ^ (t + 1) / (r - 1) * K * (1 + ‖A ^ N‖ / r ^ N)) := by ring
  exact le_of_mul_le_mul_left key hNr

/-- **The radius bound.** `‖A^t‖ ≤ r^(t+1)/(r-1) · K` for every `r > 1`. -/
theorem kreiss_radius_bound {A : E →L[ℂ] E} {K : ℝ} (hK : 0 ≤ K) (hRC : ResolventCond A K)
    (t : ℕ) {r : ℝ} (hr : 1 < r) : ‖A ^ t‖ ≤ r ^ (t + 1) / (r - 1) * K := by
  have hr0 : 0 < r := by linarith
  have hr1 : 0 < r - 1 := by linarith
  set q : ℝ≥0 := Real.toNNReal ((1 + r) / 2) with hq_def
  have hqv : (q : ℝ) = (1 + r) / 2 := Real.coe_toNNReal _ (by linarith)
  have hq1 : (1 : ℝ≥0) < q := by
    rw [← NNReal.coe_lt_coe, NNReal.coe_one, hqv]
    linarith
  have hqr : (q : ℝ) < r := by rw [hqv]; linarith
  have hev := eventually_pow_lt hRC q hq1
  have hc0 : 0 ≤ r ^ (t + 1) / (r - 1) * K := mul_nonneg (div_nonneg (pow_nonneg hr0.le _) hr1.le) hK
  have hlim : Tendsto (fun N : ℕ => r ^ (t + 1) / (r - 1) * K * (1 + ((q : ℝ) / r) ^ N)) atTop
      (𝓝 (r ^ (t + 1) / (r - 1) * K * (1 + 0))) := by
    apply Tendsto.const_mul
    apply Tendsto.const_add
    exact tendsto_pow_atTop_nhds_zero_of_lt_one (div_nonneg q.2 hr0.le) ((div_lt_one hr0).mpr hqr)
  rw [add_zero, mul_one] at hlim
  refine ge_of_tendsto hlim ?_
  filter_upwards [hev, eventually_gt_atTop t] with N hN hNt
  calc ‖A ^ t‖ ≤ r ^ (t + 1) / (r - 1) * K * (1 + ‖A ^ N‖ / r ^ N) := kreiss_avg_bound hK hRC hNt hr
    _ ≤ r ^ (t + 1) / (r - 1) * K * (1 + ((q : ℝ) / r) ^ N) := by
      refine mul_le_mul_of_nonneg_left (add_le_add le_rfl ?_) hc0
      rw [div_pow]
      exact div_le_div_of_nonneg_right hN.le (pow_pos hr0 N).le

/-- **C5, the finite-horizon Kreiss bound.** `‖A^t‖ ≤ (t+1)^(t+1)/t^t · K < e(t+1) K` for `t ≥ 1`
(radius `r = 1 + 1/t`); together with `ratio_approaches_sharp` in `KreissSharpLowerBound.lean` the constant is sharp. -/
theorem kreiss_finite_horizon {A : E →L[ℂ] E} {K : ℝ} (hK : 0 ≤ K) (hRC : ResolventCond A K)
    (t : ℕ) (ht : 1 ≤ t) : ‖A ^ t‖ ≤ ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * K := by
  have htp : (0 : ℝ) < t := by exact_mod_cast ht
  have htne : (t : ℝ) ≠ 0 := htp.ne'
  have hr : 1 < 1 + 1 / (t : ℝ) := by
    have := one_div_pos.mpr htp
    linarith
  have h := kreiss_radius_bound hK hRC t hr
  have e : (1 + 1 / (t : ℝ)) ^ (t + 1) / (1 + 1 / (t : ℝ) - 1) =
      ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t := by
    rw [add_sub_cancel_left, one_add_div htne, div_pow, div_div_eq_mul_div, div_one,
      div_mul_eq_mul_div, div_eq_div_iff (pow_ne_zero _ htne) (pow_ne_zero _ htne)]
    ring
  rwa [e] at h

end KreissC

#print axioms KreissC.roots_sum
#print axioms KreissC.unique_multiple
#print axioms KreissC.Q_mul
#print axioms KreissC.avg_identity
#print axioms KreissC.spectrum_subset_disk
#print axioms KreissC.eventually_pow_lt
#print axioms KreissC.kreiss_avg_bound
#print axioms KreissC.kreiss_radius_bound
#print axioms KreissC.kreiss_finite_horizon
