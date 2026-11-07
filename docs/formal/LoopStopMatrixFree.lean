/-
# Fewer than d matrix-vector products certify nothing beyond the a-priori bound

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: it is the resisting-oracle argument of information-based
complexity (Nemirovski & Yudin 1983; Traub, Wasilkowski & Woźniakowski 1988), here for a
deterministic lower bound on σ_min(I − J) from forward and adjoint products.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopStopMatrixFree.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 13 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.InnerProductSpace.Adjoint
import Mathlib.Analysis.InnerProductSpace.Projection.Submodule
import Mathlib.LinearAlgebra.Dimension.Constructions

/-!
# A2. Matrix-free impossibility: fewer than `d` products certify nothing beyond the a-priori bound

`E` is a finite-dimensional real inner product space, `d = finrank ℝ E`.  An algorithm sees the
operator `J` only through `k` queries.  Query `n` is any vector chosen from the answers so far
(adaptively); the answer to a query `v` is the pair `(J v, Jᵀ v)` (forward AND adjoint product,
which only strengthens the algorithm).  After `k` queries it outputs a number `β`, its claimed
lower bound `β ≤ σ_min (I - J)`, in the form `∀ x, β ‖x‖ ≤ ‖(I - J) x‖` (`IsLowerBound`).

If every answer is zero, the queries are those the algorithm makes on the all-zero transcript
(`silentQuery`); let `S` be their span (`silentSpan`, dimension `≤ k < d`).  The adversary
`J_c = c (I - P_S) = c P_{Sᗮ}` (`adversary`) answers every such query with `(0, 0)`, so the
algorithm cannot tell it from `J = 0` (`adversary_transcript`).  `‖J_c‖ ≤ c` and
`σ_min (I - J_c) = 1 - c` exactly for `0 ≤ c ≤ 1` (`adversary_sigma_min`), while
`σ_min (I - 0) = 1` (`zero_sigma_min`).

Main results
* `no_query_certificate_norm_class`: an algorithm with `k < d` queries that is sound on the class
  `{‖J‖ ≤ L}` (`L ≥ 0`) certifies at most `1 - min L 1 = max (0, 1 - L)` even when `J = 0`.
* `apriori_bound_sound`: that value is sound on the class, so it is the best possible.
* `no_query_certificate_contractive`: an algorithm with `k < d` queries that is sound on
  `{‖J‖ < 1}` certifies no positive lower bound at `J = 0`.  The class `{‖J‖ < 1}` is contained in
  `{ρ(J) < 1}`, so the same holds for any algorithm sound on `{ρ(J) < 1}`.
-/

noncomputable section

open Module
open scoped RealInnerProductSpace

namespace A2

variable {E : Type*} [NormedAddCommGroup E] [InnerProductSpace ℝ E] [FiniteDimensional ℝ E]

/-- The answer to a query `v`: forward and adjoint products. -/
def answer (J : E →L[ℝ] E) (v : E) : E × E := (J v, ContinuousLinearMap.adjoint J v)

/-- A deterministic adaptive query algorithm: the next query is a function of the answers so far;
`out` is the certified lower bound computed from all answers. -/
structure QueryAlg (E : Type*) where
  query : List (E × E) → E
  out : List (E × E) → ℝ

/-- The answers to the first `n` queries on the operator `J`. -/
def transcript (alg : QueryAlg E) (J : E →L[ℝ] E) : ℕ → List (E × E)
  | 0 => []
  | n + 1 => transcript alg J n ++ [answer J (alg.query (transcript alg J n))]

/-- The `n`-th query made when every earlier answer was zero. -/
def silentQuery (alg : QueryAlg E) (n : ℕ) : E := alg.query (List.replicate n (0, 0))

/-- `β` is a valid lower bound for `σ_min (I - J)`. -/
def IsLowerBound (J : E →L[ℝ] E) (β : ℝ) : Prop := ∀ x : E, β * ‖x‖ ≤ ‖(1 - J) x‖

theorem answer_zero (v : E) : answer (0 : E →L[ℝ] E) v = (0, 0) := by
  simp [answer]

/-- **Adaptivity step.**  If `J` answers each query of the all-zero transcript with zero, then
its transcript is the all-zero one. -/
theorem transcript_eq_replicate (alg : QueryAlg E) (J : E →L[ℝ] E) (k : ℕ)
    (hsil : ∀ n < k, answer J (silentQuery alg n) = (0, 0)) :
    ∀ n ≤ k, transcript alg J n = List.replicate n (0, 0) := by
  intro n
  induction n with
  | zero => intro _; rfl
  | succ n ih =>
    intro hn
    have ih' := ih (Nat.le_of_succ_le hn)
    have h1 : answer J (alg.query (List.replicate n (0, 0))) = (0, 0) :=
      hsil n (Nat.lt_of_succ_le hn)
    show transcript alg J n ++ [answer J (alg.query (transcript alg J n))] = _
    rw [ih', h1, List.replicate_succ']

theorem transcript_zero (alg : QueryAlg E) (n : ℕ) :
    transcript alg 0 n = List.replicate n (0, 0) :=
  transcript_eq_replicate alg 0 n (fun _ _ => answer_zero _) n le_rfl

/-- The span `S` of the queries made on the all-zero transcript. -/
def silentSpan (alg : QueryAlg E) (k : ℕ) : Submodule ℝ E :=
  Submodule.span ℝ (Set.range (fun n : Fin k => silentQuery alg n))

/-- The adversary `J_c = c • P_{Sᗮ} = c (I - P_S)`. -/
def adversary (alg : QueryAlg E) (k : ℕ) (c : ℝ) : E →L[ℝ] E :=
  c • (silentSpan alg k)ᗮ.starProjection

omit [FiniteDimensional ℝ E] in
theorem silentSpan_ne_top (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E) :
    silentSpan alg k ≠ ⊤ := by
  intro hS
  have h1 : finrank ℝ (silentSpan alg k) ≤ Fintype.card (Fin k) :=
    finrank_range_le_card (R := ℝ) (fun n : Fin k => silentQuery alg n)
  rw [hS, finrank_top, Fintype.card_fin] at h1
  omega

theorem exists_orthogonal_ne_zero (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E) :
    ∃ x ∈ (silentSpan alg k)ᗮ, x ≠ 0 := by
  have hne : (silentSpan alg k)ᗮ ≠ ⊥ := by
    intro hbot
    exact silentSpan_ne_top alg k hk (Submodule.orthogonal_eq_bot_iff.mp hbot)
  exact Submodule.exists_mem_ne_zero_of_ne_bot hne

/-- The adversary answers every silent query with `(0, 0)`. -/
theorem adversary_silent (alg : QueryAlg E) (k : ℕ) (c : ℝ) :
    ∀ n < k, answer (adversary alg k c) (silentQuery alg n) = (0, 0) := by
  intro n hn
  have hq : silentQuery alg n ∈ silentSpan alg k := Submodule.subset_span ⟨⟨n, hn⟩, rfl⟩
  have hP : (silentSpan alg k)ᗮ.starProjection (silentQuery alg n) = 0 :=
    (Submodule.starProjection_apply_eq_zero_iff (K := (silentSpan alg k)ᗮ)).mpr
      (Submodule.le_orthogonal_orthogonal (K := silentSpan alg k) hq)
  have hfwd : adversary alg k c (silentQuery alg n) = 0 := by
    simp only [adversary, ContinuousLinearMap.smul_apply, hP, smul_zero]
  have hadj : ContinuousLinearMap.adjoint (adversary alg k c) (silentQuery alg n) = 0 := by
    have hmem : ∀ v : E, adversary alg k c v ∈ (silentSpan alg k)ᗮ := by
      intro v
      simp only [adversary, ContinuousLinearMap.smul_apply]
      exact Submodule.smul_mem _ c (Submodule.starProjection_apply_mem _ v)
    obtain ⟨w, hw⟩ : ∃ w, ContinuousLinearMap.adjoint (adversary alg k c) (silentQuery alg n) = w :=
      ⟨_, rfl⟩
    rw [hw]
    have h1 := ContinuousLinearMap.adjoint_inner_left (adversary alg k c) w (silentQuery alg n)
    rw [hw, Submodule.inner_right_of_mem_orthogonal (K := silentSpan alg k) hq (hmem w)] at h1
    exact inner_self_eq_zero.mp h1
  show (adversary alg k c (silentQuery alg n),
    ContinuousLinearMap.adjoint (adversary alg k c) (silentQuery alg n)) = (0, 0)
  rw [hfwd, hadj]

/-- The algorithm cannot distinguish the adversary from `J = 0`. -/
theorem adversary_transcript (alg : QueryAlg E) (k : ℕ) (c : ℝ) :
    transcript alg (adversary alg k c) k = transcript alg 0 k := by
  rw [transcript_eq_replicate alg _ k (adversary_silent alg k c) k le_rfl, transcript_zero]

theorem adversary_norm_le (alg : QueryAlg E) (k : ℕ) (c : ℝ) (hc : 0 ≤ c) :
    ‖adversary alg k c‖ ≤ c := by
  unfold adversary
  calc ‖c • (silentSpan alg k)ᗮ.starProjection‖
      ≤ ‖c‖ * ‖(silentSpan alg k)ᗮ.starProjection‖ := ContinuousLinearMap.opNorm_smul_le _ _
    _ ≤ ‖c‖ * 1 := mul_le_mul_of_nonneg_left
        (Submodule.starProjection_norm_le (K := (silentSpan alg k)ᗮ)) (norm_nonneg _)
    _ = c := by rw [mul_one, Real.norm_eq_abs, abs_of_nonneg hc]

theorem adversary_apply_of_mem (alg : QueryAlg E) (k : ℕ) (c : ℝ) {x : E}
    (hx : x ∈ (silentSpan alg k)ᗮ) : adversary alg k c x = c • x := by
  simp only [adversary, ContinuousLinearMap.smul_apply]
  rw [Submodule.starProjection_eq_self_iff.mpr hx]

/-- On a vector orthogonal to all queries, `I - J_c` acts as `1 - c`. -/
theorem adversary_witness (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E) (c : ℝ)
    (hc1 : c ≤ 1) : ∃ x : E, x ≠ 0 ∧ ‖(1 - adversary alg k c) x‖ = (1 - c) * ‖x‖ := by
  obtain ⟨x, hx, hx0⟩ := exists_orthogonal_ne_zero alg k hk
  refine ⟨x, hx0, ?_⟩
  have hsm : x - c • x = (1 - c) • x := by rw [sub_smul, one_smul]
  rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply,
    adversary_apply_of_mem alg k c hx, hsm, norm_smul, Real.norm_eq_abs,
    abs_of_nonneg (sub_nonneg.mpr hc1)]

omit [FiniteDimensional ℝ E] in
/-- The a-priori bound is sound on `{‖J‖ ≤ L}`: `max (0, 1 - L) ≤ σ_min (I - J)`. -/
theorem apriori_bound_sound (J : E →L[ℝ] E) (L : ℝ) (hJ : ‖J‖ ≤ L) :
    IsLowerBound J (1 - min L 1) := by
  intro x
  rcases le_total L 1 with hL1 | hL1
  · rw [min_eq_left hL1]
    have h1 : ‖J x‖ ≤ L * ‖x‖ :=
      (J.le_opNorm x).trans (mul_le_mul_of_nonneg_right hJ (norm_nonneg _))
    have h2 : ‖x‖ - ‖J x‖ ≤ ‖(1 - J) x‖ := by
      rw [ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply]
      exact norm_sub_norm_le _ _
    nlinarith [h1, h2]
  · rw [min_eq_right hL1, sub_self, zero_mul]
    exact norm_nonneg _

/-- `σ_min (I - J_c) = 1 - c` exactly, for `0 ≤ c ≤ 1`. -/
theorem adversary_sigma_min (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E) (c : ℝ)
    (hc0 : 0 ≤ c) (hc1 : c ≤ 1) :
    IsGreatest {β : ℝ | IsLowerBound (adversary alg k c) β} (1 - c) := by
  constructor
  · have h := apriori_bound_sound (adversary alg k c) c (adversary_norm_le alg k c hc0)
    rwa [min_eq_left hc1] at h
  · intro β hβ
    obtain ⟨x, hx0, hx⟩ := adversary_witness alg k hk c hc1
    have h1 := (show IsLowerBound (adversary alg k c) β from hβ) x
    rw [hx] at h1
    have hxpos : 0 < ‖x‖ := norm_pos_iff.mpr hx0
    nlinarith

omit [FiniteDimensional ℝ E] in
/-- `σ_min (I - 0) = 1`. -/
theorem zero_sigma_min [Nontrivial E] :
    IsGreatest {β : ℝ | IsLowerBound (0 : E →L[ℝ] E) β} 1 := by
  constructor
  · intro x
    simp
  · intro β hβ
    obtain ⟨x, hx0⟩ := exists_ne (0 : E)
    have h1 := (show IsLowerBound (0 : E →L[ℝ] E) β from hβ) x
    simp only [sub_zero, ContinuousLinearMap.one_apply] at h1
    have hxpos : 0 < ‖x‖ := norm_pos_iff.mpr hx0
    nlinarith

/-- The core of both impossibility statements: soundness at the adversary `J_c` caps the value
certified at `J = 0` by `1 - c`. -/
theorem adversary_bound (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E) (c : ℝ)
    (hc1 : c ≤ 1)
    (hsound : IsLowerBound (adversary alg k c) (alg.out (transcript alg (adversary alg k c) k))) :
    alg.out (transcript alg 0 k) ≤ 1 - c := by
  obtain ⟨x, hx0, hx⟩ := adversary_witness alg k hk c hc1
  have h1 := hsound x
  rw [adversary_transcript, hx] at h1
  have hxpos : 0 < ‖x‖ := norm_pos_iff.mpr hx0
  nlinarith

/-- **A2, norm class.**  `k < d` adaptive forward/adjoint queries, soundness on `{‖J‖ ≤ L}`
(`L ≥ 0`): the value certified at `J = 0` is at most `1 - min L 1 = max (0, 1 - L)`, although
`σ_min (I - 0) = 1`. -/
theorem no_query_certificate_norm_class (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E)
    (L : ℝ) (hL : 0 ≤ L)
    (sound : ∀ J : E →L[ℝ] E, ‖J‖ ≤ L → IsLowerBound J (alg.out (transcript alg J k))) :
    alg.out (transcript alg 0 k) ≤ 1 - min L 1 := by
  have hc0 : 0 ≤ min L 1 := le_min hL zero_le_one
  have hJ : ‖adversary alg k (min L 1)‖ ≤ L :=
    (adversary_norm_le alg k (min L 1) hc0).trans (min_le_left _ _)
  exact adversary_bound alg k hk (min L 1) (min_le_right _ _) (sound _ hJ)

/-- **A2, contractive class.**  `k < d` queries, soundness on `{‖J‖ < 1}` (hence on any larger
class such as `{ρ(J) < 1}`): the value certified at `J = 0` is `≤ 0`. -/
theorem no_query_certificate_contractive (alg : QueryAlg E) (k : ℕ) (hk : k < finrank ℝ E)
    (sound : ∀ J : E →L[ℝ] E, ‖J‖ < 1 → IsLowerBound J (alg.out (transcript alg J k))) :
    alg.out (transcript alg 0 k) ≤ 0 := by
  have key : ∀ ε : ℝ, 0 < ε → ε ≤ 1 → alg.out (transcript alg 0 k) ≤ ε := by
    intro ε hε0 hε1
    have hJ : ‖adversary alg k (1 - ε)‖ < 1 :=
      lt_of_le_of_lt (adversary_norm_le alg k (1 - ε) (by linarith)) (by linarith)
    have h := adversary_bound alg k hk (1 - ε) (by linarith) (sound _ hJ)
    linarith
  by_contra hpos
  push_neg at hpos
  have h1 := key (min (alg.out (transcript alg 0 k) / 2) (1 / 2))
    (lt_min (by linarith) (by norm_num)) ((min_le_right _ _).trans (by norm_num))
  have h2 : min (alg.out (transcript alg 0 k) / 2) (1 / 2) ≤ alg.out (transcript alg 0 k) / 2 :=
    min_le_left _ _
  linarith

end A2

#print axioms A2.transcript_eq_replicate
#print axioms A2.transcript_zero
#print axioms A2.silentSpan_ne_top
#print axioms A2.adversary_silent
#print axioms A2.adversary_transcript
#print axioms A2.adversary_norm_le
#print axioms A2.adversary_witness
#print axioms A2.apriori_bound_sound
#print axioms A2.adversary_sigma_min
#print axioms A2.zero_sigma_min
#print axioms A2.adversary_bound
#print axioms A2.no_query_certificate_norm_class
#print axioms A2.no_query_certificate_contractive
