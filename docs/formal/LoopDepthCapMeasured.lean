/-
# The depth cap from measured residuals

Part of claim 2 of the certificate's 2026-11-07 pure-math pass
(`docs/SIGMA0-COLLAPSE-CERTIFICATE.md`, §1.2.4).

Nothing here is new mathematics: the geometric-series argument behind Banach's theorem, applied
along one run.

Checking it: Lean 4.27.0 with Mathlib v4.27.0. From any Lake project that requires
`mathlib @ "v4.27.0"` and has built it, run `lake env lean <path>/docs/formal/LoopDepthCapMeasured.lean`. The imports
are targeted, not `import Mathlib`. The expected output is 4 lines
`'…' depends on axioms: [propext, Classical.choice, Quot.sound]`, one for each `#print axioms` at
the end, and no errors or warnings. No `sorryAx` may appear.
-/
import Mathlib.Analysis.SpecificLimits.Basic

/-!
# Claim 2a, trajectory-wise: the cap needs geometric convergence, not global contraction

If the residuals `dist (h k) (h (k+1))` of one run decay geometrically with ratio `q < 1`, the run
converges to a fixed point `p` of a continuous core, and with a margin `γ` at `p` every pass
`k ≥ k₀` gives `C p` once `dist (h 0) (h 1) · q^k₀ / (1 - q) < γ`. This is the depth cap for
whatever a measured residual-contraction gate certifies along a run.

* `ratio_to_geometric`, `trajectory_cap`, `ratio_certificate`, `measured_ratio_cap`.
-/

open Filter Topology Function

namespace Claim2Traj

variable {X : Type*} [MetricSpace X] {Y : Type*}

/-- `C` has margin `γ` at `p`: it is constant on the open `γ`-ball around `p`. -/
def HasMargin (C : X → Y) (p : X) (γ : ℝ) : Prop :=
  ∀ x, dist x p < γ → C x = C p

/-- One-step residual ratios `≤ q` give geometric residuals. -/
theorem ratio_to_geometric {h : ℕ → X} {q : ℝ} (hq0 : 0 ≤ q)
    (hratio : ∀ n, dist (h (n + 1)) (h (n + 2)) ≤ q * dist (h n) (h (n + 1))) :
    ∀ n, dist (h n) (h (n + 1)) ≤ dist (h 0) (h 1) * q ^ n := by
  intro n
  induction n with
  | zero => simp
  | succ n ih =>
    calc dist (h (n + 1)) (h (n + 1 + 1)) ≤ q * dist (h n) (h (n + 1)) := hratio n
      _ ≤ q * (dist (h 0) (h 1) * q ^ n) := mul_le_mul_of_nonneg_left ih hq0
      _ = dist (h 0) (h 1) * q ^ (n + 1) := by ring

/-- **Trajectory-wise cap.** Geometric residuals and convergence to `p`, plus a margin at `p`:
every pass `k ≥ k₀` gives `C p` once `C₀ · q^k₀ / (1 - q) < γ`. No global contraction. -/
theorem trajectory_cap {h : ℕ → X} {q C₀ : ℝ} (hq0 : 0 ≤ q) (hq : q < 1)
    (hres : ∀ n, dist (h n) (h (n + 1)) ≤ C₀ * q ^ n) {p : X} (hlim : Tendsto h atTop (𝓝 p))
    {C : X → Y} {γ : ℝ} (hC : HasMargin C p γ) {k₀ : ℕ} (hk₀ : C₀ * q ^ k₀ / (1 - q) < γ) :
    ∀ k, k₀ ≤ k → C (h k) = C p := by
  intro k hk
  apply hC
  have h1q : 0 < 1 - q := sub_pos.mpr hq
  have hC0 : 0 ≤ C₀ := by
    have := le_trans dist_nonneg (hres 0)
    simpa using this
  have hd := dist_le_of_le_geometric_of_tendsto q C₀ hq hres hlim k
  have hpow : q ^ k ≤ q ^ k₀ := pow_le_pow_of_le_one hq0 hq.le hk
  have hmono : C₀ * q ^ k / (1 - q) ≤ C₀ * q ^ k₀ / (1 - q) :=
    (div_le_div_iff_of_pos_right h1q).mpr (mul_le_mul_of_nonneg_left hpow hC0)
  linarith

/-- On a complete space with a continuous core, step ratios `≤ q < 1` along one run give a
limit `p` that is a fixed point, with the a priori bound `dist (h 0) (h 1) · q^k / (1 - q)`. -/
theorem ratio_certificate [CompleteSpace X] {F : X → X} (hF : Continuous F) {h : ℕ → X}
    (hstep : ∀ n, h (n + 1) = F (h n)) {q : ℝ} (hq0 : 0 ≤ q) (hq : q < 1)
    (hratio : ∀ n, dist (h (n + 1)) (h (n + 2)) ≤ q * dist (h n) (h (n + 1))) :
    ∃ p, F p = p ∧ Tendsto h atTop (𝓝 p) ∧
      ∀ k, dist (h k) p ≤ dist (h 0) (h 1) * q ^ k / (1 - q) := by
  have hgeo := ratio_to_geometric hq0 hratio
  obtain ⟨p, hp⟩ := cauchySeq_tendsto_of_complete (cauchySeq_of_le_geometric q _ hq hgeo)
  refine ⟨p, ?_, hp, fun k => dist_le_of_le_geometric_of_tendsto q _ hq hgeo hp k⟩
  have h1 : Tendsto (fun n => h (n + 1)) atTop (𝓝 p) := hp.comp (tendsto_add_atTop_nat 1)
  have h2 : Tendsto (fun n => h (n + 1)) atTop (𝓝 (F p)) := by
    have hfun : (fun n => h (n + 1)) = F ∘ h := funext hstep
    rw [hfun]
    exact (hF.tendsto p).comp hp
  exact tendsto_nhds_unique h2 h1

/-- **The cap for a measured-ratio certificate.** Same hypotheses; if the readout has margin
`γ` at the limit, all passes `k ≥ k₀` agree with it once
`dist (h 0) (h 1) · q^k₀ / (1 - q) < γ`. -/
theorem measured_ratio_cap [CompleteSpace X] {F : X → X} (hF : Continuous F) {h : ℕ → X}
    (hstep : ∀ n, h (n + 1) = F (h n)) {q : ℝ} (hq0 : 0 ≤ q) (hq : q < 1)
    (hratio : ∀ n, dist (h (n + 1)) (h (n + 2)) ≤ q * dist (h n) (h (n + 1)))
    {k₀ : ℕ} {γ : ℝ} (hk₀ : dist (h 0) (h 1) * q ^ k₀ / (1 - q) < γ) :
    ∃ p, F p = p ∧ ∀ C : X → Y, HasMargin C p γ → ∀ k, k₀ ≤ k → C (h k) = C p := by
  obtain ⟨p, hfix, hlim, -⟩ := ratio_certificate hF hstep hq0 hq hratio
  exact ⟨p, hfix, fun C hC => trajectory_cap hq0 hq (ratio_to_geometric hq0 hratio) hlim hC hk₀⟩

end Claim2Traj

#print axioms Claim2Traj.ratio_to_geometric
#print axioms Claim2Traj.trajectory_cap
#print axioms Claim2Traj.ratio_certificate
#print axioms Claim2Traj.measured_ratio_cap
