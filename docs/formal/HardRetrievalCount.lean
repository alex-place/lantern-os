/-
# Hard top-k retrieval: local cell multiplicity, tied offsets, and fixed points that move with the values

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: a compactness argument, linear algebra on the offsets, and the
conjugation by a translation.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/HardRetrievalCount.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 3 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Topology.MetricSpace.HausdorffDistance
import Mathlib.Topology.Order.Compact
import Mathlib.Topology.Algebra.Monoid
import Mathlib.Analysis.Normed.Module.Basic
import Mathlib.Data.Fintype.Card
import Mathlib.Data.Finset.Lattice.Fold
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Positivity
import Mathlib.Tactic.FieldSimp
import Mathlib.Tactic.Ring

/-!
# B2, step 4 (counting) and the tied offsets

* `uniform_local_multiplicity`: if at most `m` cells have any given point in their closure, then on
  a compact set there is ONE radius `r > 0` such that every closed `r`-ball centred there meets at
  most `m` cells.  For the top-k loop this gives `#A_{n+1}(U) ≤ m* · #A_n(U)` once the `n`-step
  image balls (radius `λ^n R + ρ/(1-λ)`) are below `r`, so `#A_n(U) ≤ C m*^n`.
* `tied_offsets_K4`: for `K = 4, k = 2` the six offsets `b_S` obey linear relations, so the top-k
  offsets fill only a `K d`-dimensional subspace of the `C(K,k) d`-dimensional per-cell space.
* `fixed_point_shift`: shifting every value by `w = u - A u` moves every cell's fixed point by
  exactly `u`.  So "a cell's fixed point lies on a cut hyperplane" is a proper affine condition on
  the values (B4 genericity).
-/

open Metric

namespace TopKCount

open Classical in
/-- **Uniform local multiplicity** (compactness). -/
theorem uniform_local_multiplicity {E : Type*} [MetricSpace E] {ι : Type*} [Fintype ι]
    (P : ι → Set E) (m : ℕ)
    (hm : ∀ y : E, (Finset.univ.filter (fun S => y ∈ closure (P S))).card ≤ m)
    (B : Set E) (hB : IsCompact B) :
    ∃ r : ℝ, 0 < r ∧ ∀ y ∈ B,
      (Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty)).card ≤ m := by
  -- the index sets that would violate the bound
  obtain ⟨F, hF⟩ : ∃ F : Finset (Finset ι),
      F = Finset.univ.filter (fun J => m < J.card ∧ ∀ S ∈ J, (P S).Nonempty) := ⟨_, rfl⟩
  have hmemF : ∀ J : Finset ι, J ∈ F ↔ m < J.card ∧ ∀ S ∈ J, (P S).Nonempty := by
    intro J; rw [hF, Finset.mem_filter]; simp
  -- on every bad index set, the summed distance function is positive everywhere
  have hpos : ∀ J ∈ F, ∀ y, 0 < ∑ S ∈ J, infDist y (P S) := by
    intro J hJ y
    obtain ⟨hcard, hne⟩ := (hmemF J).mp hJ
    have hnn : ∀ S ∈ J, 0 ≤ infDist y (P S) := fun S _ => infDist_nonneg
    rcases (Finset.sum_nonneg hnn).lt_or_eq with h | h
    · exact h
    · exfalso
      have hzero := (Finset.sum_eq_zero_iff_of_nonneg hnn).mp h.symm
      have hsub : J ⊆ Finset.univ.filter (fun S => y ∈ closure (P S)) := by
        intro S hS
        rw [Finset.mem_filter]
        exact ⟨Finset.mem_univ S, (mem_closure_iff_infDist_zero (hne S hS)).mpr (hzero S hS)⟩
      have h1 := Finset.card_le_card hsub
      have h2 := hm y
      omega
  -- a violating ball gives a bad index set
  have hbad : ∀ (r : ℝ) (y : E),
      m < (Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty)).card →
      Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty) ∈ F := by
    intro r y hc
    rw [hmemF]
    refine ⟨hc, fun S hS => ?_⟩
    rw [Finset.mem_filter] at hS
    obtain ⟨x, _, hx⟩ := hS.2
    exact ⟨x, hx⟩
  -- the sum of distances is at most `card J * r` for the index set of a ball of radius `r`
  have hsum : ∀ (r : ℝ) (y : E),
      ∑ S ∈ Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty), infDist y (P S)
        ≤ (Fintype.card ι : ℝ) * r ∧ 0 ≤ r ∨
      (Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty)) = ∅ := by
    intro r y
    rcases (Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty)).eq_empty_or_nonempty
      with he | hne
    · right; exact he
    · left
      obtain ⟨S₀, hS₀⟩ := hne
      rw [Finset.mem_filter] at hS₀
      obtain ⟨x₀, hx₀, _⟩ := hS₀.2
      have hr : 0 ≤ r := le_trans dist_nonneg (mem_closedBall.mp hx₀)
      refine ⟨?_, hr⟩
      have hle : ∀ S ∈ Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty),
          infDist y (P S) ≤ r := by
        intro S hS
        rw [Finset.mem_filter] at hS
        obtain ⟨x, hxb, hxP⟩ := hS.2
        calc infDist y (P S) ≤ dist y x := infDist_le_dist_of_mem hxP
          _ = dist x y := dist_comm _ _
          _ ≤ r := mem_closedBall.mp hxb
      calc ∑ S ∈ Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty), infDist y (P S)
          ≤ ∑ S ∈ Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty), r :=
            Finset.sum_le_sum hle
        _ = ((Finset.univ.filter (fun S => (closedBall y r ∩ P S).Nonempty)).card : ℝ) * r := by
            rw [Finset.sum_const, nsmul_eq_mul]
        _ ≤ (Fintype.card ι : ℝ) * r := by
            apply mul_le_mul_of_nonneg_right _ hr
            exact_mod_cast Finset.card_le_univ _
  rcases B.eq_empty_or_nonempty with hBe | hBne
  · exact ⟨1, one_pos, fun y hy => by simp [hBe] at hy⟩
  -- a positive lower bound for each bad index set on `B`
  have hmin : ∀ J ∈ F, ∃ ε : ℝ, 0 < ε ∧ ∀ y ∈ B, ε ≤ ∑ S ∈ J, infDist y (P S) := by
    intro J hJ
    have hcont : Continuous (fun y => ∑ S ∈ J, infDist y (P S)) :=
      continuous_finset_sum _ (fun S _ => continuous_infDist_pt (P S))
    obtain ⟨y₀, _, hy₀⟩ := hB.exists_isMinOn hBne hcont.continuousOn
    exact ⟨_, hpos J hJ y₀, fun y hy => isMinOn_iff.mp hy₀ y hy⟩
  choose! ε hεpos hεle using hmin
  rcases F.eq_empty_or_nonempty with hFe | hFne
  · refine ⟨1, one_pos, fun y _ => ?_⟩
    by_contra hcon
    have hJ := hbad 1 y (not_le.mp hcon)
    rw [hFe] at hJ
    simp at hJ
  · obtain ⟨ε₀, hε₀def⟩ : ∃ ε₀, ε₀ = F.inf' hFne ε := ⟨_, rfl⟩
    have hε₀ : 0 < ε₀ := by
      rw [hε₀def]; exact (Finset.lt_inf'_iff hFne).mpr (fun J hJ => hεpos J hJ)
    have hcardpos : (0 : ℝ) < Fintype.card ι + 1 := by positivity
    refine ⟨ε₀ / (Fintype.card ι + 1), div_pos hε₀ hcardpos, fun y hy => ?_⟩
    by_contra hcon
    have hJ := hbad _ y (not_le.mp hcon)
    have h1 := hεle _ hJ y hy
    have h2 : ε₀ ≤ ε (Finset.univ.filter
        (fun S => (closedBall y (ε₀ / (Fintype.card ι + 1)) ∩ P S).Nonempty)) :=
      calc ε₀ = F.inf' hFne ε := hε₀def
        _ ≤ ε _ := Finset.inf'_le ε hJ
    rcases hsum (ε₀ / (Fintype.card ι + 1)) y with ⟨h3, _⟩ | h3
    · have h4 : (Fintype.card ι : ℝ) * (ε₀ / (Fintype.card ι + 1)) < ε₀ := by
        rw [mul_div_assoc', div_lt_iff₀ hcardpos]
        nlinarith
      linarith
    · rw [h3] at hcon
      simp at hcon

/-- **Tied offsets** (`K = 4`, `k = 2`): `b₁₂ + b₃₄ = b₁₃ + b₂₄ = b₁₄ + b₂₃`. -/
theorem tied_offsets_K4 {E : Type*} [AddCommGroup E] [Module ℝ E] (v : Fin 4 → E) :
    (1/2 : ℝ) • (v 0 + v 1) + (1/2 : ℝ) • (v 2 + v 3)
        = (1/2 : ℝ) • (v 0 + v 2) + (1/2 : ℝ) • (v 1 + v 3) ∧
      (1/2 : ℝ) • (v 0 + v 2) + (1/2 : ℝ) • (v 1 + v 3)
        = (1/2 : ℝ) • (v 0 + v 3) + (1/2 : ℝ) • (v 1 + v 2) := by
  constructor <;> (simp only [smul_add]; abel)

/-- **Common shift moves every cell's fixed point rigidly.** If `A p + τ = p` and
`A p' + (τ + (u - A u)) = p'` (all values shifted by `w = u - A u`), then `p' = p + u`. -/
theorem fixed_point_shift {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E] (A : E →ₗ[ℝ] E)
    (q : ℝ) (hq1 : q < 1) (hA : ∀ x, ‖A x‖ ≤ q * ‖x‖) (τ u p p' : E)
    (hp : A p + τ = p) (hp' : A p' + (τ + (u - A u)) = p') : p' = p + u := by
  have key : (p' - (p + u)) - A (p' - (p + u)) = 0 := by
    rw [map_sub, map_add]
    have e : p' - (p + u) - (A p' - (A p + A u))
        = (A p + τ - p) - (A p' + (τ + (u - A u)) - p') := by abel
    rw [e, hp, hp']
    simp
  have h1 : ‖p' - (p + u)‖ - ‖A (p' - (p + u))‖ ≤ ‖(p' - (p + u)) - A (p' - (p + u))‖ :=
    norm_sub_norm_le _ _
  have h2 := hA (p' - (p + u))
  rw [key, norm_zero] at h1
  have hpos : 0 < 1 - q := by linarith
  have h3 : (1 - q) * ‖p' - (p + u)‖ ≤ 0 := by linarith
  have h4 : ‖p' - (p + u)‖ ≤ 0 := by
    by_contra h
    push_neg at h
    have := mul_pos hpos h
    linarith
  exact sub_eq_zero.mp (norm_le_zero_iff.mp h4)

end TopKCount

#print axioms TopKCount.uniform_local_multiplicity
#print axioms TopKCount.tied_offsets_K4
#print axioms TopKCount.fixed_point_shift
