/-
# A global contraction caps a loop's useful depth

Claim 2 of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`,
§1.2.4). `LoopDepthCapThreshold.lean` gives the pass threshold in log form, and
`LoopDepthCapMeasured.lean` the cap from measured residuals alone.

Nothing here is new mathematics: Banach's fixed-point theorem and its a-posteriori bound, Miller &
Hardt's truncation argument (2019) run over depth instead of time, and the discrete Markus–Yamabe
phenomenon, whose polynomial counterexamples in dimension ≥ 3 go back to Cima, van den Essen, Gasull,
Hubbers & Mañosas (1997). The instances are written for the certificate.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopDepthCap.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 25 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Topology.MetricSpace.Contracting
import Mathlib.Analysis.Normed.Group.Basic
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.LinearCombination
import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Ring
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Positivity

/-!
# Claim 2: a global contraction caps useful depth (machine-checked parts)

Setting: `F : X → X` with `dist (F a) (F b) ≤ L * dist a b` (`0 ≤ L < 1`) and a fixed point `p`.
The readout `C` has margin `γ` at `p` (`HasMargin C p γ`).

* 2a (exact): `output_settles`, `cap_contractingWith` (Mathlib's `ContractingWith`/`fixedPoint`).
* 2a as stated is off by one: `ceiling_threshold_fails`.
* 2a (finite precision): `tracking`, `perturbed_fixed`, `additive_error`,
  `perturbed_output_settles`, `settling_certificate_iff`, `perturbed_cap_contractingWith`.
* Stop rule / certified exit: `stop_rule_bound`, `certified_exit`, `certified_exit_exact`.
* 2b quantitative core: `log_depth_suffices`, `log_depth_collapse`.
* 2b, the margin matters: `sign_flips_forever`, `sign_readout_no_margin`.
* 2c (counter direction escapes the cap): `Fc_contracts_u`, `Fc_counter_isometric`,
  `Fc_not_contraction`, `counter_escapes_cap`, `Fc_robust`.
* Premise check (spectral radius < 1 everywhere does not give contraction):
  `MY_orbit`, `MY_not_contraction`, `MY_jacobian_charpoly`.
-/

open NNReal Function

namespace Claim2

section General

variable {X : Type*} [MetricSpace X] {Y : Type*}

/-- `C` has margin `γ` at `p`: it is constant on the open `γ`-ball around `p`. -/
def HasMargin (C : X → Y) (p : X) (γ : ℝ) : Prop :=
  ∀ x, dist x p < γ → C x = C p

/-! ## 2a, exact arithmetic -/

/-- A priori bound: an `L`-Lipschitz self-map with a fixed point `p` brings every orbit
geometrically closer to `p`. (No completeness needed once `p` is given.) -/
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

/-- **2a, corrected.** If `L^k₀ · D < γ` (strict), every pass `k ≥ k₀` already gives the
fixed point's output. -/
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

/-! ## 2a, finite precision -/

/-- **Tracking lemma** (time-varying maps). Each `G k` is `L`-Lipschitz, `x` is an exact orbit
`x (k+1) = G k (x k)`, and `y` is a perturbed orbit with per-pass error at most `δ`. Then
`dist (y k) (x k) ≤ L^k · D + δ/(1-L)`. -/
theorem tracking {G : ℕ → X → X} {L : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1)
    (hG : ∀ k a b, dist (G k a) (G k b) ≤ L * dist a b)
    {x y : ℕ → X} (hx : ∀ k, x (k + 1) = G k (x k)) {δ : ℝ}
    (hy : ∀ k, dist (y (k + 1)) (G k (y k)) ≤ δ) {D : ℝ} (hD : dist (y 0) (x 0) ≤ D) :
    ∀ k, dist (y k) (x k) ≤ L ^ k * D + δ / (1 - L) := by
  have h1L : 0 < 1 - L := sub_pos.mpr hL1
  have hδ : 0 ≤ δ := le_trans dist_nonneg (hy 0)
  have hq : 0 ≤ δ / (1 - L) := div_nonneg hδ h1L.le
  have key : δ + L * (δ / (1 - L)) = δ / (1 - L) := by
    have h : δ / (1 - L) * (1 - L) = δ := div_mul_cancel₀ δ h1L.ne'
    linear_combination -h
  intro k
  induction k with
  | zero =>
    simp only [pow_zero, one_mul]
    linarith
  | succ k ih =>
    calc dist (y (k + 1)) (x (k + 1))
        ≤ dist (y (k + 1)) (G k (y k)) + dist (G k (y k)) (x (k + 1)) := dist_triangle _ _ _
      _ = dist (y (k + 1)) (G k (y k)) + dist (G k (y k)) (G k (x k)) := by rw [hx k]
      _ ≤ δ + L * dist (y k) (x k) := add_le_add (hy k) (hG k _ _)
      _ ≤ δ + L * (L ^ k * D + δ / (1 - L)) := by
          have := mul_le_mul_of_nonneg_left ih hL0
          linarith
      _ = L ^ (k + 1) * D + (δ + L * (δ / (1 - L))) := by ring
      _ = L ^ (k + 1) * D + δ / (1 - L) := by rw [key]

/-- **2a, finite precision.** `d(ỹ_k, p) ≤ L^k · D + δ/(1-L)`. -/
theorem perturbed_fixed {F : X → X} {L : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {y : ℕ → X} {δ : ℝ} (hy : ∀ k, dist (y (k + 1)) (F (y k)) ≤ δ)
    {D : ℝ} (hD : dist (y 0) p ≤ D) :
    ∀ k, dist (y k) p ≤ L ^ k * D + δ / (1 - L) :=
  tracking (G := fun _ => F) (x := fun _ => p) hL0 hL1 (fun _ => hF) (fun _ => hp.symm) hy hD

/-- The additive error model `y (k+1) = F (y k) + err k`, `‖err k‖ ≤ δ`, is a special case. -/
theorem additive_error {E : Type*} [NormedAddCommGroup E] {F : E → E} {y err : ℕ → E} {δ : ℝ}
    (hy : ∀ k, y (k + 1) = F (y k) + err k) (herr : ∀ k, ‖err k‖ ≤ δ) :
    ∀ k, dist (y (k + 1)) (F (y k)) ≤ δ := by
  intro k
  rw [hy k, dist_eq_norm]
  simpa using herr k

/-- **2a, finite precision, outputs settle.** If `L^k₀ · D + δ/(1-L) < γ`, every pass `k ≥ k₀`
gives the fixed point's output. -/
theorem perturbed_output_settles {F : X → X} {L : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C p γ)
    {y : ℕ → X} {δ : ℝ} (hy : ∀ k, dist (y (k + 1)) (F (y k)) ≤ δ)
    {D : ℝ} (hD : dist (y 0) p ≤ D) {k₀ : ℕ} (hk₀ : L ^ k₀ * D + δ / (1 - L) < γ) :
    ∀ k, k₀ ≤ k → C (y k) = C p := by
  intro k hk
  apply hC
  have hD0 : 0 ≤ D := le_trans dist_nonneg hD
  have h1 := perturbed_fixed hL0 hL1 hF hp hy hD k
  have h2 : L ^ k * D ≤ L ^ k₀ * D :=
    mul_le_mul_of_nonneg_right (pow_le_pow_of_le_one hL0 hL1.le hk) hD0
  linarith

/-- The finite-precision certificate is satisfiable for some pass iff `δ/(1-L) < γ`. -/
theorem settling_certificate_iff {L D δ γ : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1) (hD0 : 0 ≤ D) :
    (∃ k₀ : ℕ, L ^ k₀ * D + δ / (1 - L) < γ) ↔ δ / (1 - L) < γ := by
  constructor
  · rintro ⟨k₀, hk⟩
    have : 0 ≤ L ^ k₀ * D := mul_nonneg (pow_nonneg hL0 k₀) hD0
    linarith
  · intro hδγ
    rcases eq_or_lt_of_le hD0 with hD | hD
    · exact ⟨0, by rw [← hD]; simpa using hδγ⟩
    · obtain ⟨k₀, hk⟩ := exists_pow_lt_of_lt_one (div_pos (sub_pos.mpr hδγ) hD) hL1
      refine ⟨k₀, ?_⟩
      have := (lt_div_iff₀ hD).mp hk
      linarith

/-! ## Stop rule (a posteriori bound) and certified exit -/

/-- A posteriori bound behind the stop rule, with per-pass error `δ` (`b` is the computed
next state after `a`): `dist a p ≤ (dist a b + δ)/(1-L)`. -/
theorem stop_rule_bound {F : X → X} {L : ℝ} (hL1 : L < 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {a b : X} {δ : ℝ} (hab : dist b (F a) ≤ δ) :
    dist a p ≤ (dist a b + δ) / (1 - L) := by
  have h1L : 0 < 1 - L := sub_pos.mpr hL1
  rw [le_div_iff₀ h1L]
  have t1 : dist a p ≤ dist a (F a) + dist (F a) p := dist_triangle _ _ _
  have t2 : dist a (F a) ≤ dist a b + dist b (F a) := dist_triangle _ _ _
  have t3 : dist (F a) p ≤ L * dist a p := by
    calc dist (F a) p = dist (F a) (F p) := by rw [hp]
      _ ≤ L * dist a p := hF a p
  linarith

/-- **Certified exit.** If the observed step plus the per-pass error is below `(1-L)·γ`, the
current output already equals the fixed point's output. -/
theorem certified_exit {F : X → X} {L : ℝ} (hL1 : L < 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C p γ) {a b : X} {δ : ℝ} (hab : dist b (F a) ≤ δ)
    (hstop : dist a b + δ < (1 - L) * γ) : C a = C p := by
  apply hC
  have h1L : 0 < 1 - L := sub_pos.mpr hL1
  have h3 : dist a p * (1 - L) ≤ dist a b + δ :=
    (le_div_iff₀ h1L).mp (stop_rule_bound hL1 hF hp hab)
  have h4 : dist a p * (1 - L) < γ * (1 - L) := by linarith
  exact lt_of_mul_lt_mul_right h4 h1L.le

/-- Exact-arithmetic certified exit: `dist h_k h_{k+1} < (1-L)·γ` certifies the output. -/
theorem certified_exit_exact {F : X → X} {L : ℝ} (hL1 : L < 1)
    (hF : ∀ a b, dist (F a) (F b) ≤ L * dist a b) {p : X} (hp : F p = p)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C p γ) {a : X}
    (hstop : dist a (F a) < (1 - L) * γ) : C a = C p :=
  certified_exit hL1 hF hp hC (b := F a) (δ := 0) (by simp) (by simpa using hstop)

/-! ## 2b, quantitative core: polynomial `D/γ` gives `O(log n)` passes -/

/-- With `n ≤ 2^b`, `L^m ≤ 1/2`, `D ≤ n^a` and `γ ≥ n^(-c)` (written `1 ≤ γ · n^c`), the pass
count `k(n) = m·((a+c)·b + 2)` already gives `L^k(n) · D < γ/2`. Here `b = ⌈log₂ n⌉` and
`m = ⌈1/log₂(1/L)⌉`, so `k(n) = O(log n / log(1/L))`. -/
theorem log_depth_suffices {L D γ : ℝ} {n a c b m : ℕ} (hn : 1 ≤ n) (hb : n ≤ 2 ^ b)
    (hL0 : 0 ≤ L) (hm : L ^ m ≤ 1 / 2) (hD0 : 0 ≤ D) (hD : D ≤ (n : ℝ) ^ a)
    (hγ : 1 ≤ γ * (n : ℝ) ^ c) :
    L ^ (m * ((a + c) * b + 2)) * D * 2 < γ := by
  have hN1 : (1 : ℝ) ≤ n := by exact_mod_cast hn
  have hN0 : (0 : ℝ) < n := by linarith
  have hNb : (n : ℝ) ≤ 2 ^ b := by exact_mod_cast hb
  have hq0 : (0 : ℝ) < (1 / 2) ^ b := by positivity
  have hq2 : ((1 : ℝ) / 2) ^ b * 2 ^ b = 1 := by rw [← mul_pow]; norm_num
  have hqN : ((1 : ℝ) / 2) ^ b * n ≤ 1 := by
    calc ((1 : ℝ) / 2) ^ b * n ≤ (1 / 2) ^ b * 2 ^ b := mul_le_mul_of_nonneg_left hNb hq0.le
      _ = 1 := hq2
  have hP : (((1 : ℝ) / 2) ^ b) ^ (a + c) * (n : ℝ) ^ (a + c) ≤ 1 := by
    rw [← mul_pow]; exact pow_le_one₀ (mul_nonneg hq0.le hN0.le) hqN
  have hLt : L ^ (m * ((a + c) * b + 2)) ≤ (((1 : ℝ) / 2) ^ b) ^ (a + c) * (1 / 4) := by
    calc L ^ (m * ((a + c) * b + 2)) = (L ^ m) ^ ((a + c) * b + 2) := pow_mul L m _
      _ ≤ ((1 : ℝ) / 2) ^ ((a + c) * b + 2) := pow_le_pow_left₀ (pow_nonneg hL0 m) hm _
      _ = (((1 : ℝ) / 2) ^ b) ^ (a + c) * (1 / 4) := by
          rw [← pow_mul, mul_comm b (a + c), pow_add]; norm_num
  have hX0 : (0 : ℝ) < (((1 : ℝ) / 2) ^ b) ^ (a + c) * (n : ℝ) ^ a :=
    mul_pos (pow_pos hq0 _) (pow_pos hN0 _)
  have hNc0 : (0 : ℝ) < (n : ℝ) ^ c := pow_pos hN0 _
  have hXγ : (((1 : ℝ) / 2) ^ b) ^ (a + c) * (n : ℝ) ^ a ≤ γ := by
    have h1 : (((1 : ℝ) / 2) ^ b) ^ (a + c) * (n : ℝ) ^ a * (n : ℝ) ^ c ≤ γ * (n : ℝ) ^ c := by
      calc (((1 : ℝ) / 2) ^ b) ^ (a + c) * (n : ℝ) ^ a * (n : ℝ) ^ c
          = (((1 : ℝ) / 2) ^ b) ^ (a + c) * (n : ℝ) ^ (a + c) := by ring
        _ ≤ 1 := hP
        _ ≤ γ * (n : ℝ) ^ c := hγ
    exact le_of_mul_le_mul_right h1 hNc0
  have hLD : L ^ (m * ((a + c) * b + 2)) * D
      ≤ (((1 : ℝ) / 2) ^ b) ^ (a + c) * (1 / 4) * (n : ℝ) ^ a :=
    mul_le_mul hLt hD hD0 (mul_nonneg (pow_nonneg hq0.le _) (by norm_num))
  linarith

/-- **2b, depth collapse (quantitative core).** Uniform `L`-contraction, `D ≤ n^a`,
margin `γ ≥ n^(-c)`, per-pass error `δ ≤ (1-L)·γ/2`: every run of `K ≥ m·((a+c)·b + 2)` passes
outputs `C p`, so all such runs agree with the `m·((a+c)·b + 2)`-pass run. -/
theorem log_depth_collapse {F : X → X} {L : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1)
    (hF : ∀ u v, dist (F u) (F v) ≤ L * dist u v) {p : X} (hp : F p = p)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C p γ)
    {y : ℕ → X} {δ : ℝ} (hy : ∀ k, dist (y (k + 1)) (F (y k)) ≤ δ)
    (hδ : δ ≤ (1 - L) * γ / 2)
    {n a c b m : ℕ} (hn : 1 ≤ n) (hb : n ≤ 2 ^ b) (hm : L ^ m ≤ 1 / 2)
    (hD : dist (y 0) p ≤ (n : ℝ) ^ a) (hγ : 1 ≤ γ * (n : ℝ) ^ c) :
    ∀ K, m * ((a + c) * b + 2) ≤ K → C (y K) = C p := by
  have h1L : 0 < 1 - L := sub_pos.mpr hL1
  have hdepth := log_depth_suffices hn hb hL0 hm dist_nonneg hD hγ
  have hδ' : δ / (1 - L) ≤ γ / 2 := by
    rw [div_le_iff₀ h1L]; linarith
  refine perturbed_output_settles hL0 hL1 hF hp hC hy (le_refl _) ?_
  linarith

section Banach

variable [Nonempty X] [CompleteSpace X]

/-- **2a in Mathlib's setting**: `ContractingWith K F` on a complete space, Banach fixed point
`ContractingWith.fixedPoint F hF`. -/
theorem cap_contractingWith {K : ℝ≥0} {F : X → X} (hF : ContractingWith K F)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C (ContractingWith.fixedPoint F hF) γ)
    {x : X} {D : ℝ} (hD : dist x (ContractingWith.fixedPoint F hF) ≤ D)
    {k₀ : ℕ} (hk₀ : (K : ℝ) ^ k₀ * D < γ) :
    ∀ k, k₀ ≤ k → C (F^[k] x) = C (ContractingWith.fixedPoint F hF) := by
  have hK1 : (K : ℝ) < 1 := by exact_mod_cast hF.1
  exact output_settles K.coe_nonneg hK1.le (fun a b => hF.dist_le_mul a b)
    hF.fixedPoint_isFixedPt.eq hC hD hk₀

/-- **2a, finite precision, in Mathlib's setting.** -/
theorem perturbed_cap_contractingWith {K : ℝ≥0} {F : X → X} (hF : ContractingWith K F)
    {C : X → Y} {γ : ℝ} (hC : HasMargin C (ContractingWith.fixedPoint F hF) γ)
    {y : ℕ → X} {δ : ℝ} (hy : ∀ k, dist (y (k + 1)) (F (y k)) ≤ δ)
    {D : ℝ} (hD : dist (y 0) (ContractingWith.fixedPoint F hF) ≤ D) {k₀ : ℕ}
    (hk₀ : (K : ℝ) ^ k₀ * D + δ / (1 - K) < γ) :
    ∀ k, k₀ ≤ k → C (y k) = C (ContractingWith.fixedPoint F hF) := by
  have hK1 : (K : ℝ) < 1 := by exact_mod_cast hF.1
  exact perturbed_output_settles K.coe_nonneg hK1 (fun a b => hF.dist_le_mul a b)
    hF.fixedPoint_isFixedPt.eq hC hy hD hk₀

end Banach

end General

/-! ## 2a as stated: the ceiling threshold is off by one -/

/-- The map `x ↦ x/2` on `ℝ`. -/
noncomputable def halve (x : ℝ) : ℝ := x / 2

/-- Readout: `0` on the open ball of radius `1/2` about `0`, else `1`. -/
noncomputable def C₀ (x : ℝ) : ℕ := if |x| < 1 / 2 then 0 else 1

theorem halve_lipschitz : ∀ a b : ℝ, dist (halve a) (halve b) ≤ (1 / 2) * dist a b := by
  intro a b
  apply le_of_eq
  rw [Real.dist_eq, Real.dist_eq, show halve a - halve b = (1 / 2) * (a - b) by unfold halve; ring,
    abs_mul, abs_of_pos (by norm_num : (0 : ℝ) < 1 / 2)]

theorem C₀_margin : HasMargin C₀ (0 : ℝ) (1 / 2) := by
  intro x hx
  rw [Real.dist_eq, sub_zero] at hx
  have h0 : |(0 : ℝ)| < 1 / 2 := by rw [abs_zero]; norm_num
  unfold C₀
  rw [if_pos hx, if_pos h0]

/-- **The claimed threshold `k* = ⌈log(D/γ)/log(1/L)⌉` is off by one.** With `L = 1/2`,
`D = 1`, `γ = 1/2` it is `1` (the least `k` with `L^k · D ≤ γ`; see `Claim2Log.ceiling_example`),
and `L^1 · D = γ` exactly, yet the output at pass 1 is not the fixed point's output. -/
theorem ceiling_threshold_fails :
    (∀ a b : ℝ, dist (halve a) (halve b) ≤ (1 / 2) * dist a b) ∧ halve 0 = 0 ∧
    HasMargin C₀ (0 : ℝ) (1 / 2) ∧ dist (1 : ℝ) 0 ≤ 1 ∧
    ((1 : ℝ) / 2) ^ 1 * 1 = 1 / 2 ∧ C₀ (halve^[1] 1) ≠ C₀ 0 := by
  refine ⟨halve_lipschitz, by unfold halve; norm_num, C₀_margin, ?_, by norm_num, ?_⟩
  · rw [Real.dist_eq]; norm_num
  · have h1 : C₀ (halve^[1] 1) = 1 := by
      show (if |(1 : ℝ) / 2| < 1 / 2 then 0 else 1) = 1
      rw [if_neg (by rw [abs_of_pos (by norm_num : (0 : ℝ) < 1 / 2)]; exact lt_irrefl _)]
    have h2 : C₀ 0 = 0 := by
      unfold C₀
      rw [if_pos (by rw [abs_zero]; norm_num)]
    rw [h1, h2]; norm_num

/-! ## 2b: without a margin, outputs need not settle -/

/-- `x ↦ -x/2`: a `1/2`-contraction of `ℝ` with fixed point `0`. -/
noncomputable def Fneg (x : ℝ) : ℝ := -x / 2

theorem Fneg_lipschitz : ∀ a b : ℝ, dist (Fneg a) (Fneg b) ≤ (1 / 2) * dist a b := by
  intro a b
  apply le_of_eq
  rw [Real.dist_eq, Real.dist_eq, show Fneg a - Fneg b = (-(1 / 2)) * (a - b) by unfold Fneg; ring,
    abs_mul, abs_neg, abs_of_pos (by norm_num : (0 : ℝ) < 1 / 2)]

theorem Fneg_fixed : Fneg 0 = 0 := by unfold Fneg; norm_num

theorem Fneg_iterate (k : ℕ) : Fneg^[k] 1 = (-1 / 2 : ℝ) ^ k := by
  induction k with
  | zero => simp
  | succ k ih => rw [iterate_succ_apply', ih]; unfold Fneg; ring

/-- The sign readout flips at every pass, forever. -/
theorem sign_flips_forever (k : ℕ) : (0 < Fneg^[k] 1) ↔ ¬ (0 < Fneg^[k + 1] 1) := by
  rw [Fneg_iterate, Fneg_iterate]
  rcases Nat.even_or_odd k with he | ho
  · have h1 : (0 : ℝ) < (-1 / 2) ^ k := he.pow_pos (by norm_num)
    have h2 : (-1 / 2 : ℝ) ^ (k + 1) < 0 := he.add_one.pow_neg (by norm_num)
    exact ⟨fun _ => not_lt.mpr h2.le, fun _ => h1⟩
  · have h1 : (-1 / 2 : ℝ) ^ k < 0 := ho.pow_neg (by norm_num)
    have h2 : (0 : ℝ) < (-1 / 2) ^ (k + 1) := ho.add_one.pow_pos (by norm_num)
    exact ⟨fun h => absurd h (not_lt.mpr h1.le), fun h => absurd h2 h⟩

/-- The sign readout has no positive margin at the fixed point `0`. -/
theorem sign_readout_no_margin (γ : ℝ) (hγ : 0 < γ) :
    ¬ HasMargin (fun x : ℝ => decide (0 < x)) 0 γ := by
  intro h
  have hpos : 0 < γ / 2 := half_pos hγ
  have hx : dist (γ / 2) 0 < γ := by
    rw [Real.dist_eq, sub_zero, abs_of_pos hpos]; linarith
  have := h (γ / 2) hx
  simp [hpos] at this

/-! ## 2c: a counter direction escapes the cap -/

/-- Target of the contracted coordinate: `-1` while the counter is below `N`, `+1` after. -/
noncomputable def tgt (N : ℕ) (c : ℝ) : ℝ := if c < (N : ℝ) then -1 else 1

/-- Counter loop on `ℝ × ℝ`: `c` counts passes (neutral direction), `u` contracts toward
`tgt N c` at rate `L`. -/
noncomputable def Fc (L : ℝ) (N : ℕ) (h : ℝ × ℝ) : ℝ × ℝ :=
  (h.1 + 1, L * h.2 + (1 - L) * tgt N h.1)

/-- Errors in `u` (off the counter direction) contract by exactly `L` per pass. -/
theorem Fc_contracts_u {L : ℝ} (hL0 : 0 ≤ L) (N : ℕ) (c u u' : ℝ) :
    dist (Fc L N (c, u)).2 (Fc L N (c, u')).2 = L * dist u u' := by
  show dist (L * u + (1 - L) * tgt N c) (L * u' + (1 - L) * tgt N c) = L * dist u u'
  rw [Real.dist_eq, Real.dist_eq,
    show L * u + (1 - L) * tgt N c - (L * u' + (1 - L) * tgt N c) = L * (u - u') by ring,
    abs_mul, abs_of_nonneg hL0]

/-- The counter direction is neutral: distances along it are preserved exactly. -/
theorem Fc_counter_isometric (L : ℝ) (N : ℕ) (h h' : ℝ × ℝ) :
    dist (Fc L N h).1 (Fc L N h').1 = dist h.1 h'.1 := by
  show dist (h.1 + 1) (h'.1 + 1) = dist h.1 h'.1
  rw [Real.dist_eq, Real.dist_eq, show h.1 + 1 - (h'.1 + 1) = h.1 - h'.1 by ring]

theorem Fc_not_contracting_pair (L : ℝ) (N : ℕ) (c c' u : ℝ) :
    dist (c, u) (c', u) ≤ dist (Fc L N (c, u)) (Fc L N (c', u)) := by
  rw [Prod.dist_eq, Prod.dist_eq]
  have h := Fc_counter_isometric L N (c, u) (c', u)
  apply max_le
  · rw [← h]; exact le_max_left _ _
  · refine le_trans ?_ (le_max_left _ _)
    show dist u u ≤ _
    rw [dist_self]; exact dist_nonneg

/-- The counter loop is not a contraction for any constant `K < 1`. -/
theorem Fc_not_contraction (L : ℝ) (N : ℕ) {K : ℝ} (hK : K < 1) :
    ¬ ∀ a b : ℝ × ℝ, dist (Fc L N a) (Fc L N b) ≤ K * dist a b := by
  intro h
  have h1 := h (0, 0) (1, 0)
  have h2 := Fc_not_contracting_pair L N 0 1 0
  have hpos : 0 < dist ((0 : ℝ), (0 : ℝ)) ((1 : ℝ), (0 : ℝ)) := dist_pos.mpr (by simp)
  nlinarith

theorem Fc_iterate_fst (L : ℝ) (N : ℕ) (h : ℝ × ℝ) :
    ∀ k : ℕ, ((Fc L N)^[k] h).1 = h.1 + k := by
  intro k
  induction k with
  | zero => simp
  | succ k ih =>
    rw [iterate_succ_apply']
    show ((Fc L N)^[k] h).1 + 1 = h.1 + ((k + 1 : ℕ) : ℝ)
    rw [ih, Nat.cast_add_one]; ring

theorem Fc_iterate_before (L : ℝ) (N : ℕ) :
    ∀ k, k ≤ N → (Fc L N)^[k] (0, -1) = ((k : ℝ), -1) := by
  intro k
  induction k with
  | zero => intro _; simp
  | succ k ih =>
    intro hk
    rw [iterate_succ_apply', ih (by omega)]
    have ht : tgt N (k : ℝ) = -1 := by
      unfold tgt; exact if_pos (by exact_mod_cast (show k < N by omega))
    refine Prod.ext ?_ ?_
    · show (k : ℝ) + 1 = ((k + 1 : ℕ) : ℝ)
      exact (Nat.cast_add_one k).symm
    · show L * (-1) + (1 - L) * tgt N (k : ℝ) = (-1 : ℝ)
      rw [ht]; ring

theorem Fc_iterate_after (L : ℝ) (N : ℕ) :
    ∀ j, (Fc L N)^[N + j] (0, -1) = (((N + j : ℕ) : ℝ), 1 - 2 * L ^ j) := by
  intro j
  induction j with
  | zero =>
    rw [Nat.add_zero, Fc_iterate_before L N N le_rfl]
    refine Prod.ext rfl ?_
    show (-1 : ℝ) = 1 - 2 * L ^ 0
    ring
  | succ j ih =>
    rw [← Nat.add_assoc, iterate_succ_apply', ih]
    have ht : tgt N ((N + j : ℕ) : ℝ) = 1 := by
      unfold tgt
      exact if_neg (not_lt.mpr (by exact_mod_cast (show N ≤ N + j by omega)))
    refine Prod.ext ?_ ?_
    · show ((N + j : ℕ) : ℝ) + 1 = ((N + j + 1 : ℕ) : ℝ)
      exact (Nat.cast_add_one (N + j)).symm
    · show L * (1 - 2 * L ^ j) + (1 - L) * tgt N ((N + j : ℕ) : ℝ) = 1 - 2 * L ^ (j + 1)
      rw [ht]; ring

/-- **2c.** There is a `j₀` (depending only on `L`) such that for every `N` the sign readout of
the `u` coordinate is negative at every pass `k ≤ N` and positive at pass `N + j₀`. So for every
pass bound there is a run whose output still changes after that bound: no cap. -/
theorem counter_escapes_cap {L : ℝ} (hL1 : L < 1) :
    ∃ j₀ : ℕ, ∀ N : ℕ,
      (∀ k, k ≤ N → ¬ (0 < ((Fc L N)^[k] (0, -1)).2)) ∧
      0 < ((Fc L N)^[N + j₀] (0, -1)).2 := by
  obtain ⟨j₀, hj⟩ := exists_pow_lt_of_lt_one (by norm_num : (0 : ℝ) < 1 / 2) hL1
  refine ⟨j₀, fun N => ⟨?_, ?_⟩⟩
  · intro k hk
    rw [Fc_iterate_before L N k hk]
    show ¬ ((0 : ℝ) < -1)
    norm_num
  · rw [Fc_iterate_after L N j₀]
    show (0 : ℝ) < 1 - 2 * L ^ j₀
    linarith

/-- **2c, robustness.** With an exact counter and per-pass error `δ` in the contracted
coordinate, the computed `u` stays within `L^k · D + δ/(1-L)` of the exact run. -/
theorem Fc_robust {L : ℝ} (hL0 : 0 ≤ L) (hL1 : L < 1) (N : ℕ) {v : ℕ → ℝ} {δ : ℝ}
    (hv : ∀ k : ℕ, dist (v (k + 1)) (L * v k + (1 - L) * tgt N (k : ℝ)) ≤ δ) {D : ℝ}
    (hD : dist (v 0) (-1) ≤ D) :
    ∀ k, dist (v k) ((Fc L N)^[k] (0, -1)).2 ≤ L ^ k * D + δ / (1 - L) := by
  refine tracking (G := fun k u => L * u + (1 - L) * tgt N (k : ℝ))
    (x := fun k => ((Fc L N)^[k] (0, -1)).2) hL0 hL1 ?_ ?_ hv ?_
  · intro k a b
    show dist (L * a + (1 - L) * tgt N (k : ℝ)) (L * b + (1 - L) * tgt N (k : ℝ)) ≤ L * dist a b
    apply le_of_eq
    rw [Real.dist_eq, Real.dist_eq,
      show L * a + (1 - L) * tgt N (k : ℝ) - (L * b + (1 - L) * tgt N (k : ℝ)) = L * (a - b) by
        ring,
      abs_mul, abs_of_nonneg hL0]
  · intro k
    show ((Fc L N)^[k + 1] (0, -1)).2 = L * ((Fc L N)^[k] (0, -1)).2 + (1 - L) * tgt N (k : ℝ)
    rw [iterate_succ_apply']
    show L * ((Fc L N)^[k] (0, -1)).2 + (1 - L) * tgt N ((Fc L N)^[k] (0, -1)).1 = _
    rw [Fc_iterate_fst L N (0, -1) k]
    simp
  · exact hD

/-! ## Premise check: spectral radius `< 1` everywhere does not give a contraction -/

/-- A polynomial map of `ℝ³` (`u = x + y z`):
`MY (x, y, z) = (x/2 + z u², y/2 - u², z/2)`. Its Jacobian is `(1/2)·I + N` with `N` nilpotent
at every point (`MY_jacobian_charpoly`), so its spectral radius is `1/2` everywhere. -/
noncomputable def MY (v : ℝ × ℝ × ℝ) : ℝ × ℝ × ℝ :=
  (v.1 / 2 + v.2.2 * (v.1 + v.2.1 * v.2.2) ^ 2,
   v.2.1 / 2 - (v.1 + v.2.1 * v.2.2) ^ 2,
   v.2.2 / 2)

theorem MY_zero : MY ((0 : ℝ), (0 : ℝ), (0 : ℝ)) = ((0 : ℝ), (0 : ℝ), (0 : ℝ)) := by
  simp [MY]

theorem MY_step (t : ℝ) (ht : t ≠ 0) :
    MY ((147 / 32) * t, (-63 / 32) * t ^ 2, t⁻¹) =
      ((147 / 32) * (2 * t), (-63 / 32) * (2 * t) ^ 2, (2 * t)⁻¹) := by
  have hti : t * t⁻¹ = 1 := mul_inv_cancel₀ ht
  have hu : (147 / 32 : ℝ) * t + (-63 / 32) * t ^ 2 * t⁻¹ = (21 / 8) * t := by
    calc (147 / 32 : ℝ) * t + (-63 / 32) * t ^ 2 * t⁻¹
        = (147 / 32) * t + (-63 / 32) * t * (t * t⁻¹) := by ring
      _ = (21 / 8) * t := by rw [hti]; ring
  refine Prod.ext ?_ (Prod.ext ?_ ?_)
  · show (147 / 32 : ℝ) * t / 2 + t⁻¹ * ((147 / 32) * t + (-63 / 32) * t ^ 2 * t⁻¹) ^ 2
        = (147 / 32) * (2 * t)
    rw [hu]
    calc (147 / 32 : ℝ) * t / 2 + t⁻¹ * ((21 / 8) * t) ^ 2
        = (147 / 32) * t / 2 + (441 / 64) * t * (t * t⁻¹) := by ring
      _ = (147 / 32) * (2 * t) := by rw [hti]; ring
  · show (-63 / 32 : ℝ) * t ^ 2 / 2 - ((147 / 32) * t + (-63 / 32) * t ^ 2 * t⁻¹) ^ 2
        = (-63 / 32) * (2 * t) ^ 2
    rw [hu]; ring
  · show t⁻¹ / 2 = (2 * t)⁻¹
    rw [mul_inv]; ring

/-- The orbit of `(147/32, -63/32, 1)` is `((147/32)·2^k, (-63/32)·4^k, 2^(-k))`: it diverges. -/
theorem MY_orbit (k : ℕ) :
    MY^[k] ((147 / 32 : ℝ), (-63 / 32 : ℝ), (1 : ℝ)) =
      ((147 / 32) * 2 ^ k, (-63 / 32) * ((2 : ℝ) ^ k) ^ 2, ((2 : ℝ) ^ k)⁻¹) := by
  induction k with
  | zero => simp
  | succ k ih =>
    have h2 : (2 : ℝ) ^ (k + 1) = 2 * 2 ^ k := by rw [pow_succ, mul_comm]
    rw [iterate_succ_apply', ih, MY_step _ (pow_ne_zero k two_ne_zero), h2]

/-- `MY` fixes `0` and has spectral radius `1/2` everywhere, yet it is not a contraction for
any constant `K < 1` (in the product metric of `ℝ³`). -/
theorem MY_not_contraction {K : ℝ} (hK0 : 0 ≤ K) (hK1 : K < 1) :
    ¬ ∀ a b : ℝ × ℝ × ℝ, dist (MY a) (MY b) ≤ K * dist a b := by
  intro h
  have hb := dist_iterate_le hK0 h MY_zero ((147 / 32 : ℝ), (-63 / 32 : ℝ), (1 : ℝ))
  obtain ⟨k, hk⟩ := pow_unbounded_of_one_lt
    (dist ((147 / 32 : ℝ), (-63 / 32 : ℝ), (1 : ℝ)) ((0 : ℝ), (0 : ℝ), (0 : ℝ)))
    (one_lt_two : (1 : ℝ) < 2)
  have hpos : (0 : ℝ) < (147 / 32) * 2 ^ k := by positivity
  have h1 : (147 / 32 : ℝ) * 2 ^ k ≤
      dist (MY^[k] ((147 / 32 : ℝ), (-63 / 32 : ℝ), (1 : ℝ))) ((0 : ℝ), (0 : ℝ), (0 : ℝ)) := by
    rw [MY_orbit k, Prod.dist_eq]
    refine le_trans (le_of_eq ?_) (le_max_left _ _)
    show (147 / 32 : ℝ) * 2 ^ k = dist ((147 / 32 : ℝ) * 2 ^ k) 0
    rw [Real.dist_eq, sub_zero, abs_of_pos hpos]
  have h2 : K ^ k ≤ 1 := pow_le_one₀ hK0 hK1.le
  have h3 := hb k
  have h5 : 0 ≤ dist ((147 / 32 : ℝ), (-63 / 32 : ℝ), (1 : ℝ)) ((0 : ℝ), (0 : ℝ), (0 : ℝ)) :=
    dist_nonneg
  have h6 := mul_le_of_le_one_left h5 h2
  have h4 : (0 : ℝ) < 2 ^ k := by positivity
  linarith

/-- Algebra behind "spectral radius `1/2` everywhere". With `u = x + y z`, the hand-computed
Jacobian of `MY` minus `(1/2)·I` is
`N = [[2zu, 2z²u, u² + 2yzu], [-2u, -2zu, -2yu], [0, 0, 0]]`.
Its trace, sum of principal 2×2 minors and determinant all vanish, so its characteristic
polynomial is `t³`: `N` is nilpotent and every eigenvalue of the Jacobian is `1/2`. -/
theorem MY_jacobian_charpoly (x y z : ℝ) :
    (2 * z * (x + y * z)) + (-2 * z * (x + y * z)) + 0 = 0 ∧
    ((2 * z * (x + y * z)) * (-2 * z * (x + y * z))
        - (2 * z ^ 2 * (x + y * z)) * (-2 * (x + y * z)))
      + ((2 * z * (x + y * z)) * 0 - ((x + y * z) ^ 2 + 2 * y * z * (x + y * z)) * 0)
      + ((-2 * z * (x + y * z)) * 0 - (-2 * y * (x + y * z)) * 0) = 0 ∧
    (2 * z * (x + y * z)) * ((-2 * z * (x + y * z)) * 0 - (-2 * y * (x + y * z)) * 0)
      - (2 * z ^ 2 * (x + y * z)) * ((-2 * (x + y * z)) * 0 - (-2 * y * (x + y * z)) * 0)
      + ((x + y * z) ^ 2 + 2 * y * z * (x + y * z))
        * ((-2 * (x + y * z)) * 0 - (-2 * z * (x + y * z)) * 0) = 0 := by
  refine ⟨by ring, by ring, by ring⟩

end Claim2

#print axioms Claim2.dist_iterate_le
#print axioms Claim2.output_settles
#print axioms Claim2.cap_contractingWith
#print axioms Claim2.ceiling_threshold_fails
#print axioms Claim2.tracking
#print axioms Claim2.perturbed_fixed
#print axioms Claim2.additive_error
#print axioms Claim2.perturbed_output_settles
#print axioms Claim2.settling_certificate_iff
#print axioms Claim2.perturbed_cap_contractingWith
#print axioms Claim2.stop_rule_bound
#print axioms Claim2.certified_exit
#print axioms Claim2.certified_exit_exact
#print axioms Claim2.log_depth_suffices
#print axioms Claim2.log_depth_collapse
#print axioms Claim2.sign_flips_forever
#print axioms Claim2.sign_readout_no_margin
#print axioms Claim2.Fc_contracts_u
#print axioms Claim2.Fc_counter_isometric
#print axioms Claim2.Fc_not_contraction
#print axioms Claim2.counter_escapes_cap
#print axioms Claim2.Fc_robust
#print axioms Claim2.MY_orbit
#print axioms Claim2.MY_not_contraction
#print axioms Claim2.MY_jacobian_charpoly
