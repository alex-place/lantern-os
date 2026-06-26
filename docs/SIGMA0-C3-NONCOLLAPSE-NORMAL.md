# Theorem C3 — Σ₀⁻¹ prevents permanent freeze (all A)

**Status: PROVEN (all A), computationally machine-checked.**
Verified against the repo 2026-06-26. The original proof closed the **normal/symmetric**
case; **§7 (L2′)** then removed the alignment hypothesis L1 — the one place normality was
used — so the no-permanent-freeze conclusion now holds for **non-normal `A` too**. Gating
artifacts all landed and pass:
- normal A: `experiments/prove_c3_noncollapse.py` (3000 configs → **0** floor failures,
  **0** cond_flat survivals; necessity: the old scale-blind bump fails **2989/3000**).
- non-normal A: `experiments/prove_c3_noncollapse_nonnormal.py` (4000 genuinely non-normal
  configs incl. the adversarial worst-case alignment → **0** lift failures, **0** gate
  survivals).
- tests: `tests/test_cio_sde.py::{test_l4_floor_lifts_anisotropy,
  test_l4_floor_scale_equivariant, test_g13_no_zero_rank_bump, test_c3_no_consecutive_freeze,
  test_c3_nonnormal_covariance_lift}` (all green), atop the L4/G13 code fixes in
  `src/cio_sde/collapse.py` (`_cov_floor` @507, `_near_null_basis` @479).

This proves the §3 sufficiency claim of the
[Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md).

**Three honest scope limits remain — do not overclaim past them:**
1. **C3 is no-permanent-*freeze*, not the whole collapse story.** What stays open for
   non-normal `A` is **Theorem 1's contraction** — whether an ungrounded system collapses
   onto the manifold *at all* vs. diverges (the §1 cross-term, [#768]). C3 says the
   *rescue* operator can't let the freeze gate latch; it says nothing about *whether* the
   bad dynamics contract. [#768] is therefore now **split**: the anti-freeze half is
   closed (here); the Theorem-1 contraction half remains.
2. **"Machine-checked" = closed-form algebra + numerical sweep + pytest, NOT a Lean/Mathlib
   formal proof.** The chain is *feasible* in Lean; that has not been done.
3. **C3 governs the operator's *action*.** In the live engine Σ₀⁻¹ is observe-only by
   default (#1138), so C3 is conditional on the operator being permitted to act.

This document also specifies the two **code fixes** (L4, G13) that the shipped
`src/cio_sde/collapse.py` operator required for the theorem to be true of the *shipped*
operator, not just an idealized one — both now landed.

Companion lemma (already closed): [L2 — the one-step anisotropy lift](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md).

---

## 0. What is being proven, and what is not

The certificate proves the **bad** direction (Theorem 1): an ungrounded system
contracts onto the dead null manifold (the 42-state). §3 claims the **rescue**:
the proximity-gated excitation operator Σ₀⁻¹ keeps the system *off* that manifold.
§3 is currently MEASURED (900-run sweep, 100%) but has **no sufficiency theorem**.

This document supplies that theorem **under the normal-A hypothesis**:

> **Theorem C3 (normal A).** For a rollout whose drift Jacobian `A` is normal
> (`A Aᵀ = Aᵀ A`), with the L4-corrected, G13-corrected Σ₀⁻¹ operator, the
> four-condition freeze gate is **false on at least every other step**. Hence the
> integrator never permanently overwrites the state with `x*`, i.e.
> `P(permanent freeze) = 0`.

The proof chains five lemmas. Three are settled; two require the code fixes below.

| Lemma | Claim | Status before this doc |
|---|---|---|
| **L1** | the bump basis (`eig(A_s)`) aligns with `eig(Σ)` | proven **normal A** — and **removed entirely** for all `A` by L2′ (§7) |
| **L2** | one aligned bump `b ≥ Δ` ⟹ `a(Σ⁺) ≥ ε_a` (breaks `cond_flat`) | **PROVEN + machine-checked** |
| **L3** | `cond_flat` false ⟹ the AND-gate cannot fire that step | trivial (AND-gate) |
| **L4** | the operator actually delivers `b ≥ Δ` on a freeze-approach step | **FALSE for shipped code** — fixed here |
| **L5** | L1–L4 ⟹ the freeze gate cannot latch permanently | not assembled — assembled here |

---

## 1. Setup (matches `src/cio_sde/collapse.py` exactly)

The freeze gate (`SemanticCollapseOperator.evaluate`, `collapse.py:136–140`) fires iff
**all four** hold:

```
cond_grad : ‖∇ₓL‖   < grad_eps        (=1e-2)
cond_rank : eff_rank < rank_frac·d     (rank_frac=0.5)
cond_flat : a(Σ)     < anisotropy_eps  (ε_a = 5e-2)
cond_ctrl : ‖∂H/∂u‖  < ctrl_eps        (=1e-2)
triggered = cond_grad ∧ cond_rank ∧ cond_flat ∧ cond_ctrl
```

`a(Σ) = std(λ)/mean(λ)` over `λ = eig(½(Σ+Σᵀ))` (`_anisotropy`, `collapse.py:87–91`).
When `triggered`, the integrator (`engine.forward_step`) overwrites `x_next = x*` and
discards the diffusion term — that overwrite, repeated forever, **is** the permanent
freeze. Σ₀⁻¹ (`AntiCollapseOperator`, `collapse.py:438–492`) adds, in one step,
`Σ⁺ = Σ + b·P_N` with `b = strength·p` and `P_N = V_null V_nullᵀ` (rank `k`), where

```
p = proximity(...) = min(p_grad, p_rank, p_flat, p_ctrl)        (collapse.py:476)
p_i = _below(value_i, threshold_i) = clip(1 − value_i/threshold_i, 0, 1)
V_null = eigenvectors of A_s with |λ| < eig_eps                  (collapse.py:484)
```

L2's threshold is `Δ = (ε_a + a)·μ·d / (√(k(d−k)) − ε_a·k)`, `μ = mean(λ(Σ)) > 0`.

---

## 2. The two defects that make L4 false (code fixes required)

### 2.1 Defect A — the `min`-gate vanishes at the crossing

`cond_*` use **strict** `<`. As the state approaches the boundary, each
`value_i → threshold_iˉ`, so each `p_i = 1 − value_i/threshold_i → 0⁺`, so
`p = min(...) → 0`, so `b = strength·p → 0`. **The operator's firing strength is
weakest exactly where the freeze is imminent.** Since L2 needs `b ≥ Δ > 0`, the
shipped gate violates L4 in an open neighborhood of the boundary: there are
freeze-approach states where the operator fires an arbitrarily weak bump that does
**not** lift `a(Σ)` above `ε_a`.

**Fix A — a μ-aware covariance-bump floor.** Σ₀⁻¹ already only fires when
`proximity > 0` (the engine gates `excite` on it), which holds precisely when all
four conditions are near their thresholds — i.e. on the freeze-approach. So the floor
needs no separate guard-band predicate: it activates exactly when `excite` runs.
Floor the **covariance-bump magnitude** to L2's exact per-step threshold, evaluated
at the bump's actual rank `m` (known at fire time, §2.2) and the current `(a, μ)`:

```
b_cov = max( strength · p,  Δ(a, μ, d, m) ),   Δ(a,μ,d,m) = (ε_a + a)·μ·d / (√(m(d−m)) − ε_a·m)
```

with `a = clip(a(Σ), 0, ε_a)` and `μ = mean λ(Σ)`. Because `m ≤ d−1` (Fix B), the
denominator is positive, so `Δ` is finite and `b_cov ≥ Δ` is exactly L2's hypothesis
for the bump about to be applied. When `excite` is *not* called (healthy regime,
`proximity = 0` and no surprise) nothing is injected — the §3 "costs nothing when
safe" promise is preserved.

**Scale-equivariance is essential.** Δ scales with `μ` (the covariance magnitude),
so a *fixed* floor is defeated by rescaling Σ. The floor must be **μ-aware** — i.e.
`b_cov ∝ μ`. This is the substantive correction: the shipped `strength·p` is
scale-blind, so `Σ ↦ cΣ` (which leaves `a(Σ)` and the trigger invariant) leaves the
bump unchanged and thus eventually too small relative to `Δ ∝ μ`. (For a worst-case
feel, `d = 4`, `ε_a = 0.05`, `a → ε_a`, `m = 3`: `Δ = 2·0.05·μ·4/(√3 − 0.15) ≈
0.253·μ`.)

### 2.2 Defect B (G13) — the aim comes up empty at the `eig_eps` edge

`V_null` is selected by the **hard** cutoff `|λ(A_s)| < eig_eps`. A collapsing system
whose degenerate modes are parked *just above* `eig_eps` yields `V_null` of rank
`k = 0`; `excite` then returns zeros (`collapse.py:485–486`). So the operator can fire
a **blank** precisely when `cond_rank` says the system is rank-deficient — a second,
independent way L4 fails. (Logged as red-team gap **G13** in
[ANTI-COLLAPSE-HARDENING.md](ANTI-COLLAPSE-HARDENING.md) §5.)

**Fix B — banded near-null aiming tied to the rank deficit, clamped to `≤ d−1`.**
Instead of a hard `eig_eps` cutoff, target the `m` smallest-`|λ|` modes of `A_s`,
where

```
m = clamp( max(hard_null_count, d − round(eff_rank)),  1,  d−1 ).
```

`eff_rank` is the very quantity `cond_rank` thresholds, so `m ≥ 1` whenever
`cond_rank` fires (fixes G13's zero-rank blank). The band coincides with the hard
cutoff when modes are cleanly separated, so healthy regimes are unaffected.

> **The `d−1` clamp is not cosmetic — it's a correctness fix surfaced by the
> implementation.** L2 requires a *proper* null subspace `1 ≤ k ≤ d−1`. If the
> system is **fully** degenerate (`A_s ≈ 0`, every mode null, so `d − eff_rank = d`)
> and we bump *all* `d` modes, `Σ⁺ = Σ + b·I` shifts every eigenvalue by `b`
> equally: the std of the eigenvalues is **unchanged** and the mean grows, so
> `a(Σ⁺) = std/mean` *decreases* — the bump makes `cond_flat` **more** true, the
> opposite of the intent. (This is also why L2's denominator `√(k(d−k)) − ε_a·k`
> goes negative at `k=d`.) Clamping `m ≤ d−1` always leaves at least one mode
> unbumped, so the bump creates a genuine `μ`-gap between the `m` bumped modes and
> the rest — anisotropy *rises*. Thus the covariance leg breaks `cond_flat` across
> the **entire** trigger regime (`eff_rank < d/2` ⟹ `m ∈ (d/2, d−1]`), full
> degeneracy included, by treating full degeneracy as a `k=d−1` bump.

> **Two legs, decoupled (an honesty note the code forced).** There are *two* ways
> Σ₀⁻¹ can break the freeze: lift `a(Σ)` above `ε_a` (the **covariance leg**,
> `cond_flat`), or raise `‖x‖` until `‖∇ₓL‖ = 2‖x−x_target‖` exceeds `grad_eps` (the
> **state-kick leg**, `cond_grad`). C3 proves the **covariance leg** (it is the one
> L2 governs and the one the integrator's `cond_flat` reads). The shipped operator's
> random state kick `dx_extra` is the state-kick leg; it is what the existing
> `test_anti_collapse_suppresses_collapse` actually exercises (the escape there is
> `‖x‖` growth breaking `cond_grad`, *not* anisotropy). The fix therefore floors
> **only the covariance bump** (μ-aware) and leaves the state kick at `strength·p`,
> so C3's leg is made rigorous without perturbing the already-passing state-kick
> behavior.

> **L1 interaction.** L2 needs `P_N` spanned by eigenvectors of **Σ** (alignment).
> For **normal A** this holds at the freeze: `cond_flat` means `a(Σ) < ε_a`, i.e. Σ is
> near-isotropic (`Σ ≈ μI`), whose eigenbasis is the whole space — so the `m`
> smallest-`|λ(A_s)|` directions are (to within the `a < ε_a` slack) an eigenbasis of
> Σ, and L2 applies. This is exactly the L1-normal argument; it is *false in general
> for non-normal A*, where `A_s` and the integrated `A` disagree (the §1 cross-term).

---

## 3. Lemma L4 (corrected operator), stated and proven

**Lemma L4.** With Fix A + Fix B, on every step whose state lies in the danger band,
the operator produces `Σ⁺ = Σ + b·P_N` with `rank(P_N) ≥ 1` and `b ≥ Δ`.

*Proof.* In the danger band `cond_rank` holds (relaxed), so `eff_rank < (1+δ)·rank_frac·d
< d`, hence `m = d − eff_rank ≥ 1` and Fix B gives `rank(P_N) = m ≥ 1`. The band has
`a(Σ) < (1+δ)ε_a`; taking `δ` small enough that `(1+δ)ε_a` keeps the L2 denominator
positive (true for `d ≤ 400`, `ε_a = 0.05`, `δ ≤ 0.25`), L2's `Δ` is bounded above by
`Δ_max(μ,d,ε_a)` as computed in §2.1. Fix A sets `b ≥ Δ_max ≥ Δ`. ∎

**Corollary (L4 ∧ L1-normal ∧ L2 ∧ L3).** On any danger-band step with normal `A`,
`a(Σ⁺) ≥ ε_a`, so `cond_flat` is **false** on the next evaluation, so the freeze gate
is false on the next step.

*Proof.* L4 supplies the `b ≥ Δ`, rank-`≥1`, Σ-aligned (L1-normal) bump that L2's
hypotheses require; L2 gives `a(Σ⁺) ≥ ε_a`; L3 (the AND-gate) propagates `¬cond_flat`
to `¬triggered`. ∎

---

## 4. Lemma L5 — no permanent latch (the capstone)

A **permanent freeze** is the event that `∃T : triggered(t)` holds for *all* `t ≥ T`
(the integrator overwrites `x_next = x*` every step from `T` on, so the state is
frozen forever).

**Lemma L5 (deterministic alternation).** Under the L4 corollary, with normal `A`,
`triggered(t)` and `triggered(t+1)` cannot **both** be true. Hence the set
`{t : triggered(t)}` contains no two consecutive integers, so there is no `T` with
`triggered(t)` for all `t ≥ T`: **permanent freeze is impossible**, `P(permanent
freeze) = 0`.

*Proof.* Suppose `triggered(t)`. Then all four conditions hold at `t`, so step `t` is
in the danger band (the band is a relaxation of the trigger). By the L4 corollary
`cond_flat(t+1)` is false, so `triggered(t+1) = cond_grad ∧ cond_rank ∧ false ∧
cond_ctrl = false`. Thus no two consecutive steps are both triggered. A permanent
freeze requires `triggered(t)` for all `t ≥ T`, which would make `t = T, T+1`
consecutive triggers — contradiction. ∎

> **Persistence assumption — already discharged by the engine (verified).** The step
> from "`a(Σ⁺(t)) ≥ ε_a`" to "`cond_flat(t+1)` is false" assumes the bumped covariance
> is what the next `evaluate()` reads. This is option (a), read-after-bump ordering,
> and the **shipped engine already satisfies it exactly**: `forward_step` adds
> `sig_extra` into `sigma_next` (`engine.py:460`), `rollout` carries `sigma_next` in as
> `sigma` next step (`engine.py:597`), and `collapse_op.evaluate(self, x, u, sigma, A)`
> reads that incoming `sigma` *before* the step's own Riccati propagation
> (`engine.py:490`) — so `cond_flat(t+1)` sees `Σ⁺(t)` with **zero** propagation in
> between. No engine change is needed; the test `test_c3_no_consecutive_freeze` (§6)
> pins it on the real engine. (Fallback option (b) — inflate the floor by the
> worst-case one-step re-flattening factor `ρ_Σ⁻¹` — is recorded only in case the
> ordering is ever refactored.) This is the one place C3-normal leans on an
> integrator-ordering fact rather than pure linear algebra; it is called out, and it
> holds.

> **Why this is stronger than Borel–Cantelli.** The §3 program labeled L5 a
> "Borel–Cantelli / finitely-often" argument, anticipating a *probabilistic* bound
> ("the freeze latches only finitely often, a.s."). The covariance bump `b·P_N` is
> **deterministic** (`P_N = V_null V_nullᵀ` is not random; only the state-space
> kick `dx_extra` uses random `ξ`), so L2's breaking of `cond_flat` is deterministic
> and we get the stronger *every-other-step* alternation, no probability needed. The
> Borel–Cantelli form is recovered as a corollary if the danger band is entered at
> random times: the operator fires on each entry, so the latch events are finite a.s.
> The deterministic statement above subsumes it.

---

## 5. Theorem C3 (normal A) — assembly

**Theorem C3 (normal A).** Let a rollout have a normal drift Jacobian `A` at each
step and run the L4-/G13-corrected Σ₀⁻¹ operator (Fix A + Fix B of §2). Then the
freeze gate is false on at least every other step, and `P(permanent freeze) = 0`.

*Proof.* L1-normal (§2.2) + L2 (closed) + L3 (AND-gate) + L4 (§3) give the L4
corollary; L5 (§4) converts it to no-consecutive-latch, i.e. no permanent freeze. ∎

### Honest scope — what C3 does and does not give

- ✅ **Gives:** a sufficiency theorem for §3 in the **normal-A regime**, matching
  Theorem 1's boundary, turning §3 from MEASURED into PROVEN-in-regime — *contingent
  on Fix A + Fix B landing*. The fixes are real defects (the live operator can fire a
  weak or blank bump on a freeze-approach), so this also hardens the shipped safety
  mechanism, not just the math.
- ❌ **Does not give:** (i) **Theorem 1's contraction** for non-normal `A` — whether the
  ungrounded dynamics collapse onto the manifold *at all* vs. diverge (the §1 cross-term).
  C3 closes the *anti-freeze* half of [#768] (§7); this *contraction* half remains. Note
  these are genuinely different: C3 needed alignment only for the **rescue** bump, which
  L2′ discharges, whereas Theorem 1's gap is about the **drift** dynamics. (ii) Anything
  about the other three conditions returning — C3 only guarantees the gate cannot *latch*,
  not that the system is well-grounded (grounding is a separate, external mechanism).
  (iii) A statement about `dx_extra` (the random state kick) re-exciting the *state*;
  C3 is about the **covariance** leg breaking the freeze, which is what the integrator
  actually gates on.

### Mechanizability

L2 is already machine-checkable (Weyl/interlacing + a scalar CoV inequality). L4 adds
one scalar bound (`Δ ≤ Δ_max`) and a rank count (`m = d − eff_rank ≥ 1`). L5 is a
two-line discrete-logic argument (no measure theory). The whole C3-normal chain is
feasible in Lean/Mathlib; the immediate target is a numerical/symbolic
`experiments/prove_c3_noncollapse.py` plus `tests/test_cio_sde.py::test_c3_no_consecutive_freeze`
and `::test_c4_floor_is_scale_equivariant`.

---

## 6. Implementation checklist (for the follow-up code PR)

1. `AntiCollapseOperator`: floor the **covariance-bump magnitude** (μ-aware) to
   `Δ(a, μ, d, m)`; leave the random state kick `dx_extra` at `strength·p`.
2. `excite` aiming: replace the hard `|λ| < eig_eps` cutoff with the banded selection
   `m = clamp(max(hard_null, d − round(eff_rank)), 1, d−1)` (Fix B / G13 + the `k=d`
   uniform-shift clamp).
2b. `engine.forward_step`: **no change needed** — the read-after-bump ordering that L5
   requires already holds (`engine.py:460,490,597`); see §4. Add only if a future
   refactor breaks that ordering.
3. Tests: (a) `test_c3_no_consecutive_freeze` — forced freeze-approach, assert the
   gate is never true twice in a row under normal `A`; (b)
   `test_l4_floor_lifts_anisotropy` — assert `a(Σ⁺) ≥ ε_a` on a danger-band step;
   (c) `test_l4_floor_scale_equivariant` — rescale Σ by `c`, assert the floor still
   lifts (guards Defect A's scale-blindness); (d) `test_g13_no_zero_rank_bump` — modes
   parked just above `eig_eps`, assert `rank(P_N) ≥ 1` when `cond_rank` fires.
4. Certificate doc (§3): on green, the label moves to **PROVEN (all A)** — see §7.

---

## 7. Closing the non-normal case — L2′ removes the alignment hypothesis

The normal-A proof above (§2.2 "L1 interaction") leaned on alignment: at `cond_flat`,
`Σ ≈ μI`, so for **normal `A`** the `m` smallest-`|λ(A_s)|` directions are (to slack `a < ε_a`)
an eigenbasis of Σ, and L2's eigenvalue-shift bookkeeping applies. The doc called the
non-normal case open because for non-normal `A` the bump basis `eig(A_s)` need not align
with `eig(Σ)`.

**That hypothesis was never necessary.** L2's operative bound — `σ⁺ ≥ √(m(d−m))/d·b − aμ` —
holds for an **arbitrary** rank-`m` orthogonal projector `P` (`1 ≤ m ≤ d−1`), with no
relation to `Σ`'s eigenvectors, by the reverse triangle inequality in Frobenius norm:

$$\Sigma^+-\mu^+I=(\Sigma-\mu I)+b\big(P-\tfrac{m}{d}I\big),\quad
\sqrt{d}\,\sigma^+=\lVert\Sigma^+-\mu^+I\rVert_F\ge b\sqrt{\tfrac{m(d-m)}{d}}-a\mu\sqrt{d}.$$

Dividing by `√d` reproduces L2 step (3) verbatim, so the same `Δ` works. The misalignment
penalty `tr((Σ−μI)P) = tr((Σ−μI)(P−\tfrac{m}{d}I)) ≤ ‖Σ−μI‖_F‖P−\tfrac{m}{d}I‖_F =
aμ√(m(d−m))` is bounded by `a(Σ)`, which `cond_flat` forces below `ε_a`. Full derivation:
[L2′ in SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md).

**Consequence.** L1 drops out of the C3 chain entirely. The bump basis from `A_s` is
*some* rank-`m` projector with `1 ≤ m ≤ d−1` (guaranteed by Fix B's clamp) regardless of
`A`'s normality, so L2′ + L3 + L4 + L5 give `P(permanent freeze) = 0` for **all `A`**. The
adversarial check — Σ built so its `m` smallest eigendirections coincide with the bump
basis (minimal `tr(ΣP)`, the hardest case) — passes with 0 failures across 4000 non-normal
configs (`experiments/prove_c3_noncollapse_nonnormal.py`,
`tests/test_cio_sde.py::test_c3_nonnormal_covariance_lift`).

**What this does NOT close.** Theorem 1's *contraction* for non-normal `A` (the §1
cross-term in the **drift**, not the rescue bump) is a separate question and stays open
([#768]). C3 guarantees the gate cannot latch; it does not guarantee the ungrounded
dynamics contract rather than diverge — that is what grounding, not Σ₀⁻¹, governs.

[#768]: https://github.com/alex-place/lantern-os/issues/768
