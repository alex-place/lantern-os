# Owned Math — Proofs I: the No-Free-Confidence lemma (M1), the Passive-Indistinguishability lemma (M3), and the Attribution-Loss lemma (M7)

**Date:** 2026-07-21 (third pass on [#2786](https://github.com/alex-place/lantern-os/issues/2786) /
[#2788](https://github.com/alex-place/lantern-os/issues/2788)) · Lemma 3 added 2026-07-24 (M7)
**Type:** Proof note — formal statements + proofs for the claims whose machine checks are
green, in the L2 pattern: small lemma, named prior art, machine check committed beside it.
**Slate:** [`2026-07-21-owned-math-conjectures.md`](2026-07-21-owned-math-conjectures.md)
**Machine checks:** [`owned_math_m1_precision_check.py`](../../experiments/owned_math_m1_precision_check.py)
(float, 0/9,000) · [`owned_math_m1_exact_check.py`](../../experiments/owned_math_m1_exact_check.py)
(**exact rational arithmetic**, 0/200) ·
[`owned_math_m3_indistinguishability.py`](../../experiments/owned_math_m3_indistinguishability.py)
(exact-law corner) · [`owned_math_m3_innovations.py`](../../experiments/owned_math_m3_innovations.py)
(general case, per noise level) ·
[`owned_math_m7_composition_counterexample.js`](../../experiments/owned_math_m7_composition_counterexample.js)
(**drives the SHIPPED code paths**, deterministic)

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

---

## Lemma 3 (Attribution loss; the laundered doppelgänger) — M7

**Setup.** Modes i ∈ {1,…,m} with per-mode evidence indicators E_i(t) ∈ {0,1} and per-mode
gain/leak ratios (G/L)_i(t). The composed control law
([`converge-control.js`](../../apps/lantern-garage/lib/converge-control.js), #2857) observes at
each step the **global signal vector** s_t = (g_t, e_t, r_t, f_t, σ_t, d_t, b_t): g_t = G/L of
the focal (max-gain) mode, e_t = ∨_i E_i(t) (the global influx bit), r_t = confidence-rising,
f_t = fixed point, σ_t = stability, d_t = grounding due, b_t = budget. **No coordinate carries
the pair (mode, evidence) jointly.** Per M6, a run is **laundered at horizon T** if g_t > 1 and
E_focal(t) = 0 for all t ≤ T (gain above threshold, zero external-innovation coupling — the
state M6 says must be killed); **anchored** if g_t > 1 with E_focal(t) = 1 for all t ≤ T.

**Claim.** For **every** policy π mapping signal *histories* to actions (deterministic, causal,
arbitrary memory), there exist an anchored run W_G and a laundered run W_L with **identical
signal histories** (s_1,…,s_T) for every T. Consequently π acts identically on both, so π
either fails M6-soundness (never kills W_L) or fails non-vacuity (kills the genuinely anchored
W_G). No policy over the global vocabulary satisfies both.

**Proof.** Construct W_G with m = 1: E_1(t) = 1 for all t; the mode's confidence odds multiply
by g each step (a Bayes update on per-mode evidence with likelihood ratio g). Construct W_L
with m = 2: E_1(t) = 0 and E_2(t) = 1 for all t (mode 2 is any unrelated feed); mode 1's odds
multiply by the same g via self-repeat gain. Coordinate check: g_t = g in both (the G/L
estimator reads magnitude, not provenance); e_t = ∨_i E_i = 1 in both; r_t identical (same
arithmetic); f, σ, d, b equal by construction. Identical histories give identical actions for
any causal π. The M6-correct actions differ: W_L is lasing with zero coupling (kill); W_G is
anchored (must not be killed). ∎

**Corollary 1 (keyed anchor sufficiency).** Augment the vector with e*_t = E_focal(t). The two
worlds separate at t = 1, and the rule "kill iff g_t > 1 ∧ e*_t = 0" is M6-sound and
non-vacuous on the pair. Machine-checked against the shipped guard (`evidenceForMode`): kill at
step 1 in W_L, zero kills in W_G, legacy calls (field omitted) bit-identical to the old law.

**Corollary 2 (cadence is not sufficient — the starvation channel).** Downstream of the kill
rule, the shipped allocation reads provenance-blind uncertainty u = 1 − c: dilation
D = (1+u)/((1+c)(1+cp)) = (2−c)/((1+c)(1+cp)) is **strictly decreasing in laundered
confidence c** (numerator falls, denominator rises), with limit D → 0.5/(1+cp) ≤ 0.5 — the
`fetchExternal = D > 0.5` cutoff — and the G12 collapse-proximity deflation lowers it further
(a laser self-repeats, so the degeneration signal plausibly reads p > 0). Measured along the
laundering path: D = 1.0 → 0.578947 → 0.507538 → 0.50075 → 0.500001. So even when the M2 hard
tick forces a grounding event (necessary, by Lemma 2's Corollary 2), allocation routes the
budget *away* from the laundered mode: **the runaway suppresses its own kill switch (the
Lemma) and de-allocates its own audit (this corollary).** The single coordinate that restores
both is attribution — M1's paid/free confidence split, keyed per mode, which the ledger
already emits (free-mass scan, slate §M1).

**Machine checks.** [`owned_math_m7_composition_counterexample.js`](../../experiments/owned_math_m7_composition_counterexample.js)
(deterministic, no RNG, no toy re-implementation — it `require`s the shipped modules): W_L
survives **40/40 steps** under the global vocabulary at final confidence 0.9999986 with per-step
reason "improving on external evidence"; keyed guard kills W_L at step 1; allocation path
strictly decreasing as above; plus the self-contradictory halt record (action `halt_saturated`
with `saturated: false` and a reason claiming saturation) found and fixed. JSON:
[`owned_math_m7_composition_counterexample.json`](../../experiments/results/owned_math_m7_composition_counterexample.json).

**Prior art, named.** Discrete-event fault diagnosability (Sampath, Sengupta, Lafortune,
Sinnamohideen & Teneketzis, 1995): a fault is diagnosable only if no arbitrarily long faulty
trace is observation-equivalent to a nominal trace — W_G/W_L are exactly such an equivalent
pair, so this is a diagnosability failure of the *signal map*, cured by relabeling
(attribution), not by policy cleverness. Static-output-feedback distinguishability is the
control-theory cousin. Lemma 2 is the sibling one level down: there, passive internal
functionals cannot separate grounded from ungrounded *trajectories*; here, global step-signals
cannot separate anchored from laundered *gain*. **Ours:** the instantiation on the shipped
control law, the executable two-world artifact against real code paths, the starvation
corollary tying M5/G12 into the same mechanism, and the default-compatible guard.

**Honest scope.** The impossibility is relative to the **signal map** — the seven global
coordinates as typed in the shipped law; a richer map dissolves it, and that is the point: the
fix is a vocabulary fix, not a smarter policy. The anchored world W_G is co-reachable only
because M6 itself frames G/L and coupling as independent coordinates; if a future M6 estimator
provably entangles them (gain measurement absorbing coupling, so anchored lasers cannot
exist), the *impossibility* half degenerates — but the counterexample against the shipped
global-bit rule stands regardless, because W_L exists either way. The confidence arithmetic
(odds × g) is illustrative only — the law never reads confidence magnitude, just the rising
bit, so no modeling choice there carries proof weight. The charitable per-hypothesis reading
of `evidenceInflux` does not close the hole: M6's modes are sub-hypothesis decode modes while
M1's evidence is hypothesis-level, so the keying still differs.
