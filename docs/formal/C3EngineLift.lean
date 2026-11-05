/-
# Theorem C3 at engine level, machine-checked

The Σ₀⁻¹ covariance leg (`src/cio_sde/collapse.py`, `AntiCollapseOperator.excite`) bumps the
predicted covariance along a rank-`m` projector `P`, and the engine then projects with
`CovarianceField.project_preserving_shape` (`src/cio_sde/engine.py`): scale to fit under `σ_max`,
then raise any eigenvalue below `eps` to `eps`. Theorem C3 says the next gate evaluation reads an
anisotropy of at least `ε_a`, so the four-signal gate cannot be true on consecutive steps.

Everything is stated in an abstract real inner-product space `E` with a distinguished element `I`,
`⟪I, I⟫ = n`. For symmetric `n × n` matrices with the Frobenius inner product, `I` is the identity,
`⟪X, I⟫ = tr X`, and `cv` below is the engine's eigenvalue `std / mean` (unbiased std). That
bridge, and the facts that the engine's correction `D` and projector `P` satisfy the hypotheses
used here, are standard spectral identities. They are NOT formalized in this file: they are
checked numerically in `tests/test_sigma0_c3_engine.py`.

What is proven here, with no `sorry` and only Lean's standard axioms:
* L2′, the lift along any projector (`lift`), in the form the code computes its floor.
* Scale invariance (`cv_smul`), so scaling to fit cannot erase the lift.
* The Popoviciu bound for the floor correction (`popoviciu`, `clamp_keeps`).
* The shipped constants: target `1.02·ε_a`, `ε_a = 1/20`, `ρ = n·eps/σ_max ≤ 9·10⁻⁴`, every `n ≥ 2`.
* Rank feasibility of `m ≤ n/(1+4ε²)` (`rank_feasible`).
* The gate is off when `cv ≥ ε_a` (`gate_off`), and the composite `C3_engine`.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/C3EngineLift.lean`. The
expected output is eight lines `'C3.…' depends on axioms: [propext, Classical.choice, Quot.sound]`
and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib

open Real
open scoped RealInnerProductSpace

namespace C3

section Abstract

variable {E : Type*} [NormedAddCommGroup E] [InnerProductSpace ℝ E]

/-- Trace read through the identity: `tr X = ⟪X, I⟫`. -/
noncomputable def tr (I X : E) : ℝ := ⟪X, I⟫

/-- Eigenvalue mean, `tr X / n`. -/
noncomputable def mean (n : ℝ) (I X : E) : ℝ := tr I X / n

/-- The centred part `X − μ(X)·I`. -/
noncomputable def cent (n : ℝ) (I X : E) : E := X - mean n I X • I

/-- Unbiased coefficient of variation, `‖X − μI‖ / (√(n−1)·μ)`: the engine's `std / mean`. -/
noncomputable def cv (n : ℝ) (I X : E) : ℝ := ‖cent n I X‖ / (√(n - 1) * mean n I X)

variable (n : ℝ) (I : E)

theorem tr_add (X Y : E) : tr I (X + Y) = tr I X + tr I Y := by
  simp [tr, inner_add_left]

theorem tr_smul (c : ℝ) (X : E) : tr I (c • X) = c * tr I X := by
  simp [tr, real_inner_smul_left]

theorem mean_add (X Y : E) : mean n I (X + Y) = mean n I X + mean n I Y := by
  simp [mean, tr_add, add_div]

theorem mean_smul (c : ℝ) (X : E) : mean n I (c • X) = c * mean n I X := by
  simp [mean, tr_smul, mul_div_assoc]

theorem cent_add (X Y : E) : cent n I (X + Y) = cent n I X + cent n I Y := by
  simp only [cent, mean_add, add_smul]
  abel

theorem cent_smul (c : ℝ) (X : E) : cent n I (c • X) = c • cent n I X := by
  simp only [cent, mean_smul, smul_sub, mul_smul]

/-- **Scale invariance.** Scaling to fit under the cap leaves the anisotropy exactly unchanged. -/
theorem cv_smul {c : ℝ} (hc : 0 < c) (X : E) : cv n I (c • X) = cv n I X := by
  unfold cv
  rw [cent_smul, mean_smul, norm_smul, Real.norm_of_nonneg hc.le,
    show √(n - 1) * (c * mean n I X) = c * (√(n - 1) * mean n I X) by ring,
    mul_div_mul_left _ _ hc.ne']

theorem cv_nonneg (X : E) (hμ : 0 ≤ mean n I X) : 0 ≤ cv n I X :=
  div_nonneg (norm_nonneg _) (mul_nonneg (Real.sqrt_nonneg _) hμ)

/-- `‖cent X‖² = ‖X‖² − (tr X)²/n`. -/
theorem cent_norm_sq (hn : 0 < n) (hI : ⟪I, I⟫ = n) (X : E) :
    ‖cent n I X‖ ^ 2 = ‖X‖ ^ 2 - tr I X ^ 2 / n := by
  rw [← real_inner_self_eq_norm_sq, ← real_inner_self_eq_norm_sq]
  simp only [cent, mean, tr, inner_sub_left, inner_sub_right, real_inner_smul_left,
    real_inner_smul_right, hI, real_inner_comm I X]
  field_simp
  ring

/-- For a projector-like `P` (`⟪P,P⟫ = ⟪P,I⟫ = k`), `‖P − (k/n)I‖² = k(n−k)/n`. -/
theorem cent_proj_norm_sq (hn : 0 < n) (hI : ⟪I, I⟫ = n) {P : E} {k : ℝ}
    (hPP : ⟪P, P⟫ = k) (hPI : ⟪P, I⟫ = k) :
    ‖cent n I P‖ ^ 2 = k * (n - k) / n := by
  rw [cent_norm_sq n I hn hI, ← real_inner_self_eq_norm_sq, hPP]
  simp only [tr, hPI]
  field_simp

/-- **Lemma L2′ (one-step lift, any projector).** With `S` of positive mean, `P` projector-like
of rank `k`, and a bump `b` with `b·(√(k(n−k)) − εk) ≥ (ε + a(S))·μ(S)·n`, which is the floor
`Δ = (ε+a)μn/(√(k(n−k)) − εk)` that `_cov_floor` computes, the lifted anisotropy is at least `ε`.
No alignment of `P` with `S`, and no normality of anything. -/
theorem lift (hn : 2 ≤ n) (hI : ⟪I, I⟫ = n) {S P : E} {k ε b : ℝ}
    (hPP : ⟪P, P⟫ = k) (hPI : ⟪P, I⟫ = k) (hk0 : 0 ≤ k) (hkn : k ≤ n)
    (hμ : 0 < mean n I S) (hε : 0 ≤ ε) (hb0 : 0 ≤ b)
    (hb : (ε + cv n I S) * mean n I S * n ≤ b * (√(k * (n - k)) - ε * k)) :
    ε ≤ cv n I (S + b • P) := by
  have hn0 : 0 < n := by linarith
  set μ := mean n I S with hμdef
  set a := cv n I S with hadef
  set t := √(n - 1) with htdef
  set sd := √n with hsddef
  set r := √(k * (n - k)) with hrdef
  have ht : 0 < t := Real.sqrt_pos.2 (by linarith)
  have hsd : 0 < sd := Real.sqrt_pos.2 hn0
  have htsd : t ≤ sd := Real.sqrt_le_sqrt (by linarith)
  have hsd2 : sd ^ 2 = n := Real.sq_sqrt hn0.le
  have ha0 : 0 ≤ a := cv_nonneg n I S hμ.le
  -- ‖cent S‖ = a·t·μ
  have hcS : ‖cent n I S‖ = a * (t * μ) := by
    have htμ : 0 < t * μ := mul_pos ht hμ
    rw [hadef]
    unfold cv
    rw [← htdef, ← hμdef, div_mul_cancel₀ _ htμ.ne']
  -- ‖cent P‖ = r / sd
  have hcP : ‖cent n I P‖ = r / sd := by
    have h2 := cent_proj_norm_sq n I hn0 hI hPP hPI
    have hk : 0 ≤ k * (n - k) := mul_nonneg hk0 (by linarith)
    have hsq : √(‖cent n I P‖ ^ 2) = ‖cent n I P‖ := Real.sqrt_sq (norm_nonneg _)
    rw [h2, Real.sqrt_div hk] at hsq
    rw [← hsq]
  -- the mean and centred part of the lifted covariance
  have hmP : mean n I P = k / n := by simp [mean, tr, hPI]
  have hmean : mean n I (S + b • P) = μ + b * (k / n) := by
    rw [mean_add, mean_smul, hmP]
  have hcent : cent n I (S + b • P) = cent n I S + b • cent n I P := by
    rw [cent_add, cent_smul]
  -- reverse triangle inequality
  have hlow : b * (r / sd) - a * (t * μ) ≤ ‖cent n I (S + b • P)‖ := by
    rw [hcent]
    have h1 : ‖b • cent n I P‖ ≤ ‖cent n I S + b • cent n I P‖ + ‖cent n I S‖ := by
      have := norm_sub_le (cent n I S + b • cent n I P) (cent n I S)
      simpa using this
    rw [norm_smul, Real.norm_of_nonneg hb0, hcP, hcS] at h1
    linarith
  -- the arithmetic: ε·t·(μ + b k/n) ≤ b r/sd − a t μ
  have key : ε * (t * (μ + b * (k / n))) ≤ b * (r / sd) - a * (t * μ) := by
    -- (b/sd)(r − εk) ≥ (ε+a)μ·n/sd = (ε+a)μ·sd ≥ (ε+a)μ·t
    have e1 : b * (r - ε * k) / sd ≥ (ε + a) * μ * sd := by
      rw [ge_iff_le, le_div_iff₀ hsd]
      have : (ε + a) * μ * sd * sd = (ε + a) * μ * n := by rw [mul_assoc, ← sq, hsd2]
      rw [this]
      linarith
    have e2 : (ε + a) * μ * t ≤ (ε + a) * μ * sd :=
      mul_le_mul_of_nonneg_left htsd (mul_nonneg (by linarith) hμ.le)
    -- ε t b k/n ≤ ε b k/sd, since t ≤ sd and sd/n = 1/sd
    have e3 : ε * t * b * (k / n) ≤ ε * b * k / sd := by
      have hkn' : k / n = k / (sd * sd) := by rw [← sq, hsd2]
      rw [hkn']
      have hnn : 0 ≤ ε * b * k := mul_nonneg (mul_nonneg hε hb0) hk0
      rw [show ε * t * b * (k / (sd * sd)) = ε * b * k * t / (sd * sd) by ring,
        show ε * b * k / sd = ε * b * k * sd / (sd * sd) by field_simp]
      apply div_le_div_of_nonneg_right _ (by positivity)
      exact mul_le_mul_of_nonneg_left htsd hnn
    have e4 : b * (r / sd) - ε * b * k / sd = b * (r - ε * k) / sd := by ring
    nlinarith [e1, e2, e3, e4]
  -- conclude
  have hpos : 0 < t * (μ + b * (k / n)) := by
    have : 0 ≤ b * (k / n) := mul_nonneg hb0 (div_nonneg hk0 hn0.le)
    exact mul_pos ht (by linarith)
  unfold cv
  rw [hmean, ← htdef, le_div_iff₀ hpos]
  linarith

/-- **Popoviciu, abstractly.** If `‖D‖² ≤ e·tr D` (which holds for a PSD correction whose
eigenvalues lie in `[0, e]`), then `‖cent D‖² ≤ n e²/4`, and `0 ≤ tr D ≤ n e`. -/
theorem popoviciu (hn : 0 < n) (hI : ⟪I, I⟫ = n) {D : E} {e : ℝ} (he : 0 ≤ e)
    (hD : ‖D‖ ^ 2 ≤ e * tr I D) :
    ‖cent n I D‖ ^ 2 ≤ n * e ^ 2 / 4 ∧ 0 ≤ tr I D ∧ tr I D ≤ n * e := by
  have hsq := cent_norm_sq n I hn hI D
  have htr0 : 0 ≤ e * tr I D := le_trans (sq_nonneg _) hD
  -- Cauchy–Schwarz: (tr D)² ≤ ‖D‖²·n
  have hcs : tr I D ^ 2 ≤ ‖D‖ ^ 2 * n := by
    have h := abs_real_inner_le_norm D I
    have hIn : ‖I‖ ^ 2 = n := by rw [← real_inner_self_eq_norm_sq, hI]
    have h2 : |tr I D| ^ 2 ≤ (‖D‖ * ‖I‖) ^ 2 :=
      pow_le_pow_left₀ (abs_nonneg _) h 2
    rw [sq_abs, mul_pow, hIn] at h2
    exact h2
  refine ⟨?_, ?_, ?_⟩
  · rw [hsq]
    have : (tr I D - n * e / 2) ^ 2 / n ≥ 0 := div_nonneg (sq_nonneg _) hn.le
    have expand : e * tr I D - tr I D ^ 2 / n = n * e ^ 2 / 4 - (tr I D - n * e / 2) ^ 2 / n := by
      field_simp
      ring
    linarith
  · rcases he.lt_or_eq with he' | he'
    · exact (mul_nonneg_iff_of_pos_left he').1 htr0
    · -- e = 0: ‖D‖ = 0, so D = 0 and tr D = 0
      subst he'
      have hD0 : ‖D‖ ^ 2 ≤ 0 := by simpa using hD
      have : D = 0 := by
        have := le_antisymm hD0 (sq_nonneg _)
        exact norm_eq_zero.1 (pow_eq_zero_iff (n := 2) (by norm_num) |>.1 this)
      simp [this, tr]
  · -- (tr D)² ≤ n‖D‖² ≤ n e tr D, so tr D ≤ n e
    have h3 : tr I D ^ 2 ≤ n * e * tr I D := by nlinarith
    rcases (le_or_gt (tr I D) 0) with h0 | h0
    · nlinarith
    · nlinarith

/-- **The clamp step.** After scaling, `Y` has `tr Y ≥ σ_max` (its top eigenvalue is `σ_max` and it is
PSD). Raising eigenvalues to the floor adds `D` with `‖D‖² ≤ eps·tr D`. With `ρ = n·eps/σ_max`,
`cv(Y + D) ≥ (a₀ − ½√(n/(n−1))·ρ)/(1+ρ)` whenever `cv Y ≥ a₀ ≥ 0`. -/
theorem clamp_keeps (hn : 2 ≤ n) (hI : ⟪I, I⟫ = n) {Y D : E} {e smax a₀ : ℝ}
    (he : 0 ≤ e) (hsm : 0 < smax) (hY : smax ≤ tr I Y)
    (hD : ‖D‖ ^ 2 ≤ e * tr I D) (ha₀ : 0 ≤ a₀) (ha : a₀ ≤ cv n I Y) :
    (a₀ - 1 / 2 * √(n / (n - 1)) * (n * e / smax)) / (1 + n * e / smax) ≤ cv n I (Y + D) := by
  have hn0 : 0 < n := by linarith
  obtain ⟨hcD, htrD0, htrDn⟩ := popoviciu n I hn0 hI he hD
  set t := √(n - 1) with htdef
  set sd := √n with hsddef
  have ht : 0 < t := Real.sqrt_pos.2 (by linarith)
  have hsd : 0 < sd := Real.sqrt_pos.2 hn0
  have hsd2 : sd ^ 2 = n := Real.sq_sqrt hn0.le
  set μ := mean n I Y with hμdef
  have hμ : smax / n ≤ μ := by
    rw [hμdef, mean]; exact div_le_div_of_nonneg_right hY hn0.le
  have hμ0 : 0 < μ := lt_of_lt_of_le (div_pos hsm hn0) hμ
  -- ‖cent D‖ ≤ sd·e/2
  have hcD' : ‖cent n I D‖ ≤ sd * e / 2 := by
    have h : ‖cent n I D‖ ^ 2 ≤ (sd * e / 2) ^ 2 := by
      have : (sd * e / 2) ^ 2 = n * e ^ 2 / 4 := by rw [div_pow, mul_pow, hsd2]; ring
      rw [this]; exact hcD
    exact (pow_le_pow_iff_left₀ (norm_nonneg _) (by positivity) (by norm_num : (2 : ℕ) ≠ 0)).1 h
  -- cv Y = ‖cent Y‖/(tμ)
  set cY := cv n I Y with hcYdef
  have hcY : ‖cent n I Y‖ = cY * (t * μ) := by
    have htμ : 0 < t * μ := mul_pos ht hμ0
    rw [hcYdef]; unfold cv; rw [← htdef, ← hμdef, div_mul_cancel₀ _ htμ.ne']
  -- numerator and denominator of cv(Y+D)
  have hnum : cY * (t * μ) - sd * e / 2 ≤ ‖cent n I (Y + D)‖ := by
    rw [cent_add]
    have := norm_sub_le (cent n I Y + cent n I D) (cent n I D)
    simp only [add_sub_cancel_right] at this
    linarith
  have hmeanYD : mean n I (Y + D) = μ + tr I D / n := by rw [mean_add]; rfl
  have htrDn' : tr I D / n ≤ e := by rw [div_le_iff₀ hn0]; linarith
  have hden : 0 < t * (μ + tr I D / n) :=
    mul_pos ht (by have := div_nonneg htrD0 hn0.le; linarith)
  -- x = e/μ ≤ ρ
  set ρ := n * e / smax with hρdef
  have hρ0 : 0 ≤ ρ := by positivity
  have hx : e / μ ≤ ρ := by
    rw [hρdef, div_le_div_iff₀ hμ0 hsm]
    have := mul_le_mul_of_nonneg_left hμ (by positivity : 0 ≤ n * e)
    rw [show n * e * (smax / n) = e * smax by field_simp] at this
    linarith
  -- c = sd/(2t) = ½√(n/(n−1))
  have hc : sd / (2 * t) = 1 / 2 * √(n / (n - 1)) := by
    rw [Real.sqrt_div hn0.le]; ring
  set c := sd / (2 * t) with hcdef
  have hc0 : 0 ≤ c := by positivity
  -- cv(Y+D) ≥ (cY·tμ − sd·e/2)/(t(μ+e)) = (cY − c x)/(1 + x)  with x = e/μ
  have step1 : (cY - c * (e / μ)) / (1 + e / μ) ≤ cv n I (Y + D) := by
    unfold cv
    rw [hmeanYD, ← htdef]
    have hle : (cY - c * (e / μ)) / (1 + e / μ)
        = (cY * (t * μ) - sd * e / 2) / (t * (μ + e)) := by
      rw [hcdef]; field_simp
    rw [hle]
    rcases le_or_gt (cY * (t * μ) - sd * e / 2) 0 with hneg | hpos
    · have : (cY * (t * μ) - sd * e / 2) / (t * (μ + e)) ≤ 0 :=
        div_nonpos_of_nonpos_of_nonneg hneg (by positivity)
      exact le_trans this (div_nonneg (norm_nonneg _) hden.le)
    · calc (cY * (t * μ) - sd * e / 2) / (t * (μ + e))
          ≤ (cY * (t * μ) - sd * e / 2) / (t * (μ + tr I D / n)) := by
            apply div_le_div_of_nonneg_left hpos.le hden
            exact mul_le_mul_of_nonneg_left (by linarith) ht.le
        _ ≤ ‖cent n I (Y + D)‖ / (t * (μ + tr I D / n)) :=
            div_le_div_of_nonneg_right hnum hden.le
  -- monotonicity in x and in cY
  have step2 : (a₀ - c * ρ) / (1 + ρ) ≤ (cY - c * (e / μ)) / (1 + e / μ) := by
    have hx0 : 0 ≤ e / μ := div_nonneg he hμ0.le
    rw [div_le_div_iff₀ (by linarith) (by linarith)]
    nlinarith [mul_nonneg (add_nonneg ha₀ hc0) (sub_nonneg.2 hx),
      mul_nonneg (sub_nonneg.2 ha) (by linarith : (0:ℝ) ≤ 1 + ρ)]
  rw [← hc]
  exact le_trans step2 step1

/-- **The shipped constants.** Target `1.02·ε_a` with `ε_a = 1/20`: for every `n ≥ 2` and
`0 ≤ ρ ≤ 9·10⁻⁴`, the post-clamp bound stays at or above `ε_a`. -/
theorem shipped_constants (hn : 2 ≤ n) {ρ : ℝ} (hρ0 : 0 ≤ ρ) (hρ : ρ ≤ 9 / 10000) :
    (1 / 20 : ℝ) ≤ (102 / 100 * (1 / 20) - 1 / 2 * √(n / (n - 1)) * ρ) / (1 + ρ) := by
  have hq : √(n / (n - 1)) ≤ 3 / 2 := by
    rw [Real.sqrt_le_left (by norm_num)]
    rw [div_le_iff₀ (by linarith)]
    nlinarith
  rw [le_div_iff₀ (by linarith)]
  nlinarith [mul_le_mul_of_nonneg_right hq hρ0]

end Abstract

/-- **Rank feasibility.** If `1 ≤ m` and `m(1+4ε²) ≤ n`, the floor's denominator is at least half
of `√(m(n−m))`, hence positive: the floor `Δ` is finite. `_max_lift_rank` enforces this cap. -/
theorem rank_feasible {m n ε : ℝ} (hm : 1 ≤ m) (hcap : m * (1 + 4 * ε ^ 2) ≤ n)
    (hlt : m < n) :
    1 / 2 * √(m * (n - m)) ≤ √(m * (n - m)) - ε * m ∧ 0 < √(m * (n - m)) - ε * m := by
  have hnm : 0 < n - m := by linarith
  have hprod : 0 < m * (n - m) := mul_pos (by linarith) hnm
  have hs : 0 < √(m * (n - m)) := Real.sqrt_pos.2 hprod
  have hkey : 2 * (ε * m) ≤ √(m * (n - m)) := by
    apply Real.le_sqrt_of_sq_le
    nlinarith
  constructor <;> linarith

/-- One gate condition: `clamp(1 − v/θ, 0, 1)`, as in `proximity_per_sample`. -/
noncomputable def below (v θ : ℝ) : ℝ := max 0 (min 1 (1 - v / θ))

theorem below_nonneg (v θ : ℝ) : 0 ≤ below v θ := le_max_left _ _

theorem below_eq_zero {v θ : ℝ} (hθ : 0 < θ) (hv : θ ≤ v) : below v θ = 0 := by
  unfold below
  have : 1 - v / θ ≤ 0 := by rw [sub_nonpos, le_div_iff₀ hθ]; linarith
  exact max_eq_left (le_trans (min_le_right _ _) this)

/-- **The gate is off.** Proximity is the minimum of four non-negative conditions; if the
anisotropy condition reads 0, so does the gate. -/
theorem gate_off {g r a k θg θr θa θk : ℝ} (hθ : 0 < θa) (ha : θa ≤ a) :
    min (below g θg) (min (below r θr) (min (below a θa) (below k θk))) = 0 := by
  rw [below_eq_zero hθ ha]
  have h1 : min 0 (below k θk) = 0 := min_eq_left (below_nonneg _ _)
  rw [h1, min_eq_right (below_nonneg _ _), min_eq_right (below_nonneg _ _)]

section Composite

variable {E : Type*} [NormedAddCommGroup E] [InnerProductSpace ℝ E]

/-- **Theorem C3 (engine level).** The engine fires the covariance leg: `X = Σ_pred + b•P` with
`P` projector-like of rank `k`, `μ(Σ_pred) > 0`, and `b` at least the floor `_cov_floor` computes for
the target `ε' = 1.02·ε_a`. `project_preserving_shape` then returns either `X` itself (no eigenvalue
outside `[eps, σ_max]`) or `c•X + D` (scaled so the top eigenvalue is `σ_max`, then `D` raises
eigenvalues to `eps`). In both cases the next evaluation reads `cv ≥ ε_a = 1/20`, provided
`ρ = n·eps/σ_max ≤ 9·10⁻⁴`, and so the four-signal gate is off. -/
theorem C3_engine (n : ℝ) (I : E) (hn : 2 ≤ n) (hI : ⟪I, I⟫ = n)
    {S P D : E} {k b c e smax : ℝ}
    (hPP : ⟪P, P⟫ = k) (hPI : ⟪P, I⟫ = k) (hk0 : 0 ≤ k) (hkn : k ≤ n)
    (hμ : 0 < mean n I S) (hb0 : 0 ≤ b)
    (hb : (102 / 100 * (1 / 20) + cv n I S) * mean n I S * n
      ≤ b * (√(k * (n - k)) - 102 / 100 * (1 / 20) * k))
    (Snext : E)
    (hproj : Snext = S + b • P ∨
      (0 < c ∧ Snext = c • (S + b • P) + D ∧ smax ≤ tr I (c • (S + b • P)) ∧
        ‖D‖ ^ 2 ≤ e * tr I D ∧ 0 ≤ e ∧ 0 < smax ∧ n * e / smax ≤ 9 / 10000)) :
    (1 / 20 : ℝ) ≤ cv n I Snext ∧
      ∀ g r kk θg θr θk : ℝ,
        min (below g θg) (min (below r θr) (min (below (cv n I Snext) (1 / 20)) (below kk θk))) = 0 := by
  have hlift := lift n I hn hI hPP hPI hk0 hkn hμ (by norm_num) hb0 hb
  have hmain : (1 / 20 : ℝ) ≤ cv n I Snext := by
    rcases hproj with h | ⟨hc, hS, hY, hD, he, hsm, hρ⟩
    · rw [h]; linarith
    · rw [hS]
      have hcv : 102 / 100 * (1 / 20) ≤ cv n I (c • (S + b • P)) := by
        rw [cv_smul n I hc]; exact hlift
      have hk := clamp_keeps n I hn hI he hsm hY hD (by norm_num) hcv
      have hc' := shipped_constants n hn (by positivity) hρ
      linarith
  exact ⟨hmain, fun g r kk θg θr θk => gate_off (by norm_num) hmain⟩

end Composite

end C3

#print axioms C3.lift
#print axioms C3.cv_smul
#print axioms C3.popoviciu
#print axioms C3.clamp_keeps
#print axioms C3.shipped_constants
#print axioms C3.rank_feasible
#print axioms C3.gate_off
#print axioms C3.C3_engine
