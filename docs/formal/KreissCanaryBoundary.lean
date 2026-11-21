/-
# Where Kreiss-inflated thresholds stop applying

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, R2):
an infinite Kreiss constant, a threshold that is not robust over a class, and a switched loop.

Nothing here is new mathematics: an eigenvalue or a Jordan chain blocks the resolvent condition
(Trefethen & Embree 2005, ch. 18), and the switched loop is a two-step example of why one map's
Kreiss constant says nothing about a product of maps.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/KreissCanaryBoundary.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 27 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.InnerProductSpace.PiL2
import Mathlib.Analysis.Complex.ExponentialBounds

/-!
# C4: when the Kreiss constant is infinite, L3′ is not class-robust, and a switched loop

`ResolventCond A K` (vector form of `𝒦(A) ≤ K`): for every `‖z‖ > 1`, `z - A` is invertible and
`(‖z‖ - 1) ‖(z - A)⁻¹ y‖ ≤ K ‖y‖`.  "`𝒦(A) = ∞`" means: `ResolventCond A K` fails for every `K`.

Main results
* `not_rc_of_eigen_outside`  : an eigenvalue with `|μ| > 1` gives `𝒦(A) = ∞`.
* `not_rc_of_jordan_on_circle` : a Jordan chain `A v = μ v`, `A w = μ w + v` (`v ≠ 0`) with `|μ| = 1`
                               also gives `𝒦(A) = ∞`: an infinite Kreiss constant does NOT require an
                               eigenvalue outside the closed disk.
* `rc_scalar`                : `|a| ≤ 1` gives `𝒦(a • 1) ≤ 1`; so a (semisimple) eigenvalue on the
                               circle, e.g. the identity, has finite Kreiss constant.
* `forced_tau_ge_one`        : every rule that is false-alarm-free on a Kreiss class `K ≥ 1` has
                               `τ_t ≥ 1` (the identity is in the class).
* `L3prime_identity_false_alarm`, `L3prime_contraction_false_alarm` : the L3′ rule
                               `τ_t = M ‖A_nom^t‖` with a strictly stable scalar nominal model false-alarms
                               on members of the nominal model's own Kreiss class (`𝒦 = 1`).
* `resolvent_bound_of_numrad`: numerical radius `≤ 1` gives `(|z| - 1) ‖x‖ ≤ ‖(z - A) x‖`.
* `switched_loop_false_alarm`: `A₁ = 2 E₁₂`, `A₂ = 2 E₂₁` on `ℂ²` both have `𝒦 ≤ 1`, yet the loop
                               `A₁, A₂, A₁, A₂` started at `e₂` has `‖x₄‖ = 16 ‖x₀‖`, above both the sharp
                               finite-horizon threshold `C₄ = 5⁵/4⁴ ≈ 12.2` and `e(4+1) ≈ 13.6`.  A Kreiss
                               threshold for a fixed map says nothing about a step-dependent loop.
-/

noncomputable section

namespace KreissC

open Finset

section Defs

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

/-- **C4.4, eigenvalue outside the disk.** `𝒦(A) = ∞`. -/
theorem not_rc_of_eigen_outside (A : E →L[𝕜] E) (μ : 𝕜) (hμ : 1 < ‖μ‖) (v : E) (hv : v ≠ 0)
    (hAv : A v = μ • v) (K : ℝ) : ¬ ResolventCond A K := by
  intro h
  obtain ⟨R, _, h2, _⟩ := h μ hμ
  have h3 : (μ • (1 : E →L[𝕜] E) - A) v = 0 := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.smul_apply,
      ContinuousLinearMap.one_apply, hAv, sub_self]
  have h4 : (R * (μ • (1 : E →L[𝕜] E) - A)) v = v := by
    rw [h2, ContinuousLinearMap.one_apply]
  rw [ContinuousLinearMap.mul_apply, h3, map_zero] at h4
  exact hv h4.symm

/-- **C4.4, a semisimple eigenvalue on the circle is harmless.** `‖a‖ ≤ 1` gives `𝒦(a • 1) ≤ 1`. -/
theorem rc_scalar (a : 𝕜) (ha : ‖a‖ ≤ 1) : ResolventCond (a • (1 : E →L[𝕜] E)) 1 := by
  intro z hz
  have hza : z - a ≠ 0 := by
    intro h
    have : z = a := sub_eq_zero.mp h
    rw [this] at hz
    linarith
  refine ⟨(z - a)⁻¹ • (1 : E →L[𝕜] E), ?_, ?_, fun y => ?_⟩
  · rw [← sub_smul, smul_mul_assoc, one_mul, smul_smul, mul_inv_cancel₀ hza, one_smul]
  · rw [← sub_smul, smul_mul_assoc, one_mul, smul_smul, inv_mul_cancel₀ hza, one_smul]
  · rw [ContinuousLinearMap.smul_apply, ContinuousLinearMap.one_apply, norm_smul, norm_inv]
    have h1 : ‖z‖ - 1 ≤ ‖z - a‖ := by
      have := norm_sub_norm_le z a
      linarith
    have h2 : 0 < ‖z - a‖ := norm_pos_iff.mpr hza
    calc (‖z‖ - 1) * (‖z - a‖⁻¹ * ‖y‖) = ((‖z‖ - 1) / ‖z - a‖) * ‖y‖ := by ring
      _ ≤ 1 * ‖y‖ := mul_le_mul_of_nonneg_right ((div_le_one h2).mpr h1) (norm_nonneg y)

theorem rc_one_identity : ResolventCond (1 : E →L[𝕜] E) 1 := by
  have h := rc_scalar (E := E) (1 : 𝕜) (by rw [norm_one])
  rwa [one_smul] at h

/-- Every rule that is false-alarm-free on a Kreiss class with `K ≥ 1` has `τ_t ≥ 1`. -/
theorem forced_tau_ge_one {τ : ℕ → ℝ} {T : ℕ} {K : ℝ} (hK : 1 ≤ K)
    (hfree : ∀ A : E →L[𝕜] E, ResolventCond A K → ∀ x, Silent A τ T x) {x : E} (hx : x ≠ 0) :
    ∀ t ≤ T, 1 ≤ τ t := by
  intro t ht
  have h := hfree 1 (rc_one_identity.mono hK) x t ht
  rw [one_pow, ContinuousLinearMap.one_apply] at h
  have hx' : 0 < ‖x‖ := norm_pos_iff.mpr hx
  nlinarith

/-- `‖(a • 1)^t‖ = ‖a‖^t` (nontrivial `E`), so L3′'s threshold for a scalar `A_nom = a • 1`
is `τ_t = M ‖a‖^t`. -/
theorem norm_scalar_pow [Nontrivial E] (a : 𝕜) (t : ℕ) :
    ‖(a • (1 : E →L[𝕜] E)) ^ t‖ = ‖a‖ ^ t := by
  rw [smul_pow, one_pow, norm_smul, norm_pow, norm_one, mul_one]

/-- **C4.3, L3′ against the identity.** For any margin `M` and any step `t` with
`M ‖a‖^t < 1`, the L3′ rule built from `A_nom = a • 1` (`‖a‖ ≤ 1`, so `𝒦(A_nom) ≤ 1`)
false-alarms at step `t` on the identity, which is in the same Kreiss class. -/
theorem L3prime_identity_false_alarm [Nontrivial E] (a : 𝕜) (ha : ‖a‖ ≤ 1) (M : ℝ) (t : ℕ)
    (hMt : M * ‖a‖ ^ t < 1) {x : E} (hx : x ≠ 0) :
    ResolventCond (a • (1 : E →L[𝕜] E)) 1 ∧ ResolventCond (1 : E →L[𝕜] E) 1 ∧
      M * ‖(a • (1 : E →L[𝕜] E)) ^ t‖ * ‖x‖ < ‖((1 : E →L[𝕜] E) ^ t) x‖ := by
  refine ⟨rc_scalar a ha, rc_one_identity, ?_⟩
  rw [norm_scalar_pow, one_pow, ContinuousLinearMap.one_apply]
  have hx' : 0 < ‖x‖ := norm_pos_iff.mpr hx
  calc M * ‖a‖ ^ t * ‖x‖ < 1 * ‖x‖ := mul_lt_mul_of_pos_right hMt hx'
    _ = ‖x‖ := one_mul _

end Defs

/-- **C4.3, L3′ against a strictly stable contraction.** `A_nom = ½·1` and `A = (3/5)·1` both have
`𝒦 ≤ 1`; for every margin `M < 6/5` (e.g. `M = 1.05 c` with `c < 8/7`), L3′'s threshold
`τ₁ = M ‖A_nom‖ = M/2` false-alarms on `A` at step 1. -/
theorem L3prime_contraction_false_alarm {E : Type*} [NormedAddCommGroup E] [NormedSpace ℂ E]
    [Nontrivial E] {M : ℝ} (hM : M < 6 / 5) {x : E} (hx : x ≠ 0) :
    ResolventCond ((1 / 2 : ℂ) • (1 : E →L[ℂ] E)) 1 ∧ ResolventCond ((3 / 5 : ℂ) • (1 : E →L[ℂ] E)) 1 ∧
      M * ‖((1 / 2 : ℂ) • (1 : E →L[ℂ] E)) ^ 1‖ * ‖x‖ < ‖(((3 / 5 : ℂ) • (1 : E →L[ℂ] E)) ^ 1) x‖ := by
  have h12 : ‖(1 / 2 : ℂ)‖ = 1 / 2 := by
    rw [norm_div, norm_one, Complex.norm_ofNat]
  have h35 : ‖(3 / 5 : ℂ)‖ = 3 / 5 := by
    rw [norm_div, Complex.norm_ofNat, Complex.norm_ofNat]
  refine ⟨rc_scalar _ (by rw [h12]; norm_num), rc_scalar _ (by rw [h35]; norm_num), ?_⟩
  rw [norm_scalar_pow, pow_one, pow_one, ContinuousLinearMap.smul_apply,
    ContinuousLinearMap.one_apply, norm_smul, h12, h35]
  have hx' : 0 < ‖x‖ := norm_pos_iff.mpr hx
  have : M * (1 / 2) < 3 / 5 := by linarith
  exact mul_lt_mul_of_pos_right this hx'

/-- **C4.4, a Jordan block on the unit circle.** `A v = μ v`, `A w = μ w + v`, `v ≠ 0`, `‖μ‖ = 1`:
no resolvent condition holds, so `𝒦(A) = ∞` with every eigenvalue on the closed disk. -/
theorem not_rc_of_jordan_on_circle {𝕜 : Type*} [RCLike 𝕜] {E : Type*} [NormedAddCommGroup E]
    [NormedSpace 𝕜 E] (A : E →L[𝕜] E) (μ : 𝕜) (hμ : ‖μ‖ = 1) (v w : E) (hv : v ≠ 0)
    (hAv : A v = μ • v) (hAw : A w = μ • w + v) (K : ℝ) : ¬ ResolventCond A K := by
  intro h
  have hv' : 0 < ‖v‖ := norm_pos_iff.mpr hv
  have hden : 0 < 2 * (|K| + 1) * (‖w‖ + 1) := by positivity
  set s : ℝ := ‖v‖ / (2 * (|K| + 1) * (‖w‖ + 1)) with hs_def
  have hs : 0 < s := div_pos hv' hden
  set z : 𝕜 := ((1 + s : ℝ) : 𝕜) * μ with hz_def
  have hz : ‖z‖ = 1 + s := by
    rw [hz_def, norm_mul, hμ, mul_one, RCLike.norm_ofReal, abs_of_pos (by linarith)]
  obtain ⟨R, _, h2, h3⟩ := h z (by rw [hz]; linarith)
  set d : 𝕜 := z - μ with hd_def
  have hd : d = (s : 𝕜) * μ := by
    rw [hd_def, hz_def]
    push_cast
    ring
  have hdn : ‖d‖ = s := by rw [hd, norm_mul, hμ, mul_one, RCLike.norm_ofReal, abs_of_pos hs]
  have hd0 : d ≠ 0 := by
    intro h0
    rw [h0, norm_zero] at hdn
    linarith
  have e1 : (z • (1 : E →L[𝕜] E) - A) v = d • v := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.smul_apply,
      ContinuousLinearMap.one_apply, hAv, hd_def, sub_smul]
  have e2 : (z • (1 : E →L[𝕜] E) - A) w = d • w - v := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.smul_apply,
      ContinuousLinearMap.one_apply, hAw, hd_def, sub_smul]
    abel
  set u : E := d⁻¹ • w + (d⁻¹ ^ 2) • v with hu_def
  have hdd : d⁻¹ ^ 2 * d = d⁻¹ := by rw [sq, mul_assoc, inv_mul_cancel₀ hd0, mul_one]
  have hAu : (z • (1 : E →L[𝕜] E) - A) u = w := by
    rw [hu_def, map_add, map_smul, map_smul, e1, e2, smul_sub, smul_smul, smul_smul,
      inv_mul_cancel₀ hd0, one_smul, hdd]
    abel
  have hRw : R w = u := by
    have h5 := congrArg (fun T : E →L[𝕜] E => T u) h2
    simp only [ContinuousLinearMap.mul_apply, ContinuousLinearMap.one_apply, hAu] at h5
    exact h5
  have hb : ‖(d⁻¹ ^ 2) • v‖ = ‖v‖ / s ^ 2 := by
    rw [norm_smul, norm_pow, norm_inv, hdn, inv_pow, inv_mul_eq_div]
  have ha : ‖d⁻¹ • w‖ = ‖w‖ / s := by
    rw [norm_smul, norm_inv, hdn, inv_mul_eq_div]
  have htri : ‖(d⁻¹ ^ 2) • v‖ ≤ ‖u‖ + ‖d⁻¹ • w‖ := by
    have e : (d⁻¹ ^ 2) • v = u - d⁻¹ • w := by
      rw [hu_def]
      abel
    rw [e]
    exact norm_sub_le _ _
  have hRC := h3 w
  rw [hRw, hz] at hRC
  have e3 : (1 + s - 1) = s := by ring
  rw [e3] at hRC
  rw [hb, ha] at htri
  have hK : K * ‖w‖ ≤ |K| * ‖w‖ := mul_le_mul_of_nonneg_right (le_abs_self K) (norm_nonneg w)
  -- `s * (‖v‖ / s^2) ≤ s * (‖u‖ + ‖w‖/s) = s ‖u‖ + ‖w‖ ≤ (|K| + 1) ‖w‖`
  have h6 : s * (‖v‖ / s ^ 2) ≤ (|K| + 1) * ‖w‖ := by
    have e4 : s * (‖u‖ + ‖w‖ / s) = s * ‖u‖ + ‖w‖ := by
      rw [mul_add, mul_div_assoc', mul_div_cancel_left₀ _ hs.ne']
    calc s * (‖v‖ / s ^ 2) ≤ s * (‖u‖ + ‖w‖ / s) := mul_le_mul_of_nonneg_left htri hs.le
      _ = s * ‖u‖ + ‖w‖ := e4
      _ ≤ |K| * ‖w‖ + ‖w‖ := by linarith
      _ = (|K| + 1) * ‖w‖ := by ring
  have e5 : s * (‖v‖ / s ^ 2) = 2 * (|K| + 1) * (‖w‖ + 1) := by
    have e6 : s * (‖v‖ / s ^ 2) = ‖v‖ / s := by
      rw [mul_div_assoc', sq, ← div_div, mul_div_cancel_left₀ _ hs.ne']
    rw [e6, hs_def, div_div_eq_mul_div, mul_div_cancel_left₀ _ hv'.ne']
  rw [e5] at h6
  have hK1 : 0 < |K| + 1 := by positivity
  nlinarith [norm_nonneg w]

/-! ## Numerical radius `≤ 1` and the resolvent -/

section NumRad

variable {𝕜 : Type*} [RCLike 𝕜] {E : Type*} [NormedAddCommGroup E] [InnerProductSpace 𝕜 E]

/-- Numerical radius `≤ 1` (`|⟪x, A x⟫| ≤ ‖x‖²`) gives `(‖z‖ - 1) ‖x‖ ≤ ‖(z - A) x‖`. -/
theorem resolvent_bound_of_numrad (A : E →L[𝕜] E) (hA : ∀ x, ‖inner 𝕜 x (A x)‖ ≤ ‖x‖ ^ 2)
    (z : 𝕜) (x : E) : (‖z‖ - 1) * ‖x‖ ≤ ‖(z • (1 : E →L[𝕜] E) - A) x‖ := by
  rcases eq_or_ne x 0 with rfl | hx
  · simp
  have hx' : 0 < ‖x‖ := norm_pos_iff.mpr hx
  have h1 : ‖inner 𝕜 x ((z • (1 : E →L[𝕜] E) - A) x)‖ ≤
      ‖x‖ * ‖(z • (1 : E →L[𝕜] E) - A) x‖ := norm_inner_le_norm _ _
  have h2 : inner 𝕜 x ((z • (1 : E →L[𝕜] E) - A) x) =
      z * ((‖x‖ : 𝕜) ^ 2) - inner 𝕜 x (A x) := by
    rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.smul_apply,
      ContinuousLinearMap.one_apply, inner_sub_right, inner_smul_right,
      inner_self_eq_norm_sq_to_K]
  have h3 : ‖z‖ * ‖x‖ ^ 2 - ‖x‖ ^ 2 ≤ ‖inner 𝕜 x ((z • (1 : E →L[𝕜] E) - A) x)‖ := by
    rw [h2]
    have h4 := norm_sub_norm_le (z * ((‖x‖ : 𝕜) ^ 2)) (inner 𝕜 x (A x))
    rw [norm_mul, norm_pow, RCLike.norm_ofReal, abs_norm] at h4
    linarith [hA x]
  have h5 : ‖x‖ * ((‖z‖ - 1) * ‖x‖) ≤ ‖x‖ * ‖(z • (1 : E →L[𝕜] E) - A) x‖ := by
    calc ‖x‖ * ((‖z‖ - 1) * ‖x‖) = ‖z‖ * ‖x‖ ^ 2 - ‖x‖ ^ 2 := by ring
      _ ≤ _ := h3
      _ ≤ _ := h1
  exact le_of_mul_le_mul_left h5 hx'

/-- With a right inverse `R` of `z - A`, the numerical-radius bound gives
`(‖z‖ - 1) ‖R y‖ ≤ ‖y‖`. -/
theorem resolvent_norm_of_numrad (A : E →L[𝕜] E) (hA : ∀ x, ‖inner 𝕜 x (A x)‖ ≤ ‖x‖ ^ 2)
    (z : 𝕜) (R : E →L[𝕜] E) (hR : (z • (1 : E →L[𝕜] E) - A) * R = 1) (y : E) :
    (‖z‖ - 1) * ‖R y‖ ≤ 1 * ‖y‖ := by
  have h := resolvent_bound_of_numrad A hA z (R y)
  rw [← ContinuousLinearMap.mul_apply, hR, ContinuousLinearMap.one_apply] at h
  rw [one_mul]
  exact h

end NumRad

/-! ## The resolvent of a scaled nilpotent (as in C2) -/

section Nilp

variable {𝕜 : Type*} [NontriviallyNormedField 𝕜]
variable {E : Type*} [NormedAddCommGroup E] [NormedSpace 𝕜 E]

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

end Nilp

/-! ## A switched loop: every step has `𝒦 ≤ 1`, the product grows like `2^t` -/

section Switched

variable {E : Type*} [NormedAddCommGroup E] [InnerProductSpace ℂ E]

local notation "⟪" x ", " y "⟫" => inner ℂ x y

/-- The rank-one map `x ↦ ⟪w, x⟫ u` (it sends `w` to `u`). -/
def transfer (w u : E) : E →L[ℂ] E := (innerSL ℂ w).smulRight u

lemma transfer_apply (w u x : E) : transfer w u x = ⟪w, x⟫ • u := by
  simp only [transfer, ContinuousLinearMap.smulRight_apply, innerSL_apply_apply]

lemma inner_self_one {v : E} (hv : ‖v‖ = 1) : ⟪v, v⟫ = 1 := by
  rw [inner_self_eq_norm_sq_to_K, hv]
  simp

variable {u w : E}

lemma transfer_sq (huw : ⟪u, w⟫ = 0) : transfer w u ^ 2 = 0 := by
  have hwu : ⟪w, u⟫ = 0 := inner_eq_zero_symm.mp huw
  ext x
  rw [pow_two, ContinuousLinearMap.mul_apply, transfer_apply w u x, transfer_apply,
    inner_smul_right, hwu, mul_zero, zero_smul, ContinuousLinearMap.zero_apply]

/-- Bessel for an orthonormal pair. -/
lemma bessel_pair (hu : ‖u‖ = 1) (hw : ‖w‖ = 1) (huw : ⟪u, w⟫ = 0) (x : E) :
    ‖⟪u, x⟫‖ ^ 2 + ‖⟪w, x⟫‖ ^ 2 ≤ ‖x‖ ^ 2 := by
  have hwu : ⟪w, u⟫ = 0 := inner_eq_zero_symm.mp huw
  have hon : Orthonormal ℂ ![u, w] := by
    rw [orthonormal_iff_ite]
    intro i j
    fin_cases i <;> fin_cases j <;> simp [hu, hw, huw, hwu]
  have hb := hon.sum_inner_products_le x (s := Finset.univ)
  rw [Fin.sum_univ_two] at hb
  simpa using hb

/-- Numerical radius of `2 • transfer w u` is at most `1`. -/
lemma numrad_two_transfer (hu : ‖u‖ = 1) (hw : ‖w‖ = 1) (huw : ⟪u, w⟫ = 0) (x : E) :
    ‖⟪x, ((2 : ℂ) • transfer w u) x⟫‖ ≤ ‖x‖ ^ 2 := by
  rw [ContinuousLinearMap.smul_apply, transfer_apply, inner_smul_right, inner_smul_right,
    norm_mul, norm_mul, norm_inner_symm x u]
  have hb := bessel_pair hu hw huw x
  rw [Complex.norm_two]
  nlinarith [sq_nonneg (‖⟪w, x⟫‖ - ‖⟪u, x⟫‖)]

/-- **`𝒦(2 • transfer w u) ≤ 1`** for an orthonormal pair `u, w`. -/
theorem rc_two_transfer (hu : ‖u‖ = 1) (hw : ‖w‖ = 1) (huw : ⟪u, w⟫ = 0) :
    ResolventCond ((2 : ℂ) • transfer w u) 1 := by
  intro z hz
  have hz0 : z ≠ 0 := by
    intro h
    rw [h, norm_zero] at hz
    linarith
  have hN : transfer w u ^ (1 + 1) = 0 := transfer_sq huw
  refine ⟨nilpRes (transfer w u) 1 2 z, nilpRes_left _ 1 hN 2 z hz0,
    nilpRes_right _ 1 hN 2 z hz0, fun y => ?_⟩
  exact resolvent_norm_of_numrad _ (numrad_two_transfer hu hw huw) z _
    (nilpRes_left _ 1 hN 2 z hz0) y

lemma A_apply (hw : ‖w‖ = 1) (c : ℂ) : ((2 : ℂ) • transfer w u) (c • w) = (2 * c) • u := by
  rw [ContinuousLinearMap.smul_apply, transfer_apply, inner_smul_right, inner_self_one hw,
    mul_one, smul_smul]

lemma A_apply_self (hw : ‖w‖ = 1) : ((2 : ℂ) • transfer w u) w = (2 : ℂ) • u := by
  have h := A_apply (u := u) hw 1
  rwa [one_smul, mul_one] at h

/-- **C4, the switched loop.** With `A₁ = 2 • transfer w u` (`w ↦ 2u`) and
`A₂ = 2 • transfer u w` (`u ↦ 2w`), both in the Kreiss class `𝒦 ≤ 1`, the loop `A₁, A₂, A₁, A₂`
started at `w` reaches `16 • w`. -/
theorem switched_loop (hu : ‖u‖ = 1) (hw : ‖w‖ = 1) (huw : ⟪u, w⟫ = 0) :
    ResolventCond ((2 : ℂ) • transfer w u) 1 ∧ ResolventCond ((2 : ℂ) • transfer u w) 1 ∧
      ((2 : ℂ) • transfer u w) (((2 : ℂ) • transfer w u)
        (((2 : ℂ) • transfer u w) (((2 : ℂ) • transfer w u) w))) = (16 : ℂ) • w := by
  have hwu : ⟪w, u⟫ = 0 := inner_eq_zero_symm.mp huw
  refine ⟨rc_two_transfer hu hw huw, rc_two_transfer hw hu hwu, ?_⟩
  rw [A_apply_self hw, A_apply hu, A_apply hw, A_apply hu]
  norm_num

set_option linter.unnecessarySeqFocus false in
/-- **C4, a Kreiss threshold says nothing about a step-dependent loop.** The step-4 state of the
switched loop has norm `16`, above the sharp finite-horizon threshold `C₄ · 1 = 5⁵/4⁴ ≈ 12.2` and
above `e (4 + 1) · 1 ≈ 13.6`, which are false-alarm-free for every FIXED map with `𝒦 ≤ 1`. -/
theorem switched_loop_false_alarm (hu : ‖u‖ = 1) (hw : ‖w‖ = 1) (huw : ⟪u, w⟫ = 0) :
    (5 : ℝ) ^ 5 / 4 ^ 4 * ‖w‖ < ‖((2 : ℂ) • transfer u w) (((2 : ℂ) • transfer w u)
        (((2 : ℂ) • transfer u w) (((2 : ℂ) • transfer w u) w)))‖ ∧
      Real.exp 1 * (4 + 1) * ‖w‖ < ‖((2 : ℂ) • transfer u w) (((2 : ℂ) • transfer w u)
        (((2 : ℂ) • transfer u w) (((2 : ℂ) • transfer w u) w)))‖ := by
  rw [(switched_loop hu hw huw).2.2, norm_smul, hw]
  simp only [mul_one]
  rw [Complex.norm_ofNat 16]
  have he := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

end Switched

end KreissC

#print axioms KreissC.ResolventCond.mono
#print axioms KreissC.not_rc_of_eigen_outside
#print axioms KreissC.rc_scalar
#print axioms KreissC.rc_one_identity
#print axioms KreissC.forced_tau_ge_one
#print axioms KreissC.norm_scalar_pow
#print axioms KreissC.L3prime_identity_false_alarm
#print axioms KreissC.L3prime_contraction_false_alarm
#print axioms KreissC.not_rc_of_jordan_on_circle
#print axioms KreissC.resolvent_bound_of_numrad
#print axioms KreissC.resolvent_norm_of_numrad
#print axioms KreissC.nilpRes_left
#print axioms KreissC.nilpRes_right
#print axioms KreissC.transfer_apply
#print axioms KreissC.transfer_sq
#print axioms KreissC.bessel_pair
#print axioms KreissC.numrad_two_transfer
#print axioms KreissC.rc_two_transfer
#print axioms KreissC.A_apply
#print axioms KreissC.A_apply_self
#print axioms KreissC.switched_loop
#print axioms KreissC.switched_loop_false_alarm
#print axioms KreissC.scal_z
#print axioms KreissC.scal_k
#print axioms KreissC.nilp_term_left
#print axioms KreissC.nilp_term_right
#print axioms KreissC.inner_self_one
