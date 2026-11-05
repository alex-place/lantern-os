/-
# Token-level routing of recursive experts

Formal stability theory for a looped mixture-of-experts model: which routing schemes
are safe, under exactly which per-expert certificates ("receipts"), and where they fail.

Everything is about abstract maps on a metric space. Nothing here says who wrote an
expert (training, WSP, or anything else), nor that any real network meets a hypothesis.
`X` can be an invariant region of hidden states, as a subtype. An index `ι` can pair an
expert with its token context, in which case a receipt must hold uniformly over contexts.
-/
import Mathlib

open Filter Topology

namespace TokenRouting

/-! ## Core definitions -/

section Core

variable {X : Type*} [PseudoMetricSpace X]

/-- `f` is `κ`-Lipschitz. The measurable certificate an expert has to carry. -/
def LipBound (κ : ℝ) (f : X → X) : Prop :=
  ∀ x y, dist (f x) (f y) ≤ κ * dist x y

/-- Run a time-varying sequence of maps from `x`. -/
def run (g : ℕ → X → X) (x : X) : ℕ → X
  | 0 => x
  | t + 1 => g t (run g x t)

/-- Per-token routing: token `t` uses expert `σ t` for `R t` recursive steps, unswitched. -/
def token {ι : Type*} (f : ι → X → X) (σ : ℕ → ι) (R : ℕ → ℕ) : ℕ → X → X :=
  fun t => (f (σ t))^[R t]

/-- The per-expert receipt: every recursion depth from `τ` up is `θ`-Lipschitz. -/
def DepthReceipt (θ : ℝ) (τ : ℕ) (f : X → X) : Prop :=
  ∀ n, τ ≤ n → LipBound θ f^[n]

theorem run_contract {θ : ℝ} (hθ : 0 ≤ θ) {g : ℕ → X → X}
    (h : ∀ t, LipBound θ (g t)) (x y : X) (t : ℕ) :
    dist (run g x t) (run g y t) ≤ θ ^ t * dist x y := by
  induction t with
  | zero => simp [run]
  | succ t ih =>
    calc dist (run g x (t + 1)) (run g y (t + 1))
        ≤ θ * dist (run g x t) (run g y t) := h t _ _
      _ ≤ θ * (θ ^ t * dist x y) := by gcongr
      _ = θ ^ (t + 1) * dist x y := by ring

theorem LipBound.iterate {κ : ℝ} (hκ : 0 ≤ κ) {f : X → X} (h : LipBound κ f) (n : ℕ) :
    LipBound (κ ^ n) f^[n] := by
  induction n with
  | zero => intro x y; simp
  | succ n ih =>
    intro x y
    rw [Function.iterate_succ_apply', Function.iterate_succ_apply']
    calc dist (f (f^[n] x)) (f (f^[n] y))
        ≤ κ * dist (f^[n] x) (f^[n] y) := h _ _
      _ ≤ κ * (κ ^ n * dist x y) := by gcongr; exact ih x y
      _ = κ ^ (n + 1) * dist x y := by ring

/-! ## Theorem 1: a common metric permits arbitrary switching -/

/-- **T1.** If every expert contracts in one shared metric, *any* step-level routing is
incrementally stable, with no dwell-time condition. -/
theorem common_metric_arbitrary_switching {ι : Type*} {κ : ℝ} (hκ : 0 ≤ κ)
    {f : ι → X → X} (h : ∀ i, LipBound κ (f i)) (σ : ℕ → ι) (x y : X) (t : ℕ) :
    dist (run (fun t => f (σ t)) x t) (run (fun t => f (σ t)) y t) ≤ κ ^ t * dist x y :=
  run_contract hκ (fun t => h (σ t)) x y t

/-! ## Theorem 2: per-token routing needs only one receipt per expert -/

/-- **T2.** One depth receipt per expert certifies every route and every per-token depth
schedule with `R t ≥ τ`. The experts need no shared metric across their single steps. -/
theorem token_routing_stable {ι : Type*} {θ : ℝ} {τ : ℕ} (hθ : 0 ≤ θ)
    {f : ι → X → X} (h : ∀ i, DepthReceipt θ τ (f i))
    (σ : ℕ → ι) (R : ℕ → ℕ) (hR : ∀ t, τ ≤ R t) (x y : X) (t : ℕ) :
    dist (run (token f σ R) x t) (run (token f σ R) y t) ≤ θ ^ t * dist x y :=
  run_contract hθ (fun t => h (σ t) (R t) (hR t)) x y t

/-- With `θ < 1` the two runs converge together. -/
theorem token_routing_converges {ι : Type*} {θ : ℝ} {τ : ℕ} (hθ : 0 ≤ θ) (hθ1 : θ < 1)
    {f : ι → X → X} (h : ∀ i, DepthReceipt θ τ (f i))
    (σ : ℕ → ι) (R : ℕ → ℕ) (hR : ∀ t, τ ≤ R t) (x y : X) :
    Tendsto (fun t => dist (run (token f σ R) x t) (run (token f σ R) y t)) atTop (𝓝 0) := by
  have hpow : Tendsto (fun t : ℕ => θ ^ t * dist x y) atTop (𝓝 0) := by
    simpa using (tendsto_pow_atTop_nhds_zero_of_lt_one hθ hθ1).mul_const (dist x y)
  exact squeeze_zero (fun _ => dist_nonneg)
    (fun t => token_routing_stable hθ h σ R hR x y t) hpow

/-- A contraction in a common metric gives a depth receipt from depth 1 on, so T2 covers T1. -/
theorem common_metric_gives_receipt {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ ≤ 1) {f : X → X}
    (h : LipBound κ f) : DepthReceipt κ 1 f := by
  intro n hn x y
  have hp : κ ^ n ≤ κ := by
    calc κ ^ n ≤ κ ^ 1 := pow_le_pow_of_le_one hκ hκ1 hn
      _ = κ := pow_one κ
  calc dist (f^[n] x) (f^[n] y) ≤ κ ^ n * dist x y := h.iterate hκ n x y
    _ ≤ κ * dist x y := by gcongr

/-- Adding an expert needs only that expert's receipt: the others are not re-certified. -/
theorem receipts_compose {ι : Type*} {θ : ℝ} {τ : ℕ} {f : ι → X → X} {new : X → X}
    (h : ∀ i, DepthReceipt θ τ (f i)) (hnew : DepthReceipt θ τ new) :
    ∀ o : Option ι, DepthReceipt θ τ (fun x => o.elim (new x) (fun i => f i x)) := by
  intro o
  cases o with
  | none => exact hnew
  | some i => exact h i

/-- Certifying every step-level path means `E ^ R` objects; per-token routing needs `E`. -/
theorem path_count (E R : ℕ) : Fintype.card (Fin R → Fin E) = E ^ R := by
  simp

/-! ## Theorem 4: a state-dependent router -/

/-- **T4.** Stay-bounded guarantee for *any* router, even one reading the hidden state.
With `κ`-contractive experts whose fixed points lie within `r` of `c`, the state stays
within the fixed radius below once the transient decays. -/
theorem adaptive_router_bounded {ι : Type*} {κ r : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1)
    {f : ι → X → X} {p : ι → X} {c : X}
    (hf : ∀ i, LipBound κ (f i)) (hp : ∀ i, f i (p i) = p i) (hr : ∀ i, dist (p i) c ≤ r)
    (route : X → ι) (x : X) (t : ℕ) :
    dist (run (fun _ z => f (route z) z) x t) c
      ≤ κ ^ t * dist x c + (1 + κ) * r / (1 - κ) := by
  have h1 : 0 < 1 - κ := by linarith
  have step : ∀ z, dist (f (route z) z) c ≤ κ * dist z c + (1 + κ) * r := by
    intro z
    have a := hf (route z) z (p (route z))
    rw [hp] at a
    have b := dist_triangle (f (route z) z) (p (route z)) c
    have d := dist_triangle z c (p (route z))
    have e := hr (route z)
    have e' : dist c (p (route z)) ≤ r := by rwa [dist_comm]
    have : κ * dist z (p (route z)) ≤ κ * (dist z c + r) := by
      apply mul_le_mul_of_nonneg_left _ hκ
      linarith
    nlinarith
  have hrnn : 0 ≤ (1 + κ) * r / (1 - κ) := by
    have : ∃ i : ι, True := ⟨route x, trivial⟩
    obtain ⟨i, -⟩ := this
    have : 0 ≤ r := dist_nonneg.trans (hr i)
    positivity
  induction t with
  | zero => simpa [run] using hrnn
  | succ t ih =>
    show dist (f (route _) _) c ≤ _
    refine (step _).trans ?_
    have key : (1 + κ) * r = (1 - κ) * ((1 + κ) * r / (1 - κ)) := by field_simp
    have := mul_le_mul_of_nonneg_left ih hκ
    rw [pow_succ]
    nlinarith

/-- **T5.** That boundedness is all a state-reading hard router keeps. Two `1/2`-contractions
routed by the sign of the state have two distinct fixed points, so the routed map is not a
contraction, whatever each expert's receipt says. -/
theorem hard_state_router_breaks_uniqueness :
    ∃ (f : Bool → ℝ → ℝ) (route : ℝ → Bool),
      (∀ i, LipBound (1 / 2) (f i)) ∧
      (∀ x, f (route x) x = x → x = 2 ∨ x = -2) ∧
      f (route 2) 2 = 2 ∧ f (route (-2)) (-2) = -2 ∧
      ¬ ∃ κ : ℝ, κ < 1 ∧ LipBound κ (fun x => f (route x) x) := by
  refine ⟨fun b x => if b then x / 2 + 1 else x / 2 - 1, fun x => decide (0 ≤ x), ?_, ?_, ?_, ?_, ?_⟩
  · intro i x y
    cases i <;> simp only [Bool.false_eq_true, if_true, if_false, Real.dist_eq] <;>
    · have : x / 2 + 1 - (y / 2 + 1) = (x - y) / 2 := by ring
      have h2 : x / 2 - 1 - (y / 2 - 1) = (x - y) / 2 := by ring
      first
        | rw [this, abs_div]; norm_num; linarith
        | rw [h2, abs_div]; norm_num; linarith
  · intro x hx
    by_cases h : 0 ≤ x
    · simp [h] at hx
      left; linarith
    · simp [h] at hx
      right; linarith
  · norm_num
  · norm_num
  · rintro ⟨κ, hκ, hL⟩
    have h := hL 2 (-2)
    norm_num [Real.dist_eq] at h
    linarith

/-! ## Theorem 6: when "convergence" is a valid exit signal -/

/-- **T6a.** With a contraction receipt, a small step is a certified error bound. -/
theorem certified_exit {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1) {f : X → X} {p x : X}
    (hf : LipBound κ f) (hp : f p = p) :
    dist (f x) p ≤ κ / (1 - κ) * dist x (f x) := by
  have h1 : 0 < 1 - κ := by linarith
  have a : dist (f x) p ≤ κ * dist x p := by simpa [hp] using hf x p
  have b := dist_triangle x (f x) p
  have c : (1 - κ) * dist x p ≤ dist x (f x) := by nlinarith
  rw [div_mul_eq_mul_div, le_div_iff₀ h1]
  nlinarith [mul_le_mul_of_nonneg_left c hκ]

/-- **T6b.** With a contraction receipt the exit signal always fires. -/
theorem exit_fires {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1) {f : X → X} (hf : LipBound κ f)
    (x : X) {ε : ℝ} (hε : 0 < ε) : ∃ n, dist (f^[n] x) (f (f^[n] x)) ≤ ε := by
  have hb : ∀ n, dist (f^[n] x) (f (f^[n] x)) ≤ κ ^ n * dist x (f x) := by
    intro n
    have := (hf.iterate hκ n) x (f x)
    rwa [← Function.iterate_succ_apply' f n x, Function.iterate_succ_apply f n x] at *
  have hpow : Tendsto (fun n : ℕ => κ ^ n * dist x (f x)) atTop (𝓝 0) := by
    simpa using (tendsto_pow_atTop_nhds_zero_of_lt_one hκ hκ1).mul_const (dist x (f x))
  obtain ⟨n, hn⟩ := ((tendsto_order.1 hpow).2 ε hε).exists
  exact ⟨n, (hb n).trans hn.le⟩

/-- **T9, the mixture-of-recursion theorem.** Each token, a router reading the token-start
state picks an expert, which is then frozen for that token, and recursion runs to a
state-dependent depth `N`, stopping when the step is at most `ε`. Then:
a valid `N` exists, and every token's output lies within `κ / (1 - κ) * ε` of the fixed point
of the expert chosen for it, from any start and with no dwell condition.
This covers depth varying per token by state, which T2's shared schedule does not. To use a
depth receipt instead of a one-step contraction, take `f i` to be `τ` steps of the expert. -/
theorem mixture_of_recursion {ι : Type*} {κ ε : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1) (hε : 0 < ε)
    {f : ι → X → X} {p : ι → X}
    (hf : ∀ i, LipBound κ (f i)) (hp : ∀ i, f i (p i) = p i) (route : ℕ → X → ι) :
    ∃ N : ι → X → ℕ,
      (∀ i z, dist ((f i)^[N i z] z) (f i ((f i)^[N i z] z)) ≤ ε) ∧
      ∀ (x : X) (t : ℕ),
        let g : ℕ → X → X := fun s z =>
          f (route s z) ((f (route s z))^[N (route s z) z] z)
        dist (run g x (t + 1)) (p (route t (run g x t))) ≤ κ / (1 - κ) * ε := by
  have hex : ∀ i z, ∃ n, dist ((f i)^[n] z) (f i ((f i)^[n] z)) ≤ ε :=
    fun i z => exit_fires hκ hκ1 (hf i) z hε
  choose N hN using hex
  refine ⟨N, hN, ?_⟩
  intro x t g
  set z := run g x t
  set i := route t z
  have h1 : 0 < 1 - κ := by linarith
  have hc := certified_exit (x := (f i)^[N i z] z) hκ hκ1 (hf i) (hp i)
  refine hc.trans ?_
  exact mul_le_mul_of_nonneg_left (hN i z) (div_nonneg hκ h1.le)

/-- Two runs on the same chosen expert agree to `2 * κ / (1 - κ) * ε`, whatever their starts
and however different their exit depths were. -/
theorem adaptive_exit_agreement {κ ε : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1)
    {f : X → X} {p : X} (hf : LipBound κ f) (hp : f p = p) {u v : X}
    (hu : dist u (f u) ≤ ε) (hv : dist v (f v) ≤ ε) :
    dist (f u) (f v) ≤ 2 * (κ / (1 - κ) * ε) := by
  have h1 : 0 < 1 - κ := by linarith
  have hq : 0 ≤ κ / (1 - κ) := div_nonneg hκ h1.le
  have a := (certified_exit (x := u) hκ hκ1 hf hp).trans (mul_le_mul_of_nonneg_left hu hq)
  have b := (certified_exit (x := v) hκ hκ1 hf hp).trans (mul_le_mul_of_nonneg_left hv hq)
  have c := dist_triangle_right (f u) (f v) p
  linarith

/-- **T7.** Blast radius of an edit: if `f'` differs from a `κ`-contraction `f` by at most `δ`
at its own fixed point, the fixed point moves at most `δ / (1 - κ)`. -/
theorem edit_blast_radius {κ δ : ℝ} (hκ1 : κ < 1) {f f' : X → X} {p p' : X}
    (hf : LipBound κ f) (hp : f p = p) (hp' : f' p' = p') (hδ : dist (f p') (f' p') ≤ δ) :
    dist p p' ≤ δ / (1 - κ) := by
  have h1 : 0 < 1 - κ := by linarith
  rw [le_div_iff₀ h1]
  have a : dist p p' ≤ dist (f p) (f p') + dist (f p') (f' p') := by
    conv_lhs => rw [← hp, ← hp']
    rw [hp]
    have := dist_triangle p (f p') (f' p')
    simpa [hp'] using this
  have b := hf p p'
  nlinarith

end Core

/-- **T6c.** Without a contraction receipt, settling proves nothing: for any constant `C`
there is a map with a fixed point, Lipschitz constant at most 2, whose step size understates
the distance to that fixed point by more than a factor of `C`. -/
theorem settling_without_receipt_is_uninformative (C : ℝ) (hC : 0 < C) :
    ∃ f : ℝ → ℝ, f 0 = 0 ∧ LipBound 2 f ∧ ∃ x, C * dist x (f x) < dist x 0 := by
  have hη : 0 < 1 / (C + 1) := by positivity
  have hη1 : 1 / (C + 1) ≤ 1 := by
    rw [div_le_one (by positivity)]; linarith
  refine ⟨fun x => (1 + 1 / (C + 1)) * x, by simp, ?_, 1, ?_⟩
  · intro x y
    simp only [Real.dist_eq]
    have : (1 + 1 / (C + 1)) * x - (1 + 1 / (C + 1)) * y = (1 + 1 / (C + 1)) * (x - y) := by ring
    rw [this, abs_mul, abs_of_pos (by positivity)]
    apply mul_le_mul_of_nonneg_right _ (abs_nonneg _)
    linarith
  · simp only [Real.dist_eq, mul_one, sub_zero, abs_one]
    have : (1 : ℝ) - (1 + 1 / (C + 1)) = -(1 / (C + 1)) := by ring
    rw [this, abs_neg, abs_of_pos hη, mul_one_div, div_lt_one (by positivity)]
    linarith

/-! ## Theorem 8: soft mixtures and the router's Lipschitz budget -/

section Soft

variable {E : Type*} [SeminormedAddCommGroup E] [NormedSpace ℝ E] {ι : Type*} [Fintype ι]

/-- **T8.** A soft mixture driven by a state-reading router, `F x = Σ wᵢ(x) fᵢ(x)`, stays
Lipschitz with constant `κ + |ι|·L·B`. So a mixture of contractions is itself a contraction
when `κ + |ι|·L·B < 1`, which is an explicit smoothness budget for the router. On region `S`:
weights are a partition of unity, each `L`-Lipschitz, and experts are bounded by `B`. -/
theorem soft_mixture_lipschitz {S : Set E} {κ L B : ℝ} (hL : 0 ≤ L)
    {f : ι → E → E} {w : ι → E → ℝ}
    (hf : ∀ i, ∀ x ∈ S, ∀ y ∈ S, ‖f i x - f i y‖ ≤ κ * ‖x - y‖)
    (hw0 : ∀ i, ∀ x ∈ S, 0 ≤ w i x)
    (hw1 : ∀ x ∈ S, ∑ i, w i x = 1)
    (hwL : ∀ i, ∀ x ∈ S, ∀ y ∈ S, |w i x - w i y| ≤ L * ‖x - y‖)
    (hfB : ∀ i, ∀ y ∈ S, ‖f i y‖ ≤ B)
    {x y : E} (hx : x ∈ S) (hy : y ∈ S) :
    ‖∑ i, w i x • f i x - ∑ i, w i y • f i y‖
      ≤ (κ + Fintype.card ι * L * B) * ‖x - y‖ := by
  have split : ∑ i, w i x • f i x - ∑ i, w i y • f i y
      = ∑ i, (w i x • (f i x - f i y) + (w i x - w i y) • f i y) := by
    rw [← Finset.sum_sub_distrib]
    refine Finset.sum_congr rfl fun i _ => ?_
    rw [smul_sub, sub_smul]
    abel
  rw [split]
  have term : ∀ i, ‖w i x • (f i x - f i y) + (w i x - w i y) • f i y‖
      ≤ w i x * (κ * ‖x - y‖) + L * ‖x - y‖ * B := by
    intro i
    refine (norm_add_le _ _).trans (add_le_add ?_ ?_)
    · rw [norm_smul, Real.norm_of_nonneg (hw0 i x hx)]
      exact mul_le_mul_of_nonneg_left (hf i x hx y hy) (hw0 i x hx)
    · rw [norm_smul, Real.norm_eq_abs]
      exact mul_le_mul (hwL i x hx y hy) (hfB i y hy) (norm_nonneg _)
        (mul_nonneg hL (norm_nonneg _))
  calc ‖∑ i, (w i x • (f i x - f i y) + (w i x - w i y) • f i y)‖
      ≤ ∑ i, ‖w i x • (f i x - f i y) + (w i x - w i y) • f i y‖ := norm_sum_le _ _
    _ ≤ ∑ i, (w i x * (κ * ‖x - y‖) + L * ‖x - y‖ * B) :=
        Finset.sum_le_sum fun i _ => term i
    _ = (κ + Fintype.card ι * L * B) * ‖x - y‖ := by
        rw [Finset.sum_add_distrib, ← Finset.sum_mul, hw1 x hx]
        simp only [Finset.sum_const, Finset.card_univ, nsmul_eq_mul]
        ring

/-- Under the T8 budget the mixture has at most one fixed point in the region. -/
theorem soft_mixture_unique_fixed_point {S : Set E} {κ L B : ℝ}
    (hL : 0 ≤ L)
    (hbudget : κ + Fintype.card ι * L * B < 1)
    {f : ι → E → E} {w : ι → E → ℝ}
    (hf : ∀ i, ∀ x ∈ S, ∀ y ∈ S, ‖f i x - f i y‖ ≤ κ * ‖x - y‖)
    (hw0 : ∀ i, ∀ x ∈ S, 0 ≤ w i x)
    (hw1 : ∀ x ∈ S, ∑ i, w i x = 1)
    (hwL : ∀ i, ∀ x ∈ S, ∀ y ∈ S, |w i x - w i y| ≤ L * ‖x - y‖)
    (hfB : ∀ i, ∀ y ∈ S, ‖f i y‖ ≤ B)
    {x y : E} (hx : x ∈ S) (hy : y ∈ S)
    (hfx : ∑ i, w i x • f i x = x) (hfy : ∑ i, w i y • f i y = y) :
    ‖x - y‖ = 0 := by
  have h := soft_mixture_lipschitz hL hf hw0 hw1 hwL hfB hx hy
  rw [hfx, hfy] at h
  have hn := norm_nonneg (x - y)
  nlinarith

end Soft

/-- **T8, non-vacuity.** The T8 budget is satisfiable by a genuinely state-reading router, on
the very experts of T5. On `[-2, 2]`, the weights `1/2 ± x/16` give constant `3/4 < 1`.
So the hard router (two fixed points, T5) and this soft one differ only in router smoothness. -/
theorem soft_router_repairs_hard_router {x y : ℝ} (hx : x ∈ Set.Icc (-2 : ℝ) 2)
    (hy : y ∈ Set.Icc (-2 : ℝ) 2) :
    let f : Bool → ℝ → ℝ := fun b z => if b then z / 2 + 1 else z / 2 - 1
    let w : Bool → ℝ → ℝ := fun b z => if b then 1 / 2 + z / 16 else 1 / 2 - z / 16
    ‖∑ i, w i x • f i x - ∑ i, w i y • f i y‖ ≤ (3 / 4 : ℝ) * ‖x - y‖ := by
  intro f w
  have hmain := soft_mixture_lipschitz (S := Set.Icc (-2 : ℝ) 2) (κ := 1 / 2) (L := 1 / 16) (B := 2)
    (f := f) (w := w) (by norm_num) ?_ ?_ ?_ ?_ ?_ hx hy
  · have hcard : (Fintype.card Bool : ℝ) = 2 := by simp
    rw [hcard] at hmain
    norm_num at hmain ⊢
    linarith
  · intro i a _ b _
    cases i <;> simp only [f, Bool.false_eq_true, if_true, if_false, Real.norm_eq_abs] <;>
    · have e1 : a / 2 + 1 - (b / 2 + 1) = (a - b) / 2 := by ring
      have e2 : a / 2 - 1 - (b / 2 - 1) = (a - b) / 2 := by ring
      first
        | rw [e1, abs_div]; norm_num; linarith
        | rw [e2, abs_div]; norm_num; linarith
  · intro i a ha
    obtain ⟨h1, h2⟩ := ha
    cases i <;> simp only [w, Bool.false_eq_true, if_true, if_false] <;> linarith
  · intro a _
    simp only [Fintype.sum_bool, w, if_true, Bool.false_eq_true, if_false]
    ring
  · intro i a _ b _
    cases i <;> simp only [w, Bool.false_eq_true, if_true, if_false, Real.norm_eq_abs]
    · have e : 1 / 2 - a / 16 - (1 / 2 - b / 16) = -((a - b) / 16) := by ring
      rw [e, abs_neg, abs_div]; norm_num; linarith
    · have e : 1 / 2 + a / 16 - (1 / 2 + b / 16) = (a - b) / 16 := by ring
      rw [e, abs_div]; norm_num; linarith
  · intro i a ha
    obtain ⟨h1, h2⟩ := ha
    cases i <;> simp only [f, Bool.false_eq_true, if_true, if_false, Real.norm_eq_abs] <;>
      rw [abs_le] <;> constructor <;> linarith

/-! ## Theorem 3: the separation

Two experts on `ℝ²` with the sup metric. Each is stable alone. Per-step switching diverges;
so does per-token switching at any depth from 1 to 4; at depth 5 or more every route contracts.
So the receipts `ρ < 1` per expert do not suffice for step-level routing, and depth is the
parameter that decides it. The depth 5 is a property of this constructed example only. -/

section Separation

noncomputable def A₁ (p : ℝ × ℝ) : ℝ × ℝ := (p.1 / 2 + 2 * p.2, p.2 / 2)
noncomputable def A₂ (p : ℝ × ℝ) : ℝ × ℝ := (p.1 / 2, 2 * p.1 + p.2 / 2)

/-- The two experts, indexed. -/
noncomputable def expert : Bool → ℝ × ℝ → ℝ × ℝ
  | false => A₁
  | true => A₂

noncomputable def a (n : ℕ) : ℝ := (1 / 2 : ℝ) ^ n
noncomputable def c (n : ℕ) : ℝ := 4 * n * (1 / 2 : ℝ) ^ n

theorem a_pos (n : ℕ) : 0 < a n := by unfold a; positivity
theorem c_nonneg (n : ℕ) : 0 ≤ c n := by unfold c; positivity

theorem A₁_iter (n : ℕ) (p : ℝ × ℝ) :
    A₁^[n] p = (a n * p.1 + c n * p.2, a n * p.2) := by
  induction n with
  | zero => simp [a, c]
  | succ n ih =>
    rw [Function.iterate_succ_apply', ih]
    ext <;> simp only [A₁, a, c, pow_succ] <;> push_cast <;> ring

theorem A₂_iter (n : ℕ) (p : ℝ × ℝ) :
    A₂^[n] p = (a n * p.1, c n * p.1 + a n * p.2) := by
  induction n with
  | zero => simp [a, c]
  | succ n ih =>
    rw [Function.iterate_succ_apply', ih]
    ext <;> simp only [A₂, a, c, pow_succ] <;> push_cast <;> ring

theorem gain_bound {n : ℕ} (hn : 5 ≤ n) : a n + c n ≤ 21 / 32 := by
  induction n, hn using Nat.le_induction with
  | base => norm_num [a, c]
  | succ n hn ih =>
    have ht : 0 < (1 / 2 : ℝ) ^ n := by positivity
    have hn' : (5 : ℝ) ≤ n := by exact_mod_cast hn
    simp only [a, c] at ih ⊢
    rw [pow_succ]
    push_cast
    nlinarith [mul_pos ht (by linarith : (0 : ℝ) < n)]

/-- Linear bound used for both experts, in the sup metric. -/
theorem abs_comb_le {u v D α β : ℝ} (hα : 0 ≤ α) (hβ : 0 ≤ β)
    (hu : |u| ≤ D) (hv : |v| ≤ D) : |α * u + β * v| ≤ (α + β) * D := by
  calc |α * u + β * v| ≤ |α * u| + |β * v| := abs_add_le _ _
    _ = α * |u| + β * |v| := by rw [abs_mul, abs_mul, abs_of_nonneg hα, abs_of_nonneg hβ]
    _ ≤ α * D + β * D := by gcongr
    _ = (α + β) * D := by ring

/-- Every expert carries a depth receipt with `θ = 21/32`, `τ = 5`. -/
theorem expert_receipt (i : Bool) : DepthReceipt (21 / 32) 5 (expert i) := by
  intro n hn x y
  have hg := gain_bound hn
  have ha := (a_pos n).le
  have hc := c_nonneg n
  have hD : 0 ≤ dist x y := dist_nonneg
  have h1 : |x.1 - y.1| ≤ dist x y := by
    rw [← Real.dist_eq]; exact (le_max_left _ _).trans (le_of_eq (Prod.dist_eq).symm)
  have h2 : |x.2 - y.2| ≤ dist x y := by
    rw [← Real.dist_eq]; exact (le_max_right _ _).trans (le_of_eq (Prod.dist_eq).symm)
  have hscale : (a n + c n) * dist x y ≤ 21 / 32 * dist x y :=
    mul_le_mul_of_nonneg_right hg hD
  have hsolo : a n * dist x y ≤ 21 / 32 * dist x y := by nlinarith
  rw [Prod.dist_eq]
  cases i with
  | false =>
    simp only [expert, A₁_iter, Real.dist_eq]
    refine max_le ?_ ?_
    · have e : a n * x.1 + c n * x.2 - (a n * y.1 + c n * y.2)
          = a n * (x.1 - y.1) + c n * (x.2 - y.2) := by ring
      rw [e]
      exact (abs_comb_le ha hc h1 h2).trans hscale
    · have e : a n * x.2 - a n * y.2 = a n * (x.2 - y.2) := by ring
      rw [e, abs_mul, abs_of_nonneg ha]
      exact (mul_le_mul_of_nonneg_left h2 ha).trans hsolo
  | true =>
    simp only [expert, A₂_iter, Real.dist_eq]
    refine max_le ?_ ?_
    · have e : a n * x.1 - a n * y.1 = a n * (x.1 - y.1) := by ring
      rw [e, abs_mul, abs_of_nonneg ha]
      exact (mul_le_mul_of_nonneg_left h1 ha).trans hsolo
    · have e : c n * x.1 + a n * x.2 - (c n * y.1 + a n * y.2)
          = c n * (x.1 - y.1) + a n * (x.2 - y.2) := by ring
      rw [e]
      have := abs_comb_le hc ha h1 h2
      refine this.trans ?_
      rw [add_comm]
      exact hscale

/-- Each expert alone converges to the origin from every start. -/
theorem expert_stable_alone (i : Bool) (p : ℝ × ℝ) :
    Tendsto (fun n => (expert i)^[n] p) atTop (𝓝 (0, 0)) := by
  have ha : Tendsto a atTop (𝓝 0) :=
    tendsto_pow_atTop_nhds_zero_of_lt_one (by norm_num) (by norm_num)
  have hc : Tendsto c atTop (𝓝 0) := by
    have h := (tendsto_self_mul_const_pow_of_lt_one (r := 1 / 2)
      (by norm_num) (by norm_num)).const_mul 4
    simp only [mul_zero] at h
    refine h.congr fun n => ?_
    unfold c; ring
  have hx (u v : ℝ) : Tendsto (fun n => a n * u + c n * v) atTop (𝓝 0) := by
    simpa using (ha.mul_const u).add (hc.mul_const v)
  have hy (u : ℝ) : Tendsto (fun n => a n * u) atTop (𝓝 0) := by
    simpa using ha.mul_const u
  cases i with
  | false =>
    simp only [expert, A₁_iter]
    exact (hx p.1 p.2).prodMk_nhds (hy p.2)
  | true =>
    simp only [expert, A₂_iter]
    exact (hy p.1).prodMk_nhds (by simpa [add_comm] using hx p.2 p.1)

/-- Alternating route at per-token depth `n`: odd tokens use `A₁`, even tokens `A₂`. -/
noncomputable def altRoute (n : ℕ) : ℕ → ℝ × ℝ → ℝ × ℝ :=
  token expert (fun t => decide (t % 2 = 0)) (fun _ => n)

theorem alt_two_tokens (n : ℕ) (p p' : ℝ × ℝ) (k : ℕ) (h : run (altRoute n) p (2 * k) = p') :
    run (altRoute n) p (2 * (k + 1))
      = ((a n ^ 2 + c n ^ 2) * p'.1 + a n * c n * p'.2,
          a n * c n * p'.1 + a n ^ 2 * p'.2) := by
  have e : 2 * (k + 1) = 2 * k + 1 + 1 := by ring
  rw [e]
  show altRoute n (2 * k + 1) (altRoute n (2 * k) (run (altRoute n) p (2 * k))) = _
  rw [h]
  have h0 : (2 * k) % 2 = 0 := by omega
  have h1 : (2 * k + 1) % 2 = 1 := by omega
  simp only [altRoute, token, h0, h1, decide_true, decide_false, one_ne_zero, expert,
    A₁_iter, A₂_iter]
  ext <;> simp <;> ring

/-- Depths 1 to 4 give gain `c n ≥ 1`. -/
theorem c_ge_one {n : ℕ} (h1 : 1 ≤ n) (h4 : n ≤ 4) : 1 ≤ c n := by
  interval_cases n <;> norm_num [c]

/-- Below depth 5 the alternating route grows geometrically from `(1, 0)`. -/
theorem alt_growth {n : ℕ} (h1 : 1 ≤ n) (h4 : n ≤ 4) (k : ℕ) :
    (1 + a n ^ 2) ^ k ≤ (run (altRoute n) ((1 : ℝ), (0 : ℝ)) (2 * k)).1 ∧
      0 ≤ (run (altRoute n) ((1 : ℝ), (0 : ℝ)) (2 * k)).2 := by
  induction k with
  | zero => simp [run]
  | succ k ih =>
    obtain ⟨hx, hy⟩ := ih
    rw [alt_two_tokens n _ _ k rfl]
    set q := run (altRoute n) ((1 : ℝ), (0 : ℝ)) (2 * k) with hq
    have ha := a_pos n
    have hc := c_ge_one h1 h4
    have hq1 : 0 ≤ q.1 := le_trans (by positivity) hx
    have hc2 : 1 ≤ c n ^ 2 := by nlinarith
    have hac : 0 ≤ a n * c n := by nlinarith
    constructor
    · show (1 + a n ^ 2) ^ (k + 1) ≤ (a n ^ 2 + c n ^ 2) * q.1 + a n * c n * q.2
      have h3 : (1 + a n ^ 2) * q.1 ≤ (a n ^ 2 + c n ^ 2) * q.1 :=
        mul_le_mul_of_nonneg_right (by linarith) hq1
      have h4' : (1 + a n ^ 2) ^ (k + 1) ≤ (1 + a n ^ 2) * q.1 := by
        rw [pow_succ']
        exact mul_le_mul_of_nonneg_left hx (by positivity)
      have h5 : 0 ≤ a n * c n * q.2 := mul_nonneg hac hy
      linarith
    · show 0 ≤ a n * c n * q.1 + a n ^ 2 * q.2
      have := mul_nonneg hac hq1
      have := mul_nonneg (sq_nonneg (a n)) hy
      linarith

/-- **T3, the separation theorem.** The same two experts, each stable alone:
(i) depth 1 to 4 alternating routing diverges, which includes per-step switching;
(ii) at per-token depth at least 5, every route and every depth schedule contracts. -/
theorem separation :
    (∀ i p, Tendsto (fun n => (expert i)^[n] p) atTop (𝓝 (0, 0))) ∧
    (∀ n, 1 ≤ n → n ≤ 4 →
      Tendsto (fun k => (run (altRoute n) ((1 : ℝ), (0 : ℝ)) (2 * k)).1) atTop atTop) ∧
    (∀ (σ : ℕ → Bool) (R : ℕ → ℕ), (∀ t, 5 ≤ R t) → ∀ x y t,
      dist (run (token expert σ R) x t) (run (token expert σ R) y t)
        ≤ (21 / 32 : ℝ) ^ t * dist x y) := by
  refine ⟨expert_stable_alone, ?_, ?_⟩
  · intro n h1 h4
    have hgt : 1 < 1 + a n ^ 2 := by
      have := a_pos n
      nlinarith [sq_pos_of_pos this]
    exact tendsto_atTop_mono (fun k => (alt_growth h1 h4 k).1)
      (tendsto_pow_atTop_atTop_of_one_lt hgt)
  · intro σ R hR x y t
    exact token_routing_stable (by norm_num) expert_receipt σ R hR x y t

end Separation

/-! ## Capacity: what contraction costs

`F c` is the recursion step under context `c`, `κ`-Lipschitz in the state and `L`-Lipschitz in
the context. `G κ R = Σ_{j<R} κ^j` is the leverage recursion gives over a single step. -/

section Capacity

/-- Recursion's leverage on context sensitivity. -/
noncomputable def G (κ : ℝ) (R : ℕ) : ℝ := ∑ j ∈ Finset.range R, κ ^ j

theorem G_nonneg {κ : ℝ} (hκ : 0 ≤ κ) (R : ℕ) : 0 ≤ G κ R :=
  Finset.sum_nonneg fun _ _ => pow_nonneg hκ _

theorem G_succ (κ : ℝ) (R : ℕ) : G κ (R + 1) = κ * G κ R + 1 := by
  unfold G
  rw [Finset.sum_range_succ', Finset.mul_sum]
  simp [pow_succ']

/-- With `κ ≤ 1`, leverage is at most linear in depth. -/
theorem G_le_depth {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ ≤ 1) (R : ℕ) : G κ R ≤ R := by
  unfold G
  calc ∑ j ∈ Finset.range R, κ ^ j ≤ ∑ _j ∈ Finset.range R, (1 : ℝ) :=
        Finset.sum_le_sum fun j _ => pow_le_one₀ hκ hκ1
    _ = R := by simp

/-- With `κ < 1`, leverage is at most `1 / (1 - κ)`, at every depth. -/
theorem G_le_inv {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1) (R : ℕ) : G κ R ≤ 1 / (1 - κ) := by
  have h1 : 0 < 1 - κ := by linarith
  rw [le_div_iff₀ h1, mul_comm]
  have e : (1 - κ) * G κ R = 1 - κ ^ R := by
    unfold G; exact mul_neg_geom_sum κ R
  rw [e]
  have := pow_nonneg hκ R
  linarith

/-- An expansive step has leverage at least `κ ^ (R - 1)`: exponential in depth. -/
theorem G_expansive {κ : ℝ} (hκ : 1 ≤ κ) (R : ℕ) : κ ^ R ≤ G κ (R + 1) := by
  rw [G_succ]
  induction R with
  | zero => simp [G]
  | succ R ih =>
    rw [G_succ]
    have h0 : 0 ≤ κ := by linarith
    have hG := G_nonneg h0 R
    rw [pow_succ']
    nlinarith

section Bounds

variable {C X : Type*} [PseudoMetricSpace C] [PseudoMetricSpace X]

/-- **C1, the leverage bound.** Output sensitivity at depth `R`, from any two starts. -/
theorem depth_gain {κ L : ℝ} (hκ : 0 ≤ κ) {F : C → X → X}
    (hF : ∀ c, LipBound κ (F c)) (hL : ∀ c c' x, dist (F c x) (F c' x) ≤ L * dist c c')
    (c c' : C) (u v : X) (R : ℕ) :
    dist ((F c)^[R] u) ((F c')^[R] v)
      ≤ κ ^ R * dist u v + L * dist c c' * G κ R := by
  induction R with
  | zero => simp [G]
  | succ R ih =>
    rw [Function.iterate_succ_apply', Function.iterate_succ_apply', G_succ]
    set a := (F c)^[R] u
    set b := (F c')^[R] v
    have h1 : dist (F c a) (F c' b) ≤ dist (F c a) (F c b) + dist (F c b) (F c' b) :=
      dist_triangle _ _ _
    have h2 := hF c a b
    have h3 := hL c c' b
    have h4 : κ * dist a b ≤ κ * (κ ^ R * dist u v + L * dist c c' * G κ R) :=
      mul_le_mul_of_nonneg_left ih hκ
    calc dist (F c a) (F c' b) ≤ κ * dist a b + L * dist c c' := by linarith
      _ ≤ κ * (κ ^ R * dist u v + L * dist c c' * G κ R) + L * dist c c' := by linarith
      _ = κ ^ (R + 1) * dist u v + L * dist c c' * (κ * G κ R + 1) := by ring

/-- **C2.** Fixed-point sensitivity is at most `L / (1 - κ)`. -/
theorem fixed_point_sensitivity {κ L : ℝ} (hκ1 : κ < 1) {F : C → X → X}
    (hF : ∀ c, LipBound κ (F c)) (hL : ∀ c c' x, dist (F c x) (F c' x) ≤ L * dist c c')
    {p : C → X} (hp : ∀ c, F c (p c) = p c) (c c' : C) :
    dist (p c) (p c') ≤ L * dist c c' / (1 - κ) :=
  edit_blast_radius hκ1 (hF c) (hp c) (hp c') (hL c c' (p c'))

/-- **C3.** Required per-step sensitivity. If depth-`R` recursion from a fixed start tracks a
target `h` within `η`, then `h` can separate `c, c'` by no more than `2η + L·d·G`. -/
theorem required_injection {κ L η : ℝ} (hκ : 0 ≤ κ) {F : C → X → X}
    (hF : ∀ c, LipBound κ (F c)) (hL : ∀ c c' x, dist (F c x) (F c' x) ≤ L * dist c c')
    {x₀ : X} {R : ℕ} {h : C → X} (hh : ∀ c, dist ((F c)^[R] x₀) (h c) ≤ η) (c c' : C) :
    dist (h c) (h c') ≤ 2 * η + L * dist c c' * G κ R := by
  have g := depth_gain hκ hF hL c c' x₀ x₀ R
  simp only [dist_self, mul_zero, zero_add] at g
  have a := hh c
  have b := hh c'
  have t1 := dist_triangle_left (h c) (h c') ((F c)^[R] x₀)
  have t2 := dist_triangle ((F c)^[R] x₀) ((F c')^[R] x₀) (h c')
  linarith

/-- **C4, no injection.** If input enters only as the start state, a contraction erases it:
through any `ℓ`-Lipschitz decoder, its effect at depth `R` is at most `ℓ·κ^R·d`. -/
theorem no_injection_erases_input {κ ℓ : ℝ} (hκ : 0 ≤ κ) (hℓ : 0 ≤ ℓ) {f : X → X}
    (hf : LipBound κ f) {dec : X → ℝ} (hdec : ∀ x y, |dec x - dec y| ≤ ℓ * dist x y)
    (x y : X) (R : ℕ) :
    |dec (f^[R] x) - dec (f^[R] y)| ≤ ℓ * (κ ^ R * dist x y) :=
  (hdec _ _).trans (mul_le_mul_of_nonneg_left (hf.iterate hκ R x y) hℓ)

omit [PseudoMetricSpace C] in
/-- **C5, the memory horizon.** With a contracting state and only the current token as input,
an event `n` tokens back moves the state by at most `κ^n·D` once inputs agree again. -/
theorem memory_horizon {κ D : ℝ} (hκ : 0 ≤ κ) {F : C → X → X} (hF : ∀ c, LipBound κ (F c))
    (hD : ∀ x y : X, dist x y ≤ D) (u u' : ℕ → C) (s : ℕ)
    (hagree : ∀ i, u (s + i) = u' (s + i)) (x y : X) (n : ℕ) :
    dist (run (fun t => F (u t)) x (s + n)) (run (fun t => F (u' t)) y (s + n)) ≤ κ ^ n * D := by
  induction n with
  | zero => simpa using hD _ _
  | succ n ih =>
    have e : s + (n + 1) = (s + n) + 1 := by ring
    rw [e]
    show dist (F (u (s + n)) _) (F (u' (s + n)) _) ≤ _
    rw [← hagree n]
    calc dist (F (u (s + n)) _) (F (u (s + n)) _)
        ≤ κ * dist (run (fun t => F (u t)) x (s + n)) (run (fun t => F (u' t)) y (s + n)) :=
          hF _ _ _
      _ ≤ κ * (κ ^ n * D) := mul_le_mul_of_nonneg_left ih hκ
      _ = κ ^ (n + 1) * D := by ring

end Bounds

/-- **C1 is tight**, for every `κ ≥ 0`, contracting or expansive. -/
theorem depth_gain_tight {κ L : ℝ} (hL : 0 ≤ L) (hG : 0 ≤ G κ R) (c c' : ℝ) :
    dist ((fun x => κ * x + L * c)^[R] (0 : ℝ)) ((fun x => κ * x + L * c')^[R] (0 : ℝ))
      = L * dist c c' * G κ R := by
  have it : ∀ (d : ℝ) (n : ℕ), (fun x => κ * x + L * d)^[n] (0 : ℝ) = L * d * G κ n := by
    intro d n
    induction n with
    | zero => simp [G]
    | succ n ih =>
      rw [Function.iterate_succ_apply', ih, G_succ]
      ring
  rw [it, it, Real.dist_eq, Real.dist_eq]
  have e : L * c * G κ R - L * c' * G κ R = L * G κ R * (c - c') := by ring
  rw [e, abs_mul, abs_mul, abs_of_nonneg hL, abs_of_nonneg hG]
  ring

/-- The leverage price at the loop's measured magnitude: `κ = 8`, depth 4. A contraction's
leverage at depth 4 is below 4. -/
theorem leverage_at_depth_four : G 8 4 = 585 := by norm_num [G, Finset.sum_range_succ]

/-! ### Realizability: contraction loses no function if the expressive work is in the encoder -/

section Realize

variable {C E : Type*} [SeminormedAddCommGroup E] [NormedSpace ℝ E]

/-- The refinement step: move a fraction `1 - κ` of the way to the encoder's output. -/
noncomputable def refine (κ : ℝ) (h : C → E) (c : C) (x : E) : E := κ • x + (1 - κ) • h c

theorem refine_lip {κ : ℝ} (hκ : 0 ≤ κ) (h : C → E) (c : C) : LipBound κ (refine κ h c) := by
  intro x y
  have e : refine κ h c x - refine κ h c y = κ • (x - y) := by
    simp only [refine, smul_sub]; abel
  rw [dist_eq_norm, e, norm_smul, Real.norm_of_nonneg hκ, dist_eq_norm]

theorem refine_fixed (κ : ℝ) (h : C → E) (c : C) : refine κ h c (h c) = h c := by
  simp only [refine, ← add_smul]
  simp

/-- **C6, realizability.** Any target `h`, with no restriction on it, is the fixed point of a
`κ`-contraction, and recursion reaches it at rate `κ^R`. Function class is not what
contraction costs; the cost is where the work has to live. -/
theorem contraction_realizes_any_target {κ : ℝ} (hκ : 0 ≤ κ) (h : C → E) (c : C) (x : E) (R : ℕ) :
    LipBound κ (refine κ h c) ∧ refine κ h c (h c) = h c ∧
      dist ((refine κ h c)^[R] x) (h c) ≤ κ ^ R * dist x (h c) := by
  refine ⟨refine_lip hκ h c, refine_fixed κ h c, ?_⟩
  have hit := (refine_lip hκ h c).iterate hκ R x (h c)
  rwa [Function.iterate_fixed (refine_fixed κ h c) R] at hit

/-- **C7, the append-only rescue.** Let `m t` be any memory trajectory, such as the full token
history, and `h` any function of it. With `R` recursion steps per token, the working state
forgets its start at `κ^(R·t)` while tracking `h (m t)` at every token. So C5's horizon binds
the working state only, and memory held outside the contraction escapes it. -/
theorem append_only_memory_rescue {M : Type*} {κ : ℝ} (hκ : 0 ≤ κ) (h : M → E) (m : ℕ → M)
    (R : ℕ) (x y : E) (t : ℕ) :
    let g : ℕ → E → E := fun s => (refine κ h (m s))^[R]
    dist (run g x t) (run g y t) ≤ (κ ^ R) ^ t * dist x y ∧
      dist (run g x (t + 1)) (h (m t)) ≤ κ ^ R * dist (run g x t) (h (m t)) := by
  intro g
  have hg : ∀ s, LipBound (κ ^ R) (g s) := fun s => (refine_lip hκ h (m s)).iterate hκ R
  refine ⟨run_contract (pow_nonneg hκ R) hg x y t, ?_⟩
  have := hg t (run g x t) (h (m t))
  have hfix : g t (h (m t)) = h (m t) := Function.iterate_fixed (refine_fixed κ h (m t)) R
  rwa [hfix] at this

end Realize

/-! ### The depth separation -/

section Sawtooth

/-- The tent map, Lipschitz constant 2. Iterating it is Telgarsky's sawtooth. -/
noncomputable def tent (x : ℝ) : ℝ := 1 - |2 * x - 1|

theorem tent_lip : LipBound 2 tent := by
  intro x y
  simp only [tent, Real.dist_eq]
  have e : 1 - |2 * x - 1| - (1 - |2 * y - 1|) = |2 * y - 1| - |2 * x - 1| := by ring
  rw [e]
  calc |(|2 * y - 1| - |2 * x - 1|)| ≤ |(2 * y - 1) - (2 * x - 1)| :=
        abs_abs_sub_abs_le_abs_sub _ _
    _ = 2 * |x - y| := by
      have : (2 * y - 1) - (2 * x - 1) = 2 * (y - x) := by ring
      rw [this, abs_mul, abs_two, abs_sub_comm]

theorem tent_zero (R : ℕ) : tent^[R] 0 = 0 := by
  apply Function.iterate_fixed
  norm_num [tent]

theorem tent_half_pow (m : ℕ) : tent ((1 / 2 : ℝ) ^ (m + 1)) = (1 / 2 : ℝ) ^ m := by
  have hp : (0 : ℝ) < (1 / 2) ^ m := by positivity
  have hle : (1 / 2 : ℝ) ^ m ≤ 1 := pow_le_one₀ (by norm_num) (by norm_num)
  simp only [tent, pow_succ]
  rw [abs_of_nonpos (by linarith)]
  ring

/-- The sawtooth swings from 0 to 1 across a gap of `2^(-R)`. -/
theorem tent_iter_top (R : ℕ) : tent^[R] ((1 / 2 : ℝ) ^ R) = 1 := by
  have key : ∀ j m : ℕ, tent^[j] ((1 / 2 : ℝ) ^ (m + j)) = (1 / 2 : ℝ) ^ m := by
    intro j
    induction j with
    | zero => intro m; simp
    | succ j ih =>
      intro m
      rw [Function.iterate_succ_apply]
      have e : m + (j + 1) = (m + j) + 1 := by ring
      rw [e, tent_half_pow]
      exact ih m
  simpa using key R 0

/-- **C8, the lower bound.** A `κ ≤ 1` recursion with embedding `e` (`A`-Lipschitz), per-step
context sensitivity `L`, and an `ℓ`-Lipschitz decoder can match the depth-`R` sawtooth within
`η` only if `(1 - 2η)·2^R ≤ ℓ·(A + L·R)`. So per-step budgets must grow almost exponentially
in depth. -/
theorem contraction_sawtooth_lower_bound {X : Type*} [PseudoMetricSpace X]
    {κ L A ℓ η : ℝ} {R : ℕ} (hκ : 0 ≤ κ) (hκ1 : κ ≤ 1) (hL0 : 0 ≤ L) (hℓ0 : 0 ≤ ℓ)
    {F : ℝ → X → X} (hF : ∀ c, LipBound κ (F c))
    (hL : ∀ c c' x, dist (F c x) (F c' x) ≤ L * dist c c')
    {e : ℝ → X} (he : ∀ c c', dist (e c) (e c') ≤ A * dist c c')
    {dec : X → ℝ} (hdec : ∀ x y, |dec x - dec y| ≤ ℓ * dist x y)
    (hmatch : ∀ c, |dec ((F c)^[R] (e c)) - tent^[R] c| ≤ η) :
    (1 - 2 * η) * 2 ^ R ≤ ℓ * (A + L * R) := by
  set c₁ : ℝ := (1 / 2) ^ R with hc₁
  have hc₁pos : 0 < c₁ := by positivity
  have hd : dist c₁ 0 = c₁ := by simp [abs_of_pos hc₁pos]
  have gain := depth_gain hκ hF hL c₁ 0 (e c₁) (e 0) R
  have hpow : κ ^ R ≤ 1 := pow_le_one₀ hκ hκ1
  have hGR := G_le_depth hκ hκ1 R
  have hedist := he c₁ 0
  rw [hd] at hedist gain
  have hed0 : 0 ≤ dist (e c₁) (e 0) := dist_nonneg
  have g1 : κ ^ R * dist (e c₁) (e 0) ≤ A * c₁ := by
    calc κ ^ R * dist (e c₁) (e 0) ≤ 1 * dist (e c₁) (e 0) :=
          mul_le_mul_of_nonneg_right hpow hed0
      _ ≤ A * c₁ := by linarith
  have g2 : L * c₁ * G κ R ≤ L * c₁ * R :=
    mul_le_mul_of_nonneg_left hGR (mul_nonneg hL0 hc₁pos.le)
  have outdist : dist ((F c₁)^[R] (e c₁)) ((F 0)^[R] (e 0)) ≤ (A + L * R) * c₁ := by
    calc _ ≤ κ ^ R * dist (e c₁) (e 0) + L * c₁ * G κ R := gain
      _ ≤ A * c₁ + L * c₁ * R := add_le_add g1 g2
      _ = (A + L * R) * c₁ := by ring
  have dbound := hdec ((F c₁)^[R] (e c₁)) ((F 0)^[R] (e 0))
  have m1 := abs_le.1 (hmatch c₁)
  have m0 := abs_le.1 (hmatch 0)
  rw [hc₁, tent_iter_top, ← hc₁] at m1
  rw [tent_zero] at m0
  have swing : 1 - 2 * η ≤ ℓ * ((A + L * R) * c₁) := by
    have := (abs_le.1 dbound).2
    have h2 := mul_le_mul_of_nonneg_left outdist hℓ0
    linarith [m1.1, m0.2]
  have hscale : c₁ * 2 ^ R = 1 := by
    rw [hc₁, ← mul_pow]; norm_num
  have h2pos : (0 : ℝ) < 2 ^ R := by positivity
  calc (1 - 2 * η) * 2 ^ R ≤ (ℓ * ((A + L * R) * c₁)) * 2 ^ R :=
        mul_le_mul_of_nonneg_right swing h2pos.le
    _ = ℓ * (A + L * R) * (c₁ * 2 ^ R) := by ring
    _ = ℓ * (A + L * R) := by rw [hscale, mul_one]

theorem two_pow_gt (R : ℕ) (hR : 3 ≤ R) : (1 : ℝ) + 2 * R < 2 ^ R := by
  induction R, hR using Nat.le_induction with
  | base => norm_num
  | succ R hR ih =>
    push_cast
    rw [pow_succ]
    have : (3 : ℝ) ≤ R := by exact_mod_cast hR
    linarith

end Sawtooth

/-! ### The receipt that costs nothing: a shift-register recursion -/

section Shift

variable {Y : Type*} [PseudoMetricSpace Y]

/-- Layer chain: `chain g c k` applies layers `g 0, …, g (k-1)` to `c`. -/
def chain (g : ℕ → Y → Y) (c : Y) : ℕ → Y
  | 0 => c
  | k + 1 => g k (chain g c k)

/-- One recursive step on a buffer of `R + 1` slots: slot 0 reads the context, and slot `k + 1`
applies layer `k` to slot `k`. This single time-invariant map is the recursion. -/
def shift (g : ℕ → Y → Y) (R : ℕ) (c : Y) (x : Fin (R + 1) → Y) : Fin (R + 1) → Y :=
  Fin.cases c (fun j => g j (x j.castSucc))

omit [PseudoMetricSpace Y] in
theorem shift_coord (g : ℕ → Y → Y) (R : ℕ) (c : Y) (x : Fin (R + 1) → Y) :
    ∀ (k : ℕ) (hk : k < R + 1) (n : ℕ), k < n →
      ((shift g R c)^[n] x) ⟨k, hk⟩ = chain g c k := by
  intro k
  induction k with
  | zero =>
    intro hk n hn
    obtain ⟨m, rfl⟩ : ∃ m, n = m + 1 := ⟨n - 1, by omega⟩
    rw [Function.iterate_succ_apply']
    rfl
  | succ k ih =>
    intro hk n hn
    obtain ⟨m, rfl⟩ : ∃ m, n = m + 1 := ⟨n - 1, by omega⟩
    rw [Function.iterate_succ_apply']
    show g k (((shift g R c)^[m] x) ⟨k, by omega⟩) = g k (chain g c k)
    rw [ih (by omega) m (by omega)]

omit [PseudoMetricSpace Y] in
/-- From depth `R + 1` the recursion has forgotten its start exactly. -/
theorem shift_settled (g : ℕ → Y → Y) (R : ℕ) (c : Y) (x y : Fin (R + 1) → Y) {n : ℕ}
    (hn : R + 1 ≤ n) : (shift g R c)^[n] x = (shift g R c)^[n] y := by
  funext k
  have hk : k.val < n := by omega
  have h1 := shift_coord g R c x k.val k.isLt n hk
  have h2 := shift_coord g R c y k.val k.isLt n hk
  simpa using h1.trans h2.symm

/-- **C9, the receipt costs no capacity.** Any layer chain, however expansive, is one
time-invariant recursion with a depth receipt at `θ = 0`, `τ = R + 1`, so T2's routing
guarantee applies to it by construction, with nothing to measure. It computes the chain
exactly, each step is `ℓ`-Lipschitz in the buffer, and it is 1-Lipschitz in the context. -/
theorem receipt_costs_no_capacity {ℓ : ℝ} (hℓ : 0 ≤ ℓ) (g : ℕ → Y → Y)
    (hg : ∀ k x y, dist (g k x) (g k y) ≤ ℓ * dist x y) (R : ℕ) (c : Y) :
    DepthReceipt 0 (R + 1) (shift g R c) ∧
      (∀ x, ((shift g R c)^[R + 1] x) (Fin.last R) = chain g c R) ∧
      LipBound ℓ (shift g R c) ∧
      (∀ c' x, dist (shift g R c x) (shift g R c' x) ≤ dist c c') := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro n hn x y
    rw [shift_settled g R c x y hn]
    simp
  · intro x
    exact shift_coord g R c x R (by omega) (R + 1) (by omega)
  · intro x y
    refine (dist_pi_le_iff (mul_nonneg hℓ dist_nonneg)).2 fun k => ?_
    refine Fin.cases ?_ (fun j => ?_) k
    · simpa [shift] using mul_nonneg hℓ dist_nonneg
    · simp only [shift, Fin.cases_succ]
      exact (hg j _ _).trans
        (mul_le_mul_of_nonneg_left (dist_le_pi_dist x y j.castSucc) hℓ)
  · intro c' x
    refine (dist_pi_le_iff dist_nonneg).2 fun k => ?_
    refine Fin.cases ?_ (fun j => ?_) k
    · simp [shift]
    · simp [shift]

omit [PseudoMetricSpace Y] in
theorem chain_const (g : Y → Y) (c : Y) (k : ℕ) : chain (fun _ => g) c k = g^[k] c := by
  induction k with
  | zero => rfl
  | succ k ih =>
    rw [Function.iterate_succ_apply']
    show g (chain (fun _ => g) c k) = _
    rw [ih]

end Shift

/-- **C10, the capacity separation.** Same per-step budget, depth `R ≥ 3`, target the sawtooth:
(i) a one-step contraction (`κ ≤ 1`, context sensitivity at most 2, unit embedding and decoder)
cannot compute it exactly, and its budget would have to reach `2^R` up to a factor of `1 + 2R`;
(ii) a depth-receipted recursion with weight-tied layers, per-step Lipschitz 2, computes it
exactly, and T2 certifies routing for it. -/
theorem capacity_separation (R : ℕ) (hR : 3 ≤ R) :
    (¬ ∃ (κ : ℝ) (F : ℝ → ℝ → ℝ), 0 ≤ κ ∧ κ ≤ 1 ∧ (∀ c, LipBound κ (F c)) ∧
        (∀ c c' x, dist (F c x) (F c' x) ≤ 2 * dist c c') ∧
        ∀ c, (F c)^[R] c = tent^[R] c) ∧
    (∀ (c : ℝ) (x : Fin (R + 1) → ℝ),
      ((shift (fun _ => tent) R c)^[R + 1] x) (Fin.last R) = tent^[R] c ∧
      DepthReceipt 0 (R + 1) (shift (fun _ => tent) R c) ∧
      LipBound 2 (shift (fun _ => tent) R c)) := by
  constructor
  · rintro ⟨κ, F, hκ, hκ1, hF, hL, hm⟩
    have h := contraction_sawtooth_lower_bound (X := ℝ) (κ := κ) (L := 2) (A := 1) (ℓ := 1)
      (η := 0) (R := R) hκ hκ1 (by norm_num) (by norm_num) hF hL
      (e := id) (fun c c' => by simp)
      (dec := id) (fun x y => by simp [Real.dist_eq])
      (fun c => by simp [hm c])
    have := two_pow_gt R hR
    norm_num at h
    linarith
  · intro c x
    obtain ⟨h1, h2, h3, -⟩ := receipt_costs_no_capacity (ℓ := 2) (by norm_num)
      (fun _ => tent) (fun _ => tent_lip) R c
    exact ⟨(h2 x).trans (chain_const tent c R), h1, h3⟩

/-! ## Composition: the hybrid

Each token runs two stages. A pipeline (the C9 shift recursion, `R + 1` steps) settles
exactly; a contracting refinement stage then moves the working state toward the value it
reads from the pipeline's last slot. The token map contracts per token, not per step. -/

section Hybrid

variable {Y E : Type*} [PseudoMetricSpace Y] [SeminormedAddCommGroup E] [NormedSpace ℝ E]

/-- One hybrid token: pipeline to settlement, then `S` refinement steps toward its output. -/
noncomputable def hybrid (κ : ℝ) (g : ℕ → Y → Y) (out : Y → E) (R S : ℕ) (c : Y)
    (s : (Fin (R + 1) → Y) × E) : (Fin (R + 1) → Y) × E :=
  ((shift g R c)^[R + 1] s.1,
    (refine κ id (out (((shift g R c)^[R + 1] s.1) (Fin.last R))))^[S] s.2)

/-- The same token with an adaptive exit: refine until the step is small (`N` steps), then one
more step, as in T6a. -/
noncomputable def hybridExit (κ : ℝ) (g : ℕ → Y → Y) (out : Y → E) (R : ℕ) (N : E → E → ℕ)
    (c : Y) (s : (Fin (R + 1) → Y) × E) : (Fin (R + 1) → Y) × E :=
  let v := out (((shift g R c)^[R + 1] s.1) (Fin.last R))
  ((shift g R c)^[R + 1] s.1,
    refine κ id v ((refine κ id v)^[N v s.2] s.2))

omit [PseudoMetricSpace Y] [SeminormedAddCommGroup E] [NormedSpace ℝ E] in
/-- The refinement target is the pipeline's exact output. -/
theorem hybrid_target (g : ℕ → Y → Y) (out : Y → E) (R : ℕ) (c : Y) (b : Fin (R + 1) → Y) :
    out (((shift g R c)^[R + 1] b) (Fin.last R)) = out (chain g c R) := by
  rw [show ((shift g R c)^[R + 1] b) (Fin.last R) = chain g c R from
    shift_coord g R c b R (by omega) (R + 1) (by omega)]

/-- **H1.** The hybrid token map is `κ^S`-Lipschitz on the whole state (pipeline buffer and
working state, sup metric), whatever the pipeline's per-step expansion. -/
theorem hybrid_lip {κ : ℝ} (hκ : 0 ≤ κ) (g : ℕ → Y → Y) (out : Y → E) (R S : ℕ) (c : Y) :
    LipBound (κ ^ S) (hybrid κ g out R S c) := by
  intro s s'
  have hb : (shift g R c)^[R + 1] s.1 = (shift g R c)^[R + 1] s'.1 :=
    shift_settled g R c _ _ le_rfl
  have h2 : dist s.2 s'.2 ≤ dist s s' := by rw [Prod.dist_eq]; exact le_max_right _ _
  have hpos : 0 ≤ κ ^ S * dist s s' := mul_nonneg (pow_nonneg hκ S) dist_nonneg
  rw [Prod.dist_eq]
  refine max_le ?_ ?_
  · show dist ((shift g R c)^[R + 1] s.1) ((shift g R c)^[R + 1] s'.1) ≤ _
    rw [hb, dist_self]; exact hpos
  · show dist ((refine κ id (out (((shift g R c)^[R + 1] s.1) (Fin.last R))))^[S] s.2)
      ((refine κ id (out (((shift g R c)^[R + 1] s'.1) (Fin.last R))))^[S] s'.2) ≤ _
    rw [hb]
    refine ((refine_lip hκ id _).iterate hκ S _ _).trans ?_
    exact mul_le_mul_of_nonneg_left h2 (pow_nonneg hκ S)

/-- **H2, routing.** Any route over hybrid experts, any contexts (so any function of an
append-only history), and any per-token refinement depth `S t ≥ 1` contract at `κ` per token. -/
theorem hybrid_routing_stable {ι : Type*} {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ ≤ 1)
    (g : ι → ℕ → Y → Y) (out : ι → Y → E) (R : ℕ) (σ : ℕ → ι) (u : ℕ → Y) (S : ℕ → ℕ)
    (hS : ∀ t, 1 ≤ S t) (x y : (Fin (R + 1) → Y) × E) (t : ℕ) :
    dist (run (fun t => hybrid κ (g (σ t)) (out (σ t)) R (S t) (u t)) x t)
      (run (fun t => hybrid κ (g (σ t)) (out (σ t)) R (S t) (u t)) y t) ≤ κ ^ t * dist x y := by
  refine run_contract hκ (fun t => ?_) x y t
  intro a b
  have hp : κ ^ S t ≤ κ := by
    calc κ ^ S t ≤ κ ^ 1 := pow_le_pow_of_le_one hκ hκ1 (hS t)
      _ = κ := pow_one κ
  exact (hybrid_lip hκ _ _ R (S t) (u t) a b).trans
    (mul_le_mul_of_nonneg_right hp dist_nonneg)

omit [PseudoMetricSpace Y] in
/-- **H3, tracking.** After a token, the working state is within `κ^S` of the pipeline's
output, relative to where it started. -/
theorem hybrid_tracks {κ : ℝ} (hκ : 0 ≤ κ) (g : ℕ → Y → Y) (out : Y → E) (R S : ℕ) (c : Y)
    (s : (Fin (R + 1) → Y) × E) :
    dist (hybrid κ g out R S c s).2 (out (chain g c R)) ≤ κ ^ S * dist s.2 (out (chain g c R)) := by
  show dist ((refine κ id (out (((shift g R c)^[R + 1] s.1) (Fin.last R))))^[S] s.2) _ ≤ _
  rw [hybrid_target g out R c s.1]
  have hit := (refine_lip hκ id (out (chain g c R))).iterate hκ S s.2 (out (chain g c R))
  have hf : refine κ id (out (chain g c R)) (out (chain g c R)) = out (chain g c R) :=
    refine_fixed κ id (out (chain g c R))
  rwa [Function.iterate_fixed hf S] at hit

omit [PseudoMetricSpace Y] in
/-- **H4, the adaptive exit composes.** One exit rule `N` serves every expert. Under any route
and any contexts, every token's working state lies within `κ/(1-κ)·ε` of the chosen expert's
pipeline output. Two runs from *any* two starts share the pipeline buffer exactly from the first
token on, and their working states agree to `2·κ/(1-κ)·ε`, however their exit depths differ. -/
theorem hybrid_adaptive_exit {ι : Type*} {κ ε : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ < 1) (hε : 0 < ε)
    (g : ι → ℕ → Y → Y) (out : ι → Y → E) (R : ℕ) :
    ∃ N : E → E → ℕ,
      (∀ v z, dist ((refine κ id v)^[N v z] z) (refine κ id v ((refine κ id v)^[N v z] z)) ≤ ε) ∧
      ∀ (σ : ℕ → ι) (u : ℕ → Y) (x y : (Fin (R + 1) → Y) × E) (t : ℕ),
        let tok : ℕ → (Fin (R + 1) → Y) × E → (Fin (R + 1) → Y) × E :=
          fun t => hybridExit κ (g (σ t)) (out (σ t)) R N (u t)
        (run tok x (t + 1)).1 = (run tok y (t + 1)).1 ∧
        dist (run tok x (t + 1)).2 (out (σ t) (chain (g (σ t)) (u t) R)) ≤ κ / (1 - κ) * ε ∧
        dist (run tok x (t + 1)).2 (run tok y (t + 1)).2 ≤ 2 * (κ / (1 - κ) * ε) := by
  have hex : ∀ v z : E, ∃ n,
      dist ((refine κ id v)^[n] z) (refine κ id v ((refine κ id v)^[n] z)) ≤ ε :=
    fun v z => exit_fires hκ hκ1 (refine_lip hκ id v) z hε
  choose N hN using hex
  refine ⟨N, hN, ?_⟩
  intro σ u x y t tok
  have h1 : 0 < 1 - κ := by linarith
  have hq : 0 ≤ κ / (1 - κ) := div_nonneg hκ h1.le
  set i := σ t
  set c := u t
  set bx := (run tok x t).1
  set by' := (run tok y t).1
  have hb : (shift (g i) R c)^[R + 1] bx = (shift (g i) R c)^[R + 1] by' :=
    shift_settled (g i) R c _ _ le_rfl
  set v := out i (chain (g i) c R)
  have hvx : out i (((shift (g i) R c)^[R + 1] bx) (Fin.last R)) = v := hybrid_target _ _ R c bx
  have hvy : out i (((shift (g i) R c)^[R + 1] by') (Fin.last R)) = v := hybrid_target _ _ R c by'
  have ex : (run tok x (t + 1)).2
      = refine κ id v ((refine κ id v)^[N v (run tok x t).2] (run tok x t).2) := by
    show (hybridExit κ (g i) (out i) R N c (run tok x t)).2 = _
    simp only [hybridExit]
    rw [hvx]
  have ey : (run tok y (t + 1)).2
      = refine κ id v ((refine κ id v)^[N v (run tok y t).2] (run tok y t).2) := by
    show (hybridExit κ (g i) (out i) R N c (run tok y t)).2 = _
    simp only [hybridExit]
    rw [hvy]
  refine ⟨?_, ?_, ?_⟩
  · show (hybridExit κ (g i) (out i) R N c (run tok x t)).1
      = (hybridExit κ (g i) (out i) R N c (run tok y t)).1
    simp only [hybridExit]
    exact hb
  · rw [ex]
    exact (certified_exit hκ hκ1 (refine_lip hκ id v) (refine_fixed κ id v)).trans
      (mul_le_mul_of_nonneg_left (hN v _) hq)
  · rw [ex, ey]
    exact adaptive_exit_agreement hκ hκ1 (refine_lip hκ id v) (refine_fixed κ id v)
      (hN v _) (hN v _)

end Hybrid

/-- **H5, the composition beats one-step contraction.** Target: the depth-`R` sawtooth, `R ≥ 3`.
(i) No one-step contraction with per-step context sensitivity 2 computes it (C10).
(ii) The hybrid, with every single step at most 2-Lipschitz (pipeline step 2, refinement step
`κ`), gets within `κ^S` of it at every token, and its token map contracts at `κ^S`, so
H2 and H4 certify its routing and its adaptive exit. -/
theorem composition_beats_contraction (R : ℕ) (hR : 3 ≤ R) {κ : ℝ} (hκ : 0 ≤ κ) (hκ1 : κ ≤ 1) :
    (¬ ∃ (κ' : ℝ) (F : ℝ → ℝ → ℝ), 0 ≤ κ' ∧ κ' ≤ 1 ∧ (∀ c, LipBound κ' (F c)) ∧
        (∀ c c' x, dist (F c x) (F c' x) ≤ 2 * dist c c') ∧
        ∀ c, (F c)^[R] c = tent^[R] c) ∧
    (∀ (S : ℕ) (c : ℝ) (s : (Fin (R + 1) → ℝ) × ℝ),
      dist (hybrid κ (fun _ => tent) id R S c s).2 (tent^[R] c)
        ≤ κ ^ S * dist s.2 (tent^[R] c) ∧
      LipBound (κ ^ S) (hybrid κ (fun _ => tent) id R S c)) ∧
    (∀ c : ℝ, LipBound 2 (shift (fun _ => tent) R c)) ∧
    (∀ v : ℝ, LipBound κ (refine κ id v)) ∧ κ ≤ 2 := by
  refine ⟨(capacity_separation R hR).1, ?_, ?_, fun v => refine_lip hκ id v, by linarith⟩
  · intro S c s
    have ht := hybrid_tracks hκ (fun _ => tent) id R S c s
    rw [id, chain_const] at ht
    exact ⟨ht, hybrid_lip hκ _ _ R S c⟩
  · intro c
    exact (receipt_costs_no_capacity (ℓ := 2) (by norm_num) (fun _ => tent)
      (fun _ => tent_lip) R c).2.2.1

end Capacity

/-! ## Anti-collapse: depth extrapolation

Looped models degrade past their trained depth: Ouro-1.4B GSM8K drops from 76.88% at 2 steps
to 58.23% at 8, and DVLT collapses past about 30 steps after training at 16. These theorems
say when that cannot happen, why evaluating at trained depths cannot rule it out, and how
to catch it at run time without false alarms. -/

section AntiCollapse

variable {X : Type*} [PseudoMetricSpace X]

/-- **A1, more depth never hurts with a receipt.** Under a `κ ≤ 1` contraction with a fixed
point, the distance to it is non-increasing at every depth, trained or not. -/
theorem more_depth_never_hurts {κ : ℝ} (hκ1 : κ ≤ 1) {f : X → X} {p : X}
    (hf : LipBound κ f) (hp : f p = p) (x : X) (K : ℕ) :
    dist (f^[K + 1] x) p ≤ dist (f^[K] x) p := by
  rw [Function.iterate_succ_apply']
  have h := hf (f^[K] x) p
  rw [hp] at h
  have hd := dist_nonneg (x := f^[K] x) (y := p)
  nlinarith

/-- With `κ < 1` the error also has an explicit bound at every depth, so there is no depth at
which the loop collapses. -/
theorem no_depth_collapse {κ : ℝ} (hκ : 0 ≤ κ) {f : X → X} {p : X}
    (hf : LipBound κ f) (hp : f p = p) (x : X) (K : ℕ) :
    dist (f^[K] x) p ≤ κ ^ K * dist x p := by
  have h := (hf.iterate hκ K) x p
  rwa [Function.iterate_fixed hp K] at h

/-- **A3, a sound collapse alarm.** Under a `κ` receipt, every step is at most `κ` times the
step before it. So an observed step ratio above `κ` proves the receipt is violated on this
very trajectory: the alarm never fires on a receipted map. It needs no fixed point and no
ground truth, only consecutive states, which the loop already computes. -/
theorem step_ratio_alarm_sound {κ : ℝ} {f : X → X} (hf : LipBound κ f) (x : X) (k : ℕ) :
    dist (f^[k + 1] x) (f^[k + 2] x) ≤ κ * dist (f^[k] x) (f^[k + 1] x) := by
  have h := hf (f^[k] x) (f^[k + 1] x)
  rwa [← Function.iterate_succ_apply' f k x, ← Function.iterate_succ_apply' f (k + 1) x] at h

/-- Contrapositive form: one alarm refutes the receipt. -/
theorem alarm_refutes_receipt {κ : ℝ} {f : X → X} (x : X) (k : ℕ)
    (halarm : κ * dist (f^[k] x) (f^[k + 1] x) < dist (f^[k + 1] x) (f^[k + 2] x)) :
    ¬ LipBound κ f := fun hf => absurd (step_ratio_alarm_sound hf x k) (not_le.2 halarm)

end AntiCollapse

section Extrapolation

/-- The trained loop: halve. -/
noncomputable def good (x : ℝ) : ℝ := x / 2

/-- A loop identical to `good` on every trained depth up to `K`, then drifting away. -/
noncomputable def drift (K : ℕ) (x : ℝ) : ℝ :=
  if (1 / 2 : ℝ) ^ K < x then x / 2 else x - (1 / 2 : ℝ) ^ K / 2

theorem good_iter (k : ℕ) : good^[k] 1 = (1 / 2 : ℝ) ^ k := by
  induction k with
  | zero => simp
  | succ k ih => rw [Function.iterate_succ_apply', ih, good, pow_succ]; ring

theorem drift_agrees (K : ℕ) : ∀ k, k ≤ K → (drift K)^[k] 1 = (1 / 2 : ℝ) ^ k := by
  intro k
  induction k with
  | zero => intro _; simp
  | succ k ih =>
    intro hk
    rw [Function.iterate_succ_apply', ih (by omega), drift, if_pos, pow_succ]
    · ring
    · exact pow_lt_pow_right_of_lt_one₀ (by norm_num) (by norm_num) (by omega)

theorem drift_after (K n : ℕ) :
    (drift K)^[n + K] 1 = (1 / 2 : ℝ) ^ K - n * ((1 / 2 : ℝ) ^ K / 2) := by
  induction n with
  | zero => simp [drift_agrees K K le_rfl]
  | succ n ih =>
    rw [show n + 1 + K = (n + K) + 1 by ring, Function.iterate_succ_apply', ih, drift, if_neg]
    · push_cast; ring
    · have : (0 : ℝ) ≤ n * ((1 / 2 : ℝ) ^ K / 2) := by positivity
      linarith

theorem drift_lip (K : ℕ) : LipBound 1 (drift K) := by
  intro x y
  have h1 := le_abs_self (x - y)
  have h2 := neg_abs_le (x - y)
  have ht : (0 : ℝ) < (1 / 2 : ℝ) ^ K := by positivity
  rw [Real.dist_eq, Real.dist_eq, one_mul, abs_le]
  unfold drift
  split_ifs with hx hy hy <;> constructor <;> linarith

theorem good_lip : LipBound (1 / 2) good := by
  intro x y
  simp only [good, Real.dist_eq]
  rw [show x / 2 - y / 2 = (x - y) / 2 by ring, abs_div]
  norm_num
  linarith

/-- **A2, trained depths certify nothing.** For any training depth `K` there are two loops that
agree exactly on every depth from 0 to `K`, one a `1/2`-contraction and the other merely
non-expansive (1-Lipschitz), and the second runs off to `-∞`. So no evaluation at trained depths,
however thorough, separates a safe loop from one that collapses, and even non-expansiveness is
not enough. The certificate has to be a property of the map, checked off the trajectory. -/
theorem trained_depths_certify_nothing (K : ℕ) :
    LipBound (1 / 2) good ∧ LipBound 1 (drift K) ∧
      (∀ k, k ≤ K → (drift K)^[k] 1 = good^[k] 1) ∧
      Tendsto (fun n => (drift K)^[n] 1) atTop atBot := by
  refine ⟨good_lip, drift_lip K, fun k hk => by rw [drift_agrees K k hk, good_iter], ?_⟩
  rw [← Filter.tendsto_add_atTop_iff_nat K]
  simp only [drift_after]
  set t : ℝ := (1 / 2 : ℝ) ^ K
  have ht : 0 < t := by positivity
  rw [tendsto_atBot]
  intro b
  obtain ⟨N, hN⟩ := exists_nat_gt ((t - b) / (t / 2))
  filter_upwards [eventually_ge_atTop N] with n hn
  have hnN : (N : ℝ) ≤ n := by exact_mod_cast hn
  have h2 : (t - b) / (t / 2) < n := lt_of_lt_of_le hN hnN
  rw [div_lt_iff₀ (by positivity)] at h2
  linarith

/-- **A3 in action.** With the trained loop's receipt `κ = 1/2`, the alarm fires on the
drifting loop at the first step past the trained depth, while its state is still bounded,
before anything has collapsed. By A3 it never fires on `good`. -/
theorem alarm_catches_drift (K : ℕ) :
    (1 / 2 : ℝ) * dist ((drift K)^[K] 1) ((drift K)^[K + 1] 1)
        < dist ((drift K)^[K + 1] 1) ((drift K)^[K + 2] 1) ∧
      (∀ x k, dist (good^[k + 1] x) (good^[k + 2] x) ≤ 1 / 2 * dist (good^[k] x) (good^[k + 1] x)) := by
  refine ⟨?_, fun x k => step_ratio_alarm_sound good_lip x k⟩
  have e0 := drift_after K 0
  have e1 := drift_after K 1
  have e2 := drift_after K 2
  rw [show 0 + K = K by ring] at e0
  rw [show 1 + K = K + 1 by ring] at e1
  rw [show 2 + K = K + 2 by ring] at e2
  rw [e0, e1, e2, Real.dist_eq, Real.dist_eq]
  have ht : (0 : ℝ) < (1 / 2 : ℝ) ^ K := by positivity
  push_cast
  rw [abs_of_pos (by linarith), abs_of_pos (by linarith)]
  linarith

end Extrapolation

end TokenRouting

/- Axiom audit: expected output is only `propext`, `Classical.choice`, `Quot.sound`. -/
#print axioms TokenRouting.common_metric_arbitrary_switching
#print axioms TokenRouting.token_routing_stable
#print axioms TokenRouting.token_routing_converges
#print axioms TokenRouting.common_metric_gives_receipt
#print axioms TokenRouting.receipts_compose
#print axioms TokenRouting.path_count
#print axioms TokenRouting.separation
#print axioms TokenRouting.adaptive_router_bounded
#print axioms TokenRouting.hard_state_router_breaks_uniqueness
#print axioms TokenRouting.certified_exit
#print axioms TokenRouting.exit_fires
#print axioms TokenRouting.settling_without_receipt_is_uninformative
#print axioms TokenRouting.edit_blast_radius
#print axioms TokenRouting.soft_mixture_lipschitz
#print axioms TokenRouting.soft_mixture_unique_fixed_point
#print axioms TokenRouting.soft_router_repairs_hard_router
#print axioms TokenRouting.mixture_of_recursion
#print axioms TokenRouting.adaptive_exit_agreement
#print axioms TokenRouting.depth_gain
#print axioms TokenRouting.depth_gain_tight
#print axioms TokenRouting.G_le_depth
#print axioms TokenRouting.G_le_inv
#print axioms TokenRouting.G_expansive
#print axioms TokenRouting.fixed_point_sensitivity
#print axioms TokenRouting.required_injection
#print axioms TokenRouting.no_injection_erases_input
#print axioms TokenRouting.memory_horizon
#print axioms TokenRouting.contraction_realizes_any_target
#print axioms TokenRouting.append_only_memory_rescue
#print axioms TokenRouting.contraction_sawtooth_lower_bound
#print axioms TokenRouting.receipt_costs_no_capacity
#print axioms TokenRouting.capacity_separation
#print axioms TokenRouting.hybrid_lip
#print axioms TokenRouting.hybrid_routing_stable
#print axioms TokenRouting.hybrid_tracks
#print axioms TokenRouting.hybrid_adaptive_exit
#print axioms TokenRouting.composition_beats_contraction
#print axioms TokenRouting.more_depth_never_hurts
#print axioms TokenRouting.no_depth_collapse
#print axioms TokenRouting.step_ratio_alarm_sound
#print axioms TokenRouting.alarm_refutes_receipt
#print axioms TokenRouting.trained_depths_certify_nothing
#print axioms TokenRouting.alarm_catches_drift
