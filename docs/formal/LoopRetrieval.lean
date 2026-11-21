/-
# Retrieval inside the loop: hard retrieval can cycle, soft retrieval can contract

Claim 3 of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`,
§1.2.4).

Nothing here is new mathematics: piecewise contractions (Bruin & Deane 2009; Nogueira & Pires 2015),
Banach's theorem, and the softmax Lipschitz constant ½ (Gao & Pavel 2017; Nair 2025, sharp). The
example map and the blur-band lemma are elementary instances written for the certificate.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopRetrieval.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 26 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Topology.MetricSpace.Contracting
import Mathlib.Algebra.Order.Archimedean.Basic
import Mathlib.Data.Finset.Max
import Mathlib.Algebra.Order.BigOperators.Group.Finset
import Mathlib.Algebra.BigOperators.Ring.Finset
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.Ring
import Mathlib.Tactic.FieldSimp

/-!
# Claim 3: retrieval inside the loop

* 3a. Hard retrieval: `f x = x/2 + 1` for `x < 1`, `f x = x/2 - 1` for `x ≥ 1`.
  No fixed point, a 3-cycle `{-2/7, 6/7, 10/7}`, and EVERY orbit locks onto it.
* 3b. Soft retrieval: the composition/contraction step, Banach (unique resting point),
  the a-posteriori stop rule, the temperature condition, and the softmax Jacobian bound
  `‖(diag s - s sᵀ) v‖² ≤ ¼ ‖v‖²` for every probability vector `s` (sharp).
* 3c. The exchange step behind "entropy is monotone in temperature", and a
  blur-band lemma: a Lipschitz loop cannot switch retrieval outcomes abruptly.
-/

open Filter
open scoped NNReal Topology

namespace Claim3

/-! ## 3a. Hard retrieval destroys the resting point -/

/-- The hard-retrieval loop: retrieve `+1` below the threshold `1`, `-1` above it. -/
noncomputable def f (x : ℝ) : ℝ := if x < 1 then x / 2 + 1 else x / 2 - 1

lemma f_lt (x : ℝ) (h : x < 1) : f x = x / 2 + 1 := by
  unfold f; rw [if_pos h]

lemma f_ge (x : ℝ) (h : 1 ≤ x) : f x = x / 2 - 1 := by
  unfold f; rw [if_neg (not_lt.mpr h)]

/-- `f` has no fixed point. -/
theorem f_no_fixed_point (x : ℝ) : f x ≠ x := by
  intro hx
  rcases lt_or_ge x 1 with h | h
  · rw [f_lt x h] at hx; linarith
  · rw [f_ge x h] at hx; linarith

theorem cycle_1 : f (-2/7) = 6/7 := by rw [f_lt (-2/7) (by norm_num)]; norm_num
theorem cycle_2 : f (6/7) = 10/7 := by rw [f_lt (6/7) (by norm_num)]; norm_num
theorem cycle_3 : f (10/7) = -2/7 := by rw [f_ge (10/7) (by norm_num)]; norm_num

/-- `{-2/7, 6/7, 10/7}` is a 3-cycle: `-2/7 ↦ 6/7 ↦ 10/7 ↦ -2/7`. -/
theorem three_cycle : f (-2/7) = 6/7 ∧ f (6/7) = 10/7 ∧ f (10/7) = -2/7 :=
  ⟨cycle_1, cycle_2, cycle_3⟩

theorem three_cycle_iterate : f^[3] (-2/7) = -2/7 := by
  have e : f^[3] (-2/7) = f (f (f (-2/7))) := rfl
  rw [e, cycle_1, cycle_2, cycle_3]

/-- `f` is not injective on `ℝ` ... -/
theorem f_not_injective : f (-3) = f 1 := by
  rw [f_lt (-3) (by norm_num), f_ge 1 (by norm_num)]; norm_num

/-- ... but it is injective on its absorbing interval `[-1/2, 3/2]`. -/
theorem f_injOn_I (x y : ℝ) (hx1 : -1/2 ≤ x) (hx2 : x ≤ 3/2) (hy1 : -1/2 ≤ y) (hy2 : y ≤ 3/2)
    (h : f x = f y) : x = y := by
  rcases lt_or_ge x 1 with hx | hx <;> rcases lt_or_ge y 1 with hy | hy
  · rw [f_lt x hx, f_lt y hy] at h; linarith
  · rw [f_lt x hx, f_ge y hy] at h; linarith
  · rw [f_ge x hx, f_lt y hy] at h; linarith
  · rw [f_ge x hx, f_ge y hy] at h; linarith

/-- The trapping set `K = [-5/16, -1/4) ∪ [3/4, 7/8) ∪ [11/8, 23/16]`. -/
def inK (x : ℝ) : Prop :=
  (-5/16 ≤ x ∧ x < -1/4) ∨ (3/4 ≤ x ∧ x < 7/8) ∨ (11/8 ≤ x ∧ x ≤ 23/16)

/-- The cycle point lying in the same piece of `K` as `x`. -/
noncomputable def proj (x : ℝ) : ℝ := if x < 1/2 then -2/7 else if x < 1 then 6/7 else 10/7

lemma proj_A (x : ℝ) (h : x < 1/2) : proj x = -2/7 := by
  unfold proj; rw [if_pos h]

lemma proj_B (x : ℝ) (h1 : 1/2 ≤ x) (h2 : x < 1) : proj x = 6/7 := by
  have h1' : ¬ (x < 1/2) := not_lt.mpr h1
  unfold proj; rw [if_neg h1', if_pos h2]

lemma proj_C (x : ℝ) (h : 1 ≤ x) : proj x = 10/7 := by
  have h1 : ¬ (x < 1/2) := not_lt.mpr (by linarith)
  have h2 : ¬ (x < 1) := not_lt.mpr h
  unfold proj; rw [if_neg h1, if_neg h2]

lemma proj_mem (y : ℝ) : proj y = -2/7 ∨ proj y = 6/7 ∨ proj y = 10/7 := by
  unfold proj
  split_ifs <;> norm_num

/-- One step on `K`: stays in `K`, the phase advances along the cycle, and the distance
to the cycle point is halved. -/
lemma shadow (x : ℝ) (hx : inK x) :
    inK (f x) ∧ proj (f x) = f (proj x) ∧ f x - proj (f x) = (x - proj x) / 2 := by
  unfold inK at hx
  rcases hx with ⟨h1, h2⟩ | ⟨h1, h2⟩ | ⟨h1, h2⟩
  · have e1 : f x = x / 2 + 1 := f_lt x (by linarith)
    have e2 : proj x = -2/7 := proj_A x (by linarith)
    have e3 : proj (x / 2 + 1) = 6/7 := proj_B (x / 2 + 1) (by linarith) (by linarith)
    rw [e1, e2, e3, cycle_1]
    refine ⟨?_, rfl, by ring⟩
    unfold inK; right; left; constructor <;> linarith
  · have e1 : f x = x / 2 + 1 := f_lt x (by linarith)
    have e2 : proj x = 6/7 := proj_B x (by linarith) (by linarith)
    have e3 : proj (x / 2 + 1) = 10/7 := proj_C (x / 2 + 1) (by linarith)
    rw [e1, e2, e3, cycle_2]
    refine ⟨?_, rfl, by ring⟩
    unfold inK; right; right; constructor <;> linarith
  · have e1 : f x = x / 2 - 1 := f_ge x (by linarith)
    have e2 : proj x = 10/7 := proj_C x (by linarith)
    have e3 : proj (x / 2 - 1) = -2/7 := proj_A (x / 2 - 1) (by linarith)
    rw [e1, e2, e3, cycle_3]
    refine ⟨?_, rfl, by ring⟩
    unfold inK; left; constructor <;> linarith

lemma shadow_iter (x : ℝ) (hx : inK x) (n : ℕ) :
    inK (f^[n] x) ∧ proj (f^[n] x) = f^[n] (proj x) ∧
      f^[n] x - f^[n] (proj x) = (x - proj x) / 2 ^ n := by
  induction n with
  | zero =>
    refine ⟨hx, rfl, ?_⟩
    show x - proj x = (x - proj x) / 2 ^ 0
    rw [pow_zero, div_one]
  | succ n ih =>
    obtain ⟨h1, h2, h3⟩ := ih
    obtain ⟨k1, k2, k3⟩ := shadow (f^[n] x) h1
    rw [Function.iterate_succ_apply' f n x, Function.iterate_succ_apply' f n (proj x)]
    refine ⟨k1, ?_, ?_⟩
    · rw [k2, h2]
    · rw [← h2, ← k2, k3, h2, h3, pow_succ, div_div]

lemma abs_f_le (y : ℝ) : |f y| ≤ |y| / 2 + 1 := by
  have h1 := le_abs_self y
  have h2 := neg_abs_le y
  rcases lt_or_ge y 1 with h | h
  · rw [f_lt y h, abs_le]; constructor <;> linarith
  · rw [f_ge y h, abs_le]; constructor <;> linarith

lemma iter_abs_le (x : ℝ) (n : ℕ) : |f^[n] x| ≤ |x| / 2 ^ n + 2 := by
  induction n with
  | zero =>
    show |x| ≤ |x| / 2 ^ 0 + 2
    rw [pow_zero, div_one]; linarith
  | succ n ih =>
    rw [Function.iterate_succ_apply' f n x]
    have h := abs_f_le (f^[n] x)
    have e : |x| / 2 ^ (n + 1) = |x| / 2 ^ n / 2 := by rw [pow_succ, div_div]
    rw [e]
    linarith

/-- Every orbit enters the absorbing interval `[-1/2, 3/2]`. -/
lemma enter_I (x : ℝ) : ∃ N : ℕ, -1/2 ≤ f^[N] x ∧ f^[N] x ≤ 3/2 := by
  obtain ⟨n, hn⟩ := pow_unbounded_of_one_lt |x| (by norm_num : (1:ℝ) < 2)
  have hpos : (0:ℝ) < 2 ^ n := by positivity
  have h1 : |x| / 2 ^ n < 1 := (div_lt_one hpos).mpr hn
  have h2 := iter_abs_le x n
  have h3 : |f^[n] x| < 3 := by linarith
  refine ⟨n + 1, ?_⟩
  rw [Function.iterate_succ_apply' f n x]
  rw [abs_lt] at h3
  obtain ⟨h4, h5⟩ := h3
  rcases lt_or_ge (f^[n] x) 1 with h | h
  · rw [f_lt _ h]; constructor <;> linarith
  · rw [f_ge _ h]; constructor <;> linarith

/-- Three steps map `[-1/2, 3/2]` into `K`. -/
lemma I_to_K (y : ℝ) (h1 : -1/2 ≤ y) (h2 : y ≤ 3/2) : inK (f^[3] y) := by
  show inK (f (f (f y)))
  unfold inK
  rcases lt_or_ge y 1 with hy | hy
  · rw [f_lt y hy]
    rcases lt_or_ge y 0 with hy0 | hy0
    · rw [f_lt (y / 2 + 1) (by linarith), f_ge ((y / 2 + 1) / 2 + 1) (by linarith)]
      left; constructor <;> linarith
    · rw [f_ge (y / 2 + 1) (by linarith), f_lt ((y / 2 + 1) / 2 - 1) (by linarith)]
      right; left; constructor <;> linarith
  · rw [f_ge y hy, f_lt (y / 2 - 1) (by linarith), f_lt ((y / 2 - 1) / 2 + 1) (by linarith)]
    right; right; constructor <;> linarith

/-- **Every** orbit locks onto the 3-cycle: after `N` steps it shadows the cycle orbit of a
cycle point `p`, and the gap halves at every step (exactly). -/
theorem orbit_locks_onto_cycle (x : ℝ) :
    ∃ N : ℕ, ∃ p : ℝ, (p = -2/7 ∨ p = 6/7 ∨ p = 10/7) ∧
      ∀ n : ℕ, f^[n + N] x - f^[n] p = (f^[N] x - p) / 2 ^ n := by
  obtain ⟨M, hM1, hM2⟩ := enter_I x
  have hK : inK (f^[3 + M] x) := by
    rw [Function.iterate_add_apply f 3 M x]
    exact I_to_K (f^[M] x) hM1 hM2
  refine ⟨3 + M, proj (f^[3 + M] x), proj_mem _, fun n => ?_⟩
  rw [Function.iterate_add_apply f n (3 + M) x]
  exact (shadow_iter _ hK n).2.2

/-- The same, as a limit statement. -/
theorem orbit_tendsto_cycle (x : ℝ) :
    ∃ N : ℕ, ∃ p : ℝ, (p = -2/7 ∨ p = 6/7 ∨ p = 10/7) ∧
      Tendsto (fun n : ℕ => f^[n + N] x - f^[n] p) atTop (𝓝 0) := by
  obtain ⟨N, p, hp, h⟩ := orbit_locks_onto_cycle x
  refine ⟨N, p, hp, ?_⟩
  have h2 : Tendsto (fun n : ℕ => (f^[N] x - p) * (1/2 : ℝ) ^ n) atTop
      (𝓝 ((f^[N] x - p) * 0)) :=
    (tendsto_pow_atTop_nhds_zero_of_lt_one (r := (1/2 : ℝ)) (by norm_num) (by norm_num)).const_mul _
  rw [mul_zero] at h2
  refine h2.congr (fun n => ?_)
  show (f^[N] x - p) * (1/2 : ℝ) ^ n = f^[n + N] x - f^[n] p
  rw [h n, one_div_pow, mul_one_div]

/-- The residual `|f x - x|` is always above `1/2`: a stop rule `|h_{k+1} - h_k| ≤ ε` with
`ε ≤ 1/2` never fires, from any start. -/
theorem residual_gt_half (x : ℝ) : 1/2 < |f x - x| := by
  rw [lt_abs]
  rcases lt_or_ge x 1 with h | h
  · left; rw [f_lt x h]; linarith
  · right; rw [f_ge x h]; linarith

lemma cycle_mem_f (p : ℝ) (hp : p = -2/7 ∨ p = 6/7 ∨ p = 10/7) :
    f p = -2/7 ∨ f p = 6/7 ∨ f p = 10/7 := by
  rcases hp with rfl | rfl | rfl
  · right; left; exact cycle_1
  · right; right; exact cycle_2
  · left; exact cycle_3

lemma cycle_mem_iter (p : ℝ) (hp : p = -2/7 ∨ p = 6/7 ∨ p = 10/7) (n : ℕ) :
    f^[n] p = -2/7 ∨ f^[n] p = 6/7 ∨ f^[n] p = 10/7 := by
  induction n with
  | zero => exact hp
  | succ n ih =>
    rw [Function.iterate_succ_apply' f n p]
    exact cycle_mem_f _ ih

lemma cycle_period3 (p : ℝ) (hp : p = -2/7 ∨ p = 6/7 ∨ p = 10/7) : f^[3] p = p := by
  have e : f^[3] p = f (f (f p)) := rfl
  rw [e]
  rcases hp with rfl | rfl | rfl
  · rw [cycle_1, cycle_2, cycle_3]
  · rw [cycle_2, cycle_3, cycle_1]
  · rw [cycle_3, cycle_1, cycle_2]

/-- The 3-cycle is the only periodic orbit of `f`. -/
theorem periodic_points_in_cycle (x : ℝ) (m : ℕ) (hm : 0 < m) (hx : f^[m] x = x) :
    x = -2/7 ∨ x = 6/7 ∨ x = 10/7 := by
  obtain ⟨N, p, hp, h⟩ := orbit_locks_onto_cycle x
  have hxm : ∀ k : ℕ, f^[m * k] x = x := fun k => by
    rw [Function.iterate_mul]; exact Function.iterate_fixed hx k
  have hp3 : ∀ k : ℕ, f^[3 * k] p = p := fun k => by
    rw [Function.iterate_mul]; exact Function.iterate_fixed (cycle_period3 p hp) k
  have h1 := h (3 * m)
  have e1 : f^[3 * m + N] x = f^[N] x := by
    rw [add_comm, Function.iterate_add_apply f N (3 * m) x, mul_comm, hxm 3]
  rw [e1, hp3 m] at h1
  have hpow : (1:ℝ) < 2 ^ (3 * m) := one_lt_pow₀ (by norm_num) (by omega)
  have hpos : (0:ℝ) < 2 ^ (3 * m) := by positivity
  have h2 : (f^[N] x - p) * 2 ^ (3 * m) = f^[N] x - p := (eq_div_iff hpos.ne').mp h1
  have h3 : (f^[N] x - p) * (2 ^ (3 * m) - 1) = 0 := by
    rw [mul_sub, mul_one, h2, sub_self]
  have hN : f^[N] x = p := by
    rcases mul_eq_zero.mp h3 with h4 | h4
    · linarith
    · linarith
  have hle : N ≤ m * N := Nat.le_mul_of_pos_left N hm
  have e3 : x = f^[m * N - N] p := by
    calc x = f^[m * N] x := (hxm N).symm
      _ = f^[m * N - N + N] x := by rw [Nat.sub_add_cancel hle]
      _ = f^[m * N - N] (f^[N] x) := Function.iterate_add_apply f (m * N - N) N x
      _ = f^[m * N - N] p := by rw [hN]
  rw [e3]
  exact cycle_mem_iter p hp (m * N - N)

/-- Hard retrieval in general: if the update on cell `k` is the contraction `Gk k`, then `x` is a
resting point of the loop iff `x` is the resting point of its own cell's map. -/
theorem piecewise_rest_point_iff {E ι : Type*} [MetricSpace E] [CompleteSpace E] [Nonempty E]
    (cell : E → ι) (Gk : ι → E → E) (K : ι → ℝ≥0) (hK : ∀ k, ContractingWith (K k) (Gk k))
    (x : E) :
    Gk (cell x) x = x ↔ x = ContractingWith.fixedPoint (Gk (cell x)) (hK (cell x)) := by
  constructor
  · intro h
    exact (hK (cell x)).fixedPoint_unique h
  · intro h
    calc Gk (cell x) x
        = Gk (cell x) (ContractingWith.fixedPoint (Gk (cell x)) (hK (cell x))) :=
          congrArg (Gk (cell x)) h
      _ = ContractingWith.fixedPoint (Gk (cell x)) (hK (cell x)) :=
          (hK (cell x)).fixedPoint_isFixedPt
      _ = x := h.symm

/-- So hard retrieval has no resting point iff every cell's own resting point lies in another
cell (as for `f`: the `+1` branch rests at `2 ≥ 1`, the `-1` branch at `-2 < 1`). -/
theorem piecewise_no_rest_point_iff {E ι : Type*} [MetricSpace E] [CompleteSpace E] [Nonempty E]
    (cell : E → ι) (Gk : ι → E → E) (K : ι → ℝ≥0) (hK : ∀ k, ContractingWith (K k) (Gk k)) :
    (∀ x, Gk (cell x) x ≠ x) ↔ ∀ k, cell (ContractingWith.fixedPoint (Gk k) (hK k)) ≠ k := by
  constructor
  · intro h k hk
    apply h (ContractingWith.fixedPoint (Gk k) (hK k))
    rw [hk]
    exact (hK k).fixedPoint_isFixedPt
  · intro h x hx
    apply h (cell x)
    rw [← (hK (cell x)).fixedPoint_unique hx]

/-! ## 3b. Soft retrieval keeps the contraction -/

/-- Composition step: `G h = F h (r h)` is `(L + Lo * Lr)`-Lipschitz. -/
theorem lipschitz_feedback {E O : Type*} [PseudoMetricSpace E] [PseudoMetricSpace O]
    (F : E → O → E) (r : E → O) (L Lo Lr : ℝ≥0)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hr : LipschitzWith Lr r) :
    LipschitzWith (L + Lo * Lr) (fun h => F h (r h)) := by
  apply LipschitzWith.of_dist_le_mul
  intro x y
  have h1 : dist (F x (r x)) (F y (r x)) ≤ L * dist x y := (hF1 (r x)).dist_le_mul x y
  have h2 : dist (F y (r x)) (F y (r y)) ≤ Lo * dist (r x) (r y) :=
    (hF2 y).dist_le_mul (r x) (r y)
  have h3 : dist (r x) (r y) ≤ Lr * dist x y := hr.dist_le_mul x y
  have h4 : (Lo : ℝ) * dist (r x) (r y) ≤ Lo * (Lr * dist x y) :=
    mul_le_mul_of_nonneg_left h3 Lo.coe_nonneg
  calc dist (F x (r x)) (F y (r y))
      ≤ dist (F x (r x)) (F y (r x)) + dist (F y (r x)) (F y (r y)) := dist_triangle _ _ _
    _ ≤ L * dist x y + Lo * (Lr * dist x y) := by linarith
    _ = ((L + Lo * Lr : ℝ≥0) : ℝ) * dist x y := by push_cast; ring

theorem feedback_contracting {E O : Type*} [MetricSpace E] [PseudoMetricSpace O]
    (F : E → O → E) (r : E → O) (L Lo Lr : ℝ≥0)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hr : LipschitzWith Lr r) (hK : L + Lo * Lr < 1) :
    ContractingWith (L + Lo * Lr) (fun h => F h (r h)) :=
  ⟨hK, lipschitz_feedback F r L Lo Lr hF1 hF2 hr⟩

/-- Banach: a unique resting point. -/
theorem feedback_unique_rest_point {E O : Type*} [MetricSpace E] [CompleteSpace E] [Nonempty E]
    [PseudoMetricSpace O]
    (F : E → O → E) (r : E → O) (L Lo Lr : ℝ≥0)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hr : LipschitzWith Lr r) (hK : L + Lo * Lr < 1) :
    ∃! hstar : E, F hstar (r hstar) = hstar := by
  have hG := feedback_contracting F r L Lo Lr hF1 hF2 hr hK
  exact ⟨ContractingWith.fixedPoint _ hG, hG.fixedPoint_isFixedPt,
    fun y hy => hG.fixedPoint_unique hy⟩

/-- The stop rule: if one more pass moves the state by at most `ε (1 - K)`, the state is
within `ε` of the resting point. -/
theorem feedback_stop_rule {E O : Type*} [MetricSpace E] [CompleteSpace E] [Nonempty E]
    [PseudoMetricSpace O]
    (F : E → O → E) (r : E → O) (L Lo Lr : ℝ≥0)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hr : LipschitzWith Lr r) (hK : L + Lo * Lr < 1) (x0 : E) (ε : ℝ)
    (hstop : dist x0 (F x0 (r x0)) ≤ ε * (1 - ((L + Lo * Lr : ℝ≥0) : ℝ))) :
    dist x0 (ContractingWith.fixedPoint (fun h => F h (r h))
      (feedback_contracting F r L Lo Lr hF1 hF2 hr hK)) ≤ ε := by
  have hG := feedback_contracting F r L Lo Lr hF1 hF2 hr hK
  have hpos : (0:ℝ) < 1 - ((L + Lo * Lr : ℝ≥0) : ℝ) := hG.one_sub_K_pos
  have h1 := hG.dist_fixedPoint_le x0
  calc dist x0 (ContractingWith.fixedPoint _ hG)
      ≤ dist x0 (F x0 (r x0)) / (1 - ((L + Lo * Lr : ℝ≥0) : ℝ)) := h1
    _ ≤ ε := by rw [div_le_iff₀ hpos]; exact hstop

/-- Iterates converge to the resting point from any start. -/
theorem feedback_iterates_converge {E O : Type*} [MetricSpace E] [CompleteSpace E] [Nonempty E]
    [PseudoMetricSpace O]
    (F : E → O → E) (r : E → O) (L Lo Lr : ℝ≥0)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hr : LipschitzWith Lr r) (hK : L + Lo * Lr < 1) (x0 : E) :
    Tendsto (fun n => (fun h => F h (r h))^[n] x0) atTop
      (𝓝 (ContractingWith.fixedPoint (fun h => F h (r h))
        (feedback_contracting F r L Lo Lr hF1 hF2 hr hK))) :=
  (feedback_contracting F r L Lo Lr hF1 hF2 hr hK).tendsto_iterate_fixedPoint x0

/-- The arithmetic of the temperature condition. -/
theorem temperature_condition (L Lo Kv A τ : ℝ) (hL : L < 1) (hτ : 0 < τ)
    (h : Lo * Kv * A / (2 * (1 - L)) < τ) :
    L + Lo * (Kv * (1/2) * (A / τ)) < 1 := by
  have h1L : 0 < 2 * (1 - L) := by linarith
  have h2τ : 0 < 2 * τ := by linarith
  have h2 : Lo * Kv * A < τ * (2 * (1 - L)) := (div_lt_iff₀ h1L).mp h
  have h3 : Lo * (Kv * (1/2) * (A / τ)) = Lo * Kv * A / (2 * τ) := by ring1
  have h2' : τ * (2 * (1 - L)) = (1 - L) * (2 * τ) := by ring
  have h4 : Lo * Kv * A / (2 * τ) < 1 - L := by
    rw [div_lt_iff₀ h2τ]
    linarith
  rw [h3]
  linarith

/-- Soft retrieval `r = val ∘ σ ∘ q` (query map `q` with Lipschitz constant `A/τ`, softmax `σ`
with Lipschitz constant `1/2`, value read-out `val` with constant `Kv`): the loop is a
contraction once `τ > Lo Kv A / (2 (1 - L))`. -/
theorem soft_retrieval_contracting
    {E Q P O : Type*} [MetricSpace E] [PseudoMetricSpace Q] [PseudoMetricSpace P]
    [PseudoMetricSpace O]
    (F : E → O → E) (q : E → Q) (σ : Q → P) (val : P → O)
    (L Lo Kv A τ : ℝ≥0) (hτ : 0 < τ)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hq : LipschitzWith (A / τ) q) (hσ : LipschitzWith (1/2) σ) (hv : LipschitzWith Kv val)
    (hL : L < 1) (htemp : (Lo : ℝ) * Kv * A / (2 * (1 - (L : ℝ))) < τ) :
    ContractingWith (L + Lo * (Kv * (1/2) * (A / τ))) (fun h => F h (val (σ (q h)))) := by
  have hr : LipschitzWith (Kv * (1/2) * (A / τ)) (val ∘ σ ∘ q) := (hv.comp hσ).comp hq
  refine feedback_contracting F (val ∘ σ ∘ q) L Lo _ hF1 hF2 hr ?_
  have hreal := temperature_condition L Lo Kv A τ (by exact_mod_cast hL) (by exact_mod_cast hτ)
    htemp
  exact_mod_cast hreal

theorem soft_retrieval_unique_rest_point
    {E Q P O : Type*} [MetricSpace E] [CompleteSpace E] [Nonempty E]
    [PseudoMetricSpace Q] [PseudoMetricSpace P] [PseudoMetricSpace O]
    (F : E → O → E) (q : E → Q) (σ : Q → P) (val : P → O)
    (L Lo Kv A τ : ℝ≥0) (hτ : 0 < τ)
    (hF1 : ∀ o, LipschitzWith L (fun h => F h o))
    (hF2 : ∀ h, LipschitzWith Lo (F h))
    (hq : LipschitzWith (A / τ) q) (hσ : LipschitzWith (1/2) σ) (hv : LipschitzWith Kv val)
    (hL : L < 1) (htemp : (Lo : ℝ) * Kv * A / (2 * (1 - (L : ℝ))) < τ) :
    ∃! hstar : E, F hstar (val (σ (q hstar))) = hstar := by
  have hG := soft_retrieval_contracting F q σ val L Lo Kv A τ hτ hF1 hF2 hq hσ hv hL htemp
  exact ⟨ContractingWith.fixedPoint _ hG, hG.fixedPoint_isFixedPt,
    fun y hy => hG.fixedPoint_unique hy⟩

/-! ### The softmax Jacobian bound

For a probability vector `s` (every softmax output is one), `J = diag s - s sᵀ` acts by
`(J v)_i = s_i v_i - s_i ⟨s, v⟩`. We prove `0 ≤ vᵀ J v ≤ ½ ‖v‖²` and `‖J v‖² ≤ ¼ ‖v‖²`,
i.e. `‖J‖₂ ≤ 1/2`, and that equality holds for `s = (1/2, 1/2)`. -/

section Softmax

variable {ι : Type*}

lemma var_eq (S : Finset ι) (s x : ι → ℝ) (hsum : ∑ i ∈ S, s i = 1) (c : ℝ) :
    ∑ i ∈ S, s i * (x i - c) ^ 2
      = (∑ i ∈ S, s i * x i ^ 2 - (∑ i ∈ S, s i * x i) ^ 2) + (∑ i ∈ S, s i * x i - c) ^ 2 := by
  have e : ∑ i ∈ S, s i * (x i - c) ^ 2
      = ∑ i ∈ S, s i * x i ^ 2 - 2 * c * ∑ i ∈ S, s i * x i + c ^ 2 * ∑ i ∈ S, s i := by
    rw [Finset.mul_sum, Finset.mul_sum, ← Finset.sum_sub_distrib, ← Finset.sum_add_distrib]
    exact Finset.sum_congr rfl (fun i _ => by ring)
  rw [e, hsum]
  ring

/-- `vᵀ J v ≥ 0`: the quadratic form is a variance. -/
lemma var_nonneg (S : Finset ι) (s x : ι → ℝ) (hs : ∀ i ∈ S, 0 ≤ s i)
    (hsum : ∑ i ∈ S, s i = 1) :
    0 ≤ ∑ i ∈ S, s i * x i ^ 2 - (∑ i ∈ S, s i * x i) ^ 2 := by
  have h := var_eq S s x hsum (∑ i ∈ S, s i * x i)
  have h2 : 0 ≤ ∑ i ∈ S, s i * (x i - ∑ j ∈ S, s j * x j) ^ 2 :=
    Finset.sum_nonneg (fun i hi => mul_nonneg (hs i hi) (sq_nonneg _))
  have h3 : (∑ i ∈ S, s i * x i - ∑ i ∈ S, s i * x i) ^ 2 = 0 := by ring
  linarith

/-- `vᵀ J v ≤ ½ ‖v‖²` (Popoviciu's variance inequality plus `(a-b)² ≤ 2(a²+b²)`). -/
theorem softmax_quad_le (S : Finset ι) (s v : ι → ℝ) (hs : ∀ i ∈ S, 0 ≤ s i)
    (hsum : ∑ i ∈ S, s i = 1) :
    ∑ i ∈ S, s i * v i ^ 2 - (∑ i ∈ S, s i * v i) ^ 2 ≤ (1/2) * ∑ i ∈ S, v i ^ 2 := by
  classical
  have hne : S.Nonempty := by
    rcases S.eq_empty_or_nonempty with h | h
    · rw [h, Finset.sum_empty] at hsum; norm_num at hsum
    · exact h
  obtain ⟨a, ha, hamax⟩ := S.exists_max_image v hne
  obtain ⟨b, hb, hbmin⟩ := S.exists_min_image v hne
  have hvar := var_eq S s v hsum ((v a + v b) / 2)
  have hpt : ∀ i ∈ S, s i * (v i - (v a + v b) / 2) ^ 2 ≤ s i * ((v a - v b) / 2) ^ 2 := by
    intro i hi
    have h1 := hamax i hi
    have h2 := hbmin i hi
    have key : 0 ≤ (v a - v i) * (v i - v b) := mul_nonneg (sub_nonneg.mpr h1) (sub_nonneg.mpr h2)
    have h3 : (v i - (v a + v b) / 2) ^ 2 ≤ ((v a - v b) / 2) ^ 2 := by nlinarith [key]
    exact mul_le_mul_of_nonneg_left h3 (hs i hi)
  have hsum2 : ∑ i ∈ S, s i * (v i - (v a + v b) / 2) ^ 2 ≤ ((v a - v b) / 2) ^ 2 := by
    calc ∑ i ∈ S, s i * (v i - (v a + v b) / 2) ^ 2
        ≤ ∑ i ∈ S, s i * ((v a - v b) / 2) ^ 2 := Finset.sum_le_sum hpt
      _ = ((v a - v b) / 2) ^ 2 := by rw [← Finset.sum_mul, hsum, one_mul]
  have hsq : 0 ≤ (∑ i ∈ S, s i * v i - (v a + v b) / 2) ^ 2 := sq_nonneg _
  have hV : 0 ≤ ∑ i ∈ S, v i ^ 2 := Finset.sum_nonneg (fun i _ => sq_nonneg (v i))
  have hpair : ((v a - v b) / 2) ^ 2 ≤ (1/2) * ∑ i ∈ S, v i ^ 2 := by
    by_cases hab : a = b
    · have h0 : ((v a - v b) / 2) ^ 2 = 0 := by rw [hab]; ring
      rw [h0]; linarith
    · have hsub : ({a, b} : Finset ι) ⊆ S := by
        intro i hi
        rw [Finset.mem_insert, Finset.mem_singleton] at hi
        rcases hi with h | h
        · rw [h]; exact ha
        · rw [h]; exact hb
      have h2 : ∑ i ∈ ({a, b} : Finset ι), v i ^ 2 ≤ ∑ i ∈ S, v i ^ 2 :=
        Finset.sum_le_sum_of_subset_of_nonneg hsub (fun i _ _ => sq_nonneg (v i))
      rw [Finset.sum_pair hab] at h2
      have e3 := sq_nonneg (v a + v b)
      nlinarith [e3]
  calc ∑ i ∈ S, s i * v i ^ 2 - (∑ i ∈ S, s i * v i) ^ 2
      ≤ ∑ i ∈ S, s i * (v i - (v a + v b) / 2) ^ 2 := by
        rw [hvar]
        exact le_add_of_nonneg_right hsq
    _ ≤ ((v a - v b) / 2) ^ 2 := hsum2
    _ ≤ (1/2) * ∑ i ∈ S, v i ^ 2 := hpair

/-- `‖w‖² ≤ ¼ ‖v‖²` for `w = J v` (Cauchy–Schwarz for the covariance form, done by hand). -/
theorem jac_sq_le (S : Finset ι) (s v w : ι → ℝ) (hs : ∀ i ∈ S, 0 ≤ s i)
    (hsum : ∑ i ∈ S, s i = 1) (hw : ∀ i ∈ S, w i = s i * (v i - ∑ j ∈ S, s j * v j)) :
    ∑ i ∈ S, w i ^ 2 ≤ (1/4) * ∑ i ∈ S, v i ^ 2 := by
  have h0 : 0 ≤ ∑ i ∈ S, s i * (v i - 2 * w i) ^ 2 - (∑ i ∈ S, s i * (v i - 2 * w i)) ^ 2 :=
    var_nonneg S s (fun i => v i - 2 * w i) hs hsum
  have hv := softmax_quad_le S s v hs hsum
  have hwq := softmax_quad_le S s w hs hsum
  have hcov : ∑ i ∈ S, s i * v i * w i - (∑ j ∈ S, s j * v j) * ∑ i ∈ S, s i * w i
      = ∑ i ∈ S, w i ^ 2 := by
    rw [Finset.mul_sum, ← Finset.sum_sub_distrib]
    apply Finset.sum_congr rfl
    intro i hi
    rw [hw i hi]
    ring
  have hexp1 : ∑ i ∈ S, s i * (v i - 2 * w i) ^ 2
      = ∑ i ∈ S, s i * v i ^ 2 - 4 * ∑ i ∈ S, s i * v i * w i
        + 4 * ∑ i ∈ S, s i * w i ^ 2 := by
    rw [Finset.mul_sum, Finset.mul_sum, ← Finset.sum_sub_distrib, ← Finset.sum_add_distrib]
    apply Finset.sum_congr rfl
    intro i _
    ring
  have hexp2 : ∑ i ∈ S, s i * (v i - 2 * w i)
      = ∑ i ∈ S, s i * v i - 2 * ∑ i ∈ S, s i * w i := by
    rw [Finset.mul_sum, ← Finset.sum_sub_distrib]
    apply Finset.sum_congr rfl
    intro i _
    ring
  rw [hexp1, hexp2] at h0
  linarith

/-- **The softmax Jacobian bound** `‖(diag s - s sᵀ) v‖₂² ≤ ¼ ‖v‖₂²`, i.e. `‖J‖₂ ≤ 1/2`. -/
theorem softmax_jacobian_sq_le (S : Finset ι) (s v : ι → ℝ) (hs : ∀ i ∈ S, 0 ≤ s i)
    (hsum : ∑ i ∈ S, s i = 1) :
    ∑ i ∈ S, (s i * v i - s i * ∑ j ∈ S, s j * v j) ^ 2 ≤ (1/4) * ∑ i ∈ S, v i ^ 2 := by
  have e : ∀ i ∈ S, (s i * v i - s i * ∑ j ∈ S, s j * v j) ^ 2
      = (s i * (v i - ∑ j ∈ S, s j * v j)) ^ 2 := fun i _ => by ring
  rw [Finset.sum_congr rfl e]
  exact jac_sq_le S s v (fun i => s i * (v i - ∑ j ∈ S, s j * v j)) hs hsum (fun i _ => rfl)

end Softmax

/-- Sharpness: `s = softmax(0, 0) = (1/2, 1/2)`, `v = (1, -1)` gives equality,
so `1/2` cannot be lowered. -/
theorem softmax_bound_attained :
    ∑ i ∈ ({0, 1} : Finset ℕ),
        ((1/2 : ℝ) * (if i = 0 then 1 else -1)
          - (1/2 : ℝ) * ∑ j ∈ ({0, 1} : Finset ℕ), (1/2 : ℝ) * (if j = 0 then 1 else -1)) ^ 2
      = (1/4) * ∑ i ∈ ({0, 1} : Finset ℕ), (if i = 0 then (1:ℝ) else -1) ^ 2 := by
  simp only [Finset.sum_pair (show (0:ℕ) ≠ 1 by norm_num)]
  norm_num

/-! ## 3c. Stability against selectivity -/

/-- Exchange step: if `p τ` maximises `U + τ H` for every `τ > 0` (the Gibbs variational
principle, with `U q = ⟨q, z⟩` and `H` the Shannon entropy, has `p τ = softmax (z / τ)`),
then `τ ↦ H (p τ)` is non-decreasing. -/
theorem entropy_monotone_of_gibbs {P : Type*} (U H : P → ℝ) (p : ℝ → P)
    (hmax : ∀ τ, 0 < τ → ∀ q, U q + τ * H q ≤ U (p τ) + τ * H (p τ))
    {τ₁ τ₂ : ℝ} (h₁ : 0 < τ₁) (h₁₂ : τ₁ ≤ τ₂) : H (p τ₁) ≤ H (p τ₂) := by
  rcases eq_or_lt_of_le h₁₂ with h | h
  · subst h; exact le_refl _
  · have a := hmax τ₁ h₁ (p τ₂)
    have b := hmax τ₂ (lt_trans h₁ h) (p τ₁)
    by_contra hc
    have hc' : H (p τ₂) < H (p τ₁) := not_le.mp hc
    nlinarith [mul_pos (sub_pos.mpr h) (sub_pos.mpr hc')]

/-- Blur band: if a `q`-Lipschitz loop `G` is `ε`-close to the item-1 update `G₁` at `x` and to
the item-2 update `G₂` at `y` (`G₂` being `L`-Lipschitz), then the jump `‖G₁ x - G₂ x‖` that
hard switching would make is at most `2 ε + (q + L) ‖x - y‖`. -/
theorem blur_band {E : Type*} [PseudoMetricSpace E] (G G₁ G₂ : E → E) (q L : ℝ≥0)
    (hG : LipschitzWith q G) (hG₂ : LipschitzWith L G₂) (ε : ℝ) (x y : E)
    (h1 : dist (G x) (G₁ x) ≤ ε) (h2 : dist (G y) (G₂ y) ≤ ε) :
    dist (G₁ x) (G₂ x) ≤ 2 * ε + ((q : ℝ) + L) * dist x y := by
  have a : dist (G x) (G y) ≤ q * dist x y := hG.dist_le_mul x y
  have b : dist (G₂ x) (G₂ y) ≤ L * dist x y := hG₂.dist_le_mul x y
  have t1 := dist_triangle4 (G₁ x) (G x) (G y) (G₂ y)
  have t2 := dist_triangle (G₁ x) (G₂ y) (G₂ x)
  have c1 : dist (G₁ x) (G x) = dist (G x) (G₁ x) := dist_comm _ _
  have c2 : dist (G₂ y) (G₂ x) = dist (G₂ x) (G₂ y) := dist_comm _ _
  linarith

/-- The band-width form: points where retrieval is sharp on different items are at least
`(jump - 2ε) / (q + L)` apart. -/
theorem blur_band_width {E : Type*} [PseudoMetricSpace E] (G G₁ G₂ : E → E) (q L : ℝ≥0)
    (hqL : 0 < (q : ℝ) + L)
    (hG : LipschitzWith q G) (hG₂ : LipschitzWith L G₂) (ε : ℝ) (x y : E)
    (h1 : dist (G x) (G₁ x) ≤ ε) (h2 : dist (G y) (G₂ y) ≤ ε) :
    (dist (G₁ x) (G₂ x) - 2 * ε) / ((q : ℝ) + L) ≤ dist x y := by
  rw [div_le_iff₀ hqL]
  have := blur_band G G₁ G₂ q L hG hG₂ ε x y h1 h2
  linarith

end Claim3

#print axioms Claim3.f_no_fixed_point
#print axioms Claim3.three_cycle
#print axioms Claim3.three_cycle_iterate
#print axioms Claim3.f_not_injective
#print axioms Claim3.f_injOn_I
#print axioms Claim3.orbit_locks_onto_cycle
#print axioms Claim3.orbit_tendsto_cycle
#print axioms Claim3.residual_gt_half
#print axioms Claim3.periodic_points_in_cycle
#print axioms Claim3.piecewise_rest_point_iff
#print axioms Claim3.piecewise_no_rest_point_iff
#print axioms Claim3.lipschitz_feedback
#print axioms Claim3.feedback_contracting
#print axioms Claim3.feedback_unique_rest_point
#print axioms Claim3.feedback_stop_rule
#print axioms Claim3.feedback_iterates_converge
#print axioms Claim3.temperature_condition
#print axioms Claim3.soft_retrieval_contracting
#print axioms Claim3.soft_retrieval_unique_rest_point
#print axioms Claim3.var_nonneg
#print axioms Claim3.softmax_quad_le
#print axioms Claim3.softmax_jacobian_sq_le
#print axioms Claim3.softmax_bound_attained
#print axioms Claim3.entropy_monotone_of_gibbs
#print axioms Claim3.blur_band
#print axioms Claim3.blur_band_width
