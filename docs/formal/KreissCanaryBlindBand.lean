/-
# A norm-threshold canary's blind band

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, R2): a
canary with threshold τ stays silent for T steps on any mode growing by at most τ^(1/T) per step.

Nothing here is new mathematics: elementary norm and power inequalities. The certified table
entries apply them to R2's thresholds.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/KreissCanaryBlindBand.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 28 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Normed.Operator.NormedSpace
import Mathlib.Analysis.SpecialFunctions.Pow.Real
import Mathlib.Analysis.Complex.ExponentialBounds

/-!
# C1: the blind band of a norm-threshold canary

The canary watches `x_{t+1} = A x_t` and alarms at step `t` when `‖x_t‖ > τ_t ‖x_0‖`.
`Silent A τ T x` says it stays quiet on the trajectory of `x` through step `T`.

Main results
* `pow_apply_norm_le`   : `‖A y‖ ≤ ρ‖y‖` for all `y` gives `‖A^t x‖ ≤ ρ^t ‖x‖`.
* `silent_of_growth_le` : such an `A` is silent whenever `ρ^t ≤ τ_t` for `t ≤ T`.
* `silent_scalar_iff`   : the scalar map `c • 1` is silent on `x ≠ 0` iff `‖c‖^t ≤ τ_t`, `t ≤ T`.
* `blind_band`          : `T ≥ 1`, `τ ≥ 1`, `‖c‖ = τ^(1/T)`: silent through step `T` for every `x`,
                          although the mode grows by `‖c‖ ≥ 1` per step;
* `blind_band_sharp`    : any faster mode `‖c‖ > τ^(1/T)` fires at step `T` (every `x ≠ 0`);
* `blind_mode_unstable` : for `‖c‖ > 1` the silent mode is genuinely unstable (`‖x_t‖ → ∞`).
* `blind_K*_T*_*`       : certified 3-decimal brackets of `ρ_blind = τ^(1/T)` for
                          `τ = e(T+1)K` and `τ = e·2048·K`, `K ∈ {1, 10}`, `T ∈ {4, 8, 12}`.
* `r2_*`                : the R2 correction (a 1.2× mode against `e·2048·K` is silent through
                          step 47 and, for `K = 1`, fires at step 48), and the same mode against the
                          dimension-free finite-horizon threshold `e(t+1)K` (silent through 22,
                          fires at 23 for `K = 1`).
-/

noncomputable section

namespace KreissC

open Real

section General

variable {𝕜 : Type*} [NontriviallyNormedField 𝕜]
variable {E : Type*} [NormedAddCommGroup E] [NormedSpace 𝕜 E]

/-- The canary with thresholds `τ` stays silent on the trajectory of `x` through step `T`. -/
def Silent (A : E →L[𝕜] E) (τ : ℕ → ℝ) (T : ℕ) (x : E) : Prop :=
  ∀ t ≤ T, ‖(A ^ t) x‖ ≤ τ t * ‖x‖

lemma pow_apply_norm_le (A : E →L[𝕜] E) {ρ : ℝ} (hρ : 0 ≤ ρ) (hA : ∀ y, ‖A y‖ ≤ ρ * ‖y‖)
    (t : ℕ) (x : E) : ‖(A ^ t) x‖ ≤ ρ ^ t * ‖x‖ := by
  induction t with
  | zero => simp
  | succ n ih =>
    rw [pow_succ', ContinuousLinearMap.mul_apply]
    calc ‖A ((A ^ n) x)‖ ≤ ρ * ‖(A ^ n) x‖ := hA _
      _ ≤ ρ * (ρ ^ n * ‖x‖) := mul_le_mul_of_nonneg_left ih hρ
      _ = ρ ^ (n + 1) * ‖x‖ := by ring

/-- A map whose one-step growth is at most `ρ` is silent whenever `ρ^t ≤ τ_t` for `t ≤ T`. -/
theorem silent_of_growth_le (A : E →L[𝕜] E) {ρ : ℝ} (hρ : 0 ≤ ρ) (hA : ∀ y, ‖A y‖ ≤ ρ * ‖y‖)
    (τ : ℕ → ℝ) (T : ℕ) (hτ : ∀ t ≤ T, ρ ^ t ≤ τ t) (x : E) : Silent A τ T x := fun t ht =>
  (pow_apply_norm_le A hρ hA t x).trans (mul_le_mul_of_nonneg_right (hτ t ht) (norm_nonneg x))

lemma smul_one_pow_apply (c : 𝕜) (t : ℕ) (x : E) :
    ((c • (1 : E →L[𝕜] E)) ^ t) x = c ^ t • x := by
  rw [smul_pow, one_pow, ContinuousLinearMap.smul_apply, ContinuousLinearMap.one_apply]

lemma norm_smul_one_pow_apply (c : 𝕜) (t : ℕ) (x : E) :
    ‖((c • (1 : E →L[𝕜] E)) ^ t) x‖ = ‖c‖ ^ t * ‖x‖ := by
  rw [smul_one_pow_apply, norm_smul, norm_pow]

/-- The scalar mode `c • 1` is silent on `x ≠ 0` exactly when `‖c‖^t ≤ τ_t` for all `t ≤ T`. -/
theorem silent_scalar_iff (c : 𝕜) (τ : ℕ → ℝ) (T : ℕ) {x : E} (hx : x ≠ 0) :
    Silent (c • (1 : E →L[𝕜] E)) τ T x ↔ ∀ t ≤ T, ‖c‖ ^ t ≤ τ t := by
  have hx' : 0 < ‖x‖ := norm_pos_iff.mpr hx
  constructor
  · intro h t ht
    have h1 := h t ht
    rw [norm_smul_one_pow_apply] at h1
    exact le_of_mul_le_mul_right h1 hx'
  · intro h t ht
    rw [norm_smul_one_pow_apply]
    exact mul_le_mul_of_nonneg_right (h t ht) hx'.le

/-- Constant threshold: a mode with `1 ≤ ‖c‖` and `‖c‖^T ≤ τ` is silent through step `T`. -/
theorem silent_const_of_pow_le (c : 𝕜) {τ : ℝ} {T : ℕ} (hc : 1 ≤ ‖c‖) (hT : ‖c‖ ^ T ≤ τ)
    (x : E) : Silent (c • (1 : E →L[𝕜] E)) (fun _ => τ) T x := by
  intro t ht
  rw [norm_smul_one_pow_apply]
  calc ‖c‖ ^ t * ‖x‖ ≤ ‖c‖ ^ T * ‖x‖ :=
        mul_le_mul_of_nonneg_right (pow_le_pow_right₀ hc ht) (norm_nonneg x)
    _ ≤ τ * ‖x‖ := mul_le_mul_of_nonneg_right hT (norm_nonneg x)

/-- **C1, the blind band.** For `T ≥ 1`, `τ ≥ 1` and a scalar with `‖c‖ = τ^(1/T)` (so `‖c‖ ≥ 1`),
the canary with the constant threshold `τ` is silent through step `T` on every trajectory. -/
theorem blind_band (c : 𝕜) {τ : ℝ} {T : ℕ} (hT : T ≠ 0) (hτ : 1 ≤ τ)
    (hc : ‖c‖ = τ ^ ((T : ℝ)⁻¹)) (x : E) : Silent (c • (1 : E →L[𝕜] E)) (fun _ => τ) T x := by
  have h1 : 1 ≤ ‖c‖ := by rw [hc]; exact Real.one_le_rpow hτ (by positivity)
  have h2 : ‖c‖ ^ T = τ := by rw [hc]; exact Real.rpow_inv_natCast_pow (by linarith) hT
  exact silent_const_of_pow_le c h1 h2.le x

/-- The blind band is exactly `‖c‖ ≤ τ^(1/T)`: any faster scalar mode fires at step `T`. -/
theorem blind_band_sharp (c : 𝕜) {τ : ℝ} {T : ℕ} (hT : T ≠ 0) (hτ : 0 ≤ τ)
    (hc : τ ^ ((T : ℝ)⁻¹) < ‖c‖) {x : E} (hx : x ≠ 0) :
    τ * ‖x‖ < ‖((c • (1 : E →L[𝕜] E)) ^ T) x‖ := by
  rw [norm_smul_one_pow_apply]
  have h0 : 0 ≤ τ ^ ((T : ℝ)⁻¹) := Real.rpow_nonneg hτ _
  have h2 : (τ ^ ((T : ℝ)⁻¹)) ^ T = τ := Real.rpow_inv_natCast_pow hτ hT
  have h3 : (τ ^ ((T : ℝ)⁻¹)) ^ T < ‖c‖ ^ T := pow_lt_pow_left₀ hc h0 hT
  rw [h2] at h3
  exact mul_lt_mul_of_pos_right h3 (norm_pos_iff.mpr hx)

/-- The silent mode is unstable when `‖c‖ > 1`: every nonzero trajectory diverges. -/
theorem blind_mode_unstable (c : 𝕜) (hc : 1 < ‖c‖) {x : E} (hx : x ≠ 0) :
    Filter.Tendsto (fun t : ℕ => ‖((c • (1 : E →L[𝕜] E)) ^ t) x‖) Filter.atTop Filter.atTop := by
  simp_rw [norm_smul_one_pow_apply]
  exact Filter.Tendsto.atTop_mul_const (norm_pos_iff.mpr hx) (tendsto_pow_atTop_atTop_of_one_lt hc)

end General

/-! ## The table: certified brackets `lo ≤ ρ_blind < hi`, i.e. `lo^T ≤ τ < hi^T`. -/

-- rho_blind = 1.92007
theorem blind_K1_T4_dimfree : (48/25 : ℝ) ^ 4 ≤ exp 1 * 5 * 1 ∧
    exp 1 * 5 * 1 < (1921/1000 : ℝ) ^ 4 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 8.63786
theorem blind_K1_T4_n2048 : (8637/1000 : ℝ) ^ 4 ≤ exp 1 * 2048 * 1 ∧
    exp 1 * 2048 * 1 < (4319/500 : ℝ) ^ 4 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 1.49131
theorem blind_K1_T8_dimfree : (1491/1000 : ℝ) ^ 8 ≤ exp 1 * 9 * 1 ∧
    exp 1 * 9 * 1 < (373/250 : ℝ) ^ 8 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 2.93902
theorem blind_K1_T8_n2048 : (2939/1000 : ℝ) ^ 8 ≤ exp 1 * 2048 * 1 ∧
    exp 1 * 2048 * 1 < (147/50 : ℝ) ^ 8 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 1.34592
theorem blind_K1_T12_dimfree : (269/200 : ℝ) ^ 12 ≤ exp 1 * 13 * 1 ∧
    exp 1 * 13 * 1 < (673/500 : ℝ) ^ 12 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 2.05180
theorem blind_K1_T12_n2048 : (2051/1000 : ℝ) ^ 12 ≤ exp 1 * 2048 * 1 ∧
    exp 1 * 2048 * 1 < (513/250 : ℝ) ^ 12 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 3.41441
theorem blind_K10_T4_dimfree : (1707/500 : ℝ) ^ 4 ≤ exp 1 * 5 * 10 ∧
    exp 1 * 5 * 10 < (683/200 : ℝ) ^ 4 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 15.36053
theorem blind_K10_T4_n2048 : (384/25 : ℝ) ^ 4 ≤ exp 1 * 2048 * 10 ∧
    exp 1 * 2048 * 10 < (15361/1000 : ℝ) ^ 4 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 1.98869
theorem blind_K10_T8_dimfree : (497/250 : ℝ) ^ 8 ≤ exp 1 * 9 * 10 ∧
    exp 1 * 9 * 10 < (1989/1000 : ℝ) ^ 8 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 3.91925
theorem blind_K10_T8_n2048 : (3919/1000 : ℝ) ^ 8 ≤ exp 1 * 2048 * 10 ∧
    exp 1 * 2048 * 10 < (98/25 : ℝ) ^ 8 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 1.63062
theorem blind_K10_T12_dimfree : (163/100 : ℝ) ^ 12 ≤ exp 1 * 13 * 10 ∧
    exp 1 * 13 * 10 < (1631/1000 : ℝ) ^ 12 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

-- rho_blind = 2.48581
theorem blind_K10_T12_n2048 : (497/200 : ℝ) ^ 12 ≤ exp 1 * 2048 * 10 ∧
    exp 1 * 2048 * 10 < (1243/500 : ℝ) ^ 12 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

/-- An instance of the pipeline: at `T = 4`, `K = 1`, a mode growing `1.92×` per step is silent
under the dimension-free Kreiss threshold `e·5`, in any real normed space. -/
theorem K1_T4_mode_silent {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E] (x : E) :
    Silent ((48/25 : ℝ) • (1 : E →L[ℝ] E)) (fun _ => exp 1 * 5 * 1) 4 x := by
  refine silent_const_of_pow_le _ ?_ ?_ x
  · rw [Real.norm_eq_abs, abs_of_pos (by norm_num)]; norm_num
  · rw [Real.norm_eq_abs, abs_of_pos (by norm_num)]; exact blind_K1_T4_dimfree.1

/-! ## R2: a 20%-per-step mode against `e·n·𝒦` at `n = 2048`. -/

theorem r2_bracket : (6/5 : ℝ) ^ 47 < exp 1 * 2048 ∧ exp 1 * 2048 < (6/5 : ℝ) ^ 48 := by
  have h1 := Real.exp_one_gt_d9
  have h2 := Real.exp_one_lt_d9
  constructor <;> norm_num <;> linarith

/-- Against `τ = e·2048·𝒦` with any `𝒦 ≥ 1`, the `1.2×` mode is silent through step 47. -/
theorem r2_silent_through_47 {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E]
    {K : ℝ} (hK : 1 ≤ K) (x : E) :
    Silent ((6/5 : ℝ) • (1 : E →L[ℝ] E)) (fun _ => exp 1 * 2048 * K) 47 x := by
  have hn : ‖(6/5 : ℝ)‖ = 6/5 := by rw [Real.norm_eq_abs, abs_of_pos (by norm_num)]
  refine silent_const_of_pow_le _ (by rw [hn]; norm_num) ?_ x
  rw [hn]
  have he : 0 < exp 1 * 2048 := by positivity
  calc (6/5 : ℝ) ^ 47 ≤ exp 1 * 2048 := r2_bracket.1.le
    _ = exp 1 * 2048 * 1 := (mul_one _).symm
    _ ≤ exp 1 * 2048 * K := mul_le_mul_of_nonneg_left hK he.le

/-- With `𝒦 = 1` it fires at step 48 on every nonzero start: R2's "47 steps" is 48. -/
theorem r2_fires_at_48 {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E] {x : E}
    (hx : x ≠ 0) :
    exp 1 * 2048 * 1 * ‖x‖ < ‖(((6/5 : ℝ) • (1 : E →L[ℝ] E)) ^ 48) x‖ := by
  rw [norm_smul_one_pow_apply, Real.norm_eq_abs, abs_of_pos (by norm_num : (0:ℝ) < 6/5)]
  have h := r2_bracket.2
  rw [mul_one]
  exact mul_lt_mul_of_pos_right h (norm_pos_iff.mpr hx)

/-- The dimension-free finite-horizon threshold `τ_t = e(t+1)`: the `1.2×` mode stays below it
through step 22 ... -/
theorem r2_dimfree_below (t : ℕ) (ht : t ≤ 22) : (6/5 : ℝ) ^ t ≤ exp 1 * ((t : ℝ) + 1) := by
  have h1 := Real.exp_one_gt_d9
  interval_cases t <;> norm_num <;> linarith

/-- ... and crosses it at step 23. -/
theorem r2_dimfree_cross : exp 1 * ((23 : ℝ) + 1) < (6/5 : ℝ) ^ 23 := by
  have h2 := Real.exp_one_lt_d9
  norm_num
  linarith

/-- So under the time-indexed rule `τ_t = e(t+1)𝒦`, `𝒦 ≥ 1`, the mode is silent through step 22. -/
theorem r2_dimfree_silent {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E]
    {K : ℝ} (hK : 1 ≤ K) (x : E) :
    Silent ((6/5 : ℝ) • (1 : E →L[ℝ] E)) (fun t => exp 1 * ((t : ℝ) + 1) * K) 22 x := by
  have hn : ‖(6/5 : ℝ)‖ = 6/5 := by rw [Real.norm_eq_abs, abs_of_pos (by norm_num)]
  refine silent_of_growth_le _ (by norm_num : (0:ℝ) ≤ 6/5) ?_ _ 22 ?_ x
  · intro y
    rw [ContinuousLinearMap.smul_apply, ContinuousLinearMap.one_apply, norm_smul, hn]
  · intro t ht
    have h0 : 0 ≤ exp 1 * ((t : ℝ) + 1) := by positivity
    calc (6/5 : ℝ) ^ t ≤ exp 1 * ((t : ℝ) + 1) := r2_dimfree_below t ht
      _ = exp 1 * ((t : ℝ) + 1) * 1 := (mul_one _).symm
      _ ≤ exp 1 * ((t : ℝ) + 1) * K := mul_le_mul_of_nonneg_left hK h0

end KreissC

#print axioms KreissC.pow_apply_norm_le
#print axioms KreissC.silent_of_growth_le
#print axioms KreissC.smul_one_pow_apply
#print axioms KreissC.norm_smul_one_pow_apply
#print axioms KreissC.silent_scalar_iff
#print axioms KreissC.silent_const_of_pow_le
#print axioms KreissC.blind_band
#print axioms KreissC.blind_band_sharp
#print axioms KreissC.blind_mode_unstable
#print axioms KreissC.blind_K1_T4_dimfree
#print axioms KreissC.blind_K1_T4_n2048
#print axioms KreissC.blind_K1_T8_dimfree
#print axioms KreissC.blind_K1_T8_n2048
#print axioms KreissC.blind_K1_T12_dimfree
#print axioms KreissC.blind_K1_T12_n2048
#print axioms KreissC.blind_K10_T4_dimfree
#print axioms KreissC.blind_K10_T4_n2048
#print axioms KreissC.blind_K10_T8_dimfree
#print axioms KreissC.blind_K10_T8_n2048
#print axioms KreissC.blind_K10_T12_dimfree
#print axioms KreissC.blind_K10_T12_n2048
#print axioms KreissC.K1_T4_mode_silent
#print axioms KreissC.r2_bracket
#print axioms KreissC.r2_silent_through_47
#print axioms KreissC.r2_fires_at_48
#print axioms KreissC.r2_dimfree_below
#print axioms KreissC.r2_dimfree_cross
#print axioms KreissC.r2_dimfree_silent
