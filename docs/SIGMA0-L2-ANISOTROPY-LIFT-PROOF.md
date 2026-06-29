# Lemma L2 — the one-step anisotropy lift (closed form, proven)

**Status: PROVEN (closed-form) + machine-checked.** This is the deductive core of the
Σ₀⁻¹ "finitely-often" (C3) program for [#768] (see [ANTI-COLLAPSE-HARDENING.md](ANTI-COLLAPSE-HARDENING.md) §… and [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md) §3). It proves that a single Σ₀⁻¹ covariance bump breaks the collapse trigger's **flat** condition. The strengthened form **L2′** (below) discharges the alignment hypothesis L1 for **all `A`** (normal and non-normal) via a Frobenius reverse-triangle bound; the only remaining engineered hypothesis is L4 (the μ-aware proximity floor). L2/L2′ are the parts that are unconditionally true; they do **not** touch Theorem 1's separate contraction question for non-normal `A` ([#768]).

Proof script: `experiments/prove_l2_anisotropy_lift.py` (symbolic + numerical). Test: `tests/test_cio_sde.py::test_l2_anisotropy_lift`.

## Setup (matches the code exactly)

`SemanticCollapseOperator._anisotropy` (`src/cio_sde/collapse.py:87–91`) is the
coefficient of variation of the eigenvalues of the symmetrized covariance:

$$a(\Sigma) \;=\; \frac{\operatorname{std}(\lambda)}{\operatorname{mean}(\lambda)}, \qquad \lambda = \operatorname{eig}\!\big(\tfrac12(\Sigma+\Sigma^\top)\big).$$

The collapse trigger's flat leg fires when `a(Σ) < ε_a`, `ε_a = anisotropy_eps = 5e-2`
(`collapse.py:68,138`). The Σ₀⁻¹ operator (`excite`, `collapse.py:658`) adds, in one
step, `Σ⁺ = Σ + b·P_N` with `b = strength·p ≥ 0` and `P_N = V_null V_nullᵀ` a rank-`k`
orthogonal projector.

*Std convention.* The code uses torch's **unbiased** std (Bessel `1/(d−1)`), which equals
`√(d/(d−1))·σ_pop ≥ σ_pop`. We prove the bound for the **population** CoV `σ_pop/μ`; it
then holds a fortiori for the implemented (larger) unbiased CoV.

## Lemma L2

Let `Σ ⪰ 0` be real symmetric `d×d` (`d ≥ 2`) with eigenvalues `λ₁,…,λ_d > 0`, mean
`μ = (1/d)Σλᵢ > 0`, and population CoV `a = σ_pop/μ < ε` for some `ε ∈ (0,1)`
("near-isotropic"). Let `P` be an orthogonal projector of rank `k`, `1 ≤ k ≤ d−1`, whose
range is spanned by `k` eigenvectors of `Σ` (**alignment hypothesis L1**). Then for `b > 0`,

$$b \;\ge\; \Delta \;:=\; \frac{(\varepsilon + a)\,\mu\,d}{\sqrt{k(d-k)} - \varepsilon k} \qquad\Longrightarrow\qquad a(\Sigma + bP) \;\ge\; \varepsilon,$$

provided the denominator is positive, i.e. `ε < √((d−k)/k)` (true for every `1 ≤ k ≤ d−1`
when `ε ≤ 0.05` and `d ≤ 400`; in particular for the coded `d = 4`).

**Consequence.** With `ε = ε_a`: one Σ₀⁻¹ bump of magnitude `b = strength·p ≥ Δ` lifts the
anisotropy to `≥ ε_a`, so `cond_flat` is **false** on the next evaluation, so the
four-condition AND-gate cannot fire (`collapse.py:138,140`) — the freeze is skipped that
step. This is lemmas L2+L3 of the C3 program.

## Proof

Because `P` aligns with eigenvectors of `Σ` (L1), `Σ⁺ = Σ + bP` has the same eigenvectors
and eigenvalues `λᵢ⁺ = λᵢ + b` for the `k` indices in `range(P)`, `λⱼ⁺ = λⱼ` otherwise.
Partition the eigenvalues into the bumped set `B` (`|B| = k`) and unbumped set `U`
(`|U| = d−k`). Write group means `μ_B, μ_U` and the population variance decomposition
(law of total variance, weights `k/d`, `(d−k)/d`):

$$\sigma^2 = \underbrace{\tfrac{k}{d}v_B + \tfrac{d-k}{d}v_U}_{\text{within}} \;+\; \underbrace{\tfrac{k(d-k)}{d^2}(\mu_B-\mu_U)^2}_{\text{between}}.$$

**(1) Within-group variance is bump-invariant.** Adding the constant `b` to every element
of `B` shifts `B`'s mean by `b` but leaves its internal spread `v_B` unchanged; `U` is
untouched. So `within⁺ = within ≥ 0`, and

$$(\sigma^+)^2 \;=\; \text{within} \;+\; \tfrac{k(d-k)}{d^2}\big(\mu_B + b - \mu_U\big)^2 \;\ge\; \tfrac{k(d-k)}{d^2}\big(b - |\mu_B-\mu_U|\big)^2 .$$

**(2) Bound the pre-bump mean gap by the total spread.** Since `between ≤ σ²`,

$$\tfrac{k(d-k)}{d^2}(\mu_B-\mu_U)^2 \le \sigma^2 \;\Longrightarrow\; |\mu_B-\mu_U| \le \frac{\sigma\,d}{\sqrt{k(d-k)}} = \frac{a\,\mu\,d}{\sqrt{k(d-k)}}.$$

**(3) Lower-bound the post-bump std.** Taking square roots in (1) and substituting (2),

$$\sigma^+ \;\ge\; \frac{\sqrt{k(d-k)}}{d}\Big(b - \frac{a\mu d}{\sqrt{k(d-k)}}\Big) \;=\; \frac{\sqrt{k(d-k)}}{d}\,b \;-\; a\mu .$$

**(4) Exact post-bump mean.** `μ⁺ = μ + (k/d)b`.

**(5) Combine.** `a(Σ⁺) = σ⁺/μ⁺ ≥ ε` is implied by `σ⁺ ≥ ε μ⁺`, i.e.

$$\frac{\sqrt{k(d-k)}}{d}\,b - a\mu \;\ge\; \varepsilon\Big(\mu + \tfrac{k}{d}b\Big) \;\Longleftrightarrow\; b\,\frac{\sqrt{k(d-k)} - \varepsilon k}{d} \;\ge\; (\varepsilon + a)\mu,$$

and since `√(k(d−k)) − εk > 0` by hypothesis, this is exactly `b ≥ Δ`. ∎

Every inequality is exact (no asymptotics): (1) drops `within⁺ ≥ 0`, (2) drops
`within ≥ 0`, both rigorous. The threshold `Δ` is therefore a **sufficient** (conservative)
bound; the true crossing point is `≤ Δ`.

## L2′ — the alignment-free strengthening (L1 is removable)

**Status: PROVEN (closed-form) + machine-checked (2026-06-26).** The alignment hypothesis
L1 above is **not actually needed**. The bound of step (3) — `σ⁺ ≥ √(k(d−k))/d·b − aμ` —
holds for an **arbitrary** rank-`k` orthogonal projector `P` (`1 ≤ k ≤ d−1`), with no
relation to `Σ`'s eigenvectors, via the reverse triangle inequality in Frobenius norm.

Recall `σ⁺² = (1/d)‖Σ⁺ − μ⁺ I‖_F²` (population variance of the spectrum). Write the bumped,
recentred matrix as a sum and apply reverse-triangle:

$$\Sigma^+ - \mu^+ I = (\Sigma - \mu I) + b\big(P - \tfrac{k}{d}I\big),\qquad
\lVert \Sigma^+ - \mu^+ I\rVert_F \;\ge\; b\,\big\lVert P - \tfrac{k}{d}I\big\rVert_F - \lVert\Sigma-\mu I\rVert_F.$$

The two norms are exact and **basis-free**:

$$\big\lVert P - \tfrac{k}{d}I\big\rVert_F = \sqrt{\tfrac{k(d-k)}{d}},\qquad
\lVert\Sigma-\mu I\rVert_F = \sqrt{d}\,\sigma = a\mu\sqrt{d}.$$

Dividing by `√d` gives `σ⁺ ≥ √(k(d−k))/d·b − aμ` — **identical to step (3) of the aligned
proof**, but with no eigenvector alignment used. The same algebra (steps 4–5) then yields
the same threshold `b ≥ Δ ⟹ a(Σ⁺) ≥ ε`. Equivalently, the only place alignment entered was
the misalignment penalty `tr((Σ−μI)P) = tr((Σ−μI)(P−\tfrac{k}{d}I))`, which Cauchy–Schwarz
bounds by `‖Σ−μI‖_F‖P−\tfrac{k}{d}I‖_F = aμ√(k(d−k))` — controlled by `a(Σ)`, which
`cond_flat` forces below `ε`. **So L1 is discharged unconditionally, for normal *and*
non-normal `A`.** Verified: `experiments/prove_c3_noncollapse_nonnormal.py` (4000 genuinely
non-normal configs incl. the adversarial worst-case alignment, 0 lift failures) and
`tests/test_cio_sde.py::test_c3_nonnormal_covariance_lift`.

## What L2 does and does not give

- ✅ **Gives:** a closed-form `Δ` and a proof that one bump of size `≥ Δ` breaks
  `cond_flat`, hence skips the freeze that step (L2 + L3) — **for any rank-`k` projector,
  no alignment needed** (L2′ above). Mechanizable (a Frobenius reverse-triangle + a scalar
  CoV inequality; feasible in Lean/Mathlib).
- ❌ **Does not give:** (L4) that the operator actually fires (`proximity ≥ p_min`) on a
  freeze-approach step — handled by the μ-aware floor (Fix A), an engineered hypothesis.
  Nor does it touch **Theorem 1's contraction** for non-normal `A` (whether an ungrounded
  system collapses onto the manifold at all vs. diverges — the §1 cross-term, [#768]); L2/L2′
  are about the *rescue* breaking the freeze gate, a different question from *whether* the
  bad dynamics contract. The full C3 non-collapse theorem is
  `L2′ ∧ L3 ∧ L4(fixed) ∧ L5 ⇒ P(permanent freeze) = 0`, now with **L2′ holding for all `A`**.
