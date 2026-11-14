/-
# A stop certificate that needs no known fixed point

Part of the certificate's 2026-11-07 pure-math pass (`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4):
from the current iterate alone, a ball that provably holds exactly one fixed point, and the
distance to it.

Nothing here is new mathematics: it is the simplified-Newton (chord) form of the Kantorovich,
Urabe and Krawczyk a-posteriori existence theorems (Kantorovich & Akilov, ch. XVIII; Ortega &
Rheinboldt 1970, §§10.1 and 12.6; Urabe 1965; Krawczyk 1969; Rump 2010).

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopStopCertificate.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 6 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.Calculus.MeanValue
import Mathlib.Topology.MetricSpace.Contracting

/-!
# A1. The ball form of the stop certificate, with no fixed point assumed

`E` is a real Banach space, `F : E → E` the loop map, `h` the current iterate, `Δh = F h - h`.

`A` is a reference linear map (for example the Jacobian at `h`, or a computed approximation of
it) with `I - A` invertible: `u` is a unit of the ring `E →L[ℝ] E` with `↑u = 1 - A`, so
`↑u⁻¹ = (I - A)⁻¹`.

The chord (simplified-Newton) map is `G x = x + (I - A)⁻¹ (F x - x)`.  Its fixed points are
exactly the fixed points of `F` (`chordMap_eq_self_iff`), its derivative is
`(I - A)⁻¹ (F' x - A)` (`chordMap_hasFDerivWithinAt`), so by the mean value inequality it is a
contraction of the closed ball when `(I - A)⁻¹ (F' x - A)` is small there, and Banach's fixed point
theorem on the complete ball gives the fixed point.  This is the Urabe / Kantorovich / Krawczyk
"radii" form of an a-posteriori existence theorem.

Main results
* `ball_certificate`  (general constants `Y`, `Z`):
  if `‖(I - A)⁻¹ (F h - h)‖ ≤ Y`, `‖(I - A)⁻¹ (F' x - A)‖ ≤ Z < 1` on `B̄(h, R)` and
  `Y ≤ (1 - Z) R`, then `F` has exactly one fixed point `h⋆` in `B̄(h, R)`, and
  `‖(I - A)⁻¹ (F h - h)‖ / (1 + Z) ≤ ‖h - h⋆‖ ≤ Y / (1 - Z)`.
* `ball_certificate_Meta` (the form the certificate quotes): `‖(I - A)⁻¹‖ ≤ M`, `‖F' x - A‖ ≤ η` on the ball,
  `M η < 1`, `M ‖F h - h‖ ≤ (1 - M η) R`  ⟹  unique `h⋆ ∈ B̄(h, R)`,
  `‖h - h⋆‖ ≤ M ‖F h - h‖ / (1 - M η)`.
* `ball_certificate_lipschitz`: the same with `η = η₀ + L R` from an `L`-Lipschitz Jacobian.
* `kantorovich_type`: if `4 M² L ‖F h - h‖ ≤ (1 - M η₀)²` the radius
  `R = 2 M ‖F h - h‖ / (1 - M η₀)` works, and `‖h - h⋆‖ ≤ R`.
-/

noncomputable section

open Metric Set

namespace A1

variable {E : Type*} [NormedAddCommGroup E] [NormedSpace ℝ E]

lemma inv_apply_unit_apply (u : (E →L[ℝ] E)ˣ) (y : E) :
    (↑u⁻¹ : E →L[ℝ] E) ((u : E →L[ℝ] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.inv_mul, ContinuousLinearMap.one_apply]

lemma unit_apply_inv_apply (u : (E →L[ℝ] E)ˣ) (y : E) :
    (u : E →L[ℝ] E) ((↑u⁻¹ : E →L[ℝ] E) y) = y := by
  rw [← ContinuousLinearMap.mul_apply, Units.mul_inv, ContinuousLinearMap.one_apply]

/-- The chord (simplified-Newton) map `G x = x + (I - A)⁻¹ (F x - x)`. -/
def chordMap (F : E → E) (u : (E →L[ℝ] E)ˣ) (x : E) : E :=
  x + (↑u⁻¹ : E →L[ℝ] E) (F x - x)

/-- `G` and `F` have the same fixed points. -/
theorem chordMap_eq_self_iff (F : E → E) (u : (E →L[ℝ] E)ˣ) (x : E) :
    chordMap F u x = x ↔ F x = x := by
  constructor
  · intro hx
    have h2 : chordMap F u x - x = (↑u⁻¹ : E →L[ℝ] E) (F x - x) := by
      unfold chordMap
      abel
    have h1 : (↑u⁻¹ : E →L[ℝ] E) (F x - x) = 0 := by
      rw [← h2, hx, sub_self]
    have h3 : F x - x = 0 := by
      have h4 := congrArg (u : E →L[ℝ] E) h1
      rwa [unit_apply_inv_apply, map_zero] at h4
    exact sub_eq_zero.mp h3
  · intro hx
    unfold chordMap
    rw [hx, sub_self, map_zero, add_zero]

/-- The derivative of the chord map is `(I - A)⁻¹ ∘ (F' x - A)`. -/
theorem chordMap_hasFDerivWithinAt (F : E → E) (F' : E → E →L[ℝ] E) (A : E →L[ℝ] E)
    (u : (E →L[ℝ] E)ˣ) (hu : (u : E →L[ℝ] E) = 1 - A) (s : Set E) (x : E)
    (hF : HasFDerivWithinAt F (F' x) s x) :
    HasFDerivWithinAt (chordMap F u) ((↑u⁻¹ : E →L[ℝ] E).comp (F' x - A)) s x := by
  have h1 : HasFDerivWithinAt (fun y => F y - id y) (F' x - ContinuousLinearMap.id ℝ E) s x :=
    hF.sub (hasFDerivWithinAt_id x s)
  have h2 : HasFDerivWithinAt ((↑u⁻¹ : E →L[ℝ] E) ∘ (fun y => F y - id y))
      ((↑u⁻¹ : E →L[ℝ] E).comp (F' x - ContinuousLinearMap.id ℝ E)) s x :=
    (↑u⁻¹ : E →L[ℝ] E).hasFDerivAt.comp_hasFDerivWithinAt x h1
  have h3 : HasFDerivWithinAt (fun y => id y + ((↑u⁻¹ : E →L[ℝ] E) ∘ (fun y => F y - id y)) y)
      (ContinuousLinearMap.id ℝ E
        + (↑u⁻¹ : E →L[ℝ] E).comp (F' x - ContinuousLinearMap.id ℝ E)) s x :=
    (hasFDerivWithinAt_id x s).add h2
  have hfun : (fun y => id y + ((↑u⁻¹ : E →L[ℝ] E) ∘ (fun y => F y - id y)) y) = chordMap F u := by
    funext y
    rfl
  rw [hfun] at h3
  refine h3.congr_fderiv ?_
  ext v
  have hv : (↑u⁻¹ : E →L[ℝ] E) (v - A v) = v := by
    have hvA : v - A v = (u : E →L[ℝ] E) v := by
      rw [hu, ContinuousLinearMap.sub_apply, ContinuousLinearMap.one_apply]
    rw [hvA, inv_apply_unit_apply]
  simp only [ContinuousLinearMap.add_apply, ContinuousLinearMap.id_apply,
    ContinuousLinearMap.comp_apply, ContinuousLinearMap.sub_apply]
  calc v + (↑u⁻¹ : E →L[ℝ] E) ((F' x) v - v)
      = (↑u⁻¹ : E →L[ℝ] E) (v - A v) + (↑u⁻¹ : E →L[ℝ] E) ((F' x) v - v) := by rw [hv]
    _ = (↑u⁻¹ : E →L[ℝ] E) ((F' x) v - A v) := by
        rw [← map_add]
        congr 1
        abel

variable [CompleteSpace E]

/-- **A1, general form.**  No fixed point is assumed.  If `‖(I - A)⁻¹ (F h - h)‖ ≤ Y`,
`‖(I - A)⁻¹ ∘ (F' x - A)‖ ≤ Z` for every `x` in `B̄(h, R)`, `Z < 1` and `Y ≤ (1 - Z) R`, then `F`
has a fixed point `h⋆ ∈ B̄(h, R)`, it is the only fixed point of `F` in `B̄(h, R)`, and
`‖(I - A)⁻¹ (F h - h)‖ / (1 + Z) ≤ ‖h - h⋆‖ ≤ Y / (1 - Z)`. -/
theorem ball_certificate (F : E → E) (F' : E → E →L[ℝ] E) (A : E →L[ℝ] E)
    (u : (E →L[ℝ] E)ˣ) (hu : (u : E →L[ℝ] E) = 1 - A) (h : E) (R Y Z : ℝ)
    (hF : ∀ x ∈ closedBall h R, HasFDerivWithinAt F (F' x) (closedBall h R) x)
    (hZ : ∀ x ∈ closedBall h R, ‖(↑u⁻¹ : E →L[ℝ] E).comp (F' x - A)‖ ≤ Z)
    (hY : ‖(↑u⁻¹ : E →L[ℝ] E) (F h - h)‖ ≤ Y)
    (hZ1 : Z < 1) (hYR : Y ≤ (1 - Z) * R) :
    ∃ hs ∈ closedBall h R, F hs = hs ∧ ‖h - hs‖ ≤ Y / (1 - Z) ∧
      ‖(↑u⁻¹ : E →L[ℝ] E) (F h - h)‖ / (1 + Z) ≤ ‖h - hs‖ ∧
      ∀ z ∈ closedBall h R, F z = z → z = hs := by
  have hY0 : 0 ≤ Y := (norm_nonneg _).trans hY
  have h1Z : 0 < 1 - Z := sub_pos.mpr hZ1
  have hR0 : 0 ≤ R := by
    by_contra hneg
    push_neg at hneg
    have : (1 - Z) * R < 0 := mul_neg_of_pos_of_neg h1Z hneg
    linarith
  have hhs : h ∈ closedBall h R := mem_closedBall_self hR0
  have hZ0 : 0 ≤ Z := (norm_nonneg _).trans (hZ h hhs)
  -- the chord map is `Z`-Lipschitz on the ball (mean value inequality)
  have hlip : ∀ x ∈ closedBall h R, ∀ y ∈ closedBall h R,
      ‖chordMap F u x - chordMap F u y‖ ≤ Z * ‖x - y‖ := by
    intro x hx y hy
    exact (convex_closedBall h R).norm_image_sub_le_of_norm_hasFDerivWithin_le
      (f := chordMap F u) (f' := fun z => (↑u⁻¹ : E →L[ℝ] E).comp (F' z - A))
      (fun z hz => chordMap_hasFDerivWithinAt F F' A u hu (closedBall h R) z (hF z hz))
      hZ hy hx
  have hGh : chordMap F u h - h = (↑u⁻¹ : E →L[ℝ] E) (F h - h) := by
    unfold chordMap
    abel
  have hGhY : ‖chordMap F u h - h‖ ≤ Y := by rw [hGh]; exact hY
  -- the chord map sends the ball into itself
  have hmaps : MapsTo (chordMap F u) (closedBall h R) (closedBall h R) := by
    intro x hx
    have hx' : ‖x - h‖ ≤ R := by rw [← dist_eq_norm]; exact mem_closedBall.mp hx
    rw [mem_closedBall, dist_eq_norm]
    calc ‖chordMap F u x - h‖
        = ‖(chordMap F u x - chordMap F u h) + (chordMap F u h - h)‖ := by
          congr 1
          abel
      _ ≤ ‖chordMap F u x - chordMap F u h‖ + ‖chordMap F u h - h‖ := norm_add_le _ _
      _ ≤ Z * ‖x - h‖ + Y := add_le_add (hlip x hx h hhs) hGhY
      _ ≤ Z * R + Y := by
          have := mul_le_mul_of_nonneg_left hx' hZ0
          linarith
      _ ≤ R := by linarith
  -- a contraction of the complete ball
  have hcontr : ContractingWith (Real.toNNReal Z) (hmaps.restrict (chordMap F u) _ _) := by
    refine ⟨Real.toNNReal_lt_one.mpr hZ1, ?_⟩
    refine LipschitzWith.of_dist_le' (fun x y => ?_)
    simp only [Subtype.dist_eq, MapsTo.val_restrict_apply, dist_eq_norm]
    exact hlip x x.2 y y.2
  obtain ⟨hs, hss, hfix, -, -⟩ := ContractingWith.exists_fixedPoint' (f := chordMap F u)
    isClosed_closedBall.isComplete hmaps hcontr hhs (edist_ne_top _ _)
  have hGfix : chordMap F u hs = hs := hfix
  have hFfix : F hs = hs := (chordMap_eq_self_iff F u hs).mp hGfix
  refine ⟨hs, hss, hFfix, ?_, ?_, ?_⟩
  · -- upper bound
    have key : ‖h - hs‖ ≤ Y + Z * ‖h - hs‖ := by
      calc ‖h - hs‖ = ‖(h - chordMap F u h) + (chordMap F u h - chordMap F u hs)‖ := by
            rw [hGfix]
            congr 1
            abel
        _ ≤ ‖h - chordMap F u h‖ + ‖chordMap F u h - chordMap F u hs‖ := norm_add_le _ _
        _ ≤ Y + Z * ‖h - hs‖ := by
            refine add_le_add ?_ (hlip h hhs hs hss)
            rw [norm_sub_rev]
            exact hGhY
    rw [le_div_iff₀ h1Z]
    nlinarith [key]
  · -- lower bound
    have key : ‖(↑u⁻¹ : E →L[ℝ] E) (F h - h)‖ ≤ (1 + Z) * ‖h - hs‖ := by
      rw [← hGh]
      calc ‖chordMap F u h - h‖
          = ‖(chordMap F u h - chordMap F u hs) + (hs - h)‖ := by
            rw [hGfix]
            congr 1
            abel
        _ ≤ ‖chordMap F u h - chordMap F u hs‖ + ‖hs - h‖ := norm_add_le _ _
        _ ≤ Z * ‖h - hs‖ + ‖h - hs‖ := by
            refine add_le_add (hlip h hhs hs hss) ?_
            rw [norm_sub_rev]
        _ = (1 + Z) * ‖h - hs‖ := by ring
    have h1Z' : 0 < 1 + Z := by linarith
    rw [div_le_iff₀ h1Z']
    linarith [key]
  · -- uniqueness
    intro z hz hFz
    have hGz : chordMap F u z = z := (chordMap_eq_self_iff F u z).mpr hFz
    have hle : ‖z - hs‖ ≤ Z * ‖z - hs‖ := by
      have := hlip z hz hs hss
      rwa [hGz, hGfix] at this
    have hle0 : ‖z - hs‖ ≤ 0 := by nlinarith [norm_nonneg (z - hs)]
    exact sub_eq_zero.mp (norm_le_zero_iff.mp hle0)

/-- **A1, the form the certificate quotes.**  `‖(I - A)⁻¹‖ ≤ M`, `‖F' x - A‖ ≤ η` on `B̄(h, R)`, `M η < 1` and
`M ‖F h - h‖ ≤ (1 - M η) R`.  Then `F` has exactly one fixed point `h⋆` in `B̄(h, R)` and
`‖h - h⋆‖ ≤ M ‖F h - h‖ / (1 - M η)`. -/
theorem ball_certificate_Meta (F : E → E) (F' : E → E →L[ℝ] E) (A : E →L[ℝ] E)
    (u : (E →L[ℝ] E)ˣ) (hu : (u : E →L[ℝ] E) = 1 - A) (h : E) (R M η : ℝ)
    (hM : ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ M)
    (hF : ∀ x ∈ closedBall h R, HasFDerivWithinAt F (F' x) (closedBall h R) x)
    (hη : ∀ x ∈ closedBall h R, ‖F' x - A‖ ≤ η)
    (hMη : M * η < 1) (hR : M * ‖F h - h‖ ≤ (1 - M * η) * R) :
    ∃ hs ∈ closedBall h R, F hs = hs ∧ ‖h - hs‖ ≤ M * ‖F h - h‖ / (1 - M * η) ∧
      ∀ z ∈ closedBall h R, F z = z → z = hs := by
  have hM0 : 0 ≤ M := (norm_nonneg _).trans hM
  obtain ⟨hs, hss, hfix, hbound, -, huniq⟩ :=
    ball_certificate F F' A u hu h R (M * ‖F h - h‖) (M * η) hF
      (fun x hx => (ContinuousLinearMap.opNorm_comp_le _ _).trans
        (mul_le_mul hM (hη x hx) (norm_nonneg _) hM0))
      ((ContinuousLinearMap.le_opNorm _ _).trans
        (mul_le_mul_of_nonneg_right hM (norm_nonneg _)))
      hMη hR
  exact ⟨hs, hss, hfix, hbound, huniq⟩

/-- **A1 with a Lipschitz Jacobian.**  If `‖F' x - F' h‖ ≤ L ‖x - h‖` on the ball and
`‖F' h - A‖ ≤ η₀`, then `η = η₀ + L R` works in `ball_certificate_Meta`. -/
theorem ball_certificate_lipschitz (F : E → E) (F' : E → E →L[ℝ] E) (A : E →L[ℝ] E)
    (u : (E →L[ℝ] E)ˣ) (hu : (u : E →L[ℝ] E) = 1 - A) (h : E) (R M η₀ L : ℝ)
    (hM : ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ M)
    (hF : ∀ x ∈ closedBall h R, HasFDerivWithinAt F (F' x) (closedBall h R) x)
    (hA : ‖F' h - A‖ ≤ η₀) (hL0 : 0 ≤ L)
    (hLip : ∀ x ∈ closedBall h R, ‖F' x - F' h‖ ≤ L * ‖x - h‖)
    (hMη : M * (η₀ + L * R) < 1) (hR : M * ‖F h - h‖ ≤ (1 - M * (η₀ + L * R)) * R) :
    ∃ hs ∈ closedBall h R, F hs = hs ∧
      ‖h - hs‖ ≤ M * ‖F h - h‖ / (1 - M * (η₀ + L * R)) ∧
      ∀ z ∈ closedBall h R, F z = z → z = hs := by
  refine ball_certificate_Meta F F' A u hu h R M (η₀ + L * R) hM hF ?_ hMη hR
  intro x hx
  have hxR : ‖x - h‖ ≤ R := by rw [← dist_eq_norm]; exact mem_closedBall.mp hx
  calc ‖F' x - A‖ = ‖(F' x - F' h) + (F' h - A)‖ := by
        congr 1
        abel
    _ ≤ ‖F' x - F' h‖ + ‖F' h - A‖ := norm_add_le _ _
    _ ≤ L * ‖x - h‖ + η₀ := add_le_add (hLip x hx) hA
    _ ≤ L * R + η₀ := by
        have := mul_le_mul_of_nonneg_left hxR hL0
        linarith
    _ = η₀ + L * R := by ring

/-- **A Kantorovich-type corollary (constant `1/4`).**  With `q = 1 - M η₀ > 0`, if
`4 M² L ‖F h - h‖ ≤ q²` and the Jacobian is `L`-Lipschitz on `B̄(h, R)` for
`R = 2 M ‖F h - h‖ / q`, then `F` has exactly one fixed point in `B̄(h, R)` and it lies within
`R` of `h`. -/
theorem kantorovich_type (F : E → E) (F' : E → E →L[ℝ] E) (A : E →L[ℝ] E)
    (u : (E →L[ℝ] E)ˣ) (hu : (u : E →L[ℝ] E) = 1 - A) (h : E) (M η₀ L : ℝ)
    (hM : ‖(↑u⁻¹ : E →L[ℝ] E)‖ ≤ M) (hq : M * η₀ < 1)
    (hF : ∀ x ∈ closedBall h (2 * M * ‖F h - h‖ / (1 - M * η₀)),
      HasFDerivWithinAt F (F' x) (closedBall h (2 * M * ‖F h - h‖ / (1 - M * η₀))) x)
    (hA : ‖F' h - A‖ ≤ η₀) (hL0 : 0 ≤ L)
    (hLip : ∀ x ∈ closedBall h (2 * M * ‖F h - h‖ / (1 - M * η₀)),
      ‖F' x - F' h‖ ≤ L * ‖x - h‖)
    (hK : 4 * M ^ 2 * L * ‖F h - h‖ ≤ (1 - M * η₀) ^ 2) :
    ∃ hs ∈ closedBall h (2 * M * ‖F h - h‖ / (1 - M * η₀)), F hs = hs ∧
      ∀ z ∈ closedBall h (2 * M * ‖F h - h‖ / (1 - M * η₀)), F z = z → z = hs := by
  have hM0 : 0 ≤ M := (norm_nonneg _).trans hM
  set D := ‖F h - h‖ with hD
  set q := 1 - M * η₀ with hqdef
  have hqpos : 0 < q := sub_pos.mpr hq
  have hD0 : 0 ≤ D := norm_nonneg _
  set R := 2 * M * D / q with hRdef
  have hR0 : 0 ≤ R := by positivity
  have hMLR : M * L * R ≤ q / 2 := by
    have e1 : M * L * R = (2 * M ^ 2 * L * D) / q := by
      rw [hRdef]
      field_simp
    rw [e1, div_le_iff₀ hqpos]
    nlinarith [hK]
  have hRq : q * R = 2 * M * D := by
    rw [hRdef]
    field_simp
  have hc1 : M * (η₀ + L * R) < 1 := by
    have e2 : M * (η₀ + L * R) = (1 - q) + M * L * R := by
      rw [hqdef]
      ring
    rw [e2]
    linarith
  have hc2 : M * D ≤ (1 - M * (η₀ + L * R)) * R := by
    have e3 : (1 - M * (η₀ + L * R)) * R = q * R - (M * L * R) * R := by
      rw [hqdef]
      ring
    rw [e3, hRq]
    have := mul_le_mul_of_nonneg_right hMLR hR0
    nlinarith [this, hRq]
  obtain ⟨hs, hss, hfix, -, huniq⟩ :=
    ball_certificate_lipschitz F F' A u hu h R M η₀ L hM hF hA hL0 hLip hc1 hc2
  exact ⟨hs, hss, hfix, huniq⟩

end A1

#print axioms A1.chordMap_eq_self_iff
#print axioms A1.chordMap_hasFDerivWithinAt
#print axioms A1.ball_certificate
#print axioms A1.ball_certificate_Meta
#print axioms A1.ball_certificate_lipschitz
#print axioms A1.kantorovich_type
