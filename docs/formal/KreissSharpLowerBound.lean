/-
# The finite-horizon Kreiss bound is sharp, so every robust canary has a blind band

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, R2).
`KreissFiniteHorizon.lean` proves the matching upper bound.

Nothing here is new mathematics: the scaled nilpotent shift is the classical extremal example for
the Kreiss matrix theorem (LeVeque & Trefethen 1984; Spijker 1991; Nguyen-Cung & Nguyen,
arXiv:2608.29823, Thm 5.1). The fixed-horizon form and the blind-band corollary are written for the
certificate.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/KreissSharpLowerBound.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 39 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.InnerProductSpace.PiL2
import Mathlib.Analysis.SpecialFunctions.Exp

/-!
# C2: near-sharpness of the finite-horizon Kreiss bound, and the unavoidable blind band

`ResolventCond A K` is Kreiss's resolvent condition with constant `K` (vector form): for every
`‖z‖ > 1`, `z - A` is invertible and `(‖z‖ - 1) ‖(z - A)⁻¹ y‖ ≤ K ‖y‖`.  Over `ℂ`, `𝒦(A) ≤ K` iff
`ResolventCond A K`.  `C_t = (t+1)^(t+1)/t^t`.

1. Real inequalities: `bernoulli_peak` (the peak of `(r-1)/r^(m+1)` is `m^m/(m+1)^(m+1)`),
   `sharp_const_lt` (`C_t < e(t+1)`), the certified bounds `Ucrude`, `Uopt`, and `ratio_lower`,
   `sharp_within` (`C_t U(κ) ≤ (1 + t C_t/κ) κ^t`).
2. The resolvent of a scaled nilpotent (`nilpRes_left/right`), membership of `k • N` in the
   Kreiss class (`scaled_nilp_resolventCond(_opt)`), and the abstract `unavoidable_blind_band`.
3. The concrete nilpotent shift on the first `L` coordinates of `𝕜^n` (`pshift`).
4. `unavoidable_blind_band_euclid` (any `ℂ^(m+1)`, e.g. 2048), `ratio_approaches_sharp`, and
   certified instances (`blind_n2048_K10_T4`: `κ = 2.75`; `blind_n2048_K100_T4`: `κ = 5.5`).
-/

noncomputable section

namespace KreissC

open Finset



/-! ## 1. Real inequalities -/

/-- Bernoulli: `(m+1)^(m+1) (r - 1) ≤ m^m r^(m+1)` for `r ≥ 0`, `m ≥ 1`. -/
theorem bernoulli_peak (m : ℕ) (hm : 1 ≤ m) {r : ℝ} (hr : 0 ≤ r) :
    ((m : ℝ) + 1) ^ (m + 1) * (r - 1) ≤ (m : ℝ) ^ m * r ^ (m + 1) := by
  have hm' : (0 : ℝ) < m := by exact_mod_cast hm
  have hmr : 0 ≤ (m : ℝ) * r := mul_nonneg hm'.le hr
  have hb := pow_add_mul_le_add_pow_of_sq_nonneg (a := (m : ℝ) + 1)
    (b := (m : ℝ) * r - ((m : ℝ) + 1)) (by positivity) (sq_nonneg _) (sq_nonneg _)
    (by linarith) (m + 1)
  have e1 : ((m : ℝ) + 1) + ((m : ℝ) * r - ((m : ℝ) + 1)) = (m : ℝ) * r := by ring
  rw [e1, Nat.add_sub_cancel] at hb
  push_cast at hb
  have key : (m : ℝ) * (((m : ℝ) + 1) ^ (m + 1) * (r - 1)) ≤
      (m : ℝ) * ((m : ℝ) ^ m * r ^ (m + 1)) := by
    calc (m : ℝ) * (((m : ℝ) + 1) ^ (m + 1) * (r - 1))
        = ((m : ℝ) + 1) ^ (m + 1) +
            ((m : ℝ) + 1) * ((m : ℝ) + 1) ^ m * ((m : ℝ) * r - ((m : ℝ) + 1)) := by ring
      _ ≤ ((m : ℝ) * r) ^ (m + 1) := hb
      _ = (m : ℝ) * ((m : ℝ) ^ m * r ^ (m + 1)) := by ring
  exact le_of_mul_le_mul_left key hm'

lemma peak_le_one {r : ℝ} (hr : 1 < r) (m : ℕ) : (r - 1) / r ^ (m + 1) ≤ 1 := by
  rw [div_le_one (by positivity)]
  calc r - 1 ≤ r := by linarith
    _ = r ^ 1 := (pow_one r).symm
    _ ≤ r ^ (m + 1) := pow_le_pow_right₀ hr.le (by omega)

lemma peak_le_sharp {r : ℝ} (hr : 1 < r) (t : ℕ) (ht : 1 ≤ t) :
    (r - 1) / r ^ (t + 1) ≤ (t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1) := by
  rw [div_le_div_iff₀ (by positivity) (by positivity)]
  have h := bernoulli_peak t ht (r := r) (by linarith)
  rw [mul_comm (r - 1)]
  exact h

/-- `C_t = (t+1)^(t+1)/t^t = (t+1)(1+1/t)^t < e(t+1)`. -/
theorem sharp_const_lt (t : ℕ) (ht : 1 ≤ t) :
    ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t < Real.exp 1 * ((t : ℝ) + 1) := by
  have htp : (0 : ℝ) < t := by exact_mod_cast ht
  have htne : (t : ℝ) ≠ 0 := htp.ne'
  have h1 : ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t = ((t : ℝ) + 1) * (1 + 1 / (t : ℝ)) ^ t := by
    rw [one_add_div htne, div_pow]
    ring
  have h3 : 1 + 1 / (t : ℝ) < Real.exp (1 / t) := by
    have := Real.add_one_lt_exp (x := 1 / (t : ℝ)) (one_div_pos.mpr htp).ne'
    linarith
  have h2 : (1 + 1 / (t : ℝ)) ^ t < Real.exp 1 := by
    calc (1 + 1 / (t : ℝ)) ^ t < Real.exp (1 / t) ^ t :=
          pow_lt_pow_left₀ h3 (by positivity) (by omega)
      _ = Real.exp 1 := by
          rw [← Real.exp_nat_mul]
          congr 1
          field_simp
  rw [h1]
  calc ((t : ℝ) + 1) * (1 + 1 / (t : ℝ)) ^ t < ((t : ℝ) + 1) * Real.exp 1 :=
        mul_lt_mul_of_pos_left h2 (by positivity)
    _ = Real.exp 1 * ((t : ℝ) + 1) := mul_comm _ _

/-- The certified upper bound on `𝒦(kN)` used below. -/
def Ucrude (κ : ℝ) (t : ℕ) : ℝ :=
  κ ^ t * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1)) + ∑ m ∈ range t, κ ^ m

theorem kreiss_sum_le {r : ℝ} (hr : 1 < r) (κ : ℝ) (hκ : 0 ≤ κ) (t : ℕ) (ht : 1 ≤ t) :
    (r - 1) * ∑ m ∈ range (t + 1), κ ^ m / r ^ (m + 1) ≤ Ucrude κ t := by
  rw [Finset.sum_range_succ, mul_add, Ucrude, add_comm (κ ^ t * _)]
  apply add_le_add
  · rw [Finset.mul_sum]
    refine Finset.sum_le_sum fun m _ => ?_
    calc (r - 1) * (κ ^ m / r ^ (m + 1)) = κ ^ m * ((r - 1) / r ^ (m + 1)) := by ring
      _ ≤ κ ^ m * 1 := mul_le_mul_of_nonneg_left (peak_le_one hr m) (pow_nonneg hκ m)
      _ = κ ^ m := mul_one _
  · calc (r - 1) * (κ ^ t / r ^ (t + 1)) = κ ^ t * ((r - 1) / r ^ (t + 1)) := by ring
      _ ≤ κ ^ t * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1)) :=
        mul_le_mul_of_nonneg_left (peak_le_sharp hr t ht) (pow_nonneg hκ t)

/-- The per-term peaks: `(r - 1)/r^(m+1) ≤ m^m/(m+1)^(m+1)` for every `m ≥ 0` (`0^0 = 1`). -/
lemma peak_le_pk {r : ℝ} (hr : 1 < r) (m : ℕ) :
    (r - 1) / r ^ (m + 1) ≤ (m : ℝ) ^ m / ((m : ℝ) + 1) ^ (m + 1) := by
  rcases Nat.eq_zero_or_pos m with rfl | hm
  · have h := peak_le_one hr 0
    simpa using h
  · exact peak_le_sharp hr m hm

/-- The sharper certified bound `U*(κ) = Σ_{m ≤ t} κ^m m^m/(m+1)^(m+1)` (used for numbers). -/
def Uopt (κ : ℝ) (t : ℕ) : ℝ :=
  ∑ m ∈ range (t + 1), κ ^ m * ((m : ℝ) ^ m / ((m : ℝ) + 1) ^ (m + 1))

theorem kreiss_sum_le_opt {r : ℝ} (hr : 1 < r) (κ : ℝ) (hκ : 0 ≤ κ) (t : ℕ) :
    (r - 1) * ∑ m ∈ range (t + 1), κ ^ m / r ^ (m + 1) ≤ Uopt κ t := by
  rw [Uopt, Finset.mul_sum]
  refine Finset.sum_le_sum fun m _ => ?_
  calc (r - 1) * (κ ^ m / r ^ (m + 1)) = κ ^ m * ((r - 1) / r ^ (m + 1)) := by ring
    _ ≤ κ ^ m * ((m : ℝ) ^ m / ((m : ℝ) + 1) ^ (m + 1)) :=
      mul_le_mul_of_nonneg_left (peak_le_pk hr m) (pow_nonneg hκ m)

/-- `κ U(κ) ≤ κ^t (κ/C_t + t)` for `κ ≥ 1`. -/
theorem Ucrude_le (κ : ℝ) (hκ : 1 ≤ κ) (t : ℕ) :
    κ * Ucrude κ t ≤ κ ^ t * (κ * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1)) + t) := by
  have hsum : κ * ∑ m ∈ range t, κ ^ m ≤ t * κ ^ t := by
    rw [Finset.mul_sum]
    calc ∑ m ∈ range t, κ * κ ^ m ≤ ∑ _m ∈ range t, κ ^ t :=
          Finset.sum_le_sum fun m hm => by
            rw [← pow_succ']
            exact pow_le_pow_right₀ hκ (Finset.mem_range.mp hm)
      _ = t * κ ^ t := by rw [Finset.sum_const, Finset.card_range, nsmul_eq_mul]
  calc κ * Ucrude κ t
      = κ ^ t * (κ * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1))) + κ * ∑ m ∈ range t, κ ^ m := by
        rw [Ucrude]; ring
    _ ≤ κ ^ t * (κ * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1))) + t * κ ^ t := by
        linarith [hsum]
    _ = κ ^ t * (κ * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1)) + t) := by ring

lemma sharp_mul_inv (t : ℕ) (ht : 1 ≤ t) :
    ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1)) = 1 := by
  have htne : (t : ℝ) ≠ 0 := by
    have : (0 : ℝ) < t := by exact_mod_cast ht
    exact this.ne'
  have hA : ((t : ℝ) + 1) ^ (t + 1) ≠ 0 := pow_ne_zero _ (by positivity)
  have hB : (t : ℝ) ^ t ≠ 0 := pow_ne_zero _ htne
  rw [div_mul_div_comm, mul_comm (((t : ℝ) + 1) ^ (t + 1)), div_self (mul_ne_zero hB hA)]

/-- **C2, explicit form.** For `κ ≥ 1`: `C_t κ U(κ) ≤ κ^t (κ + t C_t)`, where
`C_t = (t+1)^(t+1)/t^t`.  So `κ^t / U(κ) ≥ C_t κ/(κ + t C_t) → C_t`. -/
theorem ratio_lower (κ : ℝ) (hκ : 1 ≤ κ) (t : ℕ) (ht : 1 ≤ t) :
    ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * κ * Ucrude κ t ≤
      κ ^ t * (κ + t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t)) := by
  have h := Ucrude_le κ hκ t
  have hC : 0 ≤ ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t := by positivity
  have hCc := sharp_mul_inv t ht
  calc ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * κ * Ucrude κ t
      = ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * (κ * Ucrude κ t) := by ring
    _ ≤ ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t *
          (κ ^ t * (κ * ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1)) + t)) :=
        mul_le_mul_of_nonneg_left h hC
    _ = κ ^ t * (κ * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t *
          ((t : ℝ) ^ t / ((t : ℝ) + 1) ^ (t + 1))) + t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t)) := by
        ring
    _ = κ ^ t * (κ + t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t)) := by rw [hCc, mul_one]

/-- **C2, within any factor.** If `κ ≥ 1` and `t C_t ≤ ε κ` then `C_t U(κ) ≤ (1 + ε) κ^t`. -/
theorem sharp_within (t : ℕ) (ht : 1 ≤ t) {ε κ : ℝ} (hκ : 1 ≤ κ)
    (hκε : t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t) ≤ ε * κ) :
    ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * Ucrude κ t ≤ (1 + ε) * κ ^ t := by
  have h := ratio_lower κ hκ t ht
  have hκ0 : 0 < κ := by linarith
  have hk : 0 ≤ κ ^ t := by positivity
  have h2 : κ ^ t * (κ + t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t)) ≤
      κ * ((1 + ε) * κ ^ t) := by
    calc κ ^ t * (κ + t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t)) ≤ κ ^ t * (κ + ε * κ) :=
          mul_le_mul_of_nonneg_left (by linarith) hk
      _ = κ * ((1 + ε) * κ ^ t) := by ring
  have h3 : κ * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * Ucrude κ t) ≤ κ * ((1 + ε) * κ ^ t) := by
    calc κ * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * Ucrude κ t)
        = ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * κ * Ucrude κ t := by ring
      _ ≤ _ := h
      _ ≤ _ := h2
  exact le_of_mul_le_mul_left h3 hκ0

/-! ## 2. The resolvent of a scaled nilpotent -/

section Resolvent

variable {𝕜 : Type*} [NontriviallyNormedField 𝕜]
variable {E : Type*} [NormedAddCommGroup E] [NormedSpace 𝕜 E]

/-- Kreiss's resolvent condition with constant `K` (vector form). -/
def ResolventCond (A : E →L[𝕜] E) (K : ℝ) : Prop :=
  ∀ z : 𝕜, 1 < ‖z‖ → ∃ R : E →L[𝕜] E, (z • 1 - A) * R = 1 ∧ R * (z • 1 - A) = 1 ∧
    ∀ y, (‖z‖ - 1) * ‖R y‖ ≤ K * ‖y‖

theorem ResolventCond.mono {A : E →L[𝕜] E} {K K' : ℝ} (h : ResolventCond A K) (hK : K ≤ K') :
    ResolventCond A K' := by
  intro z hz
  obtain ⟨R, h1, h2, h3⟩ := h z hz
  exact ⟨R, h1, h2, fun y => (h3 y).trans (mul_le_mul_of_nonneg_right hK (norm_nonneg y))⟩

/-- The canary is silent on the trajectory of `x` through step `T`. -/
def Silent (A : E →L[𝕜] E) (τ : ℕ → ℝ) (T : ℕ) (x : E) : Prop :=
  ∀ t ≤ T, ‖(A ^ t) x‖ ≤ τ t * ‖x‖

/-- A norm-threshold rule that never false-alarms on the class `ResolventCond · K`, steps `0..T`. -/
def FalseAlarmFree (τ : ℕ → ℝ) (T : ℕ) (K : ℝ) : Prop :=
  ∀ A : E →L[𝕜] E, ResolventCond A K → ∀ x, Silent A τ T x

/-- The resolvent of `k • N` when `N^(t+1) = 0`. -/
def nilpRes (N : E →L[𝕜] E) (t : ℕ) (k z : 𝕜) : E →L[𝕜] E :=
  ∑ m ∈ range (t + 1), (k ^ m / z ^ (m + 1)) • N ^ m

lemma scal_z (k z : 𝕜) (hz : z ≠ 0) (m : ℕ) : z * (k ^ m / z ^ (m + 1)) = k ^ m / z ^ m := by
  have hzm : z ^ m ≠ 0 := pow_ne_zero m hz
  rw [pow_succ, mul_div_assoc', div_eq_div_iff (mul_ne_zero hzm hz) hzm]
  ring

lemma scal_k (k z : 𝕜) (m : ℕ) : k * (k ^ m / z ^ (m + 1)) = k ^ (m + 1) / z ^ (m + 1) := by
  rw [pow_succ k m]
  ring

lemma nilp_term_left (N : E →L[𝕜] E) (k z : 𝕜) (hz : z ≠ 0) (m : ℕ) :
    (z • (1 : E →L[𝕜] E) - k • N) * ((k ^ m / z ^ (m + 1)) • N ^ m)
      = (k ^ m / z ^ m) • N ^ m - (k ^ (m + 1) / z ^ (m + 1)) • N ^ (m + 1) := by
  rw [sub_mul, smul_mul_assoc, one_mul, smul_smul, scal_z k z hz m, smul_mul_assoc,
    mul_smul_comm, smul_smul, scal_k k z m, ← pow_succ']

lemma nilp_term_right (N : E →L[𝕜] E) (k z : 𝕜) (hz : z ≠ 0) (m : ℕ) :
    ((k ^ m / z ^ (m + 1)) • N ^ m) * (z • (1 : E →L[𝕜] E) - k • N)
      = (k ^ m / z ^ m) • N ^ m - (k ^ (m + 1) / z ^ (m + 1)) • N ^ (m + 1) := by
  rw [mul_sub, mul_smul_comm, mul_one, smul_smul, scal_z k z hz m, mul_smul_comm,
    smul_mul_assoc, smul_smul, scal_k k z m, ← pow_succ]

theorem nilpRes_left (N : E →L[𝕜] E) (t : ℕ) (hN : N ^ (t + 1) = 0) (k z : 𝕜) (hz : z ≠ 0) :
    (z • (1 : E →L[𝕜] E) - k • N) * nilpRes N t k z = 1 := by
  rw [nilpRes, Finset.mul_sum]
  simp_rw [nilp_term_left N k z hz]
  rw [Finset.sum_range_sub']
  simp [hN]

theorem nilpRes_right (N : E →L[𝕜] E) (t : ℕ) (hN : N ^ (t + 1) = 0) (k z : 𝕜) (hz : z ≠ 0) :
    nilpRes N t k z * (z • (1 : E →L[𝕜] E) - k • N) = 1 := by
  rw [nilpRes, Finset.sum_mul]
  simp_rw [nilp_term_right N k z hz]
  rw [Finset.sum_range_sub']
  simp [hN]

lemma pow_contraction (N : E →L[𝕜] E) (hNc : ∀ y, ‖N y‖ ≤ ‖y‖) (m : ℕ) (y : E) :
    ‖(N ^ m) y‖ ≤ ‖y‖ := by
  induction m with
  | zero => simp
  | succ n ih =>
    rw [pow_succ', ContinuousLinearMap.mul_apply]
    exact (hNc _).trans ih

theorem nilpRes_apply_norm_le (N : E →L[𝕜] E) (t : ℕ) (hNc : ∀ y, ‖N y‖ ≤ ‖y‖) (k z : 𝕜)
    (y : E) : ‖nilpRes N t k z y‖ ≤ (∑ m ∈ range (t + 1), ‖k‖ ^ m / ‖z‖ ^ (m + 1)) * ‖y‖ := by
  rw [nilpRes, ContinuousLinearMap.sum_apply, Finset.sum_mul]
  refine (norm_sum_le _ _).trans (Finset.sum_le_sum fun m _ => ?_)
  rw [ContinuousLinearMap.smul_apply, norm_smul, norm_div, norm_pow, norm_pow]
  exact mul_le_mul_of_nonneg_left (pow_contraction N hNc m y) (by positivity)

/-- **C2, membership.** `k • N` satisfies the resolvent condition with constant `U(‖k‖)`. -/
theorem scaled_nilp_resolventCond (N : E →L[𝕜] E) (t : ℕ) (ht : 1 ≤ t) (hN : N ^ (t + 1) = 0)
    (hNc : ∀ y, ‖N y‖ ≤ ‖y‖) (k : 𝕜) : ResolventCond (k • N) (Ucrude ‖k‖ t) := by
  intro z hz
  have hz0 : z ≠ 0 := by
    intro h
    rw [h, norm_zero] at hz
    linarith
  refine ⟨nilpRes N t k z, nilpRes_left N t hN k z hz0, nilpRes_right N t hN k z hz0,
    fun y => ?_⟩
  have h1 := nilpRes_apply_norm_le N t hNc k z y
  have h2 := kreiss_sum_le hz ‖k‖ (norm_nonneg k) t ht
  have hz1 : 0 ≤ ‖z‖ - 1 := by linarith
  calc (‖z‖ - 1) * ‖nilpRes N t k z y‖
      ≤ (‖z‖ - 1) * ((∑ m ∈ range (t + 1), ‖k‖ ^ m / ‖z‖ ^ (m + 1)) * ‖y‖) :=
        mul_le_mul_of_nonneg_left h1 hz1
    _ = ((‖z‖ - 1) * ∑ m ∈ range (t + 1), ‖k‖ ^ m / ‖z‖ ^ (m + 1)) * ‖y‖ := by ring
    _ ≤ Ucrude ‖k‖ t * ‖y‖ := mul_le_mul_of_nonneg_right h2 (norm_nonneg y)

/-- The same membership with the sharper constant `U*(‖k‖)`. -/
theorem scaled_nilp_resolventCond_opt (N : E →L[𝕜] E) (t : ℕ) (hN : N ^ (t + 1) = 0)
    (hNc : ∀ y, ‖N y‖ ≤ ‖y‖) (k : 𝕜) : ResolventCond (k • N) (Uopt ‖k‖ t) := by
  intro z hz
  have hz0 : z ≠ 0 := by
    intro h
    rw [h, norm_zero] at hz
    linarith
  refine ⟨nilpRes N t k z, nilpRes_left N t hN k z hz0, nilpRes_right N t hN k z hz0,
    fun y => ?_⟩
  have h1 := nilpRes_apply_norm_le N t hNc k z y
  have h2 := kreiss_sum_le_opt hz ‖k‖ (norm_nonneg k) t
  have hz1 : 0 ≤ ‖z‖ - 1 := by linarith
  calc (‖z‖ - 1) * ‖nilpRes N t k z y‖
      ≤ (‖z‖ - 1) * ((∑ m ∈ range (t + 1), ‖k‖ ^ m / ‖z‖ ^ (m + 1)) * ‖y‖) :=
        mul_le_mul_of_nonneg_left h1 hz1
    _ = ((‖z‖ - 1) * ∑ m ∈ range (t + 1), ‖k‖ ^ m / ‖z‖ ^ (m + 1)) * ‖y‖ := by ring
    _ ≤ Uopt ‖k‖ t * ‖y‖ := mul_le_mul_of_nonneg_right h2 (norm_nonneg y)

lemma smul_pow_apply (k : 𝕜) (N : E →L[𝕜] E) (s : ℕ) (v : E) :
    ((k • N) ^ s) v = k ^ s • (N ^ s) v := by
  rw [smul_pow, ContinuousLinearMap.smul_apply]

lemma norm_smul_pow_apply (k : 𝕜) (N : E →L[𝕜] E) (s : ℕ) (v : E) :
    ‖((k • N) ^ s) v‖ = ‖k‖ ^ s * ‖(N ^ s) v‖ := by
  rw [smul_pow_apply, norm_smul, norm_pow]

/-- **C2, the unavoidable blind band (abstract).** Let `v` be a unit vector with `‖N^s v‖ = 1`
for `s ≤ T` and suppose `k • N` is in the class `ResolventCond · K`.  If the thresholds `τ` never
false-alarm on that class over steps `0..T`, then `τ_s ≥ ‖k‖^s` for every `s ≤ T`, and every scalar
mode with `‖c‖ ≤ ‖k‖` (unstable as soon as `‖c‖ > 1`) is silent through step `T` everywhere. -/
theorem unavoidable_blind_band (N : E →L[𝕜] E) (T : ℕ) (v : E) (hv : ‖v‖ = 1)
    (hvs : ∀ s ≤ T, ‖(N ^ s) v‖ = 1) (τ : ℕ → ℝ) (K : ℝ)
    (hfree : FalseAlarmFree (𝕜 := 𝕜) (E := E) τ T K) (k : 𝕜) (hRC : ResolventCond (k • N) K) :
    (∀ s ≤ T, ‖k‖ ^ s ≤ τ s) ∧
      ∀ c : 𝕜, ‖c‖ ≤ ‖k‖ → ∀ x, Silent (c • (1 : E →L[𝕜] E)) τ T x := by
  have hτ : ∀ s ≤ T, ‖k‖ ^ s ≤ τ s := by
    intro s hs
    have h := hfree (k • N) hRC v s hs
    rw [norm_smul_pow_apply, hvs s hs, hv, mul_one, mul_one] at h
    exact h
  refine ⟨hτ, fun c hc x s hs => ?_⟩
  rw [smul_pow, one_pow, ContinuousLinearMap.smul_apply, ContinuousLinearMap.one_apply, norm_smul,
    norm_pow]
  exact mul_le_mul_of_nonneg_right ((pow_le_pow_left₀ (norm_nonneg c) hc s).trans (hτ s hs))
    (norm_nonneg x)

end Resolvent


/-! ## 3. The nilpotent shift on the first `L` coordinates -/

section Shift

variable {𝕜 : Type*} [RCLike 𝕜]

/-- The shift on the first `L` coordinates. -/
def pshiftLM (n L : ℕ) (hL : L ≤ n) : EuclideanSpace 𝕜 (Fin n) →ₗ[𝕜] EuclideanSpace 𝕜 (Fin n) where
  toFun x := WithLp.toLp 2
    (fun i : Fin n => if h : i.val + 1 < L then x ⟨i.val + 1, by omega⟩ else 0)
  map_add' x y := by
    refine PiLp.ext (fun i => ?_)
    simp only [PiLp.add_apply]
    split_ifs <;> simp
  map_smul' c x := by
    refine PiLp.ext (fun i => ?_)
    simp only [PiLp.smul_apply, RingHom.id_apply, smul_eq_mul]
    split_ifs <;> simp

/-- The shift as a continuous linear map. -/
def pshift (n L : ℕ) (hL : L ≤ n) : EuclideanSpace 𝕜 (Fin n) →L[𝕜] EuclideanSpace 𝕜 (Fin n) :=
  LinearMap.toContinuousLinearMap (pshiftLM n L hL)

theorem pshift_apply (n L : ℕ) (hL : L ≤ n) (x : EuclideanSpace 𝕜 (Fin n)) (i : Fin n) :
    pshift n L hL x i = if h : i.val + 1 < L then x ⟨i.val + 1, by omega⟩ else 0 := by
  rfl

theorem pshift_norm_le (m L : ℕ) (hL : L ≤ m + 1) (x : EuclideanSpace 𝕜 (Fin (m + 1))) :
    ‖pshift (m + 1) L hL x‖ ≤ ‖x‖ := by
  have h1 : ∀ i : Fin m, ‖pshift (m + 1) L hL x (Fin.castSucc i)‖ ^ 2 ≤ ‖x i.succ‖ ^ 2 := by
    intro i
    rw [pshift_apply]
    split_ifs with h
    · have e : (⟨(Fin.castSucc i).val + 1, by omega⟩ : Fin (m + 1)) = i.succ :=
        Fin.ext (by simp)
      rw [e]
    · rw [norm_zero, zero_pow two_ne_zero]
      positivity
  have h2 : pshift (m + 1) L hL x (Fin.last m) = 0 := by
    rw [pshift_apply, dif_neg (by simp only [Fin.val_last]; omega)]
  have key : ‖pshift (m + 1) L hL x‖ ^ 2 ≤ ‖x‖ ^ 2 := by
    rw [EuclideanSpace.norm_sq_eq, EuclideanSpace.norm_sq_eq, Fin.sum_univ_castSucc,
      Fin.sum_univ_succ, h2, norm_zero]
    have hs : ∑ i : Fin m, ‖pshift (m + 1) L hL x (Fin.castSucc i)‖ ^ 2 ≤
        ∑ i : Fin m, ‖x i.succ‖ ^ 2 := Finset.sum_le_sum fun i _ => h1 i
    have h0 : 0 ≤ ‖x 0‖ ^ 2 := sq_nonneg _
    have hz : (0 : ℝ) ^ 2 = 0 := by norm_num
    rw [hz, add_zero]
    linarith
  exact (sq_le_sq₀ (norm_nonneg _) (norm_nonneg _)).mp key

theorem pshift_pow_succ_apply (n L : ℕ) (hL : L ≤ n) (m : ℕ) (x : EuclideanSpace 𝕜 (Fin n))
    (i : Fin n) :
    ((pshift n L hL) ^ (m + 1)) x i =
      if h : i.val + (m + 1) < L then x ⟨i.val + (m + 1), by omega⟩ else 0 := by
  induction m generalizing x with
  | zero => simp only [zero_add, pow_one, pshift_apply]
  | succ m ih =>
    rw [pow_succ, ContinuousLinearMap.mul_apply, ih]
    simp only [pshift_apply]
    split_ifs <;> first | rfl | (exfalso; omega)

theorem pshift_pow_nilp (n T : ℕ) (hL : T + 1 ≤ n) :
    (pshift (𝕜 := 𝕜) n (T + 1) hL) ^ (T + 1) = 0 := by
  ext x i
  rw [pshift_pow_succ_apply]
  have h : ¬ (i.val + (T + 1) < T + 1) := by omega
  rw [dif_neg h]
  simp

theorem pshift_pow_single (n L : ℕ) (hL : L ≤ n) (hL1 : 1 ≤ L) (s : ℕ) (hs : s < L) :
    ((pshift (𝕜 := 𝕜) n L hL) ^ s) (EuclideanSpace.single (⟨L - 1, by omega⟩ : Fin n) 1) =
      EuclideanSpace.single (⟨L - 1 - s, by omega⟩ : Fin n) 1 := by
  rcases s with _ | s
  · simp
  · ext i
    rw [pshift_pow_succ_apply]
    simp only [EuclideanSpace.single_apply, Fin.ext_iff]
    split_ifs <;> first | rfl | (exfalso; omega)

theorem pshift_pow_single_norm (n L : ℕ) (hL : L ≤ n) (hL1 : 1 ≤ L) (s : ℕ) (hs : s < L) :
    ‖((pshift (𝕜 := 𝕜) n L hL) ^ s) (EuclideanSpace.single (⟨L - 1, by omega⟩ : Fin n) 1)‖ = 1 := by
  rw [pshift_pow_single n L hL hL1 s hs, EuclideanSpace.norm_single, norm_one]

end Shift

/-! ## 4. The instance in `ℂ^(m+1)` (e.g. `m + 1 = 2048`) -/

/-- **C2, the unavoidable blind band in `ℂ^(m+1)`.** Let `T + 1 ≤ m + 1` and let the thresholds `τ`
never false-alarm on the class `{A : 𝒦(A) ≤ K}` of `(m+1)×(m+1)` complex matrices over steps
`0..T`.  If `U*(κ) ≤ K` then `τ_s ≥ κ^s` for every `s ≤ T`, and every mode `x ↦ c x` with
`|c| ≤ κ` is silent through step `T` on every trajectory. -/
theorem unavoidable_blind_band_euclid (m T : ℕ) (hn : T + 1 ≤ m + 1) (τ : ℕ → ℝ) (K : ℝ)
    (hfree : FalseAlarmFree (𝕜 := ℂ) (E := EuclideanSpace ℂ (Fin (m + 1))) τ T K)
    (κ : ℝ) (hκ : 0 ≤ κ) (hU : Uopt κ T ≤ K) :
    (∀ s ≤ T, κ ^ s ≤ τ s) ∧ ∀ c : ℂ, ‖c‖ ≤ κ → ∀ x,
      Silent (c • (1 : EuclideanSpace ℂ (Fin (m + 1)) →L[ℂ] EuclideanSpace ℂ (Fin (m + 1)))) τ T x := by
  have hnorm : ‖(κ : ℂ)‖ = κ := Complex.norm_of_nonneg hκ
  have hN := pshift_pow_nilp (𝕜 := ℂ) (m + 1) T hn
  have hNc : ∀ y, ‖pshift (𝕜 := ℂ) (m + 1) (T + 1) hn y‖ ≤ ‖y‖ := pshift_norm_le m (T + 1) hn
  have hRC : ResolventCond ((κ : ℂ) • pshift (𝕜 := ℂ) (m + 1) (T + 1) hn) K :=
    (scaled_nilp_resolventCond_opt _ T hN hNc (κ : ℂ)).mono (by rw [hnorm]; exact hU)
  have hv : ‖EuclideanSpace.single (⟨T + 1 - 1, by omega⟩ : Fin (m + 1)) (1 : ℂ)‖ = 1 := by
    rw [EuclideanSpace.norm_single, norm_one]
  have hvs : ∀ s ≤ T, ‖((pshift (𝕜 := ℂ) (m + 1) (T + 1) hn) ^ s)
      (EuclideanSpace.single (⟨T + 1 - 1, by omega⟩ : Fin (m + 1)) (1 : ℂ))‖ = 1 :=
    fun s hs => pshift_pow_single_norm (m + 1) (T + 1) hn (by omega) s (by omega)
  have h := unavoidable_blind_band _ T _ hv hvs τ K hfree (κ : ℂ) hRC
  rw [hnorm] at h
  exact h

/-- **C2, the asymptotic constant.** For every `t ≥ 1` and `ε > 0` there is `κ ≥ 1` such that
`A = κ S` on `ℂ^(t+1)` has `𝒦(A) ≤ U(κ)`, `‖A^t e_t‖ = κ^t`, and `C_t U(κ) ≤ (1 + ε) κ^t`:
the ratio `‖A^t‖/𝒦(A)` comes within any factor of `C_t = (t+1)^(t+1)/t^t`. -/
theorem ratio_approaches_sharp (t : ℕ) (ht : 1 ≤ t) (ε : ℝ) (hε : 0 < ε) :
    ∃ κ : ℝ, 1 ≤ κ ∧
      ResolventCond ((κ : ℂ) • pshift (𝕜 := ℂ) (t + 1) (t + 1) le_rfl) (Ucrude κ t) ∧
      ‖(((κ : ℂ) • pshift (𝕜 := ℂ) (t + 1) (t + 1) le_rfl) ^ t)
          (EuclideanSpace.single (⟨t + 1 - 1, by omega⟩ : Fin (t + 1)) (1 : ℂ))‖ = κ ^ t ∧
      ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t * Ucrude κ t ≤ (1 + ε) * κ ^ t := by
  have hC0 : 0 ≤ ((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t := by positivity
  refine ⟨max 1 (t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t) / ε), le_max_left _ _, ?_, ?_, ?_⟩
  · have h := scaled_nilp_resolventCond (pshift (𝕜 := ℂ) (t + 1) (t + 1) le_rfl) t ht
      (pshift_pow_nilp (t + 1) t le_rfl) (pshift_norm_le t (t + 1) le_rfl)
      ((max 1 (t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t) / ε) : ℝ) : ℂ)
    rwa [Complex.norm_of_nonneg (by positivity)] at h
  · rw [norm_smul_pow_apply, Complex.norm_of_nonneg (by positivity),
      pshift_pow_single_norm (t + 1) (t + 1) le_rfl (by omega) t (by omega), mul_one]
  · apply sharp_within t ht (le_max_left _ _)
    have h1 : t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t) / ε ≤
        max 1 (t * (((t : ℝ) + 1) ^ (t + 1) / (t : ℝ) ^ t) / ε) := le_max_right _ _
    rw [div_le_iff₀ hε] at h1
    exact h1.trans_eq (mul_comm _ _)

/-- Certified constants: `U*(κ) ≤ K` for the instances below. -/
theorem blind_cert_K10_T4 : Uopt (11 / 4) 4 ≤ 10 := by
  norm_num [Uopt, Finset.sum_range_succ]

theorem blind_cert_K10_T8 : Uopt (5 / 3) 8 ≤ 10 := by
  norm_num [Uopt, Finset.sum_range_succ]

theorem blind_cert_K10_T12 : Uopt (7 / 5) 12 ≤ 10 := by
  norm_num [Uopt, Finset.sum_range_succ]

theorem blind_cert_K100_T4 : Uopt (11 / 2) 4 ≤ 100 := by
  norm_num [Uopt, Finset.sum_range_succ]

/-- At `n = 2048` and loop depth `T = 4`: any norm-threshold rule that never false-alarms on the
Kreiss class `𝒦 ≤ 10` is silent through step 4 on every mode growing at most `2.75×` per step. -/
theorem blind_n2048_K10_T4 (τ : ℕ → ℝ)
    (hfree : FalseAlarmFree (𝕜 := ℂ) (E := EuclideanSpace ℂ (Fin (2047 + 1))) τ 4 10) :
    (∀ s ≤ 4, (11 / 4 : ℝ) ^ s ≤ τ s) ∧ ∀ c : ℂ, ‖c‖ ≤ 11 / 4 → ∀ x,
      Silent (c • (1 : EuclideanSpace ℂ (Fin (2047 + 1)) →L[ℂ] EuclideanSpace ℂ (Fin (2047 + 1))))
        τ 4 x :=
  unavoidable_blind_band_euclid 2047 4 (by norm_num) τ 10 hfree (11 / 4) (by norm_num)
    blind_cert_K10_T4

/-- The same with `𝒦 ≤ 100`: blind to every mode growing at most `5.5×` per step. -/
theorem blind_n2048_K100_T4 (τ : ℕ → ℝ)
    (hfree : FalseAlarmFree (𝕜 := ℂ) (E := EuclideanSpace ℂ (Fin (2047 + 1))) τ 4 100) :
    (∀ s ≤ 4, (11 / 2 : ℝ) ^ s ≤ τ s) ∧ ∀ c : ℂ, ‖c‖ ≤ 11 / 2 → ∀ x,
      Silent (c • (1 : EuclideanSpace ℂ (Fin (2047 + 1)) →L[ℂ] EuclideanSpace ℂ (Fin (2047 + 1))))
        τ 4 x :=
  unavoidable_blind_band_euclid 2047 4 (by norm_num) τ 100 hfree (11 / 2) (by norm_num)
    blind_cert_K100_T4

end KreissC

#print axioms KreissC.bernoulli_peak
#print axioms KreissC.peak_le_one
#print axioms KreissC.peak_le_sharp
#print axioms KreissC.sharp_const_lt
#print axioms KreissC.kreiss_sum_le
#print axioms KreissC.peak_le_pk
#print axioms KreissC.kreiss_sum_le_opt
#print axioms KreissC.Ucrude_le
#print axioms KreissC.sharp_mul_inv
#print axioms KreissC.ratio_lower
#print axioms KreissC.sharp_within
#print axioms KreissC.ResolventCond.mono
#print axioms KreissC.scal_z
#print axioms KreissC.scal_k
#print axioms KreissC.nilp_term_left
#print axioms KreissC.nilp_term_right
#print axioms KreissC.nilpRes_left
#print axioms KreissC.nilpRes_right
#print axioms KreissC.pow_contraction
#print axioms KreissC.nilpRes_apply_norm_le
#print axioms KreissC.scaled_nilp_resolventCond
#print axioms KreissC.scaled_nilp_resolventCond_opt
#print axioms KreissC.smul_pow_apply
#print axioms KreissC.norm_smul_pow_apply
#print axioms KreissC.unavoidable_blind_band
#print axioms KreissC.pshift_apply
#print axioms KreissC.pshift_norm_le
#print axioms KreissC.pshift_pow_succ_apply
#print axioms KreissC.pshift_pow_nilp
#print axioms KreissC.pshift_pow_single
#print axioms KreissC.pshift_pow_single_norm
#print axioms KreissC.unavoidable_blind_band_euclid
#print axioms KreissC.ratio_approaches_sharp
#print axioms KreissC.blind_cert_K10_T4
#print axioms KreissC.blind_cert_K10_T8
#print axioms KreissC.blind_cert_K10_T12
#print axioms KreissC.blind_cert_K100_T4
#print axioms KreissC.blind_n2048_K10_T4
#print axioms KreissC.blind_n2048_K100_T4
