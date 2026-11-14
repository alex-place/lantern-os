/-
# The Σ₀⁻¹ kick needs a measurement, and the flat leg comes back

Claim 1 of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`,
§2 and §3): the kick alone cannot make the state right, a measurement of every kicked direction
can, and a covariance update makes `Σ` flat again, so C3 covers one evaluation.

Scalar (`m = 1`) forms of claim 1(b), and the two-level spectrum behind claim 1(c). Real algebra
plus `Tendsto` for the limits. No probability: the expectation steps (independence, the cross
terms) are paper proofs, summarized in the certificate, and these theorems are what remains once they
are done.

Scalar model. Error `e = x − x*`; one pass is the kick, then the update with gain `k`:
  `e' = (1 − k h)(e + κ ξ) + k v`,  `ξ ~ N(0,1)`, `v ~ N(0,r)`, independent of `e`.
So `E e' = (1 − k h) E e` and `Var e' = (1 − k h)² (Var e + q) + k² r` with `q = κ²`.
Kalman gain at prior variance `s`: `k = s h / (h² s + r)`. One Kalman pass on the posterior
variance (predict `+ q`, then update): `s' = r (s + q) / (h² (s + q) + r)`.

Two-level spectrum: `m` eigenvalues `u` and `n − m` eigenvalues `s`, mean `μ = (m u + (n−m) s)/n`.
The gate's anisotropy is `cv = std/mean` with the unbiased std, and the flat leg is `cv < ε_a = 1/20`.

Nothing here is new mathematics. It is textbook estimation and filtering (Lehmann & Casella 1998;
Anderson & Moore 1979; Chan, Goodwin & Sin 1984), applied to the Σ₀⁻¹ operator and to the engine's
own covariance step.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/Sigma0KickMeasurement.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 25 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.SpecificLimits.Basic
import Mathlib.Data.Real.Sqrt
import Mathlib.Topology.MetricSpace.Pseudo.Lemmas
import Mathlib.Topology.Order.Basic
import Mathlib.Algebra.Order.Archimedean.Basic
import Mathlib.Tactic.LinearCombination
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.Ring
import Mathlib.Tactic.NormNum

open Filter Topology

namespace Claim1

/-! ## A geometric bound gives a limit -/

/-- If `|s n − a| ≤ L^n · C` with `0 ≤ L < 1`, then `s n → a`. -/
theorem tendsto_of_geom {s : ℕ → ℝ} {a L C : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1)
    (hb : ∀ n, |s n - a| ≤ L ^ n * C) : Tendsto s atTop (𝓝 a) := by
  have hg : Tendsto (fun n : ℕ => L ^ n * C) atTop (𝓝 0) := by
    have h := (tendsto_pow_atTop_nhds_zero_of_lt_one hL0 hL1).mul_const C
    rwa [zero_mul] at h
  have hlo : Tendsto (fun n : ℕ => a - L ^ n * C) atTop (𝓝 a) := by
    have h := hg.const_sub a
    rwa [sub_zero] at h
  have hhi : Tendsto (fun n : ℕ => a + L ^ n * C) atTop (𝓝 a) := by
    have h := hg.const_add a
    rwa [add_zero] at h
  refine tendsto_of_tendsto_of_tendsto_of_le_of_le hlo hhi (fun n => ?_) (fun n => ?_)
  · show a - L ^ n * C ≤ s n
    linarith [(abs_le.1 (hb n)).1]
  · show s n ≤ a + L ^ n * C
    linarith [(abs_le.1 (hb n)).2]

/-! ## Claim 1(b), scalar: the error mean -/

/-- The mean factor `1 − k h` has modulus below one exactly when `0 < k h < 2`. -/
theorem contract_iff (k h : ℝ) : |1 - k * h| < 1 ↔ 0 < k * h ∧ k * h < 2 := by
  rw [abs_lt]
  constructor
  · rintro ⟨h1, h2⟩
    exact ⟨by linarith, by linarith⟩
  · rintro ⟨h1, h2⟩
    exact ⟨by linarith, by linarith⟩

/-- A sequence multiplied by `a` each pass is `a^n` times its start. -/
theorem mean_closed {a : ℝ} {m : ℕ → ℝ} (hm : ∀ n, m (n + 1) = a * m n) (n : ℕ) :
    m n = a ^ n * m 0 := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [hm n, ih]
    ring

/-- `|E e_n| = |1 − k h|^n · |E e_0|`: the mean error shrinks by `|1 − k h|` every pass. -/
theorem mean_abs {a : ℝ} {m : ℕ → ℝ} (hm : ∀ n, m (n + 1) = a * m n) (n : ℕ) :
    |m n| = |a| ^ n * |m 0| := by
  rw [mean_closed hm n, abs_mul, abs_pow]

/-- **Claim 1(b), mean.** `E e_{n+1} = (1 − k h) E e_n` with `0 < k h < 2` drives the mean error
to zero. -/
theorem mean_tendsto_zero {k h : ℝ} (h0 : 0 < k * h) (h2 : k * h < 2) {m : ℕ → ℝ}
    (hm : ∀ n, m (n + 1) = (1 - k * h) * m n) : Tendsto m atTop (𝓝 0) := by
  have ha : |1 - k * h| < 1 := (contract_iff k h).2 ⟨h0, h2⟩
  have hp : Tendsto (fun n : ℕ => (1 - k * h) ^ n) atTop (𝓝 0) :=
    tendsto_pow_atTop_nhds_zero_iff.2 ha
  have h3 := hp.mul_const (m 0)
  rw [zero_mul] at h3
  exact h3.congr (fun n => (mean_closed hm n).symm)

/-! ## Claim 1(b), scalar: the error variance under a constant gain -/

/-- `v (n+1) = a² v n + w` is `w/(1 − a²)` plus `(a²)^n` times the initial offset. With
`a = 1 − k h` and `w = (1 − k h)² q + k² r` this is the scalar error variance. -/
theorem lyap_closed {a w : ℝ} (ha : a ^ 2 ≠ 1) {v : ℕ → ℝ}
    (hv : ∀ n, v (n + 1) = a ^ 2 * v n + w) (n : ℕ) :
    v n - w / (1 - a ^ 2) = (a ^ 2) ^ n * (v 0 - w / (1 - a ^ 2)) := by
  have h1 : (1 - a ^ 2) ≠ 0 := sub_ne_zero.2 (Ne.symm ha)
  have hc : w / (1 - a ^ 2) * (1 - a ^ 2) = w := div_mul_cancel₀ w h1
  have hfix : a ^ 2 * (w / (1 - a ^ 2)) + w = w / (1 - a ^ 2) := by
    linear_combination -hc
  induction n with
  | zero => simp
  | succ n ih =>
    have hstep : v (n + 1) - w / (1 - a ^ 2) = a ^ 2 * (v n - w / (1 - a ^ 2)) := by
      rw [hv n]
      linear_combination hfix
    rw [hstep, ih]
    ring

/-- **Claim 1(b), variance.** With `|a| < 1` (`a = 1 − k h`) the variance converges to the
Lyapunov floor `w / (1 − a²)` from any start. -/
theorem lyap_tendsto {a w : ℝ} (ha : |a| < 1) {v : ℕ → ℝ}
    (hv : ∀ n, v (n + 1) = a ^ 2 * v n + w) :
    Tendsto v atTop (𝓝 (w / (1 - a ^ 2))) := by
  have ha2 : a ^ 2 < 1 := (sq_lt_one_iff_abs_lt_one a).2 ha
  refine tendsto_of_geom (sq_nonneg a) ha2 (C := |v 0 - w / (1 - a ^ 2)|) (fun n => le_of_eq ?_)
  rw [lyap_closed (ne_of_lt ha2) hv n, abs_mul, abs_of_nonneg (pow_nonneg (sq_nonneg a) n)]

/-- The denominator of the floor: `1 − (1 − k h)² = k h (2 − k h)`. -/
theorem floor_den (k h : ℝ) : 1 - (1 - k * h) ^ 2 = k * h * (2 - k * h) := by ring

/-- **The kick raises the floor.** The constant-gain floor
`((1 − k h)² q + k² r) / (1 − (1 − k h)²)` is nondecreasing in `q = κ²`. -/
theorem floor_mono_kick {k h r q₁ q₂ : ℝ} (h0 : 0 < k * h) (h2 : k * h < 2) (hq : q₁ ≤ q₂) :
    ((1 - k * h) ^ 2 * q₁ + k ^ 2 * r) / (1 - (1 - k * h) ^ 2)
      ≤ ((1 - k * h) ^ 2 * q₂ + k ^ 2 * r) / (1 - (1 - k * h) ^ 2) := by
  have hden : 0 < 1 - (1 - k * h) ^ 2 := by
    rw [floor_den]
    exact mul_pos h0 (by linarith)
  refine div_le_div_of_nonneg_right ?_ hden.le
  nlinarith [mul_nonneg (sq_nonneg (1 - k * h)) (sub_nonneg.2 hq)]

/-! ## Claim 1(b), scalar: the Kalman gain and the bump -/

/-- The scalar Kalman gain at prior variance `s`: `k = s h / (h² s + r)`. -/
noncomputable def gain (h r s : ℝ) : ℝ := s * h / (h ^ 2 * s + r)

/-- **The gain grows with the bump.** For `h > 0` and `r > 0` the gain is strictly increasing in
the prior variance `s = σ² + b`, hence in the bump `b`. -/
theorem gain_strictMono {h r s t : ℝ} (hh : 0 < h) (hr : 0 < r) (hs : 0 ≤ s) (hst : s < t) :
    gain h r s < gain h r t := by
  have ht : 0 ≤ t := le_of_lt (lt_of_le_of_lt hs hst)
  have h1 : 0 < h ^ 2 * s + r := by positivity
  have h2 : 0 < h ^ 2 * t + r := by positivity
  unfold gain
  rw [div_lt_div_iff₀ h1 h2]
  nlinarith [mul_pos (mul_pos hh hr) (sub_pos.2 hst)]

/-- For `h < 0` the gain itself falls as `b` grows. What rises for every `h ≠ 0` is the absorbed
fraction `k h = h² s / (h² s + r)`. -/
theorem gain_mul_strictMono {h r s t : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hs : 0 ≤ s) (hst : s < t) :
    gain h r s * h < gain h r t * h := by
  have ht : 0 ≤ t := le_of_lt (lt_of_le_of_lt hs hst)
  have hh2 : 0 < h ^ 2 := by positivity
  have h1 : 0 < h ^ 2 * s + r := by positivity
  have h2 : 0 < h ^ 2 * t + r := by positivity
  unfold gain
  rw [div_mul_eq_mul_div, div_mul_eq_mul_div, div_lt_div_iff₀ h1 h2]
  nlinarith [mul_pos (mul_pos hh2 hr) (sub_pos.2 hst)]

/-- The Kalman gain lands inside the contracting range: `0 < k h < 1`. -/
theorem gain_mul_range {h r s : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hs : 0 < s) :
    0 < gain h r s * h ∧ gain h r s * h < 1 := by
  have hh2 : 0 < h ^ 2 := by positivity
  have h1 : 0 < h ^ 2 * s + r := by positivity
  unfold gain
  rw [div_mul_eq_mul_div]
  constructor
  · refine div_pos ?_ h1
    nlinarith [mul_pos hs hh2]
  · rw [div_lt_one h1]
    nlinarith [mul_pos hs hh2]

/-- **Completing the square.** One update with gain `k` on a prior error of variance `p` leaves
`J(k) = (1 − k h)² p + k² r`, and `J(k) = J(k*) + (h² p + r)(k − k*)²` with `k* = gain h r p`.
Only the gain computed from the true prior variance minimises the posterior error. -/
theorem mse_square {h r p : ℝ} (hd : h ^ 2 * p + r ≠ 0) (k : ℝ) :
    (1 - k * h) ^ 2 * p + k ^ 2 * r
      = ((1 - gain h r p * h) ^ 2 * p + gain h r p ^ 2 * r)
        + (h ^ 2 * p + r) * (k - gain h r p) ^ 2 := by
  have hks : gain h r p * (h ^ 2 * p + r) = p * h := by
    unfold gain
    exact div_mul_cancel₀ (p * h) hd
  linear_combination (2 * (k - gain h r p)) * hks

/-- **A bump hurts a calibrated filter.** If the filter's prior variance is the true one, `p`, any
bump `b > 0` raises the one-step posterior error. (A filter that believes `σ² < p` is helped by
the bump `b = p − σ²`, which restores `k*`.) -/
theorem bump_hurts_calibrated {h r p b : ℝ} (hh : 0 < h) (hr : 0 < r) (hp : 0 ≤ p) (hb : 0 < b) :
    (1 - gain h r p * h) ^ 2 * p + gain h r p ^ 2 * r
      < (1 - gain h r (p + b) * h) ^ 2 * p + gain h r (p + b) ^ 2 * r := by
  have hd : 0 < h ^ 2 * p + r := by positivity
  have e := mse_square hd.ne' (gain h r (p + b))
  have hlt := gain_strictMono hh hr hp (show p < p + b by linarith)
  have hpos : 0 < (h ^ 2 * p + r) * (gain h r (p + b) - gain h r p) ^ 2 :=
    mul_pos hd (pow_pos (sub_pos.2 hlt) 2)
  linarith

/-! ## Claim 1(b), scalar: the Riccati recursion with process noise `q = κ²` -/

/-- One Kalman pass on the posterior variance: predict `s + q`, then update. -/
noncomputable def ric (h r q s : ℝ) : ℝ := r * (s + q) / (h ^ 2 * (s + q) + r)

/-- `ric` is the update `(1 − k h)(s + q)` with the Kalman gain at the predicted variance. -/
theorem ric_eq_update (h r q s : ℝ) (hd : h ^ 2 * (s + q) + r ≠ 0) :
    ric h r q s = (1 - gain h r (s + q) * h) * (s + q) := by
  have hX := mul_inv_cancel₀ hd
  unfold ric gain
  linear_combination (s + q) * hX

theorem ric_sub {h r q s t : ℝ} (hs : h ^ 2 * (s + q) + r ≠ 0) (ht : h ^ 2 * (t + q) + r ≠ 0) :
    ric h r q s - ric h r q t
      = r ^ 2 * (s - t) / ((h ^ 2 * (s + q) + r) * (h ^ 2 * (t + q) + r)) := by
  unfold ric
  rw [div_sub_div _ _ hs ht]
  ring

theorem ric_nonneg {h r q s : ℝ} (hr : 0 < r) (hq : 0 ≤ q) (hs : 0 ≤ s) : 0 ≤ ric h r q s := by
  unfold ric
  positivity

theorem ric_mono {h r q s t : ℝ} (hr : 0 < r) (hq : 0 ≤ q) (ht : 0 ≤ t) (hts : t ≤ s) :
    ric h r q t ≤ ric h r q s := by
  have hs : 0 ≤ s := le_trans ht hts
  have hS0 : 0 < h ^ 2 * (s + q) + r := by positivity
  have hT0 : 0 < h ^ 2 * (t + q) + r := by positivity
  have e := ric_sub hS0.ne' hT0.ne'
  have hnn : 0 ≤ r ^ 2 * (s - t) / ((h ^ 2 * (s + q) + r) * (h ^ 2 * (t + q) + r)) :=
    div_nonneg (mul_nonneg (sq_nonneg r) (by linarith)) (mul_pos hS0 hT0).le
  linarith

/-- **The Kalman pass is a contraction** on `[0, ∞)`, with factor `(r/(h² q + r))²`, below one
once `h² q > 0`. -/
theorem ric_contract {h r q s t : ℝ} (hr : 0 < r) (hq : 0 ≤ q) (hs : 0 ≤ s) (ht : 0 ≤ t) :
    |ric h r q s - ric h r q t| ≤ (r / (h ^ 2 * q + r)) ^ 2 * |s - t| := by
  have h0 : 0 < h ^ 2 * q + r := by positivity
  have hS : h ^ 2 * q + r ≤ h ^ 2 * (s + q) + r := by nlinarith [mul_nonneg (sq_nonneg h) hs]
  have hT : h ^ 2 * q + r ≤ h ^ 2 * (t + q) + r := by nlinarith [mul_nonneg (sq_nonneg h) ht]
  have hS0 : 0 < h ^ 2 * (s + q) + r := lt_of_lt_of_le h0 hS
  have hT0 : 0 < h ^ 2 * (t + q) + r := lt_of_lt_of_le h0 hT
  have hST : (h ^ 2 * q + r) * (h ^ 2 * q + r) ≤ (h ^ 2 * (s + q) + r) * (h ^ 2 * (t + q) + r) :=
    mul_le_mul hS hT h0.le hS0.le
  have hk : r ^ 2 / (h ^ 2 * q + r) ^ 2 * (h ^ 2 * q + r) ^ 2 = r ^ 2 :=
    div_mul_cancel₀ _ (pow_ne_zero 2 h0.ne')
  have hc : 0 ≤ r ^ 2 / (h ^ 2 * q + r) ^ 2 * |s - t| := by positivity
  rw [ric_sub hS0.ne' hT0.ne', abs_div, abs_of_pos (mul_pos hS0 hT0), abs_mul,
    abs_of_nonneg (sq_nonneg r), div_pow, div_le_iff₀ (mul_pos hS0 hT0)]
  calc r ^ 2 * |s - t| = r ^ 2 / (h ^ 2 * q + r) ^ 2 * (h ^ 2 * q + r) ^ 2 * |s - t| := by
        rw [hk]
    _ = r ^ 2 / (h ^ 2 * q + r) ^ 2 * |s - t| * ((h ^ 2 * q + r) * (h ^ 2 * q + r)) := by ring
    _ ≤ r ^ 2 / (h ^ 2 * q + r) ^ 2 * |s - t| * ((h ^ 2 * (s + q) + r) * (h ^ 2 * (t + q) + r)) :=
        mul_le_mul_of_nonneg_left hST hc

/-- The Riccati fixed point `s∞ = (−h² q + √((h² q)² + 4 h² r q)) / (2 h²)`. -/
noncomputable def sfix (h r q : ℝ) : ℝ :=
  (-(h ^ 2 * q) + √((h ^ 2 * q) ^ 2 + 4 * h ^ 2 * r * q)) / (2 * h ^ 2)

theorem sfix_nonneg {h r q : ℝ} (hh : h ≠ 0) (hr : 0 ≤ r) (hq : 0 ≤ q) : 0 ≤ sfix h r q := by
  have hle : h ^ 2 * q ≤ √((h ^ 2 * q) ^ 2 + 4 * h ^ 2 * r * q) := by
    apply Real.le_sqrt_of_sq_le
    have : 0 ≤ h ^ 2 * r * q := by positivity
    linarith
  unfold sfix
  exact div_nonneg (by linarith) (by positivity)

theorem sfix_pos {h r q : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hq : 0 < q) : 0 < sfix h r q := by
  have hlt : h ^ 2 * q < √((h ^ 2 * q) ^ 2 + 4 * h ^ 2 * r * q) := by
    apply Real.lt_sqrt_of_sq_lt
    have : 0 < h ^ 2 * r * q := by positivity
    linarith
  unfold sfix
  exact div_pos (by linarith) (by positivity)

/-- `s∞` solves `h² s² + h² q s − r q = 0`. -/
theorem sfix_quad {h r q : ℝ} (hh : h ≠ 0) (hr : 0 ≤ r) (hq : 0 ≤ q) :
    h ^ 2 * sfix h r q ^ 2 + h ^ 2 * q * sfix h r q - r * q = 0 := by
  have hD : 0 ≤ (h ^ 2 * q) ^ 2 + 4 * h ^ 2 * r * q := by positivity
  have hS := Real.sq_sqrt hD
  have h2 : (2 * h ^ 2) ≠ 0 := by positivity
  have h4 : (4 * h ^ 2) ≠ 0 := by positivity
  have hu : sfix h r q * (2 * h ^ 2) = -(h ^ 2 * q) + √((h ^ 2 * q) ^ 2 + 4 * h ^ 2 * r * q) := by
    unfold sfix
    exact div_mul_cancel₀ _ h2
  have hprod : (4 * h ^ 2) * (h ^ 2 * sfix h r q ^ 2 + h ^ 2 * q * sfix h r q - r * q) = 0 := by
    linear_combination
      (sfix h r q * (2 * h ^ 2) + h ^ 2 * q + √((h ^ 2 * q) ^ 2 + 4 * h ^ 2 * r * q)) * hu + hS
  exact (mul_eq_zero.1 hprod).resolve_left h4

/-- `s∞` is a fixed point of the Kalman pass. -/
theorem sfix_fixed {h r q : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hq : 0 ≤ q) :
    ric h r q (sfix h r q) = sfix h r q := by
  have hquad := sfix_quad hh hr.le hq
  have hs := sfix_nonneg hh hr.le hq
  have hd : h ^ 2 * (sfix h r q + q) + r ≠ 0 := by positivity
  unfold ric
  rw [div_eq_iff hd]
  linear_combination -hquad

/-- The iterates stay nonnegative and approach `s∞` geometrically. -/
theorem ric_iter {h r q : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hq : 0 ≤ q) {s : ℕ → ℝ}
    (hs0 : 0 ≤ s 0) (hs : ∀ n, s (n + 1) = ric h r q (s n)) (n : ℕ) :
    0 ≤ s n ∧ |s n - sfix h r q| ≤ ((r / (h ^ 2 * q + r)) ^ 2) ^ n * |s 0 - sfix h r q| := by
  have hfix := sfix_fixed hh hr hq
  have hsI := sfix_nonneg hh hr.le hq
  induction n with
  | zero => simp [hs0]
  | succ n ih =>
    obtain ⟨h1, h2⟩ := ih
    refine ⟨by rw [hs]; exact ric_nonneg hr hq h1, ?_⟩
    calc |s (n + 1) - sfix h r q| = |ric h r q (s n) - ric h r q (sfix h r q)| := by
          rw [hs, hfix]
      _ ≤ (r / (h ^ 2 * q + r)) ^ 2 * |s n - sfix h r q| := ric_contract hr hq h1 hsI
      _ ≤ (r / (h ^ 2 * q + r)) ^ 2 * (((r / (h ^ 2 * q + r)) ^ 2) ^ n * |s 0 - sfix h r q|) :=
          mul_le_mul_of_nonneg_left h2 (sq_nonneg _)
      _ = ((r / (h ^ 2 * q + r)) ^ 2) ^ (n + 1) * |s 0 - sfix h r q| := by ring

/-- **Claim 1(b), Riccati.** With the Kalman gain and process noise `q = κ² > 0`, the posterior
variance converges to the Riccati fixed point `s∞`, from any start `s 0 ≥ 0`. -/
theorem ric_tendsto {h r q : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hq : 0 < q) {s : ℕ → ℝ}
    (hs0 : 0 ≤ s 0) (hs : ∀ n, s (n + 1) = ric h r q (s n)) :
    Tendsto s atTop (𝓝 (sfix h r q)) := by
  have h0 : 0 < h ^ 2 * q + r := by positivity
  have hl0 : 0 ≤ r / (h ^ 2 * q + r) := by positivity
  have hl1 : r / (h ^ 2 * q + r) < 1 := by
    rw [div_lt_one h0]
    have : 0 < h ^ 2 * q := by positivity
    linarith
  have hL : (r / (h ^ 2 * q + r)) ^ 2 < 1 := by nlinarith [mul_nonneg hl0 (sub_nonneg.2 hl1.le)]
  exact tendsto_of_geom (sq_nonneg _) hL (fun n => (ric_iter hh hr hq.le hs0 hs n).2)

/-- The floor with the Kalman gain is below one measurement's variance `r/h²`. -/
theorem sfix_lt_single {h r q : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hq : 0 < q) :
    sfix h r q < r / h ^ 2 := by
  have hq0 := sfix_quad hh hr.le hq.le
  have hs := sfix_pos hh hr hq
  have hh2 : 0 < h ^ 2 := by positivity
  rw [lt_div_iff₀ hh2]
  nlinarith [mul_pos hr hs, add_pos hs hq]

/-! ## Claim 1(c): a measurement update makes the covariance flat again -/

/-- **One update can undo the bump exactly.** The gate fired on `Σ = s I`, and the bump lifted
`m` eigenvalues to `s + b`. Observing those `m` directions once (`h = 1`, noise `r = s(s+b)/b`,
no process noise) returns each to `s`. So `Σ = s I` again, and `cv = 0`. -/
theorem one_update_restores {s b : ℝ} (hs : 0 < s) (hb : 0 < b) :
    ric 1 (s * (s + b) / b) 0 (s + b) = s := by
  have hB := mul_inv_cancel₀ hb.ne'
  have hden : (1 : ℝ) ^ 2 * (s + b + 0) + s * (s + b) / b ≠ 0 := by positivity
  unfold ric
  rw [div_eq_iff hden]
  linear_combination (s * (s + b)) * hB

/-- The flat leg on a two-level spectrum (`m` eigenvalues `u`, `n − m` eigenvalues `s`): the
unbiased eigenvalue variance is below `ε_a² μ²` with `ε_a = 1/20`, which is `cv < ε_a`
(`cv_lt_iff`). -/
noncomputable def flat2 (n m u s : ℝ) : Prop :=
  (m * (u - (m * u + (n - m) * s) / n) ^ 2 + (n - m) * (s - (m * u + (n - m) * s) / n) ^ 2)
      / (n - 1)
    < (1 / 20) ^ 2 * ((m * u + (n - m) * s) / n) ^ 2

/-- `cv = std/mean < 1/20` iff the variance is below `(1/20)² mean²`. -/
theorem cv_lt_iff {var μ : ℝ} (hμ : 0 < μ) :
    √var / μ < 1 / 20 ↔ var < (1 / 20) ^ 2 * μ ^ 2 := by
  rw [div_lt_iff₀ hμ, Real.sqrt_lt' (show (0 : ℝ) < 1 / 20 * μ by positivity), mul_pow]

/-- Squared deviations of a two-level spectrum: `n · SS = m (n − m) (u − s)²`. -/
theorem two_level_ss {n m u s μ : ℝ} (hμ : n * μ = m * u + (n - m) * s) :
    n * (m * (u - μ) ^ 2 + (n - m) * (s - μ) ^ 2) = m * (n - m) * (u - s) ^ 2 := by
  linear_combination (n * μ - (m * u + (n - m) * s)) * hμ

/-- **Near-flat reads flat.** With `n ≥ 2`, `m ≥ 0`, `s > 0` and `s ≤ u < s + s/15`, the flat
leg is true. (`m ≤ n` is not needed: `m (n − m) ≤ n²/4` for every real `m`.) -/
theorem flat_of_close {n m u s : ℝ} (hn : 2 ≤ n) (hm0 : 0 ≤ m) (hs : 0 < s)
    (hu : s ≤ u) (hclose : u - s < s / 15) : flat2 n m u s := by
  unfold flat2
  have hn0 : 0 < n := by linarith
  have hn1 : 0 < n - 1 := by linarith
  have hd0 : 0 ≤ u - s := by linarith
  set μ := (m * u + (n - m) * s) / n with hμdef
  have hμ : n * μ = m * u + (n - m) * s := by
    rw [hμdef, mul_comm]
    exact div_mul_cancel₀ _ hn0.ne'
  have hss := two_level_ss hμ
  set SS := m * (u - μ) ^ 2 + (n - m) * (s - μ) ^ 2 with hSSdef
  have hμs : s ≤ μ := by
    have h1 : n * s ≤ n * μ := by
      rw [hμ]
      nlinarith [mul_nonneg hm0 hd0]
    exact le_of_mul_le_mul_left h1 hn0
  have hm2 : m * (n - m) ≤ n ^ 2 / 4 := by nlinarith [sq_nonneg (n - 2 * m)]
  have hSS1 : n * SS ≤ n * (n / 4 * (u - s) ^ 2) := by
    rw [hss]
    have e : n * (n / 4 * (u - s) ^ 2) = n ^ 2 / 4 * (u - s) ^ 2 := by ring
    rw [e]
    exact mul_le_mul_of_nonneg_right hm2 (sq_nonneg _)
  have hSS2 : SS ≤ n / 4 * (u - s) ^ 2 := le_of_mul_le_mul_left hSS1 hn0
  have hus : (u - s) ^ 2 < (s / 15) ^ 2 := pow_lt_pow_left₀ hclose hd0 two_ne_zero
  have hμ2 : s ^ 2 ≤ μ ^ 2 := pow_le_pow_left₀ hs.le hμs 2
  have h1 : SS < n / 4 * (s / 15) ^ 2 :=
    lt_of_le_of_lt hSS2 (mul_lt_mul_of_pos_left hus (by positivity))
  have h2 : n / 4 * (s / 15) ^ 2 ≤ (1 / 20) ^ 2 * s ^ 2 * (n - 1) := by
    nlinarith [mul_nonneg (sq_nonneg s) (show (0 : ℝ) ≤ 5 * n - 9 by linarith)]
  have h3 : (1 / 20) ^ 2 * s ^ 2 * (n - 1) ≤ (1 / 20) ^ 2 * μ ^ 2 * (n - 1) :=
    mul_le_mul_of_nonneg_right (mul_le_mul_of_nonneg_left hμ2 (by norm_num)) hn1.le
  rw [div_lt_iff₀ hn1]
  linarith

/-- **The restored covariance reads flat on the very next evaluation** (`one_update_restores`). -/
theorem restored_is_flat {n m s b : ℝ} (hn : 2 ≤ n) (hm0 : 0 ≤ m) (hs : 0 < s) (hb : 0 < b) :
    flat2 n m (ric 1 (s * (s + b) / b) 0 (s + b)) s := by
  rw [one_update_restores hs hb]
  exact flat_of_close hn hm0 hs le_rfl (by linarith)

/-- If the bumped level stays at or above `s` and its excess decays geometrically, the flat leg is
true from some pass on. -/
theorem flat_eventually {n m s c β : ℝ} {u : ℕ → ℝ} (hn : 2 ≤ n) (hm0 : 0 ≤ m)
    (hs : 0 < s) (hc0 : 0 ≤ c) (hc1 : c < 1) (hβ : 0 ≤ β)
    (hge : ∀ k, s ≤ u k) (hle : ∀ k, u k - s ≤ c ^ k * β) :
    ∃ K : ℕ, ∀ k, K ≤ k → flat2 n m (u k) s := by
  have hb1 : (0 : ℝ) < β + 1 := by linarith
  obtain ⟨K, hK⟩ := exists_pow_lt_of_lt_one (show 0 < s / (15 * (β + 1)) by positivity) hc1
  refine ⟨K, fun k hk => flat_of_close hn hm0 hs (hge k) ?_⟩
  have hck : c ^ k ≤ c ^ K := pow_le_pow_of_le_one hc0 hc1.le hk
  calc u k - s ≤ c ^ k * β := hle k
    _ ≤ c ^ K * (β + 1) := mul_le_mul hck (by linarith) hβ (pow_nonneg hc0 K)
    _ < s / (15 * (β + 1)) * (β + 1) := mul_lt_mul_of_pos_right hK hb1
    _ = s / 15 := by rw [div_mul_eq_mul_div, mul_div_mul_right _ _ hb1.ne']

/-- **Claim 1(c): the flat leg comes back, for every bump.** The gate fired on a flat covariance
at the Riccati fixed point, `n` eigenvalues `s∞`. The Σ₀⁻¹ bump lifts `m` of them to `s∞ + b`.
Isotropic evidence each pass (`H = I`, `R = r I`, process noise `q I`) acts on every eigenvalue by
`ric`, so the other `n − m` stay at `s∞`. From some pass on, the flat leg is true again. -/
theorem flat_again {h r q b n m : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hq : 0 < q) (hb : 0 ≤ b)
    (hn : 2 ≤ n) (hm0 : 0 ≤ m) {u : ℕ → ℝ}
    (hu0 : u 0 = sfix h r q + b) (hu : ∀ k, u (k + 1) = ric h r q (u k)) :
    ∃ K : ℕ, ∀ k, K ≤ k → flat2 n m (u k) (sfix h r q) := by
  have hsI := sfix_pos hh hr hq
  have hfix := sfix_fixed hh hr hq.le
  have hge : ∀ k, sfix h r q ≤ u k := by
    intro k
    induction k with
    | zero => rw [hu0]; linarith
    | succ k ih =>
      calc sfix h r q = ric h r q (sfix h r q) := hfix.symm
        _ ≤ ric h r q (u k) := ric_mono hr hq.le hsI.le ih
        _ = u (k + 1) := (hu k).symm
  have hu00 : 0 ≤ u 0 := by rw [hu0]; linarith
  have hle : ∀ k, u k - sfix h r q ≤ ((r / (h ^ 2 * q + r)) ^ 2) ^ k * b := by
    intro k
    have hit := (ric_iter hh hr hq.le hu00 hu k).2
    rw [hu0, show sfix h r q + b - sfix h r q = b by ring, abs_of_nonneg hb] at hit
    exact le_trans (le_abs_self _) hit
  have h0 : 0 < h ^ 2 * q + r := by positivity
  have hl0 : 0 ≤ r / (h ^ 2 * q + r) := by positivity
  have hl1 : r / (h ^ 2 * q + r) < 1 := by
    rw [div_lt_one h0]
    have : 0 < h ^ 2 * q := by positivity
    linarith
  have hL1 : (r / (h ^ 2 * q + r)) ^ 2 < 1 := by nlinarith [mul_nonneg hl0 (sub_nonneg.2 hl1.le)]
  exact flat_eventually hn hm0 hsI (sq_nonneg _) hL1 hb hge hle

/-! ## Claim 1(c) with no process noise: the error vanishes, and the flat leg fires anyway -/

/-- With no process noise each pass adds `h²/r` to the posterior precision. -/
theorem ric_zero_inv {h r s : ℝ} (hr : 0 < r) (hs : 0 < s) :
    (ric h r 0 s)⁻¹ = s⁻¹ + h ^ 2 / r := by
  have hS := mul_inv_cancel₀ hs.ne'
  have hR := mul_inv_cancel₀ hr.ne'
  have hrs : r * s ≠ 0 := by positivity
  unfold ric
  rw [add_zero, inv_div, div_eq_iff hrs]
  linear_combination (-r) * hS + (-(h ^ 2 * s)) * hR

theorem ric_zero_pos {h r s : ℝ} (hr : 0 < r) (hs : 0 < s) : 0 < ric h r 0 s := by
  unfold ric
  rw [add_zero]
  positivity

/-- **Claim 1(c), no process noise.** The bump is applied once; afterwards each pass brings
isotropic evidence and no kick. The bumped level `u` (from `s + b`) and the others `v` (from `s`)
both follow `ric` with `q = 0`. The state's error variance `v k = 1/(1/s + k h²/r)` goes to zero,
so evidence settles the state exactly. Yet from some pass on, the flat leg is true. -/
theorem flat_again_noiseless {h r s b n m : ℝ} (hh : h ≠ 0) (hr : 0 < r) (hs : 0 < s)
    (hb : 0 ≤ b) (hn : 2 ≤ n) (hm0 : 0 ≤ m) {u v : ℕ → ℝ}
    (hu0 : u 0 = s + b) (hv0 : v 0 = s)
    (hu : ∀ k, u (k + 1) = ric h r 0 (u k)) (hv : ∀ k, v (k + 1) = ric h r 0 (v k)) :
    (∀ k : ℕ, v k = 1 / (s⁻¹ + k * (h ^ 2 / r))) ∧
      ∃ K : ℕ, ∀ k, K ≤ k → flat2 n m (u k) (v k) := by
  have hc : 0 < h ^ 2 / r := by positivity
  have hpu : ∀ k : ℕ, 0 < u k ∧ (u k)⁻¹ = (s + b)⁻¹ + k * (h ^ 2 / r) := by
    intro k
    induction k with
    | zero =>
      rw [hu0]
      exact ⟨by linarith, by simp⟩
    | succ k ih =>
      obtain ⟨h1, h2⟩ := ih
      refine ⟨by rw [hu k]; exact ric_zero_pos hr h1, ?_⟩
      rw [hu k, ric_zero_inv hr h1, h2]
      push_cast
      ring
  have hpv : ∀ k : ℕ, 0 < v k ∧ (v k)⁻¹ = s⁻¹ + k * (h ^ 2 / r) := by
    intro k
    induction k with
    | zero =>
      rw [hv0]
      exact ⟨hs, by simp⟩
    | succ k ih =>
      obtain ⟨h1, h2⟩ := ih
      refine ⟨by rw [hv k]; exact ric_zero_pos hr h1, ?_⟩
      rw [hv k, ric_zero_inv hr h1, h2]
      push_cast
      ring
  have hD : 0 ≤ s⁻¹ - (s + b)⁻¹ := sub_nonneg.2 (inv_anti₀ hs (by linarith))
  obtain ⟨K, hK⟩ := exists_nat_gt (15 * (s⁻¹ - (s + b)⁻¹) / (h ^ 2 / r))
  refine ⟨fun k => ?_, K, fun k hk => ?_⟩
  · rw [← (hpv k).2, one_div, inv_inv]
  · obtain ⟨hu1, hu2⟩ := hpu k
    obtain ⟨hv1, hv2⟩ := hpv k
    have hvu : v k ≤ u k := by
      have h3 : (u k)⁻¹ ≤ (v k)⁻¹ := by
        rw [hu2, hv2]
        linarith
      exact (inv_le_inv₀ hu1 hv1).1 h3
    have hkK : (K : ℝ) ≤ k := by exact_mod_cast hk
    have hkc : 15 * (s⁻¹ - (s + b)⁻¹) < k * (h ^ 2 / r) := by
      have h4 := (div_lt_iff₀ hc).1 hK
      nlinarith [mul_le_mul_of_nonneg_right hkK hc.le]
    have hone : u k * ((s + b)⁻¹ + k * (h ^ 2 / r)) = 1 := by
      rw [← hu2]
      exact mul_inv_cancel₀ hu1.ne'
    have hdiff : u k - v k = u k * v k * (s⁻¹ - (s + b)⁻¹) := by
      have e : s⁻¹ - (s + b)⁻¹ = (v k)⁻¹ - (u k)⁻¹ := by
        rw [hu2, hv2]
        ring
      have hU := mul_inv_cancel₀ hu1.ne'
      have hV := mul_inv_cancel₀ hv1.ne'
      rw [e]
      linear_combination (-(u k)) * hV + (v k) * hU
    have hb0 : 0 ≤ u k * (s + b)⁻¹ := by
      have : 0 < s + b := by linarith
      positivity
    have h15 : 15 * (u k * (s⁻¹ - (s + b)⁻¹)) < 1 := by
      have h5 : u k * (15 * (s⁻¹ - (s + b)⁻¹)) < u k * (k * (h ^ 2 / r)) :=
        mul_lt_mul_of_pos_left hkc hu1
      nlinarith
    refine flat_of_close hn hm0 hv1 hvu ?_
    rw [hdiff]
    nlinarith [mul_lt_mul_of_pos_left h15 hv1]

/-! ## Claim 1(c) through the engine's own covariance step -/

/-- One Euler step of the engine's covariance flow (`CovarianceField.step`, `C = I`) on an
eigen-direction where `A = 0`, with process noise `q` and observation noise `r`. -/
noncomputable def eul (dt q r l : ℝ) : ℝ := l + dt * (q - l ^ 2 / r)

/-- At the fixed point `s` (`s² = q r`), a bump `β` becomes `β (1 − dt (2 s + β) / r)`. -/
theorem eul_bump {dt q r s β : ℝ} (hr : r ≠ 0) (hs : s ^ 2 = q * r) :
    eul dt q r (s + β) - s = β * (1 - dt * (2 * s + β) / r) := by
  have hX := mul_inv_cancel₀ hr
  unfold eul
  linear_combination (-dt * r⁻¹) * hs + (-dt * q) * hX

/-- While `dt (2 s + β) ≤ r`, one engine step shrinks the bump by at least `1 − 2 dt s / r`. -/
theorem eul_bump_decay {dt q r s β : ℝ} (hr : 0 < r) (hs : s ^ 2 = q * r)
    (hdt : 0 ≤ dt) (hβ : 0 ≤ β) (hwin : dt * (2 * s + β) ≤ r) :
    0 ≤ eul dt q r (s + β) - s ∧ eul dt q r (s + β) - s ≤ (1 - 2 * dt * s / r) * β := by
  rw [eul_bump hr.ne' hs]
  have h1 : dt * (2 * s + β) / r ≤ 1 := (div_le_one hr).2 hwin
  have h2 : 2 * dt * s / r ≤ dt * (2 * s + β) / r :=
    div_le_div_of_nonneg_right (by nlinarith [mul_nonneg hdt hβ]) hr.le
  constructor
  · exact mul_nonneg hβ (by linarith)
  · nlinarith [mul_nonneg hβ (sub_nonneg.2 h2)]

/-- Iterated: the bump stays nonnegative and decays at least geometrically. -/
theorem eul_iter {dt q r s : ℝ} (hr : 0 < r) (hs : s ^ 2 = q * r) (hs0 : 0 ≤ s) (hdt : 0 ≤ dt)
    {l : ℕ → ℝ} (hl : ∀ k, l (k + 1) = eul dt q r (l k)) (h0 : s ≤ l 0)
    (hwin : dt * (2 * s + (l 0 - s)) ≤ r) (k : ℕ) :
    s ≤ l k ∧ l k - s ≤ (1 - 2 * dt * s / r) ^ k * (l 0 - s) := by
  have hc0 : 0 ≤ 1 - 2 * dt * s / r := by
    have : 2 * dt * s / r ≤ 1 := by
      rw [div_le_one hr]
      nlinarith [mul_nonneg hdt (sub_nonneg.2 h0)]
    linarith
  have hc1 : 1 - 2 * dt * s / r ≤ 1 := by
    have : 0 ≤ 2 * dt * s / r := by positivity
    linarith
  induction k with
  | zero => simp [h0]
  | succ k ih =>
    obtain ⟨h1, h2⟩ := ih
    have hβ : 0 ≤ l k - s := by linarith
    have hβle : l k - s ≤ l 0 - s :=
      le_trans h2 (mul_le_of_le_one_left (by linarith) (pow_le_one₀ hc0 hc1))
    have hw : dt * (2 * s + (l k - s)) ≤ r :=
      le_trans (by nlinarith [mul_nonneg hdt (sub_nonneg.2 hβle)]) hwin
    have key := eul_bump_decay hr hs hdt hβ hw
    rw [show s + (l k - s) = l k by ring, ← hl k] at key
    refine ⟨by linarith [key.1], le_trans key.2 ?_⟩
    calc (1 - 2 * dt * s / r) * (l k - s)
        ≤ (1 - 2 * dt * s / r) * ((1 - 2 * dt * s / r) ^ k * (l 0 - s)) :=
          mul_le_mul_of_nonneg_left h2 hc0
      _ = (1 - 2 * dt * s / r) ^ (k + 1) * (l 0 - s) := by ring

/-- **Claim 1(c) through the engine's own step.** On directions where `A = 0`, with isotropic
process noise `q` and the engine's `C = I`, `R = r I`: the gate fired at the fixed point
`s = √(q r)`, and the bump `b` keeps `dt (2 s + b) ≤ r`. Then the flat leg is true again from
some step on. (Eigenvalues inside `[eps, σ_max]`, where the engine's clip is the identity.) -/
theorem flat_again_engine {dt q r s b n m : ℝ} (hr : 0 < r) (hs : s ^ 2 = q * r) (hs0 : 0 < s)
    (hdt : 0 < dt) (hb : 0 ≤ b) (hwin : dt * (2 * s + b) ≤ r)
    (hn : 2 ≤ n) (hm0 : 0 ≤ m) {l : ℕ → ℝ}
    (hl0 : l 0 = s + b) (hl : ∀ k, l (k + 1) = eul dt q r (l k)) :
    ∃ K : ℕ, ∀ k, K ≤ k → flat2 n m (l k) s := by
  have h0 : s ≤ l 0 := by rw [hl0]; linarith
  have hw : dt * (2 * s + (l 0 - s)) ≤ r := by
    rw [hl0, show s + b - s = b by ring]
    exact hwin
  have hit := eul_iter hr hs hs0.le hdt.le hl h0 hw
  have hc1 : 1 - 2 * dt * s / r < 1 := by
    have : 0 < 2 * dt * s / r := by positivity
    linarith
  have hc0 : 0 ≤ 1 - 2 * dt * s / r := by
    have : 2 * dt * s / r ≤ 1 := by
      rw [div_le_one hr]
      nlinarith [mul_nonneg hdt.le hb]
    linarith
  exact flat_eventually hn hm0 hs0 hc0 hc1 (by rw [hl0]; linarith)
    (fun k => (hit k).1) (fun k => (hit k).2)

end Claim1

#print axioms Claim1.contract_iff
#print axioms Claim1.mean_abs
#print axioms Claim1.mean_tendsto_zero
#print axioms Claim1.lyap_tendsto
#print axioms Claim1.floor_mono_kick
#print axioms Claim1.gain_strictMono
#print axioms Claim1.gain_mul_strictMono
#print axioms Claim1.gain_mul_range
#print axioms Claim1.mse_square
#print axioms Claim1.bump_hurts_calibrated
#print axioms Claim1.ric_eq_update
#print axioms Claim1.ric_contract
#print axioms Claim1.sfix_fixed
#print axioms Claim1.ric_tendsto
#print axioms Claim1.sfix_lt_single
#print axioms Claim1.one_update_restores
#print axioms Claim1.cv_lt_iff
#print axioms Claim1.two_level_ss
#print axioms Claim1.flat_of_close
#print axioms Claim1.restored_is_flat
#print axioms Claim1.flat_again
#print axioms Claim1.flat_again_noiseless
#print axioms Claim1.eul_bump_decay
#print axioms Claim1.eul_iter
#print axioms Claim1.flat_again_engine
