# Owned Math — Proofs I: the No-Free-Confidence lemma (M1) and the Passive-Indistinguishability lemma (M3)

**Date:** 2026-07-21 (third pass on [#2786](https://github.com/alex-place/lantern-os/issues/2786) /
[#2788](https://github.com/alex-place/lantern-os/issues/2788))
**Type:** Proof note — formal statements + proofs for the two claims whose machine checks are
green, in the L2 pattern: small lemma, named prior art, machine check committed beside it.
**Slate:** [`2026-07-21-owned-math-conjectures.md`](2026-07-21-owned-math-conjectures.md)
**Machine checks:** [`owned_math_m1_precision_check.py`](../../experiments/owned_math_m1_precision_check.py)
(float, 0/9,000) · [`owned_math_m1_exact_check.py`](../../experiments/owned_math_m1_exact_check.py)
(**exact rational arithmetic**, 0/200) ·
[`owned_math_m3_indistinguishability.py`](../../experiments/owned_math_m3_indistinguishability.py)
(exact-law corner) · [`owned_math_m3_innovations.py`](../../experiments/owned_math_m3_innovations.py)
(general case, per noise level)

---

## Lemma 1 (No-Free-Confidence, linear-Gaussian form)

**Setup.** State x_t ∈ ℝⁿ with dynamics x_{t+1} = A x_t + w_t, w_t ~ N(0, Q), Q ⪰ 0.
A Bayesian observer holds posterior covariance Σ_t (precision Λ_t = Σ_t⁻¹) and updates by the
information filter: predict Σ_pred = A Σ_t Aᵀ + Q, then measure with any finite set of
observations {(H_k, R_k)}: Λ_post = Λ_pred + Σ_k H_kᵀ R_k⁻¹ H_k. Define **justified
confidence** J = log det Λ.

**Claim.** Each step decomposes exactly as ΔJ = E + D with:

1. **(Paid growth)** E := log det Λ_post − log det Λ_pred ≥ 0, with equality iff no
   informative measurement fired;
2. **(Contraction cap)** D := log det Λ_pred − log det Λ_prev ≤ 2·log(1/|det A|).

**Consequently** ΔJ ≤ E + 2·log(1/|det A|): *all confidence growth is either paid for by
evidence, or is contraction-driven and bounded by the log-volume contraction of the dynamics —
there is no third source.* If |det A| ≥ 1 (volume non-contracting), unpaid growth is ≤ 0.

**Proof.** The decomposition is an identity. (1): M := Σ_k H_kᵀR_k⁻¹H_k ⪰ 0, so
Λ_post = Λ_pred + M ⪰ Λ_pred in the Loewner order; log det is monotone on that order (its
increments are log-eigenvalue sums of I + Λ_pred^{-1/2} M Λ_pred^{-1/2} ⪰ I). (2):
Σ_pred = A Σ Aᵀ + Q with both summands PSD, and by the Minkowski determinant inequality's
special case det(X + Y) ≥ det(X) for X, Y ⪰ 0: det Σ_pred ≥ det(A Σ Aᵀ) = det(A)²·det Σ.
Take logs and negate to get (2). ∎

**Machine checks.** Float: 0 violations of all four inequalities over 9,000 steps / 300 random
systems. **Exact:** 0 violations of det(M+Q) ≥ det(M) and det(AΣAᵀ+Q) ≥ det(A)²det(Σ) over
200 random rational systems in `fractions.Fraction` arithmetic — no tolerance anywhere.

**Ledger mapping and its empirical state.** In the product, "evidence" = grounding events and
Verify-pass results (refutations enter as negative-precision events, i.e. they *lower* J);
"contraction" = self-consistency narrowing without external input — precisely the mode the
collapse canary polices. Empirically today: free-confidence mass is 20.8% of the ledger but
**zero** of it above c = 0.8 (the clamp), and across all 50 consecutive same-hypothesis record
pairs, **zero** confidence increases occurred without evidence growth.

**Prior art, named.** Information-filter precision additivity and the Minkowski determinant
inequality are textbook. The contribution is the *decomposition-with-cap statement*, its exact
machine check, and the mapping onto a both-class product ledger where it is enforceable.

**Honest scope.** Linear-Gaussian observer; J = log det Λ is one confidence functional (any
monotone spectral functional of Λ obeys (1); the cap (2) is specific to log det); the ledger
mapping treats grader outcomes as measurements, which is a modeling choice the Verify pass
must continue to honor.

---

## Lemma 2 (Passive indistinguishability; the grounded doppelgänger)

**Setup.** External world s_{t+1} = A s_t + w_t, w ~ N(0,Q); observations o_t = s_t + v_t,
v ~ N(0, R). The **grounded tracker** runs the steady-state Kalman filter with gain K:
ŝ_{t+1} = A ŝ_t + A K (o_t − ŝ_t). The **ungrounded mimic** is the purely internal loop
z_{t+1} = A z_t + A K ε_t with i.i.d. ε_t ~ N(0, S), where S is the tracker's innovation
covariance.

**Claim.** The internal-state processes (ŝ_t) and (z_t) have **identical law**. Hence for
*every* measurable functional φ of the internal trajectory, φ(ŝ) =_d φ(z): **no passive
internal monitor has any power to distinguish a grounded tracker from its ungrounded
doppelgänger.**

**Proof.** By the innovations representation (Kailath; Anderson & Moore), the steady-state
tracker satisfies ŝ_{t+1} = A ŝ_t + A K e_t where the innovations e_t = o_t − ŝ_t are white
Gaussian with covariance S. Thus (ŝ_t) and (z_t) solve the *same* linear recursion driven by
white Gaussian noise of the *same* covariance and initial law — their finite-dimensional
distributions coincide on all cylinder sets, so their pushforward measures on trajectory space
are equal. Equal laws give equal distributions of any measurable functional. ∎

**Corollary 1 (interventions separate — with power set by the gain).** Perturb the internal
state by δ at time t₀. The tracker's deviation evolves as (A(I−K))^t δ — the external channel
actively corrects it; the mimic's deviation evolves as A^t δ. Whenever K ≠ 0 the spectral
radii differ, so recovery statistics differ and the two are separable by a probe. Measured:
at observation noise r = 0.01 the recovery gap is maximal; as r grows (K → 0) tracker and
mimic recovery converge — **grounding quality *is* probe separability.**

**Corollary 2 (cadence necessity).** A monitor restricted to passive trajectory functionals
has zero separating power (Lemma 2). Therefore any guarantee of groundedness must include an
**intervention against the external channel** — which is exactly what the #1012 hard-cadence
re-grounding tick is. The shipped defense is not a heuristic patch; it is the only instrument
class the theorem permits.

**Machine checks.** Exact-law corner (perfect observation): 5-functional passive battery
non-separating over 200 runs/arm (KS p 0.08–0.85); probe separates with KS D = 1.0 (recovery
1 vs 22 steps). General case: per r ∈ {0.01, 0.25, 1.0, 4.0}, tracker-vs-mimic passive
battery + probe-gap measurements in
[`owned_math_m3_innovations.json`](../../experiments/results/owned_math_m3_innovations.json).

**Prior art, named.** The innovations representation is classical (Kailath 1968; Anderson &
Moore, *Optimal Filtering*); the "internal monitors can't see gradual drift" phenomenon is the
Boiling Frog Threshold result ([arXiv:2603.08455](https://arxiv.org/abs/2603.08455)). The
contribution is the corollary chain — passive-zero-power ⇒ intervention-necessity ⇒
gain-equals-separability — stated over this project's specific canary instruments and wired to
a shipped defense.

**Honest scope.** Linear-Gaussian, steady-state, matched-model mimic. Non-Gaussian or
nonstationary worlds may leak passive signal (higher-order statistics); the lemma says
passivity *cannot be guaranteed* to work, not that it never accidentally does. The corollary's
"necessity" is necessity of the instrument *class* (interventional), not of any particular
cadence value — the cadence *value* is M2's question.
