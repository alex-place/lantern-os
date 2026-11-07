/-
# The depth cap's pass threshold, in log form

Part of claim 2 of the certificate's 2026-11-07 pure-math pass
(`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: logarithm algebra for the a-priori bound of Banach's theorem.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopDepthCapThreshold.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 7 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.SpecialFunctions.Log.Basic

/-!
# Claim 2a: the pass threshold in log form

`LoopDepthCap.lean` states the cap with the log-free condition `L^k · D < γ`. This file converts it
to the claim's log formula and shows exactly where the claim's ceiling is off by one.

* `pow_mul_lt_iff`: `L^k · D < γ ↔ log(D/γ)/log(1/L) < k`.
* `pow_mul_le_iff`: `L^k · D ≤ γ ↔ log(D/γ)/log(1/L) ≤ k`.
* `ceiling_threshold_le`: the claim's `k* = ⌈log(D/γ)/log(1/L)⌉₊` only gives `L^k · D ≤ γ`.
* `ceiling_example`: in the counterexample `L = 1/2, D = 1, γ = 1/2`, the claim's `k*` is `1`.
* `corrected_threshold`, `corrected_threshold_least`: `⌊log(D/γ)/log(1/L)⌋₊ + 1` is the least
  `k` with `L^k · D < γ` (when `γ ≤ D`).
* `cap_log_form`: the corrected cap, all passes `k ≥ ⌊log(D/γ)/log(1/L)⌋₊ + 1`.
-/

open Function

namespace Claim2Log

theorem pow_mul_lt_iff {L D γ : ℝ} (hL0 : 0 < L) (hL1 : L < 1) (hD : 0 < D) (hγ : 0 < γ)
    (k : ℕ) : L ^ k * D < γ ↔ Real.log (D / γ) / Real.log (1 / L) < k := by
  have hlogL : 0 < Real.log (1 / L) := Real.log_pos (one_lt_one_div hL0 hL1)
  rw [div_lt_iff₀ hlogL, ← Real.log_pow,
    Real.log_lt_log_iff (div_pos hD hγ) (pow_pos (one_div_pos.mpr hL0) k),
    one_div_pow, div_lt_div_iff₀ hγ (pow_pos hL0 k), one_mul, mul_comm]

theorem pow_mul_le_iff {L D γ : ℝ} (hL0 : 0 < L) (hL1 : L < 1) (hD : 0 < D) (hγ : 0 < γ)
    (k : ℕ) : L ^ k * D ≤ γ ↔ Real.log (D / γ) / Real.log (1 / L) ≤ k := by
  have hlogL : 0 < Real.log (1 / L) := Real.log_pos (one_lt_one_div hL0 hL1)
  rw [div_le_iff₀ hlogL, ← Real.log_pow,
    Real.log_le_log_iff (div_pos hD hγ) (pow_pos (one_div_pos.mpr hL0) k),
    one_div_pow, div_le_div_iff₀ hγ (pow_pos hL0 k), one_mul, mul_comm]

/-- The claim's threshold `⌈log(D/γ)/log(1/L)⌉₊` guarantees only `L^k · D ≤ γ`, which is not
enough for an open-ball margin. -/
theorem ceiling_threshold_le {L D γ : ℝ} (hL0 : 0 < L) (hL1 : L < 1) (hD : 0 < D) (hγ : 0 < γ)
    {k : ℕ} (hk : ⌈Real.log (D / γ) / Real.log (1 / L)⌉₊ ≤ k) : L ^ k * D ≤ γ := by
  rw [pow_mul_le_iff hL0 hL1 hD hγ]
  exact Nat.ceil_le.mp hk

/-- In the counterexample `L = 1/2`, `D = 1`, `γ = 1/2` the claim's `k*` equals `1`. -/
theorem ceiling_example :
    ⌈Real.log ((1 : ℝ) / (1 / 2)) / Real.log ((1 : ℝ) / (1 / 2))⌉₊ = 1 := by
  rw [div_self (Real.log_pos (by norm_num : (1 : ℝ) < 1 / (1 / 2))).ne', Nat.ceil_one]

/-- **Corrected threshold.** `k* = ⌊log(D/γ)/log(1/L)⌋₊ + 1` gives `L^k* · D < γ`. -/
theorem corrected_threshold {L D γ : ℝ} (hL0 : 0 < L) (hL1 : L < 1) (hD : 0 < D) (hγ : 0 < γ) :
    L ^ (⌊Real.log (D / γ) / Real.log (1 / L)⌋₊ + 1) * D < γ := by
  rw [pow_mul_lt_iff hL0 hL1 hD hγ]
  push_cast
  exact Nat.lt_floor_add_one _

/-- The corrected threshold is the least `k` with `L^k · D < γ` (when `γ ≤ D`). -/
theorem corrected_threshold_least {L D γ : ℝ} (hL0 : 0 < L) (hL1 : L < 1) (hD : 0 < D)
    (hγ : 0 < γ) (hγD : γ ≤ D) {k : ℕ} (hk : L ^ k * D < γ) :
    ⌊Real.log (D / γ) / Real.log (1 / L)⌋₊ + 1 ≤ k := by
  rw [pow_mul_lt_iff hL0 hL1 hD hγ] at hk
  have hx : 0 ≤ Real.log (D / γ) / Real.log (1 / L) :=
    div_nonneg (Real.log_nonneg ((le_div_iff₀ hγ).mpr (by linarith)))
      (Real.log_pos (one_lt_one_div hL0 hL1)).le
  have := (Nat.floor_lt hx).mpr hk
  omega

section Cap

variable {X : Type*} [MetricSpace X] {Y : Type*}

/-- `C` has margin `γ` at `p`: it is constant on the open `γ`-ball around `p`. -/
def HasMargin (C : X → Y) (p : X) (γ : ℝ) : Prop :=
  ∀ x, dist x p < γ → C x = C p

theorem dist_iterate_le {F : X → X} {L : ℝ} (hL0 : 0 ≤ L)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p) (x : X) :
    ∀ k : ℕ, dist (F^[k] x) p ≤ L ^ k * dist x p := by
  intro k
  induction k with
  | zero => simp
  | succ k ih =>
    calc dist (F^[k + 1] x) p = dist (F (F^[k] x)) (F p) := by rw [iterate_succ_apply', hp]
      _ ≤ L * dist (F^[k] x) p := hF _ _
      _ ≤ L * (L ^ k * dist x p) := mul_le_mul_of_nonneg_left ih hL0
      _ = L ^ (k + 1) * dist x p := by ring

theorem output_settles {F : X → X} {L : ℝ} (hL0 : 0 ≤ L) (hL1 : L ≤ 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C p γ) {x : X} {D : ℝ} (hD : dist x p ≤ D)
    {k₀ : ℕ} (hk₀ : L ^ k₀ * D < γ) :
    ∀ k, k₀ ≤ k → C (F^[k] x) = C p := by
  intro k hk
  apply hC
  have hD0 : 0 ≤ D := le_trans dist_nonneg hD
  calc dist (F^[k] x) p ≤ L ^ k * dist x p := dist_iterate_le hL0 hF hp x k
    _ ≤ L ^ k * D := mul_le_mul_of_nonneg_left hD (pow_nonneg hL0 k)
    _ ≤ L ^ k₀ * D := mul_le_mul_of_nonneg_right (pow_le_pow_of_le_one hL0 hL1 hk) hD0
    _ < γ := hk₀

/-- **Claim 2a, corrected, in the claim's log form.** Every pass
`k ≥ ⌊log(D/γ)/log(1/L)⌋₊ + 1` gives the fixed point's output. -/
theorem cap_log_form {F : X → X} {L : ℝ} (hL0 : 0 < L) (hL1 : L < 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {C : X → Y} {γ : ℝ} (hγ : 0 < γ) (hC : HasMargin C p γ) {x : X} {D : ℝ} (hD0 : 0 < D)
    (hD : dist x p ≤ D) :
    ∀ k, ⌊Real.log (D / γ) / Real.log (1 / L)⌋₊ + 1 ≤ k → C (F^[k] x) = C p :=
  output_settles hL0.le hL1.le hF hp hC hD (corrected_threshold hL0 hL1 hD0 hγ)

end Cap

end Claim2Log

#print axioms Claim2Log.pow_mul_lt_iff
#print axioms Claim2Log.pow_mul_le_iff
#print axioms Claim2Log.ceiling_threshold_le
#print axioms Claim2Log.ceiling_example
#print axioms Claim2Log.corrected_threshold
#print axioms Claim2Log.corrected_threshold_least
#print axioms Claim2Log.cap_log_form
