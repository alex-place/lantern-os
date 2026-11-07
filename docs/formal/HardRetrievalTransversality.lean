/-
# Hard top-k retrieval: moving the values moves every image, for every λ < 1

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: geometric sums of a contraction, and the transversality step of
the Bruin–Deane and Gaivão–Pires genericity arguments for piecewise contractions.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/HardRetrievalTransversality.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 10 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Normed.Module.Basic
import Mathlib.Algebra.Ring.GeomSum
import Mathlib.Topology.Order.IntermediateValue
import Mathlib.Topology.MetricSpace.Pseudo.Lemmas
import Mathlib.Topology.Algebra.Monoid
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Ring

/-!
# B2, step 2: transversality of the image-centre map in the values `V`

For an itinerary `S_0, …, S_{n-1}` the `n`-step image centre is
`t(V) = ∑_{i<n} A^{n-1-i} (c + b_{S_i})`, `b_S = (1/k) ∑_{j ∈ S} v_j`.

* `common_shift_transversal`: shifting every value by the same `w` moves `t` by
  `∑_{m<n} A^m w`, and `‖∑_{m<n} A^m w‖ ≥ (1 - λ^n)/(1 + λ) ‖w‖` for EVERY `λ = ‖A‖ < 1`.
  So transversality needs no `λ < 1/2`.
* `last_value_transversal`: a per-coordinate bound: the coefficient of a value selected
  at the last step is `(1/k)(I + ∑_{m ∈ M} A^{m+1})`, and it is bounded below by
  `(1 - 2λ)/(k (1 - λ))` (useful only for `λ < 1/2`).
* `per_coordinate_coefficient_can_vanish`: that per-coordinate route genuinely fails above
  `λ ≈ 0.6823`: for `A = a` with `1 + a + a³ = 0`, `a ∈ (-0.69, -0.68)`, the coefficient of a value
  selected at steps `n-1, n-2, n-4` is `0`.

Linear maps are used through their iterates `A^[m]`; the only hypothesis on `A` is
`‖A x‖ ≤ q ‖x‖` with `0 ≤ q < 1`.
-/

open Finset

namespace TopKTransversality

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E]

/-- `‖A^[n] x‖ ≤ q^n ‖x‖`. -/
lemma iterate_norm_le (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖)
    (x : E) (n : ℕ) : ‖(⇑A)^[n] x‖ ≤ q ^ n * ‖x‖ := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [Function.iterate_succ_apply']
    calc ‖A ((⇑A)^[n] x)‖ ≤ q * ‖(⇑A)^[n] x‖ := hA _
      _ ≤ q * (q ^ n * ‖x‖) := mul_le_mul_of_nonneg_left ih hq0
      _ = q ^ (n + 1) * ‖x‖ := by ring

/-- Telescoping: with `s = ∑_{m<n} A^m x`, `s - A s = x - A^n x`. -/
lemma telescope (A : E →ₗ[ℝ] E) (x : E) (n : ℕ) :
    (∑ m ∈ range n, (⇑A)^[m] x) - A (∑ m ∈ range n, (⇑A)^[m] x) = x - (⇑A)^[n] x := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [sum_range_succ, map_add, Function.iterate_succ_apply' (⇑A) n x]
    have e : (∑ m ∈ range n, (⇑A)^[m] x) + (⇑A)^[n] x
        - (A (∑ m ∈ range n, (⇑A)^[m] x) + A ((⇑A)^[n] x))
        = ((∑ m ∈ range n, (⇑A)^[m] x) - A (∑ m ∈ range n, (⇑A)^[m] x))
          + ((⇑A)^[n] x - A ((⇑A)^[n] x)) := by abel
    rw [e, ih]
    abel

/-- **Common-shift transversality**, for every `q < 1`:
`(1 - q^n) ‖x‖ ≤ (1 + q) ‖∑_{m<n} A^m x‖`. -/
theorem common_shift_transversal (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (x : E) (n : ℕ) :
    (1 - q ^ n) * ‖x‖ ≤ (1 + q) * ‖∑ m ∈ range n, (⇑A)^[m] x‖ := by
  set s := ∑ m ∈ range n, (⇑A)^[m] x with hs
  have h1 : ‖x - (⇑A)^[n] x‖ = ‖s - A s‖ := by rw [telescope A x n]
  have h2 : ‖x‖ - ‖(⇑A)^[n] x‖ ≤ ‖x - (⇑A)^[n] x‖ := norm_sub_norm_le _ _
  have h3 : ‖(⇑A)^[n] x‖ ≤ q ^ n * ‖x‖ := iterate_norm_le A q hq0 hA x n
  have h4 : ‖s - A s‖ ≤ ‖s‖ + ‖A s‖ := norm_sub_le _ _
  have h5 : ‖A s‖ ≤ q * ‖s‖ := hA s
  nlinarith

/-- The same as a lower bound on the smallest singular value: `σ_min ≥ (1 - q^n)/(1 + q)`. -/
theorem common_shift_transversal' (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (x : E) (n : ℕ) :
    (1 - q ^ n) / (1 + q) * ‖x‖ ≤ ‖∑ m ∈ range n, (⇑A)^[m] x‖ := by
  have hpos : 0 < 1 + q := by linarith
  have h := common_shift_transversal A q hq0 hA x n
  rw [div_mul_eq_mul_div, div_le_iff₀ hpos]
  linarith

/-- Uniform in `n ≥ 1`: `σ_min ≥ (1 - q)/(1 + q)`. -/
theorem common_shift_transversal_uniform (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (x : E) (n : ℕ) (hn : 1 ≤ n) :
    (1 - q) / (1 + q) * ‖x‖ ≤ ‖∑ m ∈ range n, (⇑A)^[m] x‖ := by
  have hpow : q ^ n ≤ q := by
    calc q ^ n ≤ q ^ 1 := pow_le_pow_of_le_one hq0 hq1.le hn
      _ = q := pow_one q
  have hpos : 0 < 1 + q := by linarith
  have h := common_shift_transversal' A q hq0 hA x n
  have hmono : (1 - q) / (1 + q) ≤ (1 - q ^ n) / (1 + q) :=
    div_le_div_of_nonneg_right (by linarith) hpos.le
  have hx : 0 ≤ ‖x‖ := norm_nonneg x
  nlinarith

/-- `∑_{m<n} q^m ≤ 1/(1 - q)`. -/
lemma geom_le (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1) (n : ℕ) :
    ∑ m ∈ range n, q ^ m ≤ 1 / (1 - q) := by
  have hpos : 0 < 1 - q := by linarith
  have e := mul_neg_geom_sum q n
  have hqn : 0 ≤ q ^ n := pow_nonneg hq0 n
  rw [le_div_iff₀ hpos, mul_comm]
  linarith

/-- **A per-coordinate bound.** For any set `M ⊆ {0,…,n-1}` of "earlier selections",
`‖x + ∑_{m∈M} A^{m+1} x‖ ≥ (1 - 2q)/(1 - q) ‖x‖`. -/
theorem last_value_transversal (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (x : E) (n : ℕ) (M : Finset ℕ) (hM : M ⊆ range n) :
    (1 - 2 * q) / (1 - q) * ‖x‖ ≤ ‖x + ∑ m ∈ M, (⇑A)^[m + 1] x‖ := by
  have hpos : 0 < 1 - q := by linarith
  have hx : 0 ≤ ‖x‖ := norm_nonneg x
  set y := ∑ m ∈ M, (⇑A)^[m + 1] x with hy
  have h1 : ‖y‖ ≤ ∑ m ∈ M, ‖(⇑A)^[m + 1] x‖ := norm_sum_le _ _
  have h2 : ∑ m ∈ M, ‖(⇑A)^[m + 1] x‖ ≤ ∑ m ∈ M, q ^ (m + 1) * ‖x‖ :=
    sum_le_sum (fun m _ => iterate_norm_le A q hq0 hA x (m + 1))
  have h3 : ∑ m ∈ M, q ^ (m + 1) * ‖x‖ ≤ ∑ m ∈ range n, q ^ (m + 1) * ‖x‖ :=
    sum_le_sum_of_subset_of_nonneg hM (fun m _ _ => mul_nonneg (pow_nonneg hq0 _) hx)
  have h4 : ∑ m ∈ range n, q ^ (m + 1) * ‖x‖ = q * ‖x‖ * ∑ m ∈ range n, q ^ m := by
    rw [mul_sum]
    exact sum_congr rfl (fun m _ => by ring)
  have h5 := geom_le q hq0 hq1 n
  have h6 : q * ‖x‖ * ∑ m ∈ range n, q ^ m ≤ q * ‖x‖ * (1 / (1 - q)) :=
    mul_le_mul_of_nonneg_left h5 (mul_nonneg hq0 hx)
  have hyle : ‖y‖ ≤ q * ‖x‖ / (1 - q) := by
    have e : q * ‖x‖ * (1 / (1 - q)) = q * ‖x‖ / (1 - q) := by ring
    linarith
  have htri : ‖x‖ ≤ ‖x + y‖ + ‖y‖ := by
    have := norm_sub_le (x + y) y
    rwa [add_sub_cancel_right] at this
  have e2 : (1 - 2 * q) / (1 - q) * ‖x‖ = ‖x‖ - q * ‖x‖ / (1 - q) := by
    field_simp
    ring
  rw [e2]
  linarith

/-- With the `1/k` of the top-`k` average: `σ_min(C_j) ≥ (1 - 2q)/(k (1 - q))`. -/
theorem last_value_transversal_k (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (x : E) (n : ℕ) (M : Finset ℕ) (hM : M ⊆ range n)
    (k : ℕ) (hk : 0 < k) :
    (1 - 2 * q) / ((k : ℝ) * (1 - q)) * ‖x‖ ≤ ‖(k : ℝ)⁻¹ • (x + ∑ m ∈ M, (⇑A)^[m + 1] x)‖ := by
  have hkpos : (0 : ℝ) < k := by exact_mod_cast hk
  have h := last_value_transversal A q hq0 hq1 hA x n M hM
  rw [norm_smul, Real.norm_eq_abs, abs_of_pos (inv_pos.mpr hkpos)]
  have e : (1 - 2 * q) / ((k : ℝ) * (1 - q)) * ‖x‖
      = (k : ℝ)⁻¹ * ((1 - 2 * q) / (1 - q) * ‖x‖) := by
    field_simp
  rw [e]
  exact mul_le_mul_of_nonneg_left h (inv_nonneg.mpr hkpos.le)

/-- **The per-coordinate route fails for larger `λ`.** There is `a ∈ (-0.69, -0.68)` with
`1 + a + a³ = 0`: for the scalar contraction `A = a` (`|a| < 0.69`) the coefficient of a value
selected exactly at steps `n-1, n-2, n-4` of an itinerary is `(1/k)(1 + a + a³) = 0`. -/
theorem per_coordinate_coefficient_can_vanish :
    ∃ a : ℝ, -69/100 < a ∧ a < -17/25 ∧ 1 + a + a ^ 3 = 0 := by
  have hcont : Continuous (fun a : ℝ => 1 + a + a ^ 3) :=
    (continuous_const.add continuous_id').add (continuous_id'.pow 3)
  have hab : (-69/100 : ℝ) ≤ -17/25 := by norm_num
  have hivt := intermediate_value_Icc hab hcont.continuousOn
  have h0 : (0 : ℝ) ∈ Set.Icc (1 + (-69/100 : ℝ) + (-69/100) ^ 3) (1 + (-17/25 : ℝ) + (-17/25) ^ 3) := by
    constructor <;> norm_num
  obtain ⟨c, ⟨hc1, hc2⟩, hgc⟩ := hivt h0
  simp only at hgc
  refine ⟨c, ?_, ?_, hgc⟩
  · rcases eq_or_lt_of_le hc1 with h | h
    · exfalso; rw [← h] at hgc; norm_num at hgc
    · exact h
  · rcases eq_or_lt_of_le hc2 with h | h
    · exfalso; rw [h] at hgc; norm_num at hgc
    · exact h

/-- ... while the common-shift coefficient `∑_{m<n} a^m` never vanishes for `|a| < 1`, `n ≥ 1`. -/
theorem common_shift_coefficient_ne_zero (a : ℝ) (ha : |a| < 1) (n : ℕ) (hn : 1 ≤ n) :
    ∑ m ∈ range n, a ^ m ≠ 0 := by
  intro h
  have e := mul_neg_geom_sum a n
  rw [h, mul_zero] at e
  have h1 : |a ^ n| < 1 := by
    rw [abs_pow]
    calc |a| ^ n ≤ |a| ^ 1 := pow_le_pow_of_le_one (abs_nonneg a) ha.le hn
      _ = |a| := pow_one _
      _ < 1 := ha
  have h2 : a ^ n ≤ |a ^ n| := le_abs_self _
  linarith

end TopKTransversality

#print axioms TopKTransversality.iterate_norm_le
#print axioms TopKTransversality.telescope
#print axioms TopKTransversality.common_shift_transversal
#print axioms TopKTransversality.common_shift_transversal'
#print axioms TopKTransversality.common_shift_transversal_uniform
#print axioms TopKTransversality.geom_le
#print axioms TopKTransversality.last_value_transversal
#print axioms TopKTransversality.last_value_transversal_k
#print axioms TopKTransversality.per_coordinate_coefficient_can_vanish
#print axioms TopKTransversality.common_shift_coefficient_ne_zero
