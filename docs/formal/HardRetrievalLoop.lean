/-
# Hard top-k retrieval: cycles away from the cuts, and a stop rule that cannot certify a false rest

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: "an attractor at positive distance from the discontinuities is a
finite union of attracting cycles" is Catsigeras, Guiraud, Meyroneinc & Ugalde (2016), Thm 3.1. The
stop-rule lemmas apply the exact stop identity inside one cell.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/HardRetrievalLoop.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 20 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end (`cycle_gap` needs only `[propext, Quot.sound]`), and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Topology.MetricSpace.Pseudo.Lemmas
import Mathlib.Analysis.Normed.Module.Basic
import Mathlib.Topology.UniformSpace.Cauchy
import Mathlib.Analysis.SpecificLimits.Basic
import Mathlib.Algebra.Order.Archimedean.Basic
import Mathlib.Data.Fintype.Pigeonhole
import Mathlib.Dynamics.PeriodicPts.Defs
import Mathlib.Data.Set.Finite.Basic
import Mathlib.Data.Finset.Max
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Ring

/-!
# B2, step 5: "attractor at positive distance from the discontinuities ⇒ asymptotically periodic"

Abstract deterministic core, in any metric space `E`.  Hypotheses:
* `K` compact and forward invariant (`MapsTo f K K`);
* `LocContr f K δ q`: two points of `K` closer than `δ` are mapped `q`-closer, `0 ≤ q < 1`.

For a piecewise contraction whose pieces share the linear part `A` (`‖A‖ ≤ q`), this holds on any
compact invariant `K` lying at distance `≥ δ` from the discontinuity set (this file).

Results
* `lock_onto_cycle`: every orbit in `K` locks onto a periodic orbit: after `m` steps it is within
  `δ` of a point `z` with `f^[P] z = z`, `P > 0`, and the gap then shrinks like `q^n`.
* `periodic_points_finite`: `K` holds only finitely many periodic points.
* `residual_bounded_below`: if the limit cycle is not a fixed point, the step size
  `dist (f^[n+1] x) (f^[n] x)` stays above a positive constant: a step-size stop rule with a
  smaller threshold never fires.
-/

open Filter Topology Metric

namespace TopKCore

variable {E : Type*} [MetricSpace E]

/-- The local contraction hypothesis: on `K`, `f` contracts by `q` at scale `δ`. -/
def LocContr (f : E → E) (K : Set E) (δ q : ℝ) : Prop :=
  ∀ y ∈ K, ∀ y' ∈ K, dist y y' < δ → dist (f y) (f y') ≤ q * dist y y'

/-- Two `δ`-close points of `K` stay together forever, the gap shrinking like `q^n`. -/
lemma iterate_close (f : E → E) (K : Set E) (hmaps : Set.MapsTo f K K) (δ q : ℝ)
    (hq0 : 0 ≤ q) (hq1 : q ≤ 1) (hloc : LocContr f K δ q) {y y' : E} (hy : y ∈ K) (hy' : y' ∈ K)
    (hd : dist y y' < δ) (n : ℕ) :
    dist (f^[n] y) (f^[n] y') ≤ q ^ n * dist y y' := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [Function.iterate_succ_apply', Function.iterate_succ_apply']
    have hmem : f^[n] y ∈ K := hmaps.iterate n hy
    have hmem' : f^[n] y' ∈ K := hmaps.iterate n hy'
    have hqn : q ^ n ≤ 1 := pow_le_one₀ hq0 hq1
    have hd0 : 0 ≤ dist y y' := dist_nonneg
    have hle : q ^ n * dist y y' ≤ dist y y' := by
      have := mul_le_mul_of_nonneg_right hqn hd0
      linarith
    have hlt : dist (f^[n] y) (f^[n] y') < δ := by linarith
    calc dist (f (f^[n] y)) (f (f^[n] y')) ≤ q * dist (f^[n] y) (f^[n] y') :=
          hloc _ hmem _ hmem' hlt
      _ ≤ q * (q ^ n * dist y y') := mul_le_mul_of_nonneg_left ih hq0
      _ = q ^ (n + 1) * dist y y' := by ring

/-- Pigeonhole on a finite cover of `K` by `δ/2`-balls: some two orbit points are `δ`-close. -/
lemma exists_close_pair (f : E → E) (K : Set E) (hK : IsCompact K) (hmaps : Set.MapsTo f K K)
    (δ : ℝ) (hδ : 0 < δ) {y : E} (hy : y ∈ K) :
    ∃ i j : ℕ, i < j ∧ dist (f^[i] y) (f^[j] y) < δ := by
  obtain ⟨t, htfin, hcover⟩ :=
    Metric.totallyBounded_iff.mp hK.totallyBounded (δ / 2) (by linarith)
  have hex : ∀ n : ℕ, ∃ c : t, f^[n] y ∈ ball (c : E) (δ / 2) := by
    intro n
    have hmem : f^[n] y ∈ ⋃ c ∈ t, ball c (δ / 2) := hcover (hmaps.iterate n hy)
    rw [Set.mem_iUnion₂] at hmem
    obtain ⟨c, hc, hball⟩ := hmem
    exact ⟨⟨c, hc⟩, hball⟩
  choose g hg using hex
  haveI : Finite t := htfin.to_subtype
  obtain ⟨i, j, hij, hgij⟩ := Finite.exists_ne_map_eq_of_infinite g
  have hi := hg i
  have hj := hg j
  rw [hgij] at hi
  rw [mem_ball] at hi hj
  have hd : dist (f^[i] y) (f^[j] y) < δ := by
    calc dist (f^[i] y) (f^[j] y) ≤ dist (f^[i] y) (g j) + dist (f^[j] y) (g j) :=
          dist_triangle_right _ _ _
      _ < δ / 2 + δ / 2 := add_lt_add hi hj
      _ = δ := by ring
  rcases lt_or_gt_of_ne hij with h | h
  · exact ⟨i, j, h, hd⟩
  · exact ⟨j, i, h, by rw [dist_comm]; exact hd⟩

/-- **Every orbit locks onto a cycle.** -/
theorem lock_onto_cycle (f : E → E) (K : Set E) (hK : IsCompact K) (hmaps : Set.MapsTo f K K)
    (δ q : ℝ) (hδ : 0 < δ) (hq0 : 0 ≤ q) (hq1 : q < 1) (hloc : LocContr f K δ q)
    {y : E} (hy : y ∈ K) :
    ∃ m P : ℕ, ∃ z ∈ K, 0 < P ∧ f^[P] z = z ∧ dist (f^[m] y) z < δ ∧
      ∀ n, dist (f^[n] (f^[m] y)) (f^[n] z) ≤ q ^ n * dist (f^[m] y) z := by
  obtain ⟨i, j, hij, hd⟩ := exists_close_pair f K hK hmaps δ hδ hy
  obtain ⟨P, rfl⟩ : ∃ P, j = P + i := ⟨j - i, by omega⟩
  have hPpos : 0 < P := by omega
  obtain ⟨w, hw⟩ : ∃ w, w = f^[i] y := ⟨_, rfl⟩
  have hwK : w ∈ K := by rw [hw]; exact hmaps.iterate i hy
  have hPw : f^[P] w = f^[P + i] y := by rw [hw, Function.iterate_add_apply]
  have hd' : dist w (f^[P] w) < δ := by rw [hPw, hw]; exact hd
  have hPwK : f^[P] w ∈ K := hmaps.iterate P hwK
  obtain ⟨u, hu⟩ : ∃ u : ℕ → E, ∀ n, u n = f^[n * P] w := ⟨fun n => f^[n * P] w, fun n => rfl⟩
  have huK : ∀ n, u n ∈ K := fun n => by rw [hu n]; exact hmaps.iterate (n * P) hwK
  have hshift : ∀ n, f^[P] (u n) = u (n + 1) := by
    intro n
    rw [hu n, hu (n + 1), ← Function.iterate_add_apply]
    have e : P + n * P = (n + 1) * P := by ring
    rw [e]
  have hstep : ∀ n, dist (u n) (u (n + 1)) ≤ dist w (f^[P] w) * (q ^ P) ^ n := by
    intro n
    have h1 := iterate_close f K hmaps δ q hq0 hq1.le hloc hwK hPwK hd' (n * P)
    have e1 : f^[n * P] (f^[P] w) = u (n + 1) := by
      rw [hu (n + 1), ← Function.iterate_add_apply]
      have e : n * P + P = (n + 1) * P := by ring
      rw [e]
    rw [e1, ← hu n] at h1
    calc dist (u n) (u (n + 1)) ≤ q ^ (n * P) * dist w (f^[P] w) := h1
      _ = dist w (f^[P] w) * (q ^ P) ^ n := by rw [← pow_mul, mul_comm P n]; ring
  have hqP : q ^ P < 1 := pow_lt_one₀ hq0 hq1 hPpos.ne'
  have hcauchy : CauchySeq u :=
    cauchySeq_of_le_geometric (q ^ P) (dist w (f^[P] w)) hqP hstep
  obtain ⟨z, hzK, hlim⟩ := cauchySeq_tendsto_of_isComplete hK.isComplete huK hcauchy
  -- the limit `z` is `P`-periodic
  have hfix : f^[P] z = z := by
    by_contra hne
    have hpos : 0 < dist (f^[P] z) z := dist_pos.mpr hne
    obtain ⟨N, hN⟩ := Metric.tendsto_atTop.mp hlim (min δ (dist (f^[P] z) z / 3))
      (lt_min hδ (by linarith))
    have hN1 := hN N le_rfl
    have hN2 := hN (N + 1) (Nat.le_succ N)
    have hclose : dist (u N) z < δ := lt_of_lt_of_le hN1 (min_le_left _ _)
    have hs1 : dist (u N) z < dist (f^[P] z) z / 3 := lt_of_lt_of_le hN1 (min_le_right _ _)
    have hs2 : dist (u (N + 1)) z < dist (f^[P] z) z / 3 := lt_of_lt_of_le hN2 (min_le_right _ _)
    have hc := iterate_close f K hmaps δ q hq0 hq1.le hloc (huK N) hzK hclose P
    rw [hshift N] at hc
    have hdn : 0 ≤ dist (u N) z := dist_nonneg
    have h5 : q ^ P * dist (u N) z ≤ dist (u N) z := by
      have := mul_le_mul_of_nonneg_right hqP.le hdn
      linarith
    have h3 : dist (f^[P] z) z ≤ dist (f^[P] z) (u (N + 1)) + dist (u (N + 1)) z :=
      dist_triangle _ _ _
    have h4 : dist (f^[P] z) (u (N + 1)) = dist (u (N + 1)) (f^[P] z) := dist_comm _ _
    linarith
  -- lock-on time
  obtain ⟨J, hJ⟩ := Metric.tendsto_atTop.mp hlim δ hδ
  have hJ' := hJ J le_rfl
  have e3 : f^[J * P + i] y = u J := by
    rw [hu J, hw, Function.iterate_add_apply]
  refine ⟨J * P + i, P, z, hzK, hPpos, hfix, ?_, ?_⟩
  · rw [e3]; exact hJ'
  · intro n
    rw [e3]
    exact iterate_close f K hmaps δ q hq0 hq1.le hloc (huK J) hzK hJ' n

/-- **Finitely many periodic points in `K`.** Distinct periodic points are `δ`-separated, and `K`
is covered by finitely many `δ/2`-balls. -/
theorem periodic_points_finite (f : E → E) (K : Set E) (hK : IsCompact K)
    (hmaps : Set.MapsTo f K K) (δ q : ℝ) (hδ : 0 < δ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hloc : LocContr f K δ q) :
    {z | z ∈ K ∧ ∃ P, 0 < P ∧ f^[P] z = z}.Finite := by
  have hsep : ∀ z ∈ {z | z ∈ K ∧ ∃ P, 0 < P ∧ f^[P] z = z},
      ∀ z' ∈ {z | z ∈ K ∧ ∃ P, 0 < P ∧ f^[P] z = z}, dist z z' < δ → z = z' := by
    rintro z ⟨hzK, P, hP, hPz⟩ z' ⟨hz'K, P', hP', hPz'⟩ hd
    have hQz : f^[P * P'] z = z := by
      rw [Function.iterate_mul]; exact Function.iterate_fixed hPz P'
    have hQz' : f^[P' * P] z' = z' := by
      rw [Function.iterate_mul]; exact Function.iterate_fixed hPz' P
    rw [mul_comm] at hQz'
    have hc := iterate_close f K hmaps δ q hq0 hq1.le hloc hzK hz'K hd (P * P')
    rw [hQz, hQz'] at hc
    have hqQ : q ^ (P * P') < 1 := pow_lt_one₀ hq0 hq1 (Nat.mul_pos hP hP').ne'
    by_contra hne
    have hpos : 0 < dist z z' := dist_pos.mpr hne
    have := mul_lt_mul_of_pos_right hqQ hpos
    linarith
  obtain ⟨t, htfin, hcover⟩ :=
    Metric.totallyBounded_iff.mp hK.totallyBounded (δ / 2) (by linarith)
  have hex : ∀ x ∈ K, ∃ c, c ∈ t ∧ x ∈ ball c (δ / 2) := by
    intro x hx
    have := hcover hx
    rw [Set.mem_iUnion₂] at this
    obtain ⟨c, hc, hb⟩ := this
    exact ⟨c, hc, hb⟩
  classical
  obtain ⟨cen, hcen⟩ : ∃ cen : E → E, ∀ x ∈ K, cen x ∈ t ∧ x ∈ ball (cen x) (δ / 2) :=
    ⟨fun x => if h : x ∈ K then Classical.choose (hex x h) else x, fun x hx => by
      simp only [dif_pos hx]
      exact Classical.choose_spec (hex x hx)⟩
  apply Set.Finite.of_finite_image (f := cen)
  · apply htfin.subset
    rintro _ ⟨x, ⟨hxK, _⟩, rfl⟩
    exact (hcen x hxK).1
  · intro x hx x' hx' heq
    obtain ⟨hxK, _⟩ := id hx
    obtain ⟨hx'K, _⟩ := id hx'
    apply hsep x hx x' hx'
    have h1 := (hcen x hxK).2
    have h2 := (hcen x' hx'K).2
    rw [heq] at h1
    rw [mem_ball] at h1 h2
    calc dist x x' ≤ dist x (cen x') + dist x' (cen x') := dist_triangle_right _ _ _
      _ < δ / 2 + δ / 2 := add_lt_add h1 h2
      _ = δ := by ring

omit [MetricSpace E] in
/-- On a cycle that is not a fixed point, consecutive points are never equal. -/
lemma cycle_gap (f : E → E) {z : E} {P : ℕ} (hP : 0 < P) (hPz : f^[P] z = z)
    (hnotfix : f z ≠ z) (i : ℕ) : f^[i + 1] z ≠ f^[i] z := by
  intro heq
  apply hnotfix
  have hfixi : f (f^[i] z) = f^[i] z := by rw [← Function.iterate_succ_apply' f i z]; exact heq
  have h1 : ∀ m, f^[m] (f^[i] z) = f^[i] z := fun m => Function.iterate_fixed hfixi m
  have hle : i ≤ P * (i + 1) := by
    calc i ≤ i + 1 := Nat.le_succ i
      _ ≤ P * (i + 1) := Nat.le_mul_of_pos_left (i + 1) hP
  have hz : z = f^[i] z := by
    calc z = f^[P * (i + 1)] z := by
          rw [Function.iterate_mul]; exact (Function.iterate_fixed hPz _).symm
      _ = f^[P * (i + 1) - i + i] z := by rw [Nat.sub_add_cancel hle]
      _ = f^[P * (i + 1) - i] (f^[i] z) := Function.iterate_add_apply _ _ _ _
      _ = f^[i] z := h1 _
  calc f z = f (f^[i] z) := by rw [← hz]
    _ = f^[i] z := hfixi
    _ = z := hz.symm

/-- **The step size stays bounded below near a cycle of period `≥ 2`.** If `x` is `δ`-close to a
point `z` of a cycle that is not a fixed point, then from some time on every step of the orbit of
`x` has length at least `η > 0`. -/
theorem residual_bounded_below (f : E → E) (K : Set E) (hmaps : Set.MapsTo f K K)
    (δ q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1) (hloc : LocContr f K δ q)
    {x z : E} (hxK : x ∈ K) (hzK : z ∈ K) {P : ℕ} (hP : 0 < P) (hPz : f^[P] z = z)
    (hd : dist x z < δ) (hnotfix : f z ≠ z) :
    ∃ η > 0, ∃ N, ∀ n ≥ N, η ≤ dist (f^[n + 1] x) (f^[n] x) := by
  have hper : Function.IsPeriodicPt f P z := hPz
  obtain ⟨i₀, _, hmin⟩ := Finset.exists_min_image (Finset.range P)
    (fun i => dist (f^[i + 1] z) (f^[i] z)) ⟨0, Finset.mem_range.mpr hP⟩
  have hη₀ : 0 < dist (f^[i₀ + 1] z) (f^[i₀] z) := dist_pos.mpr (cycle_gap f hP hPz hnotfix i₀)
  have hcyc : ∀ n, dist (f^[i₀ + 1] z) (f^[i₀] z) ≤ dist (f^[n + 1] z) (f^[n] z) := by
    intro n
    have hlt : n % P < P := Nat.mod_lt n hP
    have h1 : f^[n] z = f^[n % P] z := (hper.iterate_mod_apply n).symm
    have h2 : f^[n + 1] z = f^[n % P + 1] z := by
      rw [Function.iterate_succ_apply', Function.iterate_succ_apply', h1]
    rw [h1, h2]
    exact hmin (n % P) (Finset.mem_range.mpr hlt)
  have hd0 : 0 ≤ dist x z := dist_nonneg
  obtain ⟨N, hN⟩ := exists_pow_lt_of_lt_one
    (show 0 < dist (f^[i₀ + 1] z) (f^[i₀] z) / (4 * (dist x z + 1)) by positivity) hq1
  have hqN : q ^ N * (dist x z + 1) < dist (f^[i₀ + 1] z) (f^[i₀] z) / 4 := by
    rw [lt_div_iff₀ (by positivity)] at hN
    have e : q ^ N * (4 * (dist x z + 1)) = 4 * (q ^ N * (dist x z + 1)) := by ring
    rw [e] at hN
    linarith
  refine ⟨dist (f^[i₀ + 1] z) (f^[i₀] z) / 2, by linarith, N, fun n hn => ?_⟩
  have hqn : q ^ n ≤ q ^ N := pow_le_pow_of_le_one hq0 hq1.le hn
  have hqn1 : q ^ (n + 1) ≤ q ^ n := pow_le_pow_of_le_one hq0 hq1.le (Nat.le_succ n)
  have hc1 := iterate_close f K hmaps δ q hq0 hq1.le hloc hxK hzK hd n
  have hc2 := iterate_close f K hmaps δ q hq0 hq1.le hloc hxK hzK hd (n + 1)
  have hcz := hcyc n
  have htri : dist (f^[n + 1] z) (f^[n] z) ≤ dist (f^[n + 1] z) (f^[n + 1] x)
      + dist (f^[n + 1] x) (f^[n] x) + dist (f^[n] x) (f^[n] z) := dist_triangle4 _ _ _ _
  rw [dist_comm (f^[n + 1] z) (f^[n + 1] x)] at htri
  have hqNpos : 0 ≤ q ^ N := pow_nonneg hq0 N
  have b1 : q ^ n * dist x z ≤ q ^ N * (dist x z + 1) := by
    have := mul_le_mul_of_nonneg_right hqn hd0
    have : q ^ N * dist x z ≤ q ^ N * (dist x z + 1) :=
      mul_le_mul_of_nonneg_left (by linarith) hqNpos
    linarith
  have b2 : q ^ (n + 1) * dist x z ≤ q ^ N * (dist x z + 1) := by
    have := mul_le_mul_of_nonneg_right hqn1 hd0
    linarith
  linarith

end TopKCore

/-!
# The top-k loop: from "positive distance to the cuts" to asymptotic periodicity, and the stop rule

`f x = A x + τ (cell x)` with one linear part `A` (`‖A x‖ ≤ q ‖x‖`, `0 ≤ q < 1`) and one offset
`τ S = c + b_S` per selected set `S = cell x`.  The discontinuity set enters only through
`IsCutSet cell D`: `cell` is constant on every open ball that misses `D`.  For the top-k map, `D` is
the set of points where `T` is not locally constant (it lies in the union of the hyperplanes
`⟨W x, κ_i - κ_j⟩ + β_i - β_j = 0`), and balls are connected, so `IsCutSet T D` holds.

* `loop_asymptotically_periodic`: if the closure of `f^[N] X` (X compact, invariant) stays `δ`-far
  from `D`, every orbit from `X` locks onto a cycle that is itself `δ`-far from `D`.
* `loop_periodic_points_finite`, `loop_residual_bounded_below`: finitely many cycles, and the
  step size stays bounded below near any cycle of period `≥ 2`.
* `stop_identity_near_fixed_point`: near a resting point `z` that is `δ`-far from `D`,
  `f x - x = -(I - A)(x - z)` exactly (the stop identity with `J = A`).
* `stop_rule_sound` (B4, no asymptotic periodicity needed, any `q < 1`): if every cell's own fixed
  point `p S` is `η`-far from `D`, then `M ‖f x - x‖ < η` (with `‖v‖ ≤ M ‖v - A v‖`, e.g.
  `M = 1/(1-q)`) forces: `p (cell x)` is a genuine resting point of the loop, `x` is in its cell's
  ball, `‖x - p‖ ≤ M ‖f x - x‖`, and the orbit converges to it.  `residual_ge_off_rest`: otherwise
  `M ‖f x - x‖ ≥ η`.
-/

namespace TopKLoop

open TopKCore Metric

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E] {ι : Type*}

/-- The hard-retrieval loop `f x = A x + τ (cell x)`. -/
def loop (A : E →ₗ[ℝ] E) (cell : E → ι) (τ : ι → E) (x : E) : E := A x + τ (cell x)

/-- `cell` is constant on every open ball that misses `D`. -/
def IsCutSet (cell : E → ι) (D : Set E) : Prop :=
  ∀ y : E, ∀ r : ℝ, (∀ z ∈ ball y r, z ∉ D) → ∀ z ∈ ball y r, cell z = cell y

omit [NormedSpace ℝ E] in
lemma ball_misses {D : Set E} {y : E} {δ : ℝ} (h : ∀ w ∈ D, δ ≤ dist y w) :
    ∀ z ∈ ball y δ, z ∉ D := by
  intro z hz hzD
  have h1 := h z hzD
  rw [mem_ball, dist_comm] at hz
  linarith

/-- Near a point that is `δ`-far from the cuts, the loop is the affine map of that point's cell. -/
lemma loop_local_lipschitz (A : E →ₗ[ℝ] E) (q : ℝ) (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖)
    (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D) {δ : ℝ} {y y' : E}
    (hy : ∀ w ∈ D, δ ≤ dist y w) (hd : dist y y' < δ) :
    dist (loop A cell τ y) (loop A cell τ y') ≤ q * dist y y' := by
  have hcell : cell y' = cell y :=
    hD y δ (ball_misses hy) y' (by rw [mem_ball, dist_comm]; exact hd)
  rw [dist_eq_norm, dist_eq_norm]
  unfold loop
  rw [hcell]
  have e : A y + τ (cell y) - (A y' + τ (cell y)) = A (y - y') := by rw [map_sub]; abel
  rw [e]
  exact hA _

lemma loop_locContr (A : E →ₗ[ℝ] E) (q : ℝ) (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖)
    (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D) (K : Set E) (δ : ℝ)
    (hsep : ∀ y ∈ K, ∀ w ∈ D, δ ≤ dist y w) : LocContr (loop A cell τ) K δ q := by
  intro y hy y' _ hd
  exact loop_local_lipschitz A q hA cell τ D hD (hsep y hy) hd

/-- The closure of an image `f^[N] X` of an invariant set is invariant, once it is far from `D`. -/
lemma closure_image_mapsTo (A : E →ₗ[ℝ] E) (q : ℝ) (_hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (X : Set E) (hXmaps : Set.MapsTo (loop A cell τ) X X) (N : ℕ) (δ : ℝ) (hδ : 0 < δ)
    (hsep : ∀ y ∈ closure ((loop A cell τ)^[N] '' X), ∀ w ∈ D, δ ≤ dist y w) :
    Set.MapsTo (loop A cell τ) (closure ((loop A cell τ)^[N] '' X))
      (closure ((loop A cell τ)^[N] '' X)) := by
  intro z hz
  have hzsep := hsep z hz
  rw [Metric.mem_closure_iff] at hz ⊢
  intro ε hε
  obtain ⟨b, hb, hzb⟩ := hz (min δ ε) (lt_min hδ hε)
  obtain ⟨x, hx, rfl⟩ := hb
  refine ⟨loop A cell τ ((loop A cell τ)^[N] x), ⟨loop A cell τ x, hXmaps hx, ?_⟩, ?_⟩
  · exact (Function.iterate_succ_apply _ _ _).symm.trans (Function.iterate_succ_apply' _ _ _)
  · have h1 : dist z ((loop A cell τ)^[N] x) < δ := lt_of_lt_of_le hzb (min_le_left _ _)
    have h2 : dist z ((loop A cell τ)^[N] x) < ε := lt_of_lt_of_le hzb (min_le_right _ _)
    have h3 := loop_local_lipschitz A q hA cell τ D hD hzsep h1
    have h4 : q * dist z ((loop A cell τ)^[N] x) ≤ dist z ((loop A cell τ)^[N] x) := by
      have := mul_le_mul_of_nonneg_right hq1.le (dist_nonneg (x := z) (y := (loop A cell τ)^[N] x))
      linarith
    linarith

lemma closure_image_compact (A : E →ₗ[ℝ] E) (cell : E → ι) (τ : ι → E)
    (X : Set E) (hX : IsCompact X) (hXmaps : Set.MapsTo (loop A cell τ) X X) (N : ℕ) :
    IsCompact (closure ((loop A cell τ)^[N] '' X)) :=
  hX.of_isClosed_subset isClosed_closure
    (closure_minimal (hXmaps.iterate N).image_subset hX.isClosed)

/-- **Asymptotic periodicity of the loop** once `closure (f^[N] X)` is `δ`-far from the cuts. -/
theorem loop_asymptotically_periodic (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (X : Set E) (hX : IsCompact X) (hXmaps : Set.MapsTo (loop A cell τ) X X) (N : ℕ) (δ : ℝ)
    (hδ : 0 < δ) (hsep : ∀ y ∈ closure ((loop A cell τ)^[N] '' X), ∀ w ∈ D, δ ≤ dist y w)
    {x : E} (hx : x ∈ X) :
    ∃ m P : ℕ, ∃ z : E, 0 < P ∧ (loop A cell τ)^[P] z = z ∧ (∀ w ∈ D, δ ≤ dist z w) ∧
      dist ((loop A cell τ)^[m] x) z < δ ∧
      ∀ n, dist ((loop A cell τ)^[n] ((loop A cell τ)^[m] x)) ((loop A cell τ)^[n] z)
        ≤ q ^ n * dist ((loop A cell τ)^[m] x) z := by
  have hK := closure_image_compact A cell τ X hX hXmaps N
  have hmaps := closure_image_mapsTo A q hq0 hq1 hA cell τ D hD X hXmaps N δ hδ hsep
  have hloc := loop_locContr A q hA cell τ D hD _ δ hsep
  have hy : (loop A cell τ)^[N] x ∈ closure ((loop A cell τ)^[N] '' X) :=
    subset_closure (Set.mem_image_of_mem _ hx)
  obtain ⟨m, P, z, hzK, hP, hPz, hclose, hconv⟩ :=
    lock_onto_cycle (loop A cell τ) _ hK hmaps δ q hδ hq0 hq1 hloc hy
  refine ⟨m + N, P, z, hP, hPz, hsep z hzK, ?_, ?_⟩
  · rw [Function.iterate_add_apply]; exact hclose
  · intro n
    rw [Function.iterate_add_apply]
    exact hconv n

/-- Finitely many periodic points in `closure (f^[N] X)`. -/
theorem loop_periodic_points_finite (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (X : Set E) (hX : IsCompact X) (hXmaps : Set.MapsTo (loop A cell τ) X X) (N : ℕ) (δ : ℝ)
    (hδ : 0 < δ) (hsep : ∀ y ∈ closure ((loop A cell τ)^[N] '' X), ∀ w ∈ D, δ ≤ dist y w) :
    {z | z ∈ closure ((loop A cell τ)^[N] '' X) ∧ ∃ P, 0 < P ∧ (loop A cell τ)^[P] z = z}.Finite :=
  periodic_points_finite (loop A cell τ) _ (closure_image_compact A cell τ X hX hXmaps N)
    (closure_image_mapsTo A q hq0 hq1 hA cell τ D hD X hXmaps N δ hδ hsep) δ q hδ hq0 hq1
    (loop_locContr A q hA cell τ D hD _ δ hsep)

/-- Along an orbit locked onto a cycle that is not a fixed point, the step size stays `≥ η > 0`. -/
theorem loop_residual_bounded_below (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (X : Set E) (hX : IsCompact X) (hXmaps : Set.MapsTo (loop A cell τ) X X) (N : ℕ) (δ : ℝ)
    (hδ : 0 < δ) (hsep : ∀ y ∈ closure ((loop A cell τ)^[N] '' X), ∀ w ∈ D, δ ≤ dist y w)
    {x : E} (hx : x ∈ X) :
    ∃ m P : ℕ, ∃ z : E, 0 < P ∧ (loop A cell τ)^[P] z = z ∧
      (loop A cell τ z ≠ z →
        ∃ η > 0, ∃ N', ∀ n ≥ N', η ≤ dist ((loop A cell τ)^[n + 1] ((loop A cell τ)^[m] x))
          ((loop A cell τ)^[n] ((loop A cell τ)^[m] x))) := by
  have hK := closure_image_compact A cell τ X hX hXmaps N
  have hmaps := closure_image_mapsTo A q hq0 hq1 hA cell τ D hD X hXmaps N δ hδ hsep
  have hloc := loop_locContr A q hA cell τ D hD _ δ hsep
  have hy : (loop A cell τ)^[N] x ∈ closure ((loop A cell τ)^[N] '' X) :=
    subset_closure (Set.mem_image_of_mem _ hx)
  obtain ⟨m, P, z, hzK, hP, hPz, hclose, _⟩ :=
    lock_onto_cycle (loop A cell τ) _ hK hmaps δ q hδ hq0 hq1 hloc hy
  refine ⟨m + N, P, z, hP, hPz, fun hnot => ?_⟩
  have hmK : (loop A cell τ)^[m] ((loop A cell τ)^[N] x) ∈ closure ((loop A cell τ)^[N] '' X) :=
    hmaps.iterate m hy
  have e : (loop A cell τ)^[m + N] x = (loop A cell τ)^[m] ((loop A cell τ)^[N] x) :=
    Function.iterate_add_apply _ _ _ _
  rw [e]
  exact residual_bounded_below (loop A cell τ) _ hmaps δ q hq0 hq1 hloc hmK hzK hP hPz hclose hnot

/-- **The stop identity with `J = A`** near a resting point that is `δ`-far from the cuts. -/
theorem stop_identity_near_fixed_point (A : E →ₗ[ℝ] E) (cell : E → ι) (τ : ι → E) (D : Set E)
    (hD : IsCutSet cell D) {z : E} {δ : ℝ} (hz : loop A cell τ z = z)
    (hzsep : ∀ w ∈ D, δ ≤ dist z w) {x : E} (hx : dist x z < δ) :
    loop A cell τ x - x = -((x - z) - A (x - z)) := by
  have hcell : cell x = cell z := hD z δ (ball_misses hzsep) x (by rw [mem_ball]; exact hx)
  have hz' : A z + τ (cell z) = z := hz
  unfold loop
  rw [hcell, map_sub]
  have e : τ (cell z) = z - A z := by rw [eq_sub_iff_add_eq, add_comm]; exact hz'
  rw [e]
  abel

theorem stop_bound_near_fixed_point (A : E →ₗ[ℝ] E) (q : ℝ) (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖)
    (cell : E → ι) (τ : ι → E) (D : Set E)
    (hD : IsCutSet cell D) {z : E} {δ : ℝ} (hz : loop A cell τ z = z)
    (hzsep : ∀ w ∈ D, δ ≤ dist z w) {x : E} (hx : dist x z < δ) :
    (1 - q) * ‖x - z‖ ≤ ‖loop A cell τ x - x‖ := by
  rw [stop_identity_near_fixed_point A cell τ D hD hz hzsep hx, norm_neg]
  have h1 : ‖x - z‖ - ‖A (x - z)‖ ≤ ‖(x - z) - A (x - z)‖ := norm_sub_norm_le _ _
  have h2 := hA (x - z)
  linarith

/-- **B4, local form: a checkable stop certificate, sound for EVERY parameter.**  Let `p` be the
fixed point of the affine map of `x`'s own cell (`A p + τ (cell x) = p`) and let `p` be `η`-far from
the cuts `D`.  If `M ‖f x - x‖ < η` (with `‖v‖ ≤ M ‖v - A v‖`, e.g. `M = 1/(1-q)`), then `p` is a
genuine resting point of the loop, it lies in `x`'s cell, the exact identity and the error bound
hold, and the orbit of `x` converges to `p`. -/
theorem stop_rule_sound_local (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (M : ℝ) (hM : ∀ v, ‖v‖ ≤ M * ‖v - A v‖)
    (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (x p : E) (hp : A p + τ (cell x) = p) (η : ℝ) (hη : ∀ w ∈ D, η ≤ dist p w)
    (hres : M * ‖loop A cell τ x - x‖ < η) :
    loop A cell τ p = p ∧ cell p = cell x ∧
      loop A cell τ x - x = -((x - p) - A (x - p)) ∧
      ‖x - p‖ ≤ M * ‖loop A cell τ x - x‖ ∧
      ∀ n, ‖(loop A cell τ)^[n] x - p‖ ≤ q ^ n * ‖x - p‖ := by
  have hτ : τ (cell x) = p - A p := by
    rw [eq_sub_iff_add_eq, add_comm]; exact hp
  have hid : loop A cell τ x - x = -((x - p) - A (x - p)) := by
    unfold loop
    rw [hτ, map_sub]
    abel
  have hbound : ‖x - p‖ ≤ M * ‖loop A cell τ x - x‖ := by
    rw [hid, norm_neg]; exact hM _
  have hball := ball_misses hη
  have hxin : dist x p < η := by rw [dist_eq_norm]; linarith
  have hcell : cell x = cell p := hD p η hball x (by rw [mem_ball]; exact hxin)
  have hin : ∀ y, ‖y - p‖ < η → loop A cell τ y - p = A (y - p) := by
    intro y hy
    have hcy : cell y = cell p := hD p η hball y (by rw [mem_ball, dist_eq_norm]; exact hy)
    unfold loop
    rw [hcy, ← hcell, hτ, map_sub]
    abel
  have hfix : loop A cell τ p = p := by
    have h0 := hin p (by rw [sub_self, norm_zero]; linarith [dist_nonneg (x := x) (y := p)])
    rw [sub_self, map_zero] at h0
    exact sub_eq_zero.mp h0
  have horbit : ∀ n, ‖(loop A cell τ)^[n] x - p‖ ≤ q ^ n * ‖x - p‖ := by
    intro n
    induction n with
    | zero => simp
    | succ n ih =>
      rw [Function.iterate_succ_apply']
      have hqn : q ^ n ≤ 1 := pow_le_one₀ hq0 hq1.le
      have hlt : ‖(loop A cell τ)^[n] x - p‖ < η := by
        have := mul_le_mul_of_nonneg_right hqn (norm_nonneg (x - p))
        linarith
      rw [hin _ hlt]
      calc ‖A ((loop A cell τ)^[n] x - p)‖ ≤ q * ‖(loop A cell τ)^[n] x - p‖ := hA _
        _ ≤ q * (q ^ n * ‖x - p‖) := mul_le_mul_of_nonneg_left ih hq0
        _ = q ^ (n + 1) * ‖x - p‖ := by ring
  exact ⟨hfix, hcell.symm, hid, hbound, horbit⟩

/-- **B4: the stop rule is sound off the cuts.**  If every cell's own fixed point `p S`
(`A (p S) + τ S = p S`) is `η`-far from `D`, then `M ‖f x - x‖ < η` forces `p (cell x)` to be a
genuine resting point of the loop in the cell of `x`, with the exact identity, the error bound, and
convergence of the orbit of `x`. -/
theorem stop_rule_sound (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (M : ℝ) (hM : ∀ v, ‖v‖ ≤ M * ‖v - A v‖)
    (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (p : ι → E) (hp : ∀ S, A (p S) + τ S = p S) (η : ℝ) (hη : ∀ S, ∀ w ∈ D, η ≤ dist (p S) w)
    (x : E) (hres : M * ‖loop A cell τ x - x‖ < η) :
    loop A cell τ (p (cell x)) = p (cell x) ∧ cell (p (cell x)) = cell x ∧
      loop A cell τ x - x = -((x - p (cell x)) - A (x - p (cell x))) ∧
      ‖x - p (cell x)‖ ≤ M * ‖loop A cell τ x - x‖ ∧
      ∀ n, ‖(loop A cell τ)^[n] x - p (cell x)‖ ≤ q ^ n * ‖x - p (cell x)‖ :=
  stop_rule_sound_local A q hq0 hq1 hA M hM cell τ D hD x (p (cell x)) (hp (cell x)) η
    (hη (cell x)) hres

/-- Contrapositive: wherever the cell's own fixed point is NOT a resting point of the loop, the
residual is at least `η / M`, so a stop threshold below `η / M` never fires there. -/
theorem residual_ge_off_rest (A : E →ₗ[ℝ] E) (q : ℝ) (hq0 : 0 ≤ q) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (M : ℝ) (hM : ∀ v, ‖v‖ ≤ M * ‖v - A v‖)
    (cell : E → ι) (τ : ι → E) (D : Set E) (hD : IsCutSet cell D)
    (p : ι → E) (hp : ∀ S, A (p S) + τ S = p S) (η : ℝ) (hη : ∀ S, ∀ w ∈ D, η ≤ dist (p S) w)
    (x : E) (hnot : loop A cell τ (p (cell x)) ≠ p (cell x)) :
    η ≤ M * ‖loop A cell τ x - x‖ := by
  by_contra h
  exact hnot (stop_rule_sound A q hq0 hq1 hA M hM cell τ D hD p hp η hη x (not_le.mp h)).1

/-- `M = 1/(1-q)` is always admissible: `‖v‖ ≤ (1-q)⁻¹ ‖v - A v‖`. -/
lemma inv_one_sub_admissible (A : E →ₗ[ℝ] E) (q : ℝ) (hq1 : q < 1)
    (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (v : E) : ‖v‖ ≤ (1 - q)⁻¹ * ‖v - A v‖ := by
  have hpos : 0 < 1 - q := by linarith
  have h1 : ‖v‖ - ‖A v‖ ≤ ‖v - A v‖ := norm_sub_norm_le _ _
  have h2 := hA v
  rw [← div_eq_inv_mul, le_div_iff₀ hpos]
  nlinarith [norm_nonneg v]

end TopKLoop

#print axioms TopKCore.iterate_close
#print axioms TopKCore.exists_close_pair
#print axioms TopKCore.lock_onto_cycle
#print axioms TopKCore.periodic_points_finite
#print axioms TopKCore.cycle_gap
#print axioms TopKCore.residual_bounded_below
#print axioms TopKLoop.ball_misses
#print axioms TopKLoop.loop_local_lipschitz
#print axioms TopKLoop.loop_locContr
#print axioms TopKLoop.closure_image_mapsTo
#print axioms TopKLoop.closure_image_compact
#print axioms TopKLoop.loop_asymptotically_periodic
#print axioms TopKLoop.loop_periodic_points_finite
#print axioms TopKLoop.loop_residual_bounded_below
#print axioms TopKLoop.stop_identity_near_fixed_point
#print axioms TopKLoop.stop_bound_near_fixed_point
#print axioms TopKLoop.stop_rule_sound_local
#print axioms TopKLoop.stop_rule_sound
#print axioms TopKLoop.residual_ge_off_rest
#print axioms TopKLoop.inv_one_sub_admissible
