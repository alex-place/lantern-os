/-
# The cut set of a cell map is closed, and the map is constant on balls that miss it

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: point-set topology and the preconnectedness of convex sets.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/HardRetrievalCutSet.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 2 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Convex.PathConnected
import Mathlib.Analysis.Normed.Module.Convex
import Mathlib.Topology.Connected.Basic

-- Some lemmas hold without every section hypothesis; the linter would ask to `omit` each one.
set_option linter.unusedSectionVars false

/-!
# The cut set of a cell map

For ANY map `cell : E → ι` on a real normed space, let `cutSet cell` be the set of points where
`cell` is not locally constant.  Then
* `cutSet_isClosed`: it is closed;
* `isCutSet_cutSet`: `cell` is constant on every open ball that misses it (balls are convex, hence
  preconnected).

So the hypothesis `IsCutSet cell D` of `HardRetrievalLoop.lean` holds for `D = cutSet T`, `T` the top-k map,
whose cut set lies in the union of the hyperplanes `⟨W x, κ_i - κ_j⟩ + β_i - β_j = 0`.
-/

open Filter Topology Metric

namespace TopKCut

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E] {ι : Type*}

/-- Points where `cell` is not locally constant. -/
def cutSet (cell : E → ι) : Set E := {x | ¬ ∀ᶠ y in 𝓝 x, cell y = cell x}

theorem cutSet_isClosed (cell : E → ι) : IsClosed (cutSet cell) := by
  rw [← isOpen_compl_iff, isOpen_iff_mem_nhds]
  intro x hx
  have h : ∀ᶠ y in 𝓝 x, cell y = cell x := by
    simpa [cutSet] using hx
  have h2 : ∀ᶠ y in 𝓝 x, ∀ᶠ z in 𝓝 y, cell z = cell y :=
    (h.eventually_nhds.and h).mono (fun y hy => hy.1.mono (fun z hz => hz.trans hy.2.symm))
  filter_upwards [h2] with y hy
  simpa [cutSet] using hy

theorem isCutSet_cutSet (cell : E → ι) (y : E) (r : ℝ)
    (hmiss : ∀ z ∈ ball y r, z ∉ cutSet cell) : ∀ z ∈ ball y r, cell z = cell y := by
  intro z hz
  have hr : 0 < r := lt_of_le_of_lt dist_nonneg (mem_ball.mp hz)
  have hy : y ∈ ball y r := mem_ball_self hr
  have hloc : ∀ w ∈ ball y r, ∀ᶠ v in 𝓝 w, cell v = cell w := by
    intro w hw
    have := hmiss w hw
    simpa [cutSet] using this
  set u : Set E := {w | ∀ᶠ v in 𝓝 w, cell v = cell y} with hu
  set v : Set E := {w | ∀ᶠ v in 𝓝 w, cell v ≠ cell y} with hv
  have huo : IsOpen u := isOpen_setOf_eventually_nhds
  have hvo : IsOpen v := isOpen_setOf_eventually_nhds
  have hdisj : Disjoint u v := by
    rw [Set.disjoint_left]
    intro w hwu hwv
    have hwu' : ∀ᶠ t in 𝓝 w, cell t = cell y := hwu
    have hwv' : ∀ᶠ t in 𝓝 w, cell t ≠ cell y := hwv
    have := (hwu'.and hwv').exists
    obtain ⟨t, h1, h2⟩ := this
    exact h2 h1
  have hcover : ball y r ⊆ u ∪ v := by
    intro w hw
    by_cases hc : cell w = cell y
    · left
      exact (hloc w hw).mono (fun t ht => ht.trans hc)
    · right
      exact (hloc w hw).mono (fun t ht => by rw [ht]; exact hc)
  have hyu : (ball y r ∩ u).Nonempty := ⟨y, hy, (hloc y hy)⟩
  have hsub := (convex_ball y r).isPreconnected.subset_left_of_subset_union huo hvo hdisj
    hcover hyu
  exact (show ∀ᶠ t in 𝓝 z, cell t = cell y from hsub hz).self_of_nhds

end TopKCut

#print axioms TopKCut.cutSet_isClosed
#print axioms TopKCut.isCutSet_cutSet
