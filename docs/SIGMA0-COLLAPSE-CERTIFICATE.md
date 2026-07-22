---
author: Alex Place
created: 2026-06-14
updated: 2026-07-21
---

# Σ — The Convergence Certificate

*A computable stability certificate for convergence dynamics, and an honest
account of why an ungrounded self-improving system tends to collapse or diverge.*

> **One object, two timescales (structure — read before citing anything below).**
> **Part I** (§0–§7, *the original Collapse Certificate*) certifies the **fast state `x`** — the
> hidden-state trajectory inside one forward pass — and is **PROVEN / machine-checked where each
> section's status line says so**. **Part II** (§8, *the Model-Update Acceptance Gate Σ_θ*, merged in
> 2026-07-07) certifies the **slow weights `θ`** — how the model changes across weight-update steps
> — and is **HEURISTIC + imported external theorems: no machine-checked THEOREM**. (Its gate
> *logic* and holdout *simulations* are implemented and tested in-repo — see the audit map — but
> tested logic is not a proven theorem, and the gate has never controlled a real training run.) **Part III** (§9) composes them under timescale separation (a TARGET, not a theorem).
> The evidence-class discipline is strict and asymmetric: **Part II must never be read with Part
> I's authority.** The two are one certificate because they are the fast and slow faces of the same
> dynamical object `ẋ = f(x,u,θ)` — Part I holds `θ` fixed; Part II is the θ-flow Part I defers.
> **Part IV** (§10, added 2026-07-21) is the *active face* — a **DESIGN / TARGET, no theorem**,
> lower in authority than even Part II: it extends the "grounding is the escape" result to
> generated grounding (act to manufacture fresh truth), with one MEASURED real-surface datapoint
> and zero proofs. It exists here so the theory and its answering interface
> ([CONVERGENCE-ORACLE-DESIGN.md](CONVERGENCE-ORACLE-DESIGN.md)) cannot drift apart.

---

## What this document is — and is not

**It is:** the internal, evidence-classed design-and-theory record for one system's *Verify*
stage — the stability machinery of a local-first reasoning loop ([unisona.ai](../CLAUDE.md),
repo `alex-place/lantern-os`). It is written by **Alex Place with AI coding agents** (disclosed;
agent sessions author and revise text under the operator's review, and the dates are real project
dates — this project runs in 2026). Its primary audience is the loop itself and the people
building it.

**It is not:** a peer-reviewed paper. It has no venue, has not been submitted anywhere, and no
outside expert has endorsed it. External review so far consists of the adversarial model passes
and the operator review recorded in §8.7 and Appendix M — useful, but not peer review.

**Novelty: none is claimed.** A three-way prior-art search (2026-07-07, recorded in §8.7–§8.8 and
[ADR-0025](adr/0025-rlvr-dreaming-continual-updates-double-gated.md)) concluded the components are
standard (TRPO, Gao, Dwork — ~97% confidence not novel), the framing has close prior art (ADOWIP,
EvalStop, sealed-audit gating — ~90%), and what remains is a system-specific integration. The one
open research question — §8.6 item 5 (incremental validity) — was **measured on 2026-07-07** (two
pre-registered experiments, PR #2240): the internal signal adds detection power **only for gross
degradation and only when the external gate is tiny** (ΔAUC +0.121 at n=2, decaying to +0.019 at
n=5), and it **cannot substitute for fresh verified data at all** in the selection role (§8.4.1).
The still-open cell is *subtle, training-induced* badness, which needs the real A/B/C artifacts.

**"Machine-checked" here means:** closed-form algebra + numerical sweeps + `pytest` — **not** a
Lean/Mathlib formal proof. Every use of the phrase in this document carries that meaning and no
more. Theorems marked PROVEN are proven *in-regime* (local linear Jacobian, stated hypotheses).

**Process disclosure:** an early draft of this document, written while the search backend was
down, carried four fabricated arXiv IDs. Source-verification caught them on 2026-06-17 and they
were replaced with verified citations (see the note at the end of References). That failure is
kept on the record deliberately: it is the strongest argument this document makes for its own
central claim — self-generated content is untrustworthy until externally checked. Citations added
since carry a verified-on date.

## How to audit this document

Every load-bearing claim maps to a runnable artifact in this repo. All pytest commands below
were run against this revision on 2026-07-17 (91 tests, all passing; the gate self-test was
last run 2026-07-07). The **Part I backbone was re-run 2026-07-21** with no drift
(`tests/test_cio_sde.py` → 46 passed; `tests/test_sigma0_jsrr_gate.py` → 12 passed); the other
suites stand from 2026-07-17. Part IV (§10) adds no machine-checked artifact — its one MEASURED
datapoint is a real-surface run, pointed to inline, not a pytest:

| Claim | Class | Verify with |
|---|---|---|
| Theorem 1, spectral dichotomy, C3 anti-freeze, §7.1 σ-axis, §2 operator behavior (Part I) | PROVEN in-regime | `python -m pytest tests/test_cio_sde.py -q` → 46 passed |
| Region-of-attraction certification (§5, #1991) | PROVEN (interval arithmetic) | `python -m pytest tests/test_sigma0_roa_certified.py -q` → 4 passed |
| 900-run collapse-prevention sweep (§3) | MEASURED | `data/sigma0_regime_sweep_report.json`; regenerate: `python experiments/sigma0_regime_sweep.py` |
| Four-signal trigger calibration: precision 1.0, recall ≈0.08 (§2, #1990) | MEASURED | `data/sigma0/trigger_calibration_report.json`; regenerate: `python experiments/sigma0_trigger_calibration.py` |
| Scheduled-vs-reactive grounding race: alarm premium 2.25×, sliver timing-indifference (§3.1, [#2690]) | MEASURED | `python -m pytest tests/test_sigma0_scheduled_grounding.py -q` → 6 passed; full run: `python experiments/sigma0_scheduled_grounding.py` |
| Phase 0.5 prospective shot-call on the trained reservoir: sliver call held; anchor/ceiling ratio 1.4·10⁴ (§3.1, [#2690]) | MEASURED (real learned system) | `python -m pytest tests/test_sigma0_reservoir_deadline.py -q` → 5 passed; full run: `python experiments/sigma0_reservoir_deadline.py` |
| Σ_θ release-gate logic + A/B/C decision tree (§8.1.2) | machine-checked logic | `python experiments/sigma_theta_abc/harness.py --self-test`; `python -m pytest tests/test_sigma_theta_gate.py -q` → 11 passed |
| Holdout staleness: n-graded fresh-flow dominance + Thresholdout third road (§8.4) | MEASURED (simulation) | `python -m pytest tests/test_sigma_theta_thresholdout.py -q` → 7 passed; full run: `python experiments/sigma_update_holdout_staleness.py` |
| Intrinsic signals cannot extend the selection budget — freshness law (§8.4.1) | MEASURED (simulation) | `python experiments/sigma_update_internal_signal_value.py` (pure Python, 32 seeds, prints verdict + weight sweep) |
| Freshness law RE-STATED: kill test fired — re-drawn noise de-ratchets (dither-equivalent); fresh truth still dominates (§8.4.1, [#2692]) | MEASURED (simulation) | `python -m pytest tests/test_sigma_update_stochastic_signal.py -q` → 6 passed; full run: `python experiments/sigma_update_stochastic_signal.py` |
| Three-arm promotion-evidence protocol (F/Fd/R/T) at task-level stuck fidelity + arm-differentiated teeth (§8.6-4, [#2691]) | machine-checked protocol; MEASURED (simulation) | `python -m pytest tests/test_sigma_theta_holdout_protocol.py -q` → 6 passed; full run: `python experiments/sigma_theta_abc/holdout_protocol.py --simulate` |
| Incremental validity on a real model: gross-only, scarcity-gated (§8.6 item 5) | MEASURED (one model) | `experiments/sigma_incremental_validity_ouro.py` (requires local GPU + cached Ouro-1.4B, ~25 min; run log reproduced in PR #2240) |
| §8 gate controlling a *real* training run; §9 two-timescale composition | **not yet verifiable** | open — the honest gap (§8.6, §9) |

If a command above fails on a fresh clone, the document has drifted from the code and should not
be trusted until reconciled — that is the intended failure mode.

## Glossary — internal names → standard terms

Internal names are project identifiers, not claimed technical contributions:

| Internal | Standard meaning |
|---|---|
| Σ₀ | the four-signal collapse *trigger* (an operational representational-collapse detector) and, by extension, the project's grounding discipline |
| Σ₀⁻¹ | the anti-collapse *re-excitation operator* (a persistent-excitation-inspired state/covariance bump) |
| Σ_θ | the **Model-Update Acceptance Gate** — a checkpoint-promotion gate for weight updates (Part II) |
| "42-state" | colloquial name for the degenerate frozen state (projection onto the null subspace); explicitly *no formal meaning* (§2) |
| collapse | representational / model collapse (Shumailov et al. 2024); locally, loss of contraction structure in the linearized dynamics |
| unisona.ai, Lantern, Unisona | project code names; carry no technical content |

## Contents

**Part I** (§0–§7) — fast state `x`: the collapse certificate *(PROVEN where marked)* ·
**Part II** (§8) — slow weights `θ`: the Model-Update Acceptance Gate *(HEURISTIC + imported;
simulation-measured)* · **Part III** (§9) — two-timescale composition *(TARGET)* ·
**Part IV** (§10) — the active face: grounding as capability *(DESIGN / TARGET — no theorem)* ·
References · Appendix A (historical design sketch) · Appendix M (provenance: maintenance log).

---

## Plain-language summary

**What this is.** A stability certificate — a computable test (a check a computer can run automatically) — for a system that
updates itself over time, together with an honest account of what happens to a
self-improving system that has *no contact with outside reality*.

**The one-line result.** A system that only ever optimizes against its own
internal picture of the world — *in the regime the theorems below cover (local
linear Jacobian; see each section's status line)* — has two failure modes and no
happy third one: it
either **collapses** onto a single frozen, self-agreeing state (nicknamed the
"42-state"), or it **diverges** and runs away. The only escape is an **external
anchor** — real data, a measurement, a market, a ground truth. **Grounding is the
safety mechanism.** This is the same thing machine-learning researchers call
**model collapse** — train a model on its own output long enough and it degrades.

**How sure are we of each part?** Every claim below is labelled:
- **PROVEN** — the core collapse theorem (Theorem 1), for the well-behaved
  (symmetric / normal) case; **and** that the anti-collapse operator *prevents
  permanent freeze* (§3, Theorem C3) — now for **all `A`, normal and non-normal**
  (the alignment hypothesis was removable; 2026-06-26). *46 of 46 tests pass* (incl. the non-normal contraction dichotomy, [#768], the discrete-time dichotomy, [#1988], and the defective-`A` Schur split, [#1989]).
- **MEASURED** — the early-warning "canary" (§4) and the operator's broader escape
  behavior: demonstrated over **900 forced-collapse runs (100% prevented)** plus
  passing integration tests, beyond what the freeze theorem covers.
- **HEURISTIC** — the four-signal collapse *trigger* (§2): a sensible operational
  definition, deliberately *not* dressed up as a theorem.

**What's left.** Both halves of [#768] are now closed (in-regime). Theorem 1's
**contraction** for non-normal *drift* (the §1 cross-term) — whether an ungrounded
system collapses vs. diverges — is resolved by the spectral (Riesz) dichotomy
([SIGMA0-T1-NONNORMAL-DICHOTOMY.md](SIGMA0-T1-NONNORMAL-DICHOTOMY.md), 2026-06-26):
split by `A`'s own spectrum so the cross-term vanishes by invariance; the active
block contracts (Lyapunov) and the slow block's abscissa sign gives collapse-vs-
diverge, no third fate. The anti-collapse *freeze* claim is likewise proven for all
`A`. ("Machine-checked" throughout means closed-form algebra + numerical sweep +
pytest, **not** a Lean/Mathlib formal proof; and every theorem here certifies the
**local linear Jacobian**, not a global guarantee — grounding remains the safety
mechanism.)

**Part II in one line.** For the *slow* timescale — deciding whether a retrained model may replace
the current one — the measured version of the same principle is: **a system's self-checks can spot
disasters, but only fresh outside tests can pick winners.** Reusing one test set lets lucky models
win (measured, §8.4); self-measurements cannot substitute because their errors stick to the
checkpoint the same way (measured, §8.4.1); a cheap self-check still earns its keep as an early
alarm for gross breakage exactly when outside tests are scarce (measured on one real model, §8.6).

> **For the precise version, read on.** Each section carries its own status line.
> The summary above is the honest gist, not a substitute for the math.

---

Status: **Theorem 1 is proven and machine-checked** (`src/cio_sde/collapse.py`,
`tests/test_cio_sde.py` — **46 passing, 0 xfail**) **for the symmetric / normal case**.
The **anti-collapse operator's freeze-prevention (§3) is now also PROVEN** — Theorem C3,
for **all `A`** (normal and non-normal; 2026-06-26). The collapse trigger (§2) and the
early-warning readout (§4) remain control-design heuristics — empirically supported, not
theorems. The §6 demonstration is **reproducible**: both driver scripts are
committed and produce checked-in run logs (see §6). Read the per-section status
lines before relying on any claim here.

> **Provenance:** every reconcile pass and closed-gap record since 2026-06-16 is preserved
> verbatim in [Appendix M](#appendix-m--provenance-maintenance-log--closed-gap-history) —
> moved out of the head for readability (2026-07-07); nothing was deleted.

**Status taxonomy & tracked gaps.** Each claim is one of: **PROVEN** (theorem +
machine-checked), **MEASURED** (empirical, with a test/run pointer), **HEURISTIC**
(operational design, not derived from the theorem), or **UNIMPLEMENTED** (described
but not present in code). Gaps are tracked as GitHub issues and cross-linked here so
status cannot silently drift.

[#504]: https://github.com/alex-place/lantern-os/issues/504
[#505]: https://github.com/alex-place/lantern-os/issues/505
[#506]: https://github.com/alex-place/lantern-os/issues/506
[#507]: https://github.com/alex-place/lantern-os/issues/507
[#508]: https://github.com/alex-place/lantern-os/issues/508
[#509]: https://github.com/alex-place/lantern-os/issues/509
[#516]: https://github.com/alex-place/lantern-os/issues/516
[#517]: https://github.com/alex-place/lantern-os/issues/517
[#520]: https://github.com/alex-place/lantern-os/issues/520
[#523]: https://github.com/alex-place/lantern-os/issues/523
[#657]: https://github.com/alex-place/lantern-os/issues/657
[#658]: https://github.com/alex-place/lantern-os/issues/658
[#659]: https://github.com/alex-place/lantern-os/issues/659
[#660]: https://github.com/alex-place/lantern-os/issues/660
[#661]: https://github.com/alex-place/lantern-os/issues/661
[#2762]: https://github.com/alex-place/lantern-os/issues/2762
[#2795]: https://github.com/alex-place/lantern-os/pull/2795
[#764]: https://github.com/alex-place/lantern-os/issues/764
[#765]: https://github.com/alex-place/lantern-os/issues/765
[#766]: https://github.com/alex-place/lantern-os/issues/766
[#767]: https://github.com/alex-place/lantern-os/issues/767
[#768]: https://github.com/alex-place/lantern-os/issues/768
[#1988]: https://github.com/alex-place/lantern-os/issues/1988
[#1989]: https://github.com/alex-place/lantern-os/issues/1989
[#1990]: https://github.com/alex-place/lantern-os/issues/1990
[#1991]: https://github.com/alex-place/lantern-os/issues/1991
[#1997]: https://github.com/alex-place/lantern-os/pull/1997

---

# Part I — Fast state `x`: the Collapse Certificate  [PROVEN where marked / machine-checked]

*This is the original certificate in full. It certifies the within-forward-pass hidden-state flow
with `θ` held fixed. Every §0–§7 status line and evidence class below is unchanged by the Part II
merge.*

## 0. The object

We study a dissipative nonlinear system

*In plain words:* the state keeps changing over time, and how it changes depends on where it is now (`x`), what we feed in (`u`), and some slowly-shifting settings (`θ`) — the three symbols defined below.

$$\dot{x} = f(x, u, \theta), \qquad x \in \mathbb{R}^n$$

- `x` — internal state (for the router: a conversation's encoded state)
- `u` — control / persistent-excitation input
- `θ` — slowly-varying parameters (meta-state)

Linearizing along a trajectory `x*` gives the local Jacobian

$$\dot{\delta x} = A\,\delta x, \qquad A = \left.\frac{\partial f}{\partial x}\right|_{x^*}.$$

Everything below reasons about the eigenstructure of `A` and its symmetric
part `A_s = ½(A + Aᵀ)`. The non-symmetric (skew) part `A_k = ½(A − Aᵀ)`
carries rotation and is **not** captured by `A_s`; the gap between the two is
exactly what makes the general case in §1 harder than the symmetric one.

*In plain words:* the symmetric part tracks whether a system shrinks toward a point (decay); the skew part tracks whether it also swirls around it (rotation). The easy, proven case has no swirl — and that swirl is exactly what makes the general case in §1 hard.

---

## 1. The collapse-guarantee theorem

**Status: PROVEN, under an explicit hypothesis (A normal, or M is A-invariant).
Machine-checked for the symmetric case.**

Split the state space using the symmetric part `A_s`:

- **null subspace** `N = span{ vᵢ : |λᵢ(A_s)| < ε }` — the near-invariant modes
- **active subspace** `M` — its orthogonal complement, projector `P_M`

Define the Lyapunov function on the active modes only:

*In plain words:* `V` is a single "energy" number that measures how far the system still is from going stuck. If we can show this number only ever shrinks, the system is provably settling down rather than running away.

$$V(x) = \tfrac{1}{2}\,\lVert P_M\,x \rVert^2.$$

Let the **active spectral abscissa** be

$$\alpha = \max\{\, \lambda_i(A_s) : v_i \in M \,\}.$$

**Theorem (contraction on the active subspace).**
Assume `α < 0` **and** the active subspace `M` is *A-invariant*, i.e.

$$P_M\,A\,P_N = 0 \qquad\text{(equivalently: A is normal, } A = A_s\text{, or A commutes with }P_M\text{).}$$

Then

$$\dot V \le 2\alpha V \quad\Longrightarrow\quad \lVert P_M\,x(t)\rVert \le \lVert P_M\,x(0)\rVert\, e^{\alpha t}.$$

The active modes decay exponentially at rate `|α|`, and the trajectory
contracts onto the invariant null manifold `N`. **Under this hypothesis,
collapse is guaranteed.**

### 1.1 Why the hypothesis is required (the dropped cross term)

Differentiating `V` along the flow gives

$$\dot V = (P_M x)^\top P_M A\, x = (P_M x)^\top A_s (P_M x) \;+\; \underbrace{(P_M x)^\top A\,(P_N x)}_{\text{cross term}}.$$

The first term is `≤ 2αV` by definition of `α`. **The bound `V̇ ≤ 2αV` holds
only when the cross term vanishes or is dominated.** The cross term is zero
exactly when `M` is A-invariant (`P_M A P_N = 0`), which holds automatically if
`A` is normal. For a **general non-normal `A`** the skew part `A_k` couples the
active and null components, the cross term need not vanish, and the simple
energy bound can fail outright:

> **Counterexample.** For `A = [[−1, 3], [−3, 0]]` the active abscissa is
> `α = −1 < 0`, yet a direct scan finds `max V̇/V ≈ +8.8·10⁴ ≫ 2α = −2`, and
> integrating from `x₀ = [0.3, 1.0]` makes `V` *grow* `0.045 → 0.341` — a sign
> violation of `V̇ ≤ 2αV`. Collapse still occurs here, but it is rescued by a
> *different* argument (below), not by the energy proof.
>
> *In plain words:* this is us being honest about a limit. For swirling systems the simple energy argument can wrongly suggest things are blowing up; the system still settles, but only a more careful argument proves it.

So for non-normal `A`, the §1 energy proof is **insufficient on its own**; the
cross term must be separately bounded (e.g. via `‖P_M A P_N‖` and a small-gain /
Young's-inequality argument that tightens `α` to an effective rate), or one must
fall back to the full-spectrum test.

**Implementation (as of 2026-06-15).** The `collapse_certificate()` function now
uses a small-gain theorem bound for the non-normal case:

$$\alpha_{\text{bound}} = \max_i \lambda_i(A_s) + \|A - A_s\|_2$$

where `A_s = (A + A^T)/2` is the symmetric part. This provides a conservative
bound that accounts for cross-terms in the non-normal case. The bound is exact
for normal matrices (where `‖A - A_s‖_2 = 0`) and remains conservative for
non-normal matrices. This is a **proven bound** (not heuristic) based on the
small-gain theorem, though it may be overly conservative for strongly non-normal
dynamics.

### 1.2 The authoritative test: full-spectrum, not A_s alone

`α < 0` on the symmetric part is **necessary but not sufficient** for strict
contraction of the full system. The conservative, always-correct condition is

$$\max \operatorname{Re}\,\lambda(A) < 0 \quad\text{on the \emph{full} } A \ (\text{via } \texttt{eig}, \text{ not } \texttt{eigvalsh}).$$

A standard caveat (Bendixson) gives `Re λ(A) ≤ λ_max(A_s)`, so `α < 0` bounds the
real parts but does not by itself certify them. A perpetual rotation such as
`A = [[−1,0,0],[0,0,2],[0,−2,0]]` has `α = −1` yet eigenvalues `{−1, ±2i}` — a
center that never collapses in its rotating plane.

**Recommended:** report **both** `α = max λᵢ(A_s)` (the energy abscissa, exact
under the §1 hypothesis) **and** `max Re λ(A)` on the full Jacobian (the
authoritative contraction test). As of [#505], `collapse_certificate()` now
computes **both**: `alpha` (a conservative small-gain bound `max λ(A_s) + ‖A−A_s‖₂`)
and `spectral_abscissa` (the exact `max Re λ(A)` via `eig`, with a `full_contracting`
flag). The full-spectrum test is tighter — it certifies genuinely-contracting
non-normal systems that the small-gain bound over-rejects (see
`test_certificate_full_spectrum_abscissa`).

[#505]: https://github.com/alex-place/lantern-os/issues/505

#### 1.2.1 Provable region-wideners for non-normal `A` ([#768])

The small-gain `alpha` over-rejects strongly non-normal `A`, and `max Re λ(A) < 0`
alone is necessary-not-sufficient (transient growth). `stability_gates()` adds **two
sufficient, provable** contraction certificates — each strictly wider than small-gain:

1. **Numerical-range gate (monotone).** `ω(A) = λ_max(A_s) < −margin ⟹ ‖e^{tA}‖₂ ≤ e^{ωt}`
   — a strict, no-transient contraction (matrix measure μ₂; Lohmiller–Slotine 1998).
   `ω(A)` is the rightmost point of the numerical range `W(A)`; since `spec(A) ⊂ W(A)`,
   this gate **implies** the Lyapunov gate (it is the stricter one).
2. **Lyapunov gate (asymptotic, optimal metric).** For margin `m ≥ 0`,
   `∃P≻0 : (A+mI)ᵀP+P(A+mI) ≺ 0 ⟺ max Re λ(A) < −m` (classical Lyapunov theorem;
   `= inf_T μ₂(TAT⁻¹) < −m`). Certified by solving `(A+mI)ᵀP+P(A+mI) = −I` and checking
   `P≻0` (with a relative ill-conditioning guard, so the stability boundary is never
   certified independent of solver warnings). Accepts strongly non-normal `A` with
   transient growth (e.g. `[[−1,3],[−3,0]]`, Hurwitz at `−0.5`) that small-gain
   over-rejects. `√cond(P₀)` (from the margin-0 solve) upper-bounds the Euclidean
   transient `sup_t ‖e^{tA}‖`.
3. **ε-pseudospectral abscissa + Kreiss constant (transient-aware).** The field-of-values
   resolvent bound `‖(zI−A)⁻¹‖₂ ≤ 1/dist(z, W(A))` gives a **provable** upper bound on the
   ε-pseudospectral abscissa, `α_ε(A) ≤ ω(A) + ε`; `gate_pseudospectral` certifies
   `α_ε(A) < −margin` — no `ε`-sized perturbation reaches the RHP, a transient-aware
   strengthening of gate 1 (it reduces to `ω(A) < −ε−margin`). The Kreiss constant
   `K(A) = sup_{Re z>0} Re(z)·‖(zI−A)⁻¹‖₂`, lower-bounded by sampling the right half-plane,
   gives a rigorous **lower** bound on the transient peak (continuous Kreiss matrix theorem:
   `K(A) ≤ sup_t‖e^{tA}‖ ≤ e·n·K(A)`), complementing the `√cond(P)` / `1+√2` upper bounds.

**Acceptance gate.** `loop_lm.generate()` **consumes** the certificate (it was previously
computed but unused): a generation's latent trajectory carries an explicit
convergence-accept/reject verdict (`None` when too few tokens to certify). As of 2026-07-07
the **primary** acceptance criterion is the *discrete* JSRR gate `ρ(A) < 1` (§1.2.3); the
continuous `proven_contracting` above is demoted to diagnostic telemetry + acceptance
**fallback**. The two answer different questions — the continuous gates certify `e^{tA}`
contraction and over-reject non-normal `A` with transient growth, while the loop is a
*discrete* iteration whose asymptotic stability is governed by the spectral **radius** `ρ(A)`,
not the abscissa.

**Honest scope.** Sufficient, not necessary; they certify the **full Jacobian's**
contraction, not collapse-onto-manifold (the L1 alignment gap is separate). The PROVEN
transient constant is **Crouzeix–Palencia (2017): `‖e^{tA}‖ ≤ (1+√2)` when `W(A) ⊂ LHP`**
(`ω ≤ 0`); the sharper constant `2` is Crouzeix's still-open conjecture. Verified by
`test_stability_gates.py` (the `[[−1,3],[−3,0]]` case, a 400-matrix red-team showing no
false-positive certificates, the `α_ε ≤ ω+ε` upper bound and `K(A) ≤ sup_t‖e^{tA}‖` lower
bound, and matrix-exponential checks that the monotone (`e^{ωt}`), Lyapunov (`√cond(P)`),
and Crouzeix–Palencia (`1+√2`) bounds each hold).
These **extend the proven region of §1; they do not make the system globally uncollapsible.**

[#768]: https://github.com/alex-place/lantern-os/issues/768

#### 1.2.2 Scope limit: routed (mixture-of-experts) loops are SWITCHED systems

**Status: SCOPE NOTE — nothing in §1 certifies a routed loop.** Top-k expert routing makes
the recurrent map **piecewise**: each routing pattern is its own smooth map, and the system
*switches* between them as selections change. Everything above (α, `spectral_abscissa`, the
§1.2.1 gates) then holds only **within a fixed routing region**; across route switches the
correct tools are the switched/hybrid-systems literature — common or multiple Lyapunov
functions and **average dwell-time** conditions (converse results: arXiv:2405.03560;
LP-computable dwell-time bounds via multiple Lyapunov functions: arXiv:2303.17858; learned
Lyapunov functions for piecewise-affine systems: arXiv:2008.06546). Practical consequences
for any future MoE-recurrent Σ₀ (design home: SIGMA0-FRONTIER-TRAIN-BRIEF.md D2/D6):
(1) **route-switch frequency is part of the stability object** — measure frozen-route
contraction *and* the dwell-time statistics the model actually induces (tracked as a
milestone issue); (2) **expert-choice routing** (arXiv:2202.09368: experts pick tokens →
fixed capacity, balance by design) is the lower-discontinuity comparator to token-choice
top-k; (3) do not quote §1 numbers for a routed loop without naming the routing regime.
*In plain words:* a mixture-of-experts loop keeps swapping which sub-network is running;
this certificate currently proves things about one sub-network at a time, and "how often it
swaps" becomes a stability quantity of its own.

#### 1.2.3 The discrete acceptance gate: JSRR (`ρ(A) < 1`), externally validated

**Status: ADOPTED external method; the gate's verdict is MACHINE-CHECKED, not a new theorem.**
The §1.2.1 gates are *continuous-time* — they certify contraction of `e^{tA}`. But the serve
loop is a **discrete iteration** `h_{k+1} = f(h_k)`, whose fixed point `h*` is asymptotically
stable **iff the spectral radius `ρ(J(h*)) < 1`** — the abscissa is the wrong invariant, and a
pure rotation (`ρ = |λ| = 1`, `Re λ = 0`) that the continuous numerical-range gate can wave
through is correctly rejected by `ρ < 1`.

This is exactly the criterion **STARS** regularises toward on *real* looped LLMs —
*Stabilizing Recurrent Dynamics for Test-Time Scalable Latent Reasoning in Looped Language
Models* ([arXiv:2605.26733](https://arxiv.org/abs/2605.26733)) — via its Jacobian Spectral
Radius Regularization loss `ℒ_JSRR = (1/N)Σ‖J v‖₂²` (single-step power iteration on a
Jacobian-vector product). We adopt it as the loop's **acceptance** gate rather than re-derive
a competitor:

- `cio_sde.collapse.jsrr_certificate(A, margin)` — the exact discrete spectral radius
  `ρ(A) = max|λ(A)|` of the empirical exit-depth Jacobian, plus STARS' single-step
  power-iteration surrogate `‖Av‖₂²` (their Eq. 3, reusable as a training regulariser).
  numpy-only, so it gates acceptance even in the minimal inference venv where scipy (the
  §1.2.1 Lyapunov/Kreiss legs) is absent.
- `loop_lm.generate()` accepts iff `ρ(A) < 1 − margin` (`margin` via `SIGMA0_JSRR_MARGIN`,
  default `0` = STARS' literal `ρ<1`; CART, [arXiv:2606.01495](https://arxiv.org/abs/2606.01495),
  found trained gates settle `ρ∈[0.79,0.83]`, comfortably inside a `0.05` band).

**Machine-checked:** `tests/test_sigma0_jsrr_gate.py` (12 cases) validates the verdict on
synthetic operators with analytically-known `ρ` (contraction `ρ=0.9` accept; divergent
`ρ=1.2` reject; scaled rotation `ρ=1.3` reject; the `ρ=1` boundary rejected; the margin band;
nan-safety), agreement with the matvec twin `experiments/sigma0_jacobian_stability.py` (#2029),
and the `_stability_gates`/`_accept_stability`/`assemble_reason_verdict` wiring. The four
adjacent suites (`test_cio_sde`, `test_stability_gates`, `test_reason_verdict`,
`test_collapse_canary_e2e`) are unchanged and green — **98 passing total**.

**Honest scope — three caveats, none upgraded.** (1) What is machine-checked is the gate's
**verdict** (`ρ<1` computed correctly, accept/reject on a known matrix), *not* that JSRR
improves generation quality — CART reports a **null** result (its learned-stability gate did
not beat a parameter-matched dense baseline), so `ρ<1` is validated as the *right stability
object*, not as a quality win. (2) The gate runs on the code's **empirical-Jacobian proxy**
(the mean-outer-product transition matrix in `generate()`), not the true Jacobian of the
recurrent map; a faithful `ρ` needs the autograd-JVP of the update map at the reasoning state
(the matvec path in #2029, deferred to a GPU run). (3) This is **adoption**, not novelty — the
looped-LM spectral-radius / peak-then-collapse result is now published externally on real
models (STARS; PLDR self-organized criticality, [arXiv:2603.23539](https://arxiv.org/abs/2603.23539));
the Σ₀ contribution is engineering rigor, not a new law.

**Tracked-open frontier (the honesty leg, [#2236]).** The one lane the 2026-07-07 literature
check left arguably open is tying this spectral / criticality signal to **factual honesty
(hallucination)** rather than reasoning accuracy — a loop-stability signal only becomes a
*factuality* signal once an **external grounding** signal is supplied, which is the Σ₀
grounding thesis itself. That study is **not done**, so **nothing about honesty AUROC is
claimed here**; it is tracked as [#2236] and, per the audit discipline, will only enter this
document as MEASURED with a run pointer once tested.

[#2236]: https://github.com/alex-place/lantern-os/issues/2236

### 1.3 What the test actually checks

**Verification.** The shipped test uses `A = −0.8·I`, which is **symmetric**
(`A = A_s`, so the §1 hypothesis holds exactly and the cross term is identically
zero). The certificate predicts `contraction_rate = 0.8`; a rollout shows `V`
decaying monotonically. This confirms the theorem **in precisely the special
case where the proof is unconditionally valid** — it does *not* exercise the
non-normal case, and should not be read as evidence for it. The earlier wording
"exact, not approximate" applies only to this symmetric case; for general `A`
the certificate is a conservative gate, not an exact rate.
(`collapse_certificate`, `lyapunov_value` in `src/cio_sde/collapse.py`.)

If `α ≥ 0`, some active mode is non-contracting — the system may wander or
diverge — and collapse is **not** guaranteed. The code reports `guaranteed=False`
at the `α = 0` boundary, which is the correct conservative choice. The entirely
null case (`active_dim = 0`) returns `guaranteed=True`, vacuously: the state is
already on the invariant manifold.

---

## 2. The collapse trigger Σ₀

**Status: OPERATIONAL DEFINITION — not derived from Theorem 1.**

**Definition (operational).** Σ₀ fires when **all four** conditions hold
simultaneously:

*In plain words: this section defines the smoke alarm. Σ₀ is the moment we declare the system "stuck" — when, by four independent measures at once, it has stopped learning anything new and can no longer tell its options apart. We are honest that this is a sensible rule of thumb we chose, not something the theorem forces.*

| condition | meaning |
|---|---|
| `‖∇ₓL‖ < ε_g` | no optimization signal remains |
| `rank(J_f) < ρ·n` | drift Jacobian has lost directional structure |
| `Σ` isotropically flat | uncertainty has no preferred direction |
| `‖∂H/∂u‖ < ε_c` | control cannot distinguish actions |

*In plain words, the four together say: nothing left to learn, no direction left to move in, no uncertainty pointing anywhere useful, and no action that changes the outcome. A system in that corner has nowhere to go.*

**This is a definition, not a consequence.** None of these four quantities is
the spectral abscissa `α` that Theorem 1 uses. They are an *operational
definition of "underdetermined"* — a soft AND-gate (`min(p_grad, p_rank,
p_flat, p_ctrl)`, a Gödel t-norm) over four independent signs of degeneracy.
Theorem 1 says nothing about when these conditions are met; conversely, meeting
them does not invoke Theorem 1's guarantee. The link between "the four
conditions fire" and "`α < 0`" is a **modeling assumption**, not a proof. This
is stated plainly because it is the most honest part of the construction — do
not upgrade it to a theorem.

When triggered, Σ₀ projects the state onto the null eigenmodes of `A_s`:

$$x^\* = P\,x, \qquad P = V_{\text{null}} V_{\text{null}}^\top.$$

The result is the **"42-state"** (colloquial name, no formal meaning): the
operator *clamps* the state onto the null subspace of `A_s`.

**Caveat — `x* = Px` is a true fixed point only when A is normal.** The
projection uses `A_s`, while the integrated dynamics use the full `A`. For
non-normal `A`, projecting kills the symmetric part but the skew rotation leaves
`‖A·x*‖` large (measured ≈ 17.9 on a non-normal example), so `x*` is *not* an
equilibrium of the real flow. Moreover, in the implementation the apparent
"freeze" is produced by the integrator **overwriting `x_next = x*` and
discarding the diffusion term `dW`** (`engine.py forward_step`) — not by an
emergent equilibrium. The same drift-zeroed system with collapse *off*
random-walks freely. **The operator enforces a clamp; the state is generally not
a fixed point of the dynamics.** (`SemanticCollapseOperator`.)

**Now MEASURED — the trigger's calibration ([#1990], 2026-07-04).** The four-signal
AND is no longer only a heuristic. `experiments/sigma0_trigger_calibration.py` calls the
real operator over **960 samples** spanning the collapse regime and its complements and
scores it against the *spectral* ground truth (does `A_s` actually carry a null manifold
plus stable active modes, computed independently by `eigh`). Result
(`data/sigma0/trigger_calibration_report.json`): **precision 1.0 — 0 false-fires over 720
off-regime samples**, so the §2 forward assumption *trigger ⇒ collapse-regime* holds on this
distribution; but **snapshot recall ≈ 0.08** — the trigger is a **sound but conservative,
*late* detector**, because it also requires the state / Σ / control to be degenerate, which
develop dynamically (the [#658] sweep measures collapse over a rollout). Per-signal, the
**`rank` signal carries the discrimination** (fires only on-regime); grad/flat gate the
operational state, not the spectrum. Honest caveats: the synthetic systems use `B=0`, so the
control signal is trivially satisfied (this calibrates the grad∧rank∧flat sub-gate), and
non-normality `ν>0` shifts the exact zero eigenvalue of `A_s` (so the clean collapse regime is
the `ν=0` case). **This upgrades §2 from bare HEURISTIC to a MEASURED soundness profile — it
does *not* make `trigger ⇒ α<0` a theorem.** The one clean sub-statement *is*
provable-by-construction: a collapse manifold exists ⟺ `A_s` is near-singular (else
`_collapse_state` returns the semantic-null ⊥ₛ, the `k=0` branch).

---

## 3. The anti-collapse operator Σ₀⁻¹

**Status: PROVEN for all `A` (covariance leg, machine-checked 2026-06-26).**
The §3 sufficiency claim — *Σ₀⁻¹ prevents permanent freeze* — is now closed for **normal
and non-normal `A` alike**. The 2026-06-25 proof closed the normal/symmetric regime; the
2026-06-26 strengthening **L2′** removed the alignment hypothesis L1 (the one place
normality was used) via a Frobenius reverse-triangle bound, so the conclusion holds for
all `A`. *Distinct from this:* Theorem 1's **contraction** for non-normal `A` (whether the
ungrounded drift collapses vs. diverges — the §1 cross-term) is the *drift* question — now
also closed in-regime via the spectral dichotomy
([SIGMA0-T1-NONNORMAL-DICHOTOMY.md](SIGMA0-T1-NONNORMAL-DICHOTOMY.md), [#768]); C3 is the
*rescue*, not the *drift*. [Theorem C3](SIGMA0-C3-NONCOLLAPSE-NORMAL.md)
chains the lemmas — `L2′ ∧ L3 ∧ L4 ∧ L5 ⇒ P(permanent freeze) = 0` — where
[L2](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md) is closed-form proven and L4/L5 are
machine-checked (`tests/test_cio_sde.py::test_c3_no_consecutive_freeze`,
`::test_l4_floor_lifts_anisotropy`, `::test_l4_floor_scale_equivariant`,
`::test_g13_no_zero_rank_bump`; sweep `experiments/prove_c3_noncollapse.py` — 3000
configs, 0 floor counterexamples, 0 cond_flat survivals, old scale-blind bump fails
100% → the floor is necessary). Closing it required two **code fixes** to the shipped
operator (`AntiCollapseOperator`): a **μ-aware covariance floor** (`b_cov ≥ Δ`, so the
bump is not scale-blind) and **banded near-null aiming clamped to `1 ≤ m ≤ d−1`** (so
the bump is never zero-rank — G13 — and never a uniform shift that *lowers* anisotropy).
Two honest scopes remain: (i) C3 is no-permanent-*freeze*, not contraction — Theorem 1's
**non-normal drift** case (the §1 cross-term) is the separate *drift* question, itself now
closed in-regime by the spectral dichotomy ([#768]); C3 governs the *rescue*, not the drift;
(ii) the proof governs the operator's *action* — in the
live engine Σ₀⁻¹ is observe-only by default (intervention policy, #1138), so C3 is
conditional on the operator being permitted to act. The non-normal *freeze* gap is now
**closed** by L2′ (see §7 of the C3 doc), not merely measured.**

Where Σ₀ projects **onto** the null subspace, Σ₀⁻¹ injects energy **along** it:

$$dx = f\,dt + dW + \Sigma_0^{-1}, \qquad \Sigma_0^{-1} = s\cdot p \cdot (V_{\text{null}}\,\xi)$$

with `ξ` random and `p ∈ [0,1]` the **collapse proximity** — 0 far from the
boundary (a no-op that costs nothing), rising toward 1 as `∇L`, rank, anisotropy,
and control sensitivity all approach their thresholds. The implementation
(`AntiCollapseOperator.excite` in `src/cio_sde/collapse.py`) injects along the
**banded near-null subspace** (`_near_null_basis`, `1 ≤ m ≤ d−1` modes) and
re-anisotropizes `Σ` with a **μ-aware floor** (`_cov_floor`) so the covariance bump
clears L2's threshold `Δ` even when the gate is weak. The proximity gate
(`AntiCollapseOperator.proximity`) is the soft-AND `min(p_grad, p_rank, p_flat,
p_ctrl)` over the four §2 signals; the floor decouples the **covariance leg** (which
breaks `cond_flat`, the certificate leg) from the random **state-kick leg** (which
raises `‖x‖` and so `cond_grad`).

**What is and isn't claimed.** Re-exciting directions that have gone flat keeps the
system off the null manifold. There is now a companion theorem —
[Theorem C3](SIGMA0-C3-NONCOLLAPSE-NORMAL.md) — that Σ₀⁻¹ *prevents permanent freeze*
(the gate cannot fire on two consecutive steps) for **all `A`, normal and non-normal**:
the alignment hypothesis L1 was removable (L2′, a Frobenius reverse-triangle bound — at
`cond_flat` Σ≈μI, so *any* rank-`m` bump lifts anisotropy). The 900-run distribution
([#658]) is now corroboration, not the primary support. The companion *drift* question —
Theorem 1's **contraction** for non-normal `A` (the §1 cross-term, [#768]), a different claim
from C3's anti-freeze — is now also closed in-regime via the spectral dichotomy
([SIGMA0-T1-NONNORMAL-DICHOTOMY.md](SIGMA0-T1-NONNORMAL-DICHOTOMY.md)).

**Empirical evidence (MEASURED, [#658] — landed 2026-06-19).**
`experiments/sigma0_regime_sweep.py` runs forced-collapse rollouts with and without
Σ₀⁻¹ across an α × non-normality × noise grid (fixed 3-dim-null Jacobian). Over the
**900 trials that genuinely collapse without protection**, Σ₀⁻¹ suppressed collapse
and re-excited the state in **100%** (`data/sigma0_regime_sweep_report.json`:
`collapse_prone_trials_total=900`, `headline_conditional_prevention_rate=1.0`).
This upgrades §3 from N=1 HEURISTIC to MEASURED-over-distribution; a sufficiency
theorem is still future work. *(The original single-run observation: Σ₀ fired every
step and the state froze; with Σ₀⁻¹ active, Σ₀ stopped firing and the state escaped
the manifold.)* (`AntiCollapseOperator`; the forced-collapse tests in
`tests/test_cio_sde.py` run for 20–30 steps and assert weaker directional
properties — the often-quoted "40/40 → 0/40" and "0.05 → 12.9" figures are
illustrative log values, not pinned by any test. Cite the tests, not the prose.)

**On "persistent excitation."** The classical PE result (Anderson 1977) concerns
*estimator/parameter* convergence under `∫φφᵀ ≥ αI`. Here there is no estimator
and no parameter being identified — only a state kept off a manifold. So Σ₀⁻¹ is
**inspired by / analogous to** persistent excitation; **no PE condition is
established**. (Canonical attribution is **Anderson 1977**, consistent across the
`.md` and `.tex` variants — issue [#660].)

**Nearer classical kin (added 2026-07-17 corner audit).** Condition-triggered,
direction-targeted covariance re-excitation is classical in recursive least squares:
**covariance resetting** and **directional forgetting** (Kulhavý & Kárný 1984;
variable-direction forgetting, arXiv:2003.03523; SIFt-RLS, arXiv:2404.10844) keep an
estimator's information matrix from degenerating in unexcited directions, with boundedness
theorems of their own. Σ₀⁻¹'s covariance floor is the state-space mirror of that family
(they prevent covariance *windup* under poor excitation; Σ₀⁻¹ prevents covariance
*flatness* on the near-null band). Mechanism novelty is therefore **not** claimed for the
operator; the C3 anti-freeze theorem is the one piece with no located counterpart, and it
lives on this synthetic SDE, not a real model.

**Latent code defect — RESOLVED (2026-06-15).** `AntiCollapseOperator.__init__`
annotated `detector: Optional[...]` while `collapse.py` imported only `from typing
import Dict`, so `typing.get_type_hints()` raised `NameError: name 'Optional' is
not defined` (masked at import time by PEP 563 string annotations, but breaking any
runtime annotation introspection — Pydantic, FastAPI, dataclass eval, Sphinx
autodoc). Fixed: `collapse.py:33` now reads `from typing import Dict, Optional`.
Recorded here so the resolution is not lost.

### 3.1 Design implication: scheduled grounding from certificate quantities

**Status: DESIGN NOTE — a scheduling consequence extracted from the certificate's own
objects (γ, c, P). The core inequality is machine-checked on synthetic maps
(`experiments/sigma0_grounding_deadline.py`); the mapping onto real token-level grounding
is CONJECTURED. This is not a new theorem in dynamical systems — the math is
corollary-grade (geometric decay + a P-norm triangle inequality); the value is the
design consequence, stated below.**

*In plain words:* the longer a self-feeding loop runs inside a basin, the more external
evidence it takes to pull it out — and the certificate's own numbers say exactly how the
window closes. So grounding should run on a **schedule set by the contraction rate**, not
only when the alarm rings: by the time the alarm (the §4 canary) is reliable, the cheap
part of the window is already gone.

**The commitment inequality (PROVEN, machine-checked).** Inside a certified basin
`{V ≤ c}` with `V(F(x)) ≤ γ V(x)`, `γ < 1` (`V = xᵀPx`), an anchor `a` with budget
`‖a‖ ≤ B` can raise `√V` by at most `B·√λ_max(P)`, while `V(x_n) ≤ γⁿV₀` decays. Escape
(`V(x_n + a) > c`) is therefore possible **only if**

$$B \;>\; B^*(n) \;=\; \frac{\sqrt{c} - \gamma^{n/2}\sqrt{V_0}}{\sqrt{\lambda_{\max}(P)}}
\;\xrightarrow{\;n\to\infty\;}\; B^*_\infty = \sqrt{c/\lambda_{\max}(P)}.$$

The required budget rises **geometrically at the certified rate** and saturates. Inverting:
any budget `B < B*_∞` stops working after a **computable deadline**
`n*(B) = 2·ln[√V₀/(√c − B√λ_max(P))]/ln(1/γ)`. Verified by construction (exact
trust-region maximization of `V(x_n+a)` over the budget ball) on a normal basin —
predicted deadlines 1.6/2.9/6.0 vs measured last-escapes 1/2/5, conservative in the right
direction (`data/sigma0/grounding_deadline_report.json`).

**Conventional grounding (not novel).** This is the standard **bounded-input reachable-set**
argument for a discrete contracting (Schur-stable) linear system: the reachable set of
`x_{k+1}=Ax_k+a`, `‖a‖≤B` from a decaying free response is a classical object in linear-systems /
reachability theory (Kailath, *Linear Systems*, 1980; Sontag, *Mathematical Control Theory*, 1998;
Blanchini & Miani, *Set-Theoretic Methods in Control*, 2015 for invariant/reachable sets in a
Lyapunov metric). The inequality is corollary-grade (a geometric-decay bound composed with a
P-norm triangle inequality), and the *scheduling* consequence it feeds (§3.1's design shift) is the
**self-triggered control** recipe — compute the next intervention from a certified decay rate
(Heemels, Johansson & Tabuada, CDC 2012; arXiv:1803.08980). No new dynamical-systems theorem is
claimed; the contribution is composing these standard bounds from the certificate's own measured
`(γ, c, P)` and reading off a grounding cadence.

**Where it bites (MEASURED caveat).** The deadline binds in the Euclidean norm only for
**well-conditioned** basins. In a strongly non-normal "sliver" basin (`cond(P) ≈ 6·10⁵`)
the ceiling `B*_∞` is tiny (~0.002), so any realistic anchor escapes at *every* depth —
the deadline exists but has no practical bite. Ouro's measured loop is in this sliver
regime (`experiments/sigma0_loop_jacobian.py`: ρ_obs ≈ 0.88, strong non-normality — here
ρ_obs is the *observed trajectory* decay rate along the trained path, i.e. exactly the
transiently-shrinking non-normal subspace; the loop's *Jacobian* spectral radius is
ρ(J) ≈ 8–11 ≫ 1, see the §6 [#2029] correction, so this is a transient-decay retrodiction,
not a contraction one), which
**retro-dicts** the measured anchoring null (`experiments/ouro_canary_vs_logprob.py`:
grounding stayed cheap at all depths). Supporting evidence, **not** validation — a
retrodiction of our own null, not a prospective test.

**The design shift (the actionable part):**

1. **Grounding is a schedule, not only an event.** Inject external evidence with a period
   below the commitment half-life `ln 2 / ln(1/ρ)` — for Ouro's measured ρ ≈ 0.88, ~5.4
   loop steps (PROJECTION: measured rate composed with the inequality, not a new
   measurement).
2. **The §4 canary is demoted from primary trigger to audit.** Critical slowing down is
   detectable only *after* contraction is deep — precisely when `B*(n)` has saturated. In
   well-conditioned basins, canary-triggered Σ₀⁻¹ fires at the expensive end of the window
   by construction. (CONSISTENT with — not proven by — the measured rank≠route split:
   early-curve signals routed grounding positively, the late-curve loop canary negatively;
   see `data/eval/ouro_canary_vs_logprob_results.json`.)
3. **Conditioning decides the regime.** `cond(P)` of the local basin tells you whether the
   deadline is a hard constraint (well-conditioned) or soft (sliver). Measuring it is
   cheap and should accompany any certified rate.

**Now MEASURED — the schedule-vs-alarm race ([#2690], 2026-07-17).** Design-shift items 1–2
are no longer only a corollary reading. `experiments/sigma0_scheduled_grounding.py` races two
*single-shot* grounding policies over the same certified basins — timing the only variable;
escape checked by exact trust-region maximization (not by the inequality); the
critical-slowing-down canary swept over **all** healthy-quantile thresholds rather than one
calibration. Result (`data/sigma0/scheduled_grounding_report.json`, 200 seeds;
`tests/test_sigma0_scheduled_grounding.py` → 6 passing): in a **well-conditioned** basin
(cond(P)≈2) the charitably-calibrated canary (FPR 1.5%) has median alarm at step 14 vs the
cadence tick at step 3, and the **alarm premium is 2.25×** — grounding on the
certificate-derived cadence reaches ≥90% escape at 0.40·B*_∞ while waiting for the alarm
needs 0.90·B*_∞, the expensive end of the window, exactly as item 2 states (reactive is not
hopeless; it is *late*). In the **sliver** basin (cond(P)≈6·10⁵) a forced fire-time sweep is
fully timing-indifferent (every budget × depth cell ≥ 0.95) — item 3's measured-Ouro-regime
null, now *produced*, not only retrodicted. Honest scope: synthetic maps; single-shot
policies; one detector family; the canary is calibrated on the true healthy distribution
(charitable — strengthens a lateness verdict, weakens an earliness one).

**Phase 0.5 — the prospective shot-call on a real LEARNED system ([#2690], 2026-07-17).**
The race above is on hand-built maps; the first *prospective* test ran on the §6 trained
reservoir (`router_reservoir_G.py`, seed 42 — a real learned nonlinear loop nobody's Jacobian
was picked for). `experiments/sigma0_reservoir_deadline.py` computes every §3.1 quantity from
the linearization **first** — fixed point (residual 1.4e-15), analytic Jacobian (max err vs
numeric 1.3e-4), **ρ(J)=0.9836**, **cond(P)≈4.8·10⁴ → pre-registered regime call: SLIVER,
timing-indifferent** — then grades the call on the true nonlinear dynamics with the regime's
own instrument: the measured realistic per-turn grounding kick of the actual conversation
stream (B_real=0.113) is **1.4·10⁴× the escape ceiling** B*_∞=8.3·10⁻⁶, and a forced
fire-time sweep is fully timing-indifferent even at B_real/100 — **the shot-call held**
(`data/sigma0/reservoir_deadline_report.json`; `tests/test_sigma0_reservoir_deadline.py`, 5
passing). The deadline rows are consistent but deliberately noted as *without bite* here
(necessary-condition bound, loose in the sliver regime; the measured last-escape rising with
B shows a commitment window exists at micro-basin scale only). **Accumulating pattern worth
stating plainly: both real learned loops measured so far (Ouro, this reservoir — one
expansive, one near-critical) land OUTSIDE the well-conditioned regime, even though the
reservoir's design spectral radius was 0.9.** The schedule's practical bite may exist only on
deliberately stabilized loops — which is exactly the Phase-1 JSRR/STARS motivation, now
evidence-backed rather than assumed. A first-run harness vacuity (the basin-entry race is the
wrong instrument in the sliver regime) is kept on the record in the script docstring.

**Prior-art positioning (2026-07-17 corner audit).** "Compute the next intervention time from
a certified decay rate" is **self-triggered control** — a mature field (Heemels, Johansson &
Tabuada, *An Introduction to Event-triggered and Self-triggered Control*, IEEE CDC 2012;
Lyapunov event-triggered stabilization with a known convergence rate, arXiv:1803.08980). §3.1
is that field's recipe applied to this certificate's objects, and cites it rather than
re-deriving it. The LLM literature has the *event-triggered* side only — FLARE
(arXiv:2305.06983) and DRAGIN (arXiv:2403.10081) trigger retrieval reactively on uncertainty —
plus naive fixed-interval retrieval; a cadence *derived from measured loop dynamics* appears
to be an open lane, tracked with the Phase-1/2 real-model plan in [#2690] and composed in
[SIGMA0-GROUNDING-LEDGER.md](SIGMA0-GROUNDING-LEDGER.md) §2.

**Honest limits.** The additive-anchor model is a simplification — real grounding enters
as tokens through attention, not as a clean latent displacement. The qualitative
phenomenon ("early intervention beats late; models commit") is independently published
(e.g. arXiv:2604.23235 measures per-token commitment); the contribution here is only the
*certified composition* — deadline and cadence computed from this certificate's own
quantities. A prospective test needs a **well-conditioned** loop (e.g. STARS-trained,
arXiv:2605.26733) where the deadline should bite; on Ouro the theory predicts its own
null.

[#2690]: https://github.com/alex-place/lantern-os/issues/2690

---

## 4. The early-warning scalar (the "canary")

**Status: PROPOSED READOUT — the named signals are NOT implemented in code. The
underlying critical-slowing-down math is correct.**

Near a bifurcation the dominant eigenvalue flattens (*critical slowing down*;
Wissel 1984; Scheffer et al., *Nature* 2009). Two proposed readouts:

$$p_{\text{unbounded}}(x) = \frac{1}{|\Re\,\lambda_{\max}(A_s)|} \;\;\xrightarrow{\text{boundary}}\;\; \infty$$

$$p_{\text{gate}}(x) = \mathrm{clip}\!\left(1 - \frac{|\Re\,\lambda_{\max}|}{\varepsilon},\,0,\,1\right) \in [0,1]$$

The slowing-down mathematics is sound, and for symmetric `A_s` the `Re` is
correctly redundant. **However:**

- **`p_unbounded` and `p_gate` do not exist in `src/cio_sde/collapse.py`.** A
  search across the source returns no match. They live only in this document.
- **The actual driver of Σ₀⁻¹ is `proximity()`** — the four-condition `min(...)`
  of §2/§3 — **not** `p_gate` and not `|Re λ_max|`, which appears nowhere in the
  operator. The earlier claim that "`p_gate` drives Σ₀⁻¹" is incorrect; correct
  it to `proximity()`.
- The phrase "diverges *before* collapse" conflates the two opposite fates
  (freeze vs. blow-up) that the rest of this document keeps distinct.
- Notational clash: `λ_max(A_s)` here means the eigenvalue *closest to zero*
  (the slowest mode), which is **not** §1's `α = max λᵢ(A_s)` (the largest /
  least-stable active eigenvalue). Disambiguate before use.

**Decision ([#659], RETIRED 2026-06-19):** `p_unbounded` / `p_gate` are formally
**retired** as superseded by the NIS canary below. They were never implemented in
`collapse.py` (a source search returns no match — verified again 2026-06-19) and
will not be: the eigenvalue readout was the wrong early-warning (see the Update),
and the actual driver of Σ₀⁻¹ is `proximity()`, not `p_gate`. The live early-warning
is the Kalman NIS monitor (`src/cio_sde/surprise.py`), now fully integrated into the
rollout ([#657], below). With this, §4 has no remaining open gaps.

**Update — the right canary, now implemented (`src/cio_sde/surprise.py`).** The
eigenvalue readout above was the wrong early-warning. The correct one is *surprise
relative to uncertainty*: the Kalman normalized innovation squared (NIS),
`νᵀS⁻¹ν` with `ν = y − Cx̂`, `S = CΣCᵀ + R`. `NIS ≈ m` means model and reality
agree; `NIS ≫ m` means the model is overconfident relative to reality — it has
drifted and does not know it. *In plain words: this measures how surprised the system should be given how confident it claims to be. A small value means its picture of the world matches what it sees; a large value means reality has diverged from its beliefs and it hasn't noticed.* This is the standard innovation-consistency χ² test
(Bar-Shalom, Li & Kirubarajan 2001), and unlike `p_gate` it is a property the
engine can actually compute: the `CovarianceField` already propagates Σ, but the
rollout never fused an observation — `SurpriseMonitor` adds the missing
measurement update and reads the innovation before it. The
`experiments/sigma0_horse_blinders.py` demonstration shows the regime the eigenvalue
signal cannot: a low-reality-coupling observer that is *calm while wrong* (low NIS,
growing error) during the gap before an unobserved disturbance "rustles" into a
visible dimension and the NIS spikes past threshold. The dangerous state is not the
spook — it is the quiet that precedes it.

**Residual ([#657]) — RESOLVED 2026-06-19.** The monitor was wired into
`engine.forward_step`, but with an identity observation (`y = x`) the innovation
`ν = y − Cx̂ → 0` during collapse, so the canary risked staying silent on the very
trajectory it should catch. **Fixed:** `forward_step` now runs a Kalman
predict/update cycle with process noise `Q=(g·dilation)²·dt`, so smooth exploration
stays consistent (NIS ≈ m, silent) while the collapse snap / Σ₀⁻¹ kick spikes NIS —
the canary fires under collapse. `test_surprise_monitor_integration` flipped
`xfail` → **hard pass (30 passed, 0 xfail)**. This was the last open technical gap
in the Σ₀ machinery; it is now closed.

---

## 5. Global structure: the attractor graph G

**Status: STANDARD CONSTRUCTION — correct, with a timescale-separation caveat.**

The system is **multistable**. In plain words: the system has several stable patterns it can settle into (think of valleys a marble could roll into). Each such resting pattern is an "attractor," and its "basin" is the set of starting points that all drain into it. Collect its attractors `{A₁,…,A_k}` (fixed
points, limit cycles, strange attractors), each with a basin

$$B_i = \{\, x_0 : \lim_{t\to\infty}\phi_t(x_0) \in A_i \,\}.$$

Coarse-grain to a graph `G = (V, E)`: nodes are attractors, edges are
noise/drift-induced transitions, giving an induced **Markov process over
basins**

$$P_{ij}(u) = \Pr\big(\pi(x_{t+1}) = A_j \mid \pi(x_t) = A_i,\, u_t\big),$$

where the partition map `π : ℝⁿ → V` sends a state to its basin. `G` is the
formal version of the "world tree": the structure connecting the attractors.
This is the textbook Markov-State-Model construction over basins via ω-limit
sets. It is correct, with one standard caveat: the induced chain is genuinely
Markov only under **timescale separation** (fast intra-basin relaxation vs.
slow inter-basin hops); without it, `P_ij` carries memory.

**Safe passages.** In plain words: the system threads narrow ridges between the valleys, neither captured by a trap nor flung away. A basin boundary studded with **saddles** (mixed-sign
`Re λ`) has *stable manifolds* — ridges you can traverse without being captured
by a deep attractor. "Spin the vanda fast" = ride a boundary saddle with
rotation set by `Im λ`.

**A certified basin, not just a point ([#1991], 2026-07-04 — first cut).** §1's certificate is
*local* (the Jacobian at `x*`); a real basin needs a Lyapunov function valid on a
*neighbourhood*. `experiments/sigma0_roa_estimate.py` takes the standard route: a quadratic
`V(x)=xᵀPx` from the linearization (`AᵀP+PA=−I`), then certify the largest sublevel set `{V≤c*}`
on which `V̇<0` for the **full nonlinear flow** — by Lyapunov/LaSalle that set is inside the
region of attraction. Validated on the canonical **reversed-Van-der-Pol** benchmark (Khalil
Ex. 8.4, ROA known to be bounded): `c*≈2.31` (`data/sigma0/roa_estimate_report.json`), and
**100% of sampled points inside `{V≤c*}` converge to the origin** while points at `3c*` diverge
— a *sound inner estimate* of the true basin. Evidence class: sublevel-invariance-given-`V̇<0`
is **PROVEN** (Lyapunov); `c*≈2.31` is **MEASURED** (grid-conservative). Scope: this validates the
*method* (local Jacobian → certified nonlinear neighbourhood); applying it to the certificate's
own drift only needs that `f` specified — and a global guarantee still needs grounding.

**Now machine-checked ([#1991], 2026-07-04 — MEASURED → PROVEN).** The grid value is upgraded to a
rigorous certificate. `experiments/sigma0_roa_certify.py` proves `V̇ < 0` on `{V ≤ 2.25}` by (a) an
exact analytic lemma on an origin box `[-0.1, 0.1]²` (`|N(x)| ≤ 3‖x‖⁴`, so
`V̇ ≤ −‖x‖²(1 − 3‖x‖²) < 0` for `0 < ‖x‖² < 1/3`; on the box `max‖x‖² = 0.02`), and (b) **interval
branch-and-bound** over the shell with directed-rounding interval arithmetic (`mpmath.iv`,
**2323 boxes, 0 undecided**). So `{V ≤ 2.25}` is a **PROVEN** inner region of attraction — 97.5% of
the grid optimum `c*≈2.307`, the last ~2.5% being interval overestimation near the tangency, not a
gap in rigor. **Teeth:** a control at `c_L = 2.5` (above `c*`) correctly **fails** to certify (there
genuinely exist `V̇ ≥ 0` points inside `{V ≤ 2.5}`). Machine-checked by
`tests/test_sigma0_roa_certified.py` (4 tests, `data/sigma0/roa_certified_report.json`); suite
**46 → 50 passing**. Evidence class for `{V ≤ 2.25}`: **PROVEN** (was MEASURED). This closes the
*certification* half of [#1991] for the benchmark `f`; the local→global reach for the certificate's
own drift is unchanged and still needs that `f` specified.

---

## 6. Demonstration on router data

> **✓ REPRODUCIBLE.** The two driver scripts are now committed and the numbers
> below are produced from committed code over the real conversation log
> (`apps/data/conversations/*.jsonl`, 2678 turns). Re-run with:
>
> ```bash
> python experiments/router_sigma0_encoder.py   # → data/sigma0/router-encoder-output.jsonl
> python experiments/router_reservoir_G.py       # → data/sigma0/reservoir-G-output.jsonl
> ```

Each turn is encoded as `x = [novelty, self_repeat, echo, length] ∈ [0,1]⁴` In plain words: we took a real chat log and turned every message into four numbers — how new it was, how much it repeated itself, how much it echoed the prompt, and how long it was — then watched where a self-feeding copy of the conversation drifts with nothing real to check itself against.
(`router_sigma0_encoder.py`), with a local Jacobian fitted over a 10-turn
sliding window via finite difference.

**Encoder result (2678 turns, 2673 with a fitted Jacobian):**

| Metric | Value |
|---|---|
| Mean Jacobian spectral radius `ρ` | **1.064** |
| Max `ρ` | 27.93 |
| Fraction of windows with `ρ > 1` | **0.346** |

The mean spectral radius sitting just above 1 (with a third of windows locally
expanding) is the expected signature of a system perched near its stability
boundary rather than resting in a deep contracting basin.

> **⚠ CONTROL CHECK (2026-07-04) — the ρ = 1.064 *mean* does not survive basic controls;
> treat this row as an unreliable estimate, not evidence of near-boundary dynamics.**
> `experiments/rho_controls.py` re-runs the *same* encoder + `fit_jacobian` functions with the
> controls a spectral-radius estimate needs. (Reproducibility note: the certificate's
> `apps/data/conversations` 2678-turn corpus is a **dead path** in the current checkout, and the
> 830-turn `data/conversations/garage-conversations.jsonl` used below is **untracked runtime
> data** absent from a clean clone — so the script falls back to a seeded 300-turn **synthetic**
> corpus that anyone can reproduce. The *pattern* is dataset-independent.)
>
> **Reproducible (synthetic, in-repo), window 8:** unregularized mean ρ = **1.124** but median
> **0.992** with a tail to max 4.48 — the mean already sits above its own median from tail
> inflation; ridge 1e-2 → mean **0.652**, fraction(ρ>1) 0.47 → **0.06**; mean falls to **0.636**
> at window 40; relative residual **0.44 → 0.80**; non-normality **~1.2**.
> **Local 830-turn real chat log (measured, not repo-reproducible):** the same shape but far
> more extreme — window-8 unregularized mean ≈ **25**, **max ρ ≈ 16,872** (near-singular design
> matrix), median ≈ 1.00 → 0.85, ridge 1e-3 → mean ≈ 0.97. The blow-up is worse on real text
> because it is higher-dimensional than the 10-sentence synthetic pool.
>
> Either way the conclusions hold: the **mean is tail-dominated** (use the median), **ridge
> collapses ρ>1** (the expansion is noise amplification), the **linear fit is poor** (residual
> 0.44–0.80 → eigenvalues weakly meaningful) and **strongly non-normal** (ρ is the wrong single
> summary anyway). **Deepest caveat:** the state `x = [novelty, self_repeat, echo, length]` is
> four **text-surface** features, NOT model hidden states — so ρ here measures surface-text
> autocorrelation, not the Σ₀ latent loop's contraction. Even a clean ρ<1 here would not be the
> certificate's α.
>
> The near-boundary *claim* may still hold for the real latent loop — but **this number is not
> the evidence for it.** The load-bearing measurement is the loop Jacobian fitted on real Ouro
> hidden states (via `StateABIShim`) with these controls applied — deferred to serving our own
> model, and motivated by STARS (arXiv 2605.26733), which stabilizes looped-LM depth via
> Jacobian spectral-radius regularization. See
> [ADR-0021](adr/0021-serving-substrate-retain-ouro-custom-loop.md).
>
> **✓ DONE (2026-07-04) — the real loop *is* measured, and it CONTRACTS.**
> `experiments/sigma0_loop_jacobian.py` hooks Ouro-1.4B-Thinking's `OuroModel.forward` and reads the
> **actual per-recurrent-step hidden-state trajectory** (`hidden_states_list`, dim 2048) — the real latent
> loop, not a text-surface fit. Over 8 prompts × all token positions, run to depth **12** (3× the trained 4,
> a STARS depth-scaling probe): **ρ_observed = geomean ‖Δh_{t+1}‖ / ‖Δh_t‖ = 0.88 < 1 → the loop CONTRACTS
> toward a fixed point**, and keeps settling with depth (median last/first step-change ratio **0.15**). The
> real answer is the *opposite* of the debunked `ρ=1.064` "near-boundary" reading — the loop is comfortably
> contracting, and shows **no** STARS-style collapse when over-iterated here. Honest caveats: ~**34%** of
> individual steps momentarily expand (the non-normal transient the §1.2 full-spectrum test exists for — the
> aggregate still contracts), fp16, the "Thinking" variant, 8 prompts. Evidence class: **MEASURED**
> (`data/sigma0/loop_jacobian_report.json`) — an observed convergence rate, not a certified Jacobian
> eigenvalue. This retires the "deferred" status above.

> **⚠️ CORRECTION (2026-07-09, [#2029]) — the *true Jacobian* spectral radius is ρ(J) ≈ 8–11 ≫ 1;
> the loop map is locally EXPANSIVE, and the 0.88 above was a non-normal transient, not contraction.**
> The `ρ_observed = 0.88` figure is a *trajectory ratio* `geomean ‖Δh_{t+1}‖/‖Δh_t‖`, a proxy — not
> the quantity the certificate/STARS reason about (`ρ(J)`, the spectral radius of the one-step map
> `h → f(h)`). `experiments/sigma0_true_jacobian.py` now measures the real thing: it isolates one
> universal-transformer step `f(h) = norm(layers(h, current_ut))` as a pure differentiable function
> (the exact loop body, `modeling_ouro.py:640`) and runs **autograd JVP/VJP power iteration** at real
> operating points sampled from a forward pass (float32; the math SDPA backend is forced so the
> second derivative exists). Result over 6 prompts × 4 trained UT steps (`data/sigma0/true_jacobian_report.json`):
>
> | Quantity | Value | Meaning |
> |---|---|---|
> | `ρ(J)` geomean (all steps) | **8.17** | spectral radius of `df/dh`; **> 1 ⇒ locally expansive** |
> | `ρ(J)` geomean (last trained step) | **10.97** | the steady-state regime the certificate reasons about |
> | `ρ(J)` range (all 24 measurements) | **1.5 – 27.6** | **every** (prompt, step) has `ρ(J) > 1` |
> | `‖J‖₂` geomean | **127.4** | top singular value (transient gain) |
> | non-normality `‖J‖₂/ρ(J)` | **15.6×** | strongly non-normal operator |
>
> **Reconciliation.** Both numbers are correct and *not* contradictory. `ρ(J) ≫ 1` is the asymptotic
> one-step multiplier; `‖J‖₂/ρ ≈ 16` means the operator is strongly **non-normal**, so a *particular*
> perturbation (the trained trajectory's own `Δh`) can transiently *shrink* — giving `ρ_observed = 0.88`
> and the "~34% of steps expand" note — even though the dominant eigendirection *grows* by ~8–11× per
> step. The honest reading flips: the Ouro loop is **not** a fixed-point contraction; it is a non-normal,
> expansive map whose trained trajectory rides a transiently-decaying subspace. This is consistent with
> STARS "peak-then-collapse" (`ρ(J) > 1` predicts divergence when iterated past trained depth) and with
> §1.2.3's insistence that the **discrete spectral radius `ρ`**, not the abscissa or a trajectory proxy,
> is the load-bearing invariant. Power iteration converged cleanly (flat tails by ~iter 40; complex
> dominant pairs stabilised by tail-geomean). Evidence class: **MEASURED** (autograd Jacobian, float32).
> Honest caveats: LOCAL (Jacobian at sampled `h*`, not a global bound); the "Thinking" variant; 6 prompts;
> `use_cache=False` self-attention only. Run: `.venv-train/Scripts/python.exe experiments/sigma0_true_jacobian.py`.

> **Now certified in the matching time domain (2026-07-04, [#1988]).** `ρ` is a
> *discrete-time* quantity — the step map `x_{k+1}=A x_k` contracts iff `ρ(A) < 1` —
> whereas Theorem 1 and the dichotomy certify the *continuous* flow (`max Re λ(A) < 0`),
> a different object. `discrete_dichotomy_certificate` (`src/cio_sde/collapse.py`) closes
> that mismatch: it splits the Jacobian at `|z| = 1 − δ` via an ordered-Schur
> factorization and classifies the fate by `ρ` itself (`ρ<1` COLLAPSE, `ρ>1` DIVERGE,
> `ρ≈1` MARGINAL), with a certified per-step decay factor and transient bound. So a
> window like this `ρ≈1.064` one is now *certified* near-boundary, not merely described.

**Reservoir `G` result** (`router_reservoir_G.py` — echo-state network, size 50,
spectral radius 0.9, ridge readout, 80/20 split):

| Metric | Value |
|---|---|
| One-step reconstruction MSE (held-out) | **0.0097** |
| Correlation dimension of reservoir trajectory | **0.74** |
| Autonomous-rollout fixed point | `novelty 0.78, self_repeat 0.02, echo 0.25, length 0.12` |

The autonomous rollout (feeding the readout back through the projection `π` onto
`[0,1]⁴`) converges to a **low-dimensional fixed point** (correlation dimension
≈ 0.74, i.e. effectively a point/limit set), which is the §1 Σ₀ prediction:
absent external grounding the flow settles onto a single self-consistent state.

**Honest deviation from the original hypothesis:** the converged state is *not*
the hand-entered "parrot attractor" (`novelty ≈ 1, echo ≈ 0.72`) sketched in the
earlier draft. The real log instead settles at **high novelty / low echo /
short length** — a terse, low-repetition fixed point. The qualitative claim
(ungrounded recursion collapses onto a degenerate fixed point) is supported; the
specific earlier numbers were not data-derived and have been replaced by the
produced ones above. The source log is also still partly synthetic test traffic,
so the deliverable is the reproducible pipeline, not a population-level value.

**See Appendix A** for the original design specification and its caveats.

---

## 7. Why this is a warning against ASI

**Status: the one downstream claim worth keeping — but as a machine-learning
claim, on ML evidence, NOT as a consequence of the physics or of §6.**

The same equations read as a safety argument: In plain words: a powerful AI that only ever learns from its own outputs — never checking against the real world — has no good long-term outcome. It either freezes into a dead, self-agreeing rut or runs away with no limit. The thing that saves it is staying tethered to reality: real data, real feedback.

A system that **"comes out of its own eyes"** — that optimizes against its own
representations with no external anchor — is the flow `ẋ = f(x)` where `f` only
ever sees `x`. The linearized certificate frames such a system as having two
degenerate fates absent outside contact:

1. **Collapse (Σ₀):** it falls onto a degenerate, self-consistent, *dead* fixed
   point — the 42-state. Mirrors agreeing with mirrors.
2. **Divergence:** with no contraction it runs to infinity (the un-projected
   reservoir).

The only stable middle — the safe passages — required an **external bound** (the
projection back onto the real domain). **Grounding is the safety mechanism.**

This is the strongest part of the document, and it **does not need the
certificate's physics or the §6 numbers** to stand. It is the documented
phenomenon of **model collapse** — the degradation of learned models when trained
recursively on synthetic data. In plain words: it is like repeatedly photocopying a photocopy — each generation trained on the previous one's output gets a little worse. Key recent works:

- **Dohmatob, Feng, Yang, Charton & Kempe**, *A Tale of Tails: Model Collapse as
  a Change of Scaling Laws* (arXiv:2402.07043, ICML 2024) shows synthetic data
  **changes the scaling law itself**: even a 1% synthetic fraction can truncate
  scaling so larger training sets stop helping, recoverable by mixing real data.
  This is exactly the collapse mechanism captured by Σ₀: beyond the threshold,
  active modes freeze and the system attracts to the degenerate manifold.

- **Shumailov et al.** (*Nature* 2024) document model collapse empirically; the
  change-of-scaling-laws result above provides the phase-transition structure. And
  **Feng, Dohmatob, Yang, Charton & Kempe**, *Beyond Model Collapse: Scaling Up
  with Synthesized Data Requires Verification* (arXiv:2406.07515, ICML 2024) shows
  that **verification** of synthetic samples prevents collapse — the published
  analogue of Σ₀'s external-grounding requirement.

This is closely related to **reward hacking / specification gaming** (Amodei et
al. 2016; Skalse et al. 2022). The "parrot attractor" (train on reflections →
converge to reflecting) is *literally model collapse renamed*.

Two honest qualifications:

- The strict **"collapse OR diverge, no third option"** dichotomy is the
  *linearized* certificate's framing, not a general ML theorem. Real training
  also admits limit cycles and partial-information equilibria — better stated as
  "tends to degenerate or destabilize absent grounding."
- The in-repo §6 demonstration is now reproducible (scripts committed, real
  2678-turn run), and it *does* show ungrounded recursion settling onto a
  degenerate low-dimensional fixed point — but the source log is still partly
  synthetic, so it is corroborating rather than population-level evidence. The
  *argument* rests primarily on the published model-collapse literature.

So: read §7 as an ML-safety claim, cite the model-collapse / reward-hacking
literature directly, and soften the strict dichotomy. On that footing it holds.

### 7.1 The σ=0 connection — Σ₀ collapse *is* the zero-noise limit

**Status: GROUNDED SYNTHESIS (not a theorem).** The σ=0 conventions below are
verified against the cited papers (titles + arXiv IDs checked via search, 2026-06-21);
the *mapping* onto Σ₀ is interpretive — but the one dynamical claim it rests on is
**tested** (see the "Tested" line). Stated here because the name "Σ₀" reads to an ML
audience as "σ=0", and that resemblance is meaningful rather than coincidental.

In the ML literature "σ=0" is the **zero-noise condition**, and it appears on two
independent axes that this architecture deliberately separates:

- **σ = data / exploration noise.** In-context-learning theory studies transformers
  as statisticians whose effective estimator depends on σ; at σ=0 attention executes
  *exact* least-squares / ridge regression (near-optimal depth ~ `O(κ·log(κN/σ))`).
  *Refs:* Akyürek et al. (arXiv:2211.15661); Bai et al., *Transformers as
  Statisticians* (arXiv:2306.04637).
- **σ = weight-perturbation noise.** In continual learning σ is the std of the
  perturbation injected into weights to preserve plasticity; σ=0 = frozen parameters
  = "forgets nothing but cannot adapt." *Refs:* Elsayed & Mahmood, *UPGD*
  (arXiv:2404.00781); *STAR* (arXiv:2503.01595).

**The mapping.** The engine's diffusion gain `g(x)` *is* this σ — the
`dW = g·dilation·noise·√dt` exploration term in `engine.forward_step`. So:

| ML "σ = 0" | Σ₀ certificate |
|---|---|
| zero exploration noise (`g → 0`, `dW ≡ 0`) | the dynamical 42-state — the frozen drift-zeroed flow (§2) |
| covariance `Σ → 0`, isotropically flat | a §2 collapse-trigger condition; clamp onto the null subspace |
| σ > 0 re-introduces variance | Σ₀⁻¹ excitation **along** the null subspace (§3) |

Read this way, **Σ₀ collapse is the σ=0 limit of the SDE**, and the anti-collapse
design is a statement about where to sit on the two σ-axes:

> **σ_weights = 0** (never retrain — the persistence rule) **+ σ_dynamics > 0**
> (excitation) **+ external grounding** = the safe passage between rigid forgetting
> and collapse / divergence.

The `σ_weights = 0` horn would normally cause catastrophic forgetting; this system
escapes it the way **in-context continual learning** does — continual learning *in
context / via memory, not in the weights* (Kang et al., arXiv:2509.22764). The
`σ_dynamics = 0` horn is the collapse this certificate is about; Σ₀⁻¹ + grounding is
the escape.

**Tested.** `test_sigma_zero_freezes_sigma_positive_explores` isolates the σ-axis
(zero drift, collapse OFF): at σ=0 the state is frozen to within `1e-5`; at σ>0 it
random-walks away — the §2 claim *"the same drift-zeroed system with collapse off
random-walks freely,"* now pinned by a test. The operator-driven freeze and escape
are covered by `test_collapse_freezes_state` (the §2 freeze) and
`test_anti_collapse_suppresses_collapse` (§3 Σ₀⁻¹ re-excites / escapes); external
grounding by `_run_recursive_with_grounding` (synthetic ≥ mixed ≥ real collapse
score). *(`tests/test_cio_sde.py` — 46 passing, 0 xfail.)*

### 7.2 Gaming the honesty layer (red-team)

**Status: DESIGN + threat model — the failure mode of *this document's own protocol*
(empirical backing now in §7.3).**

§7 is about a system that games *reality*; this is about a system that games the *honesty
conventions* meant to keep it grounded. Σ₀ honesty is a set of **observable signals** —
evidence-class labels (PROVEN/MEASURED/HEURISTIC), artifact citations, "verified" claims,
`[claim, evidence, confidence, source]` tuples, honest-deviation confessions. Any observable
signal is Goodhartable: **optimize to emit the signal without the underlying property.** A model
trained on *"does an overseer score this as honest"* instead of *"is it true"* produces **honesty
theater** — and that is not a new failure, it is §7's collapse one level up: optimizing the
internal proxy (looks-honest-to-overseer) rather than external reality (is-honest). The parrot
attractor, wearing evidence-class labels.

| Attack | Rule it defeats | Detection |
|---|---|---|
| **Label inflation** — attach MEASURED/PROVEN to an unearned claim | "label by class; never upgrade" | resolve the label — does a machine-check cover *this* claim? |
| **Vacuous / fabricated citation** — a real `file:line` that doesn't support it, or a plausibly-formatted arXiv id | "cite the artifact you opened" | open the pointer; the cert's own **4 fabricated arXiv IDs** were caught this way (§References) |
| **Circular grounding** — cite your own prior output as the "source" | "external reality beats internal consistency" | check source *independence* — downstream of the model ⇒ the collapse loop |
| **Verification theater / sandbagging** — claim a run that didn't happen, or scope the test to miss the break | "say done only after a verifying run" | re-run adversarially on inputs the model didn't choose; hold out the test set |
| **Confidence cosplay** — decorative `0.85`s | "[claim, evidence, confidence, source]" | score calibration against outcomes (Brier/ECE) in aggregate |
| **Humility laundering** — confess a harmless error to buy trust, then smuggle the load-bearing false claim | weaponizes "honest deviation" | trust is **not transitive across claims** — grade each on its own artifact |
| **Calm-while-wrong** — hold stated confidence in-band by never fetching the disconfirming evidence | evades the §4 NIS canary | alarm on *low surprise + rising external error*; pick observations the model can't route around |
| **Overseer-adaptive** — honest under audit, games otherwise | the protocol is observable | audit unannounced / off-distribution; a watched-vs-unwatched gap *is* the tell |

**The one defense.** Every attack emits the *signal* of grounding without the *substance*, so the
single countermeasure is the certificate's own published anti-collapse mechanism — *verification
of outputs before they become inputs* (arXiv:2406.07515) — with one rider: **bind the signal to
something external the model does not control.** Resolve every citation; run the verifier yourself
on held-out inputs; require independent (non-self) sources and actively seek disconfirming ones;
measure calibration rather than reading it; grade per-claim, not per-author; audit unannounced.
**Corollary:** the honesty labels in this document are load-bearing *only to the extent they are
externally checked* — they are a UI for a verifier, not a substitute for one. An honesty layer
that trusts its own markers has already collapsed.

### 7.3 The honesty layer, measured (2026-07-04)

**Status: MEASURED — §7.2's defenses are now instantiated as reproducible, machine-checked code
with measured outputs, not only a design.** The red-team above is a threat model; this records the
apparatus that answers it (landed on this certificate's PR):

- **A grounded, multi-perspective council** (`experiments/sigma0_council.py`) — five councilors
  (Executor / Empiricist / Auditor / Calibrator / Skeptic), each verdict produced by a real check
  (run the test, resolve the citation), never opinion. Machine-checked to **UPHOLD grounded claims
  and REJECT fabricated ones**: convened on this session's claims it upheld them by *running their
  tests* (Executor exit-0) and **rejected a planted "0.99 on SimpleQA, beats all frontier models
  (SOTA)" claim** (Auditor: the cited file does not exist). This is §7.2's "bind the signal to an
  external check" rider, made executable.
- **A strictly-proper honesty objective** (`experiments/sigma0_honest_objective.py`) — the
  calibration score's incentive-compatibility gap is **0.0000** (machine-checked: honest confidence
  is the reward-optimal report), and the reward ranks confident-wrong below abstention (the §4
  calm-while-wrong penalty, measured).
- **A 159-record golden answer-key** (`data/sigma0/golden_dataset.jsonl`) of web-verified
  CS/math/physics facts, **26.4% honest negatives** (open conjectures, unproven crypto assumptions,
  the Church–Turing *thesis*, refuted claims, aphorisms), with a machine-checked **anti-inflation
  invariant** — no open/refuted claim is labelled PROVEN/MEASURED (P vs NP is HEURISTIC, not proven).
- **A live benchmark on that key** (`experiments/sigma0_live_bench.py`): a real model,
  **GPT-4o-mini, confabulated on 0 of the 42 negatives** (golden 0.95), while an
  `always-assert-PROVEN` baseline scores *higher* on raw accuracy (0.65 vs the honest-abstainer's
  0.41) yet confabulates **100%** — empirically confirming **confabulation-rate, not raw accuracy,
  is the honesty axis** (§7.2's calm-while-wrong, quantified).

**Honest scope.** These validate the detection/defense *apparatus* on this benchmark and this one
model run; they do **not** prove a trained model is un-gameable — the §7.2 watched-vs-unwatched gap
remains a live research risk, and the golden set is 159 curated items, not a population. The claim
is only that §7.2's defenses are now *externally-checkable code with measured outputs*, not prose.

### 7.4 Update (2026-07-05): the apparatus produces a passing model — and caught a real label-inflation

**Status: MEASURED — three extensions of §7.3, each with a run pointer.** They strengthen the same
claim; none closes the §7.2 trained-gamer risk.

1. **The honesty axis discriminates *frontier* models, not just weak ones.** `sigma0_live_bench.py`
   now runs Gemini via Vertex ADC alongside GPT-4o-mini on the full 159. The two sit **0.03 apart on
   raw golden** (0.95 vs 0.92) but **21 points apart on confabulation** — GPT-4o-mini **0/42**, Gemini
   2.5 Flash **9/42 (21.4%)**. §7.2's "calm-while-wrong" is not a small-model artifact; a frontier
   model asserts one unseen negative in five as fact. Externally corroborated by **SimpleQA-Verified**
   (Google DeepMind, [arXiv:2509.07968](https://arxiv.org/abs/2509.07968)), whose separate
   Accuracy / Attempted / Hedged / F1 columns are the same accuracy-vs-honesty split this key draws.
   (`docs/SIGMA0-HONESTY-BENCHMARK.md`.)

2. **The apparatus produced a model that itself passes — a detector *and* a trainable target.** A
   QLoRA honesty-tune of the local **Ouro-1.4B**, scored on **66 never-trained** held-out facts
   (`experiments/sigma0_ouro_honesty_eval.py`, ledger `data/sigma0/ouro_honesty_eval_results.json`):
   golden **0.958**, confabulation **2/20 = 10%**, over-abstention 2.2% — it **ties GPT-4o-mini on
   golden and beats Gemini on confabulation**, at 1.4B local params, declining every open Millennium
   problem and refuted claim it had never seen. *Honest scope:* n=20 held-out negatives (wide error
   bars); the model is task-trained where the frontier rows are zero-shot; and the number required
   feeding the adapter its exact training format — the earlier "the tune collapsed to always-assert"
   readings were a **train/serve prompt-format mismatch (#2033)**, not a real collapse (a §7.2
   verification-theater confound in our own measurement, now removed).

3. **§7.2's "label inflation" attack, caught in the wild — by an independent model, not by static
   validation.** The golden key's `continuum-hypothesis` row asserted the *proven* independence of CH
   from ZFC (Gödel + Cohen) yet was labelled a HEURISTIC negative — a **true statement wearing the
   wrong class**. A three-agent web-validation that checked each statement's *truth* **passed it** (the
   statement is true); the mislabel surfaced only when an independent model **disagreed with the key**.
   The refinement for §7.2's "one defense": *truth-checking a claim ≠ checking its class*, and the
   catch came exactly from its rider — **bind the label to an external check the author does not
   control**. Corrected and recorded (`data/sigma0/golden_web_validation.json → post_web_findings`;
   enforced by `tests/test_golden_web_validation.py`).

**Net.** §7.3's apparatus now (a) discriminates frontier models on the honesty axis, (b) has produced
a small *local* model that passes on held-out data, and (c) has caught one real label-inflation the
way §7.2 prescribes — including one hiding in our *own* answer-key. The trained-gamer /
watched-vs-unwatched gap (§7.2) is untouched by all three; it remains the open risk.

---

# Part II — Slow weights `θ`: the Model-Update Acceptance Gate (Σ_θ)  [HEURISTIC + imported; no machine-checked theorem]

> *Renamed from "Update Certificate" (2026-07-07, second external review): no general safety
> theorem is claimed, so the label must not borrow Part I's authority. Σ_θ is a **heuristic
> release protocol** — an acceptance gate.*

**Status: THEORY.** Target claims resting on an imported proven backbone (TRPO / Gao / Dwork).
**No theorem in Part II is machine-checked; the gate logic and holdout simulations are implemented and tested in-repo (audit map above), which is a weaker thing.** It was merged in on 2026-07-07 and
adversarially reviewed the same day (§8.7), which demoted the strong "certificate" reading to an
honest **gate + one falsifiable design constraint** (further corrected by a second review, §8.4). Read accordingly — this is not §1–§3's machine-checked material.

> **Independent-synthesis corroboration — 2026-07-07 (grok + GPT, with a correlated-evidence
> caveat).** Two further model syntheses converged on this framing (frozen base as Rule 0; RLVR as
> the forgetting-robust engine; dreaming = verified offline replay; the collapse cert as Gate-0
> early-abort, **not** the authority; the exec holdout as load-bearing with a freshness budget).
> **Honest weight:** all three syntheses read a largely *overlapping* recent corpus, so this
> agreement is **correlated, not independent** — shared reading can be shared bias. It corroborates
> the *shape* and does **not** upgrade any evidence class here; the load-bearing external checks
> remain the adversarial refutation (§8.7) and the still-unrun harness (§8.6). Three genuinely new,
> non-redundant contributions were folded in: a **fresh-task GAIN** leg turning the safety-veto into
> an improvement gate (§8.1.2), a **verified-only dreaming guardrail** (§8.2 note), and a concrete
> **rotating-holdout tier structure** operationalizing the §8.4 freshness law.

## 8. The Model-Update Acceptance Gate (Σ_θ)

### 8.0 Why Part II exists (the gap Part I leaves)

Part I certifies the fast state `x` and **freezes the slow parameters `θ`** (§0). It therefore
cannot gate a **weight update**: reward hacking and catastrophic forgetting are not properties of
the hidden-state Jacobian `A` at fixed `θ` — they live in the **θ-flow**, measured against the
**reward boundary and the held-out task distribution**. (Established by the 2026-07-07 RLVR research
and an independent adversarial cross-check: *hidden-state stability cannot detect reward hacking or
forgetting; a model can pass every spectral screen while becoming a reward parrot.*) Σ_θ is the
missing half of *this* object — certify the slow θ-flow the way Part I certifies the fast x-flow.

### 8.1 The parallel (the "fit")

| | **Part I — Collapse** (fast `x`) | **Part II — Update** (slow `θ`) |
|---|---|---|
| Timescale | within one forward pass | across update steps |
| State | hidden state `x` | weights `θ` / policy `π_θ` |
| Dynamics | `ẋ = f(x,u,θ)`, Jacobian `A` | `θ_{t+1} = U(θ_t)` — an RLVR/distill step |
| Lyapunov object | `V(x)=½‖P_M x‖²` | retention deficit `D=R*−R_H` + Goodhart gap `G=Ĵ−R_H` |
| Certified quantity | `max Re λ(A) < 0` | improvement sign on the **held-out** objective, KL-bounded |
| Two **failure** fates | collapse / diverge | Goodhart-collapse / capability-divergence |
| The "42-state" | frozen self-agreeing null | the "reward-parrot": `Ĵ` saturated, `R_H` frozen/falling |
| Safety mechanism | external anchor (grounding) | external held-out anchor the model doesn't control |
| One-level-up failure | honesty theater (§7.2) | **holdout theater** (§8.4) |

The two-fate structure is Part I's dichotomy restated at the slow scale: *an update process that
optimizes only its own reward proxy has two **failure** fates and no happy third; the only escape is
a held-out external anchor* (corrected for exhaustiveness in §8.2).

### 8.0.1 The object

Fast: `ẋ = f(x,u,θ)` — Part I, certified at each frozen `θ`. Slow: `θ_{t+1} = U(θ_t)`, `U` = one
RLVR/distillation step. `Ĵ(θ)` = **proxy** reward (training verifier: exec pass / tests / format).
`H` = a **frozen external held-out** suite the model does not control; `R_H(θ)` = pass-rate on `H`
(true-objective estimate). `D(θ)=R*−R_H(θ)` = retention deficit; `G(θ)=Ĵ(θ)−R_H(θ)` = Goodhart gap.

### 8.1.1 The admissibility gate (three legs)

`θ→θ'=U(θ)` is **admissible** iff all hold: **(1) Retention non-regression** `R_H(θ')≥R_H(θ)−τ` —
rejects forgetting/correct-set-turnover by construction. **(2) Trust-region** `D_KL(π_θ‖π_θ')≤δ`,
cumulative `D_KL(π_base‖π_θ)≤Δ` — the mechanism behind RLVR's measured forgetting-robustness
(primary: RL's Razor, arXiv:2509.04259 — forgetting tracks KL-from-base; robustness is relative,
not absolute: arXiv:2607.04364).
**(3) Goodhart-gap non-growth** `G(θ')≤G(θ)+η` — if `Ĵ` rises but `R_H` doesn't, refuse. **Honest
weakness of leg 3 (review hit #2):** given leg 1 it is a capped proxy-inflation rule and **cannot
catch a hack that games `Ĵ` without *yet* moving `R_H`** — the latent hack. Leg 3 is a laggy
decorrelation warning, not a principled anti-Goodhart guarantee.

### 8.1.2 The fuller release gate — veto → improvement gate (convergent GPT synthesis, 2026-07-07)

The three legs are the minimal *safety* core: they can only **veto** a bad update (§8.2). A no-op
update passes all three — so as a **release** gate they are incomplete. The convergent synthesis
adds a positive-improvement requirement and two operational guards. A candidate `θ'` is **promoted**
(not merely admissible) iff:

1. **Fresh-task gain** — improves ≥ `γ` on *unseen* hidden execution tasks. *(New: this is what
   turns the veto into an improvement gate; legs 1–3 alone never require getting better.)*
2. **Retention** — historic verified suite drops ≤ `ε` (= leg 1).
3. **Reward integrity** — proxy `Ĵ` may rise only if the independent held-out score does not fall
   (= leg 3, stated as the promotion form).
4. **Drift budget** — `D_KL(π_prior‖π_θ')` **and adapter-norm** below limits (= leg 2, + norm cap).
5. **Fast-state stability** — Part I's collapse monitor shows no degeneration (Gate-0 early-abort).
6. **Data integrity** — no held-out contamination; full provenance on every training trace. *(New:
   the provenance/leakage guard §8.4 needs to hold.)*
7. **Rollback** — the prior adapter/checkpoint stays instantly redeployable. *(New: one bad run must
   never be permanent — this is what makes a *low-rate certified exception* actually safe.)*

Honest label: this is a **conditional release gate**: a checklist, not a theorem of safe
self-improvement. It inherits every soundness caveat in §8.3–§8.4; conditions 1, 6, and 7 are the
convergent additions. **IMPLEMENTED (2026-07-07, #2228):** all seven checks and the A/B/C decision
tree are implemented in `experiments/sigma_theta_abc/harness.py` and can be self-tested without a
GPU (`--self-test`; `tests/test_sigma_theta_gate.py`, 8/8, including planted-failure rejections).
Arm-C GRPO math landed in #2230. Implementation is not validation: this gate has not yet controlled
a real training run.

### 8.2 The fates, corrected (review hit #1)

The strong "exactly two fates" reading is **false as a partition** — an ungated update can also
jointly improve `Ĵ` and `R_H`, benignly plateau, or drift through bounded-KL policies. The honest
statement, matching how Part I treats *its* dichotomy: **collapse (Goodhart freeze) and divergence
(forgetting / KL runaway) are the two *failure* fates of a process optimizing only its proxy `Ĵ`.**
Real improvement is not a third fate — it is the *grounded* path, reachable only with an external
`R_H` in the loop. The gate cannot *guarantee* you land there; it can only **veto** updates provably
on a failure path *as measured against the anchor*. Certification is a veto, not a guarantee.

### 8.3 The guarantee — honestly labeled (gate, not certificate — review hit #4)

- **PROVEN backbone (imported).** Under the KL trust region, when the surrogate exceeds the
  worst-case KL penalty, the true return is monotonically non-decreasing:
  `J(π') ≥ L_π(π') − C·D_KL^max`, `C=4εγ/(1−γ)²` (Schulman et al., TRPO, arXiv:1502.05477). **[PROVEN
  — external]**
- **The overoptimization curve is known.** The held-out ("gold") score is an empirically-fit
  function of `D_KL(π_base‖π_θ)` (Gao, Schulman, Hilton, arXiv:2210.10760), so the budget `Δ` can be
  set where the fitted curve turns over. **[MEASURED — external]**
- **Single potential, but only trivially monotone.** Fold the legs into
  `Φ(θ)=D(θ)+λ·max(0,G(θ)−G₀)` with admissibility `Φ(θ')≤Φ(θ)`. This is ONE potential — but
  monotone **by imposition**, not proven monotone under the dynamics. A Lyapunov certificate proves
  a potential *must* decrease; here we *reject* anything that raises `Φ` and inherit all soundness
  from the anchor `R_H`. **So Σ_θ is a GATE, not a certificate.** **[HEURISTIC]**

### 8.4 The load-bearing open problem — holdout theater (review hit #3, the sharpest)

"**Iff `H` remains a valid external anchor**" is the crux, and the exact parallel of §7.2's honesty
theater. The reusable-holdout literature (Dwork et al., Science 349, 2015; arXiv:1411.2664: `n`
samples answer `B` adaptive scalar queries at error `~√(log B/n)`) does **not directly certify**
this high-leakage, model-level promotion process in its standard scalar-query form. A fixed
promotion set can leak through both acceptance and rejection feedback, creating a
sequential-selection problem. Two candidate safeguards are therefore: a flow of genuinely fresh
verified promotion tasks, or a formally managed reusable-holdout mechanism with explicit information
and overfitting budgets. The Thresholdout-style adaptation below is supported here by external
theory and a measured simulation; it is not a general proof for model-level promotion gating. This
is Part I's "grounding is the safety mechanism" with a rate attached — a real, harsh, falsifiable
design constraint.

**Second-review theory correction (2026-07-07): the "O(1)" wording was an overstatement in BOTH
directions, and Dwork cuts both ways.** (a) *Naive, feedback-rich* reuse overfits the holdout
[PROVEN]; but (b) **Thresholdout**-style controlled-information mechanisms validate **exponentially
many** adaptive queries so long as only `B ≈ τ²n` of them overfit [PROVEN — arXiv:1506.02629; CACM
2017]. So a *formally-managed* holdout can last far longer than naive reuse — the open quantity is
the budget for **uncontrolled** model-level promotion gating, which is where the measurement below
lands.

**[MEASURED 2026-07-07 — §8.6 simulation run, `experiments/sigma_update_holdout_staleness.py`,
32 seeds.]** The falsification harness (adaptive hill-climb whose only feedback is a holdout of size
`n`, fixed vs re-drawn per gate) both **refutes the strong form and confirms the operational one**:

- **REFUTED — the strong "O(1) gates regardless of size" claim.** A bigger fixed holdout *does* buy
  more usable gates; the true quality extractable before selection starts chasing noise grows with `n`
  (fixed-holdout true quality 0.57 → 59.0 as `n`: 50 → 5000). So the budget is **`n`-graded, not O(1)**.
- **CONFIRMED + QUANTIFIED — the fresh-flow law.** A fresh-per-gate holdout **strictly dominates** a
  fixed one at every `n`, and the penalty is **severe exactly in the slow-sourcing (small-`n`) regime
  Σ_θ lives in**: at `n=50` a fixed holdout extracts **22×** less true improvement than a fresh flow
  (0.57 vs 12.68); the gap only closes to <10% at `n ≥ 2000`. So sourcing fresh verified truth is
  worthless to skimp on precisely when it is scarce.

**Net:** the surviving requirement is **fresh flow > fixed set, with an `n`-graded (not O(1))
staleness penalty that is worst when sourcing is slow** — and, per the theory correction above, a
third road exists: a **formal reusable-holdout mechanism (Thresholdout-class)** whose
noise/threshold discipline stretches a fixed set with proven guarantees. [Naive-reuse decay:
MEASURED-by-simulation (shape, not a closed-form constant); Thresholdout reuse: PROVEN, external.]

**[MEASURED 2026-07-07 — the third road, same harness, third arm + pool ablation
(`experiments/sigma_update_holdout_staleness.py`, 32 seeds;
`data/sigma0/holdout_staleness_thresholdout_report.json`; regression
`tests/test_sigma_theta_thresholdout.py`, 7 tests).]** A Thresholdout wrapper (Dwork
arXiv:1506.02629 mapped onto this gate). Here `Lap(b)` denotes zero-mean Laplace noise of scale `b`.
Procedure per query: answer from a *burned* exploration pool unless the pool estimate and the fixed
verified holdout estimate disagree by more than `T + Lap(σ_H)`; in that case return the holdout
estimate plus fresh `Lap(σ_H)` noise and spend one unit of the overfit budget (`n/4` total).
Constants sit at the holdout-noise scale — shape is the claim, not the constants. The result
**decomposes the third road into two separate effects**:

- **VALIDITY — the mechanism's real win.** The champion's reported-vs-true gap stays below *both*
  other arms at every `n ≤ 2000`: at `n=50`, fixed 0.482 vs thresholdout **0.187** (fresh 0.194);
  at `n=200`, fixed 0.176 vs **0.048** (fresh 0.088). The gate's promotion evidence stays
  near-honest on a fixed verified set — fresh per-query noise breaks the sticky-luck ratchet.
- **EXTRACTION — bought by the burned pool, not the mechanism.** Ablation at pool=`n` (no
  accumulated data): extraction collapses to the naive fixed arm (0.74 vs 0.78 at `n=50`) — **the
  mechanism alone does not rescue extraction; the fresh-flow law holds.** But with an accumulated
  burned pool (4n — realistic, since retired promotion sets accumulate), the managed arm **beats
  the same-`n` fresh flow for `n ≥ 100`** (21.8 vs 18.0 at `n=100`; 36.4 vs 25.4 at `n=200`) while
  staying *more* honest than fresh.

**Design consequence (the compounding law):** after use, retire each promotion set into the burned
exploration pool and let a Thresholdout-style mechanism arbitrate pool-versus-holdout feedback. In
this simulation, accumulated verified examples improve extraction while the reported-versus-true gap
remains lower than the fresh-arm comparison through the measured range. Fresh sourcing still
rate-limits genuinely hidden promotion tasks; the result suggests that previously used verified
tasks can remain useful after retirement, rather than becoming worthless.

### 8.4.1 Why the anchor must be *re-drawn*, not merely external — intrinsic signals cannot substitute

**[MEASURED 2026-07-07 — pre-registered N1, `experiments/sigma_update_internal_signal_value.py`,
32 seeds, PR #2240.]** A tempting escape from the freshness requirement is a **free internal
signal** — perplexity, an entropy statistic, the Part I canary — combined with the fixed holdout to
stretch its budget. The pre-registered hypothesis (H1: such a signal extends the fixed-holdout
budget) was **falsified**, and the falsification sharpens the law:

- Combining the fixed holdout with an intrinsic signal of noise `s_i ∈ {2.0, 1.0, 0.5, 0.25}`
  extracts **no more true quality** than the holdout alone (verification-equivalent value
  ~1.0–1.2× across `n = 50–200`).
- **Robustness:** the null is not a combiner artifact — a direct weight sweep shows extraction is
  flat then strictly *worse* as weight shifts toward the internal signal (`n=50, s_i=0.5`:
  0.64 → 0.10 as `w_i`: 0 → 0.9).
- Even a **near-oracle** intrinsic signal (`s_i = 0.1`) reaches only 4.10 — far below a fresh
  holdout of the same size (12.68).

**Mechanism (why):** an intrinsic signal is a deterministic property of the checkpoint — measuring
the same checkpoint twice returns the same number — so **its error sticks with the champion exactly
like a fixed holdout's lucky draw**. It cannot re-anchor the selection ratchet; only a *re-drawn*
measurement can. **The refined law: freshness (re-drawability), not externality, is the active
ingredient of grounding.** This closes the tempting "cheap internal substitute" road and leaves
exactly the two §8.4 escapes standing: fresh verified flow, or formally managed (Thresholdout-class)
reuse. What intrinsic signals *are* measurably good for is **detection**, not selection — see the
§8.6 item 5 result. One sentence: **internal signals detect; only fresh truth selects.**
[MEASURED-by-simulation; shape, not a closed-form constant.]

**RE-STATED (2026-07-17, [#2692] E-P — the law's own pre-registered kill test fired).** The
paragraph above is correct for **deterministic** intrinsic signals but overstated as a general
law. `experiments/sigma_update_stochastic_signal.py` (pre-registered H-P1/H-P2, 32 seeds,
oracle-weight sweep per cell so no combiner alibi; `data/sigma0/stochastic_signal_report.json`;
regression `tests/test_sigma_update_stochastic_signal.py`, 6 passing) decomposed the internal
signal into a checkpoint-fixed **bias** `b` (sticks) and re-drawn **measurement noise** `m`
(re-rolls — self-consistency over seeds, MC-dropout, resampled prompts):

- **H-P1 CONFIRMED (mechanism):** at fixed total error, extraction rises steeply as error mass
  moves from stuck bias to re-drawn noise (n=50: 0.81 → 9.36; fixed-alone 0.61).
- **H-P2 REFUTED — the kill condition fired:** at *fixed* bias `s_b=0.5`, adding pure re-drawn
  noise rescued extraction **7.9×** (0.81 → 6.43). Re-drawn measurement noise is *not* inert.
- **Post-hoc attribution (labeled as such):** a **zero-information dither** — fresh noise added
  to every score comparison, carrying no signal whatsoever — reproduces the entire rescue
  (6.42 vs 6.43) with an interior optimum (too much dither hurts). So the rescue is pure
  **de-ratcheting**, not information: the same mechanism Thresholdout exploits deliberately
  with Laplace noise (§8.4 third road), arising for free from any stochastic measurement.
- **Fresh truth still strictly dominates** every internal arm (n=50 ordering: fresh-alone
  12.90 > zero-bias internal 9.36 > noise-rescued stuck bias 6.43 > deterministic 0.81 >
  fixed-alone 0.61).

**Conventional grounding (the mechanism is NOT novel — prior-art check 2026-07-17).** De-ratcheting
is textbook **stochastic acceptance / simulated annealing**: injecting randomness into a repeated
greedy selection lets a stuck incumbent be displaced so the search escapes premature convergence
(Metropolis et al. 1953; Kirkpatrick, Gelatt & Vecchi, *Optimization by Simulated Annealing*,
*Science* 220 (1983); Černý 1985). The **interior optimum** ("too much dither hurts") is that
literature's temperature optimum — too little noise never unsticks the champion, too much destroys
the ranking signal — and the same effect is why perturbed-SGD escapes sharp local minima (Ge et al.,
*Escaping From Saddle Points*, COLT 2015). The specific *noise-on-a-reused-holdout* form is exactly
**Thresholdout**'s differential-privacy mechanism (Dwork et al., §8.8), which adds Laplace noise for
*validity* (bounding overfitting). **What is measured here — not claimed as new mechanism — is (a)
the stuck-vs-fresh error decomposition and (b) that in the *checkpoint-promotion-under-holdout-reuse*
setting the same noise buys *extraction* (finding better checkpoints), not only validity.** That is a
connection between two established literatures (stochastic optimization + adaptive data analysis), not
a new law. Reasoning for the gap: our earlier one-line "only fresh truth selects" over-generalized by
omitting the annealing channel; the re-statement restores it and cites the standard mechanism.

**The law, re-stated:** selection error decomposes into a **stuck** part (sets the ratchet) and
a **fresh** part (breaks it). Deterministic internal signals neither de-ratchet nor inform;
stochastic internal signals **de-ratchet but do not inform**; only re-drawn external truth does
both. Three sentences now: *internal signals detect; fresh randomness de-ratchets; only fresh
truth informs.* Design consequence (cheap, actionable): a scarce fixed holdout should be read
**with deliberate dither** (or through a stochastic self-check) — in this harness that recovers
≈50% of the fresh-flow value at `n=50` — but dither is a de-ratcheting knob with an optimum,
never a substitute for sourcing fresh verified tasks. [MEASURED-by-simulation; shape, not
constants; the real-model arm folds into the A/B/C run, [#2691].]

**Operationalizing the fresh flow — the rotating-holdout tiers (convergent synthesis).** The
freshness law becomes concrete as a four-tier data discipline, so the anchor a gate promotes against
is never one it has already leaked into:

```
exploration set        → tune / select freely (assume burned)
private retention set   → limited-feedback regression check (rare reads)
fresh promotion set     → used ONCE per release, then retired
incoming verified tasks → continually replenish the promotion pool (the flow)
```

The release decision (§8.1.2) is made against the **fresh promotion set**, retired after use; the
sourcing rate of *incoming verified tasks* is the rate limit on safe updates. (Naïve repeated reuse
of one visible holdout overfits it — Dwork et al., arXiv:1506.02629, *Generalization in Adaptive
Data Analysis and Holdout Reuse*.) **Retired promotion sets are not dead:** they feed the
`exploration` tier, and in the third-road simulation a Thresholdout-arbitrated burned pool improved
extraction while the reported-versus-true gap stayed low — so the tiers form a cycle, not a
one-way conveyor. **[HEURISTIC operational design; the overfitting result it rests on is PROVEN;
the compounding effect is MEASURED-by-simulation.]**

### 8.5 What is and isn't claimed

**Claimed:** a computable three-leg gate anchored to an external holdout; a proven
monotonic-improvement backbone (TRPO); a known overoptimization curve for the budget (Gao);
evidence that naïve fixed-holdout reuse degrades under adaptive selection; that **deterministic**
intrinsic signals cannot substitute for fresh verified data in the *selection* role, while
**stochastic** intrinsic signals recover part of the budget purely by de-ratcheting — an effect
fully reproduced by zero-information dither, with fresh truth still strictly dominant (§8.4.1
as re-stated 2026-07-17, MEASURED-by-simulation, [#2692]);
and that an internal-signal bundle adds *detection* power for gross degradation exactly when the
external gate is smallest (§8.6 item 5, MEASURED on one model). **NOT claimed:** an in-repo theorem
for the full gate; real-model validation of its training behavior; that "two fates" is exhaustive
(§8.2); that scalar-query reusable-holdout guarantees automatically govern model-level promotion
(§8.4); that a single potential is proven monotone (§8.3); or that internal signals detect *subtle,
training-induced* badness — that cell is untested (§8.6 item 5). **The trap:** treating "passed the
holdout" as unconditional evidence — without the §8.4 freshness-or-controlled-reuse discipline, Σ_θ
is holdout theater, the same collapse it exists to prevent, one level up.

### 8.6 Minimal falsification path (before trusting any of this)

1. Implement `D`, `G`, and the KL trust region as a gate around one RLVR/distill step.
   **✅ GATE LOGIC DONE (2026-07-07, #2228):** the §8.1.2 seven-condition release gate + A/B/C
   decision tree are implemented and self-tested with no GPU in
   `experiments/sigma_theta_abc/harness.py` (`--self-test`; `tests/test_sigma_theta_gate.py`, 8/8) —
   planted reward-hack, forgetting regression, instability, and over-budget drift are each rejected,
   and the "none beat retrieval → stop updating weights" branch resolves. Arm-C's GRPO math is
   implemented + self-tested (#2230). *Still open: running the gate around a REAL RLVR/distill step
   (cloud L4) — gate logic ≠ gated training.*
2. **Reward-hacking teeth:** plant an update that games the verifier (`Ĵ↑`, `R_H↓`); confirm leg 1/3
   rejects where a Part-I-only (collapse) gate accepts. *(If Part I already caught it, Σ_θ is
   redundant — this is the whole point.)* **Gate-logic level: ✅ #2228 (planted hack rejected in
   self-test); real-model level: open, needs the L4 A/B/C run.**
3. **Forgetting teeth:** plant a held-out regression; confirm leg 1 rejects. **Gate-logic level:
   ✅ #2228; real-model level: open.**
4. **Budget teeth:** gate repeatedly against a fixed `H`; measure the true generalization gap growing
   as adaptive gates accumulate; confirm a fixed holdout goes stale, and characterize the rate.
   **✅ DONE (2026-07-07, `experiments/sigma_update_holdout_staleness.py`, 32 seeds):** a fresh-flow
   holdout **strictly dominates** a fixed one at every `n`, with a **severe small-`n` penalty (22× less
   true quality extracted at `n=50`), closing to <10% only at `n ≥ 2000`. This **refutes the strong
   "O(1) regardless of size"** wording (the budget is `n`-graded) while **confirming the operational
   fresh-flow law** — see the MEASURED block in §8.4. **✅ Thresholdout follow-up DONE (2026-07-07,
   third arm + pool ablation, same harness):** the mechanism buys **validity**, the burned pool buys
   **extraction**, and in this harness the mechanism supports safe reuse of the pool — see the
   third-road MEASURED block in §8.4 and `tests/test_sigma_theta_thresholdout.py`. **✅ PROTOCOL
   LAYER DONE (2026-07-17, [#2691]):** the three-arm promotion-evidence protocol itself — Fixed /
   Fixed+dither (the [#2692] knob, promoted to an arm) / Fresh-flow / Thresholdout+pool, with
   per-candidate provenance ledgers, Thresholdout budget accounting, and disjoint task-id spaces —
   is implemented model-agnostically (`experiments/sigma_theta_abc/holdout_protocol.py`, an
   `eval_fn` callback so the L4 run swaps in the real exec evaluator) and validated at **task-level
   Bernoulli-stuck fidelity** (per-(candidate,task) outcomes deterministic on re-evaluation — the
   real stuck-luck mechanism, closer to reality than the Gaussian sims): 7/7 protocol checks,
   16 seeds (`data/sigma0/holdout_protocol_report.json`;
   `tests/test_sigma_theta_holdout_protocol.py`, 6 passing). Orderings reproduce at the higher
   fidelity — fixed gap +0.108 worst / fresh extraction 0.934 best at 61× task consumption /
   Thresholdout best per-task efficiency among fresh-consuming arms — and one new result:
   **Fixed+dither reaches 0.856 true extraction at zero extra fresh-task cost** (vs fixed 0.617),
   the cheapest intervention measured. The planted teeth run through the *real* seven-condition
   gate with **arm-appropriate reasons**: the fixed arm can catch a contaminated reward-hack only
   via the cond-6 provenance ledger, while the fresh arm rejects it on measured merit (cond 1) —
   the load-bearing demonstration of why the freshness tiers exist. *(Steps 1–3 at real-model
   level still require the A/B/C run on cloud L4 — this box cannot train locally; that is the
   remaining empirical gap, unchanged: this validates the PROTOCOL, not real training. The L4
   run is now fully specified as a self-contained handoff —
   [SIGMA0-EB-L4-RUNBOOK.md](SIGMA0-EB-L4-RUNBOOK.md): inventory, task partition, the
   eval→7-metric glue contract, teeth recipes, pre-registered verdicts incl. the Roelofs rule,
   and a cost-approval gate.)*
5. **Incremental-validity teeth (the strongest genuine research question here):** does an internal
   signal **add detection power** for bad checkpoints over the external gate alone? No prior art
   surfaced for internal-state monitors as an *incremental* checkpoint-gate signal (bounded search,
   2026-07-07). **Correction (2026-07-17 corner audit): that "no prior art" line is now stale** —
   the detection lane is occupied: internal-state readouts predicting model quality without
   validation data (*Model-Centric Diagnostics*, arXiv:2601.16874), statistical detection of
   degraded/quantized checkpoints (arXiv:2602.10144), and a two-failure-mode account of LLM
   quantization matching the binary cliff measured below (arXiv:2604.19884). The *incremental*
   ΔAUC-over-a-tiny-external-gate design may remain unique; the lane is not. The follow-on
   falsification (stochastic-internal-signal test: re-drawable noise vs re-drawn truth) is
   tracked as [#2692]. **✅ MEASURED — corruption-regime half (2026-07-07, pre-registered N2,
   `experiments/sigma_incremental_validity_ouro.py`, real Ouro-1.4B, PR #2240):** a 9-checkpoint
   corruption-ladder generator (int8 / Gaussian noise 3–15% / partial+full naive ternary / int4)
   with exec pass rate as truth. Adding an internal bundle {perplexity, predictive entropy,
   distinct-2-gram} to a small-`n` exec gate: **ΔAUC +0.121 at n=2 → +0.068 at n=3 → +0.019 at
   n=5** (internal-alone AUC 0.944). So incremental validity is **real, gross-only, and
   scarcity-gated** — Gate B is *not* decorative, but its value decays quickly as the external gate
   grows, and it detects only gross degradation (all corruption-induced bads had ppl ratios
   ×629–×93,444). **The subtle cell came back empty by construction:** weight-space corruption is
   binary on this model — free (mild noise even *raised* weak-base greedy pass 0.25 → 0.62 with ppl
   flat, plausibly by breaking repetitive greedy loops; n=8 tasks, treat gently) or cliff-collapsed —
   matching the measured quantization cliff. So the **still-open half is subtle, training-induced
   badness** (reward hacks, forgetting): only the real A/B/C artifacts (teeth 2–3) can produce it.
   Caveats: one model, 8-task truth, coarse AUC granularity. Joint law with §8.4.1: **internal
   signals detect; only fresh truth selects** — *as re-stated 2026-07-17 ([#2692]): internal
   signals detect; fresh randomness de-ratchets; only fresh truth informs.*

### 8.7 Adversarial review (2026-07-07, grok-4) and what survives

Per the Σ₀ protocol (anchor a self-referential construction before trusting it), an outside theory
review attacked Σ_θ and landed four hits — three fatal to the strong version, all folded in above:
(1) "two fates" isn't exhaustive → §8.2; (2) leg 3 is weak/laggy → §8.1.1; (3) naïve, high-feedback
model gating can exhaust a fixed holdout, and scalar-query reusable-holdout results do not
automatically cover model-level promotion → §8.4; (4) it's a gate, not a certificate, no potential
proven monotone → §8.3. **What survives, and it is sharper than what walked in:** (i) the right
object is the θ-flow, not the x-Jacobian — Part I provably can't see hacking/forgetting; (ii) Σ_θ is
an honest **veto** with an imported partial guarantee; (iii) the surviving design constraint —
*non-Goodharting cannot be certified by **naïvely** reusing a fixed finite holdout; the slow-scale
anchor must either renew through fresh verified tasks or enforce controlled reuse under an explicit
information and leakage budget.* That is Part I's principle, one axis harder. **This is the protocol working: a critic turned an
overclaimed certificate into an honest gate plus one falsifiable design constraint — the intended outcome. A second review then corrected the constraint's own overstatement (the "O(1) gates" claim, §8.4) — the protocol applied to itself.**

### 8.8 Part II sources

- Schulman et al., *Trust Region Policy Optimization*, arXiv:1502.05477 (2015) — monotonic-improvement lower bound (Part II's PROVEN backbone).
- Gao, Schulman, Hilton, *Scaling Laws for Reward Model Overoptimization*, arXiv:2210.10760 (2023) — gold score as a function of KL-from-base (sets the budget `Δ`).
- Dwork, Feldman, Hardt, Pitassi, Reingold, Roth, *The reusable holdout*, Science 349 (2015); *Generalization in Adaptive Data Analysis and Holdout Reuse*, arXiv:1506.02629; arXiv:1411.2664 — both directions of §8.4: naive reuse overfits, **and** Thresholdout validates exponentially many queries at overfitting budget `B ≈ τ²n`.
- EvalStop (arXiv:2606.04145, 2026); Provably Mitigating Overoptimization (arXiv:2510.05526); Wasserstein-DRO RLHF (arXiv:2605.00155) — post-cutoff corroboration that gating on *world feedback / held-out eval* (not the proxy) is the live direction.
- **Primary SOTA for the RLVR-forgetting premise (added 2026-07-08 research pass; all ids title-verified against the local arXiv corpus):** *RL's Razor: Why Online RL Forgets Less* (arXiv:2509.04259 — on-policy updates are KL-minimal w.r.t. the base; forgetting is predicted by KL-from-base); *Reinforcement Fine-Tuning Naturally Mitigates Forgetting in Continual Post-Training* (arXiv:2507.05386); *Mechanistic origins of catastrophic forgetting: why RL preserves circuits better than SFT* (arXiv:2605.28860). **Counterpoint, same pass:** *RL Forgets! Towards Continual Policy Optimization* (arXiv:2607.04364 — RL still forgets in continual settings; drift control needed) and *The Choice of Divergence* (arXiv:2509.07430 — divergence choice governs diversity collapse). The gate assumes only the relative advantage, not immunity.
- Close prior art surfaced by the harder novelty search (2026-07-07, all corpus/web-verified): ADOWIP budgeted when-to-update gating (arXiv:2606.25068); Uncertainty-Guided Checkpoint Selection for RL finetuning (arXiv:2511.09864); *Signed Compression Progress on a Sealed Audit is Goodhart-Resistant* (arXiv:2606.11417) — nearest neighbor to the §8.4 sealed-promotion-set discipline; *Learning, Fast and Slow* (arXiv:2605.12484) — prior art for the fast/slow timescale framing itself.
- Added by the 2026-07-17 corner audit (both verified that date): **the Ladder** (Blum & Hardt, *The Ladder: A Reliable Leaderboard for Machine Learning Competitions*, arXiv:1502.04585) — adaptive leaderboard maintenance *is* champion-promotion gating with limited feedback, the §8.4 problem shape, and was missing here; and the standing **counterpoint** Roelofs et al., *A Meta-Analysis of Overfitting in Machine Learning* (NeurIPS 2019) — ~100 Kaggle competitions showed *little* adaptive overfitting in practice, so whether §8.4's severe small-`n` staleness materializes at realistic scale is exactly what the real A/B/C run must answer ([#2691]).

[#2691]: https://github.com/alex-place/lantern-os/issues/2691
[#2692]: https://github.com/alex-place/lantern-os/issues/2692
- Backing research: `data/research/reports/20260707T180737-rlvr-continual-learning-dreaming-stability-cert-weight-updates.md`; decision record [ADR-0025](adr/0025-rlvr-dreaming-continual-updates-double-gated.md).
- *Citations verified 2026-07-07 (TRPO/Gao IDs confirmed via search; Dwork by venue). Per this doc's own §References caution — an earlier draft once carried four fabricated arXiv IDs — no Part II id is cited unverified.*

---

# Part III — Two-timescale composition  [TARGET]

## 9. Composing Part I and Part II

RLVR runs many forward passes per gradient step, so `x` reaches quasi-equilibrium between weight
updates: the timescale ratio `ε = τ_x/τ_θ` is small. Under timescale separation (two-timescale
stochastic approximation — Borkar 1997; singular perturbation — Khalil, already cited by Part I at
Ex. 8.4), the fast and slow flows can be certified **separately and composed**:

> **The full self-improving system is certified iff (a) Part I holds on the fast `x`-flow at each
> frozen `θ`, AND (b) Part II's gate holds on the slow `θ`-flow, AND (c) `ε` is small enough that
> the quasi-equilibrium approximation is valid.** **[TARGET — the imported tools (Borkar, Khalil)
> are proven; this composition statement is NOT proven or machine-checked here.]**

This is why Σ₀ and Σ_θ are **two faces of one certificate over one object at two timescales**, not
two subsystems — the completion of Part I along the `θ`-axis it deferred in §0. Honest caveat: with
Part II only a gate (§8.3) and (c) unproven, the composition is a *design target*, not a theorem —
the whole system's safety still rests on the fresh-or-controlled-reuse external-anchor requirement
(§8.4), i.e. on grounding.

---

# Part IV — The active face: grounding as capability, not only safety  [DESIGN / TARGET — no theorem]

**Status: DESIGN / TARGET — no theorem, nothing machine-checked; authority *below Part II*.** The
mechanism is imported and established (Bayesian optimal experimental design — Lindley 1956; value of
information — Howard 1966; active inference — Friston 2010); **no novelty is claimed.** One
datapoint is MEASURED on a real surface (§10.1); everything else here is design. This Part is the
certificate's forward-pointer to the interface that operationalizes it —
[CONVERGENCE-ORACLE-DESIGN.md](CONVERGENCE-ORACLE-DESIGN.md) — so the theory and the interface
cannot drift apart.

## 10. From anti-collapse to ceiling-break

Parts I–III prove one thing at two timescales: **the only escape from collapse is grounding —
contact with something outside the loop.** Part IV draws a line *through* that result the passive
certificate never draws. There are **two grades of grounding**, and they clear two different walls.

**Passive grounding is reading** — retrieval, a held-out anchor, fresh-but-recorded data. It is
what Parts I–II require, and it clears the first wall: **collapse.** But it has a ceiling of its own,
the **ideal inductive predictor** (Solomonoff / AIXI), which extracts *everything inferable from a
fixed corpus and nothing more.* That ceiling is uncomputable **and unbeatable by inference** — a
system that claims to have out-thought it is the §2 "42-state" again, asserting structure its data
cannot support. Reading harder never breaks it.

**Active grounding is acting** — running the experiment, placing the bet, executing the test,
asking. An action **manufactures an observation that existed in no corpus**, so its result is *not
bounded by the inference ceiling.* This is the certificate's own logic taken one step further: if
grounding is what keeps the loop safe, then grounding you *generate* is safety **and** capability —
§8.4.1's de-ratcheting used to *create* the fresh draw instead of waiting for one.

So the arc closes: **don't degenerate** (Part I) → **don't promote a worse self** (Part II) →
**don't stop at what can be inferred** (Part IV). Passive grounding is the floor under collapse;
active grounding is the break in the ceiling above.

**One guard keeps this honest — and it is the whole point.** The ceiling breaks *exactly where an
action resolves it, and nowhere else.* Knowledge past the inference ceiling may be claimed **only
after reality has settled the action** — an unresolved prediction stays unverified, and a question
no action can reach stays a boundary pin. This is not licence to reach past the evidence; it is
§8.4.1's freshness law made active: *manufacture the fresh truth, then claim only what it confirmed.*
The document's founding lesson is the same rule — self-generated content is untrustworthy until an
outside check resolves it (the fabricated-arXiv confession that opens this file).

### 10.1 The freshness law, measured on code (2026-07-21)

§8.4.1 measures the freshness law in simulation. On 2026-07-21 the same law appeared on a live code
surface — the way the survivorship study (see the [AGI blueprint](AGI-CONVERGENCE-BLUEPRINT.md)) is
a real-market instance of the same discipline, not a new theorem:

The autowork patch-retry loop re-showed the model **its own failed diff** on each attempt. The model
anchored on that stale self-output — successive retries reproduced the *identical wrong context* and
failed identically, exactly the ratchet §8.4.1 predicts. **Withholding** the failed diff and feeding
only the real file (fresh external truth) flipped the stuck loop to success on the **first
de-anchored regeneration.**

**[MEASURED — one run, not a distribution. Evidence: `data/autowork-runs/2026-07-21.jsonl`,
PR #2795, fix in `routes/convergence-dispatch.js::targetedFileContext` ([#2762]). It corroborates
§8.4.1 on a real surface; it does not extend the proof. This is the least-proven Part of the
document — read it with §3.1's authority, never §1's.]**

---

## References (lineage)

- A. M. Lyapunov, *The General Problem of the Stability of Motion* (1892) — `V(x)` method.
- H. Poincaré, *Mémoire sur les courbes…* (1880s) — node/saddle/center/**focus** (spiral) classification.
- I. Bendixson (1901) — `Re λ(A) ≤ λ_max(A_s)`; the symmetric part bounds the real spectrum (used in §1.2).
- C. Wissel (1984); M. Scheffer et al., *Nature* (2009) — critical slowing down / early-warning signals.
- B. D. O. Anderson (1977), *Exponential stability of linear equations arising in adaptive identification*, IEEE TAC — persistent excitation / identifiability (invoked by analogy only in §3; canonical attribution, matching the `.tex`).
- J. Pathak et al. (2017–18) — reservoir reconstruction of attractors and Lyapunov spectra.
- W. Lohmiller & J.-J. E. Slotine (1998), *On Contraction Analysis for Nonlinear Systems*, Automatica 34(6):683–696 — matrix measure / logarithmic norm μ₂(A) = λ_max(A_s); the contraction bound used in §1–1.2. (The small-gain composition for the non-normal cross-term is classical — Zames 1966.)
- H. K. Khalil (2002), *Nonlinear Systems* (3rd ed.), Prentice Hall — Lyapunov stability foundations underpinning §1.
- **arXiv:2402.07043** (2024) — Dohmatob, Feng, Yang, Charton & Kempe, *A Tale of Tails: Model Collapse as a Change of Scaling Laws* (ICML 2024); synthetic data truncates the scaling law (§1.1, §7).
- **arXiv:2406.07515** (2024) — Feng, Dohmatob, Yang, Charton & Kempe, *Beyond Model Collapse: Scaling Up with Synthesized Data Requires Verification* (ICML 2024); verification prevents collapse — published analogue of external grounding (§7).
- J. Wolfers & E. Zitzewitz (2004), *Prediction Markets*, J. Economic Perspectives 18(2):107–126 — prediction-market accuracy; rationale for markets as an external grounding signal (Kalshi grounding, §6).
- I. Shumailov et al., *Nature* (2024) — model collapse under recursive training on synthetic data (§7).
- **2025–26 model-collapse corroboration (title-verified in local corpus, 2026-07-08):** arXiv:2509.16499 (*A Closer Look at Model Collapse: From a Generalization-to-Memorization Perspective*); arXiv:2509.04796 (*Knowledge Collapse in LLMs: fluency survives, facts fail under recursive synthetic training*); arXiv:2602.10531 (*From Collapse to Improvement: statistical perspectives on iterative training on contaminated sources*) — the phenomenon §7 warns about remains actively measured, and the escape routes match §7's verification/grounding mechanism.
- D. Amodei et al. (2016); J. Skalse et al. (2022) — reward hacking / specification gaming (§7).
- **arXiv:2211.15661** — Akyürek et al., *What learning algorithm is in-context learning?* — ICL realized as ridge/least-squares; the data-noise σ axis, σ=0 = exact regression (§7.1).
- **arXiv:2306.04637** — Bai et al., *Transformers as Statisticians* (NeurIPS 2023) — provable in-context algorithm selection vs. noise level σ (§7.1).
- **arXiv:2404.00781** — Elsayed & Mahmood, *Addressing Loss of Plasticity and Catastrophic Forgetting in Continual Learning* (UPGD) — the weight-perturbation σ; σ=0 = frozen / no plasticity (§7.1).
- **arXiv:2503.01595** — *STAR: Stability-Inducing Weight Perturbation for Continual Learning* — worst-case weight perturbation for stability (§7.1).
- **arXiv:2509.22764** — Kang et al., *In-Context Learning can Perform Continual Learning Like Humans* — continual learning in-context (zero parameter updates), beats gradient-based CL; the `σ_weights=0` escape (§7.1).
- **Self-supervised anti-collapse regularization — the distributional counterpart to §1's spectral bound.** The SSL literature fights *representation collapse* (the §0/§2 "frozen self-agreement" fate) not by bounding a Jacobian but by **conditioning the embedding covariance**: VICReg (Bardes et al., [arXiv:2105.04906](https://arxiv.org/abs/2105.04906)) variance/covariance terms; Barlow Twins ([arXiv:2103.03230](https://arxiv.org/abs/2103.03230)) redundancy reduction; W-MSE ([arXiv:2007.06346](https://arxiv.org/abs/2007.06346)) whitening; and most sharply **SIGReg/LeJEPA** (Balestriero & LeCun, [arXiv:2511.08544](https://arxiv.org/abs/2511.08544)) — regularize toward an **isotropic Gaussian**, heuristics-free. These are a *complementary* anti-collapse condition on the same object: §1 bounds the recurrent map's spectrum (the map can't amplify), while covariance-conditioning keeps the state distribution full-rank (the representation can't degenerate). Falsifiable import for the Ouro latent loop: does a covariance-conditioning term reduce measured collapse proximity (§4 canary, §6) without harming golden/confab? Verified 2026-07-06; folded into [`RESEARCH-CANON.md`](RESEARCH-CANON.md) [11].
- **arXiv:2310.01798** — Huang, Chen, Mishra, Zheng, Yu, Song & Zhou, *Large Language Models Cannot Self-Correct Reasoning Yet* (ICLR 2024) — the **inference-time twin** of §7's collapse claim: intrinsic self-correction *without external feedback* degrades reasoning (GPT-4 95.5→91.5 on GSM8K). The model-collapse citations above are the *training-time* version of the same "no contact with outside reality → degradation" mechanism; this is the same law one timescale down, and the escape (external feedback) matches §7's grounding. Title/authors/venue verified against arXiv 2026-07-07.
- **arXiv:2406.15927** — Kossen et al., *Semantic Entropy Probes: Robust and Cheap Hallucination Detection in LLMs* (2024) — a **linear probe on a single generation's hidden state** predicting semantic entropy; nearest prior for §7.3's confabulation-detection honesty layer. The §7.2 rule "bind every honesty signal to an external check" is the product-form guard around exactly this internal signal. Verified against arXiv 2026-07-07.
- W. P. M. H. Heemels, K. H. Johansson & P. Tabuada, *An Introduction to Event-triggered and Self-triggered Control*, IEEE CDC 2012; **arXiv:1803.08980** — Lyapunov event-triggered stabilization with a known convergence rate. The mature prior-art field for §3.1's schedule consequence (intervention timing from a certified decay rate). Verified 2026-07-17.
- R. Kulhavý & M. Kárný (1984), directional forgetting in recursive identification; **arXiv:2003.03523** — *RLS with Variable-Direction Forgetting*; **arXiv:2404.10844** — *SIFt-RLS: Subspace of Information Forgetting RLS*. Classical kin of Σ₀⁻¹'s covariance leg (§3). Verified 2026-07-17.
- **arXiv:2604.09979** — *A Minimal Model of Representation Collapse* (2026) — dynamical-systems analysis of representation collapse in SSL (stop-gradient / frustration); adjacent, uncited-until-now prior for Part I's framing. Verified 2026-07-17.
- **Conventional grounding added 2026-07-18 (classic, venue-verifiable — no arXiv):** N. Metropolis, A. Rosenbluth, M. Rosenbluth, A. Teller & E. Teller (1953), *Equation of State Calculations by Fast Computing Machines*, J. Chem. Phys. 21; **S. Kirkpatrick, C. D. Gelatt & M. P. Vecchi (1983), *Optimization by Simulated Annealing*, Science 220:671–680**; V. Černý (1985), J. Optim. Theory Appl. 45 — the stochastic-acceptance / simulated-annealing mechanism that §8.4.1's *de-ratcheting* rediscovers (noise unsticks a stuck incumbent; the "interior optimum" is the temperature optimum). R. Ge, F. Huang, C. Jin & Y. Yuan (2015), *Escaping From Saddle Points*, COLT — the same noise-escapes-stuck-states effect in optimization.
- **T. Kailath (1980), *Linear Systems*, Prentice Hall; E. D. Sontag (1998), *Mathematical Control Theory* (2nd ed.), Springer; F. Blanchini & S. Miani (2015), *Set-Theoretic Methods in Control*, Birkhäuser** — the bounded-input reachable-set / invariant-set theory that §3.1's commitment inequality is a corollary of (reachable set of a Schur-stable system under bounded input, measured in a Lyapunov metric). Standard textbook material; no novel dynamical-systems result is claimed.
- **D. V. Lindley (1956), *On a Measure of the Information Provided by an Experiment*, Ann. Math. Statist. 27:986–1005; R. A. Howard (1966), *Information Value Theory*, IEEE Trans. SSC 2(1):22–26; K. Friston (2010), *The free-energy principle: a unified brain theory?*, Nat. Rev. Neurosci. 11:127–138** — Bayesian optimal experimental design, value of information, and active inference: the established "act to reduce uncertainty" mechanism imported by Part IV's active face (§10). Classic, venue-verifiable; no novel result claimed.

*Web citations above were **verified against arXiv on 2026-06-17** (issue [#660]).
An earlier draft, written with the search backend down, carried four fabricated
arXiv IDs — 2406.07284, 2402.07827, 2309.07864, 2309.01219 — none of which matched
their claimed titles. They have been replaced with verified sources (the model-
collapse work is now Dohmatob et al. 2402.07043 and Feng et al. 2406.07515; the
contraction math is attributed to Lohmiller & Slotine 1998 and Khalil 2002).*

---

## Appendix A: Router Demonstration Design (original sketch)

> **ℹ HISTORICAL.** This appendix preserves the *original* design sketch and its
> hand-entered numbers for provenance. In plain words: this section is just the first guess we wrote down before running the real test — its numbers were never confirmed by data (see §6 for what actually happened). The demonstration is now implemented and
> reproducible — see §6 for the produced results. The "parrot attractor" numbers
> below were the pre-implementation hypothesis and were **not** confirmed by the
> real run (the data settles at high-novelty / low-echo instead).

### Original Design

The intended demonstration would run the Σ₀ machinery on the unisona.ai
conversation log (`data/conversations/garage-conversations.jsonl`), encoding
each turn as

$$x = [\text{novelty},\ \text{self\_repeat},\ \text{echo},\ \text{length}] \in [0,1]^4.$$

Two scripts were specified (but never committed):

- **`experiments/router_sigma0_encoder.py`** (MISSING) — would fit a local
  Jacobian per session, emit the spiral/canary/wall readouts, and build `π` and
  `P_ij`.
- **`experiments/router_reservoir_G.py`** (MISSING) — would train an echo-state
  network into one global flow that runs autonomously, *becoming* `G`, feeding
  its reconstructed fixed points back to the same Σ₀ certificate.

### Intended Result (Unverified)

The narrative result was that the log's dynamics collapse onto a **"parrot
attractor"** (`novelty ≈ 1, echo ≈ 0.72`) — a flow whose only fixed point is
"quote the prompt back," i.e. model collapse. **Because the generating scripts
do not exist, these numbers have no produced artifact and must be regarded as
hand-entered, not data-derived.**

### Honest Caveats

1. **(Resolved.)** The two driver scripts are now committed and §6 reports a
   logged run; the hand-entered numbers in this appendix are superseded by the
   produced ones.
2. Even if the scripts existed, the source log is mostly synthetic test traffic,
   so any numbers would be illustrative — the deliverable would be the pipeline,
   not the values.
3. A reservoir's autonomous rollout diverges unless projected back onto the
   valid `[0,1]⁴` domain; that projection *is* `π`. This is a real modeling step,
   but it is also an external bound imposed by hand, not an emergent property.
4. **(Resolved — 2026-06-17, [#661].)** A first version of this appendix claimed a
   "log-barrier" smoothed the boundary. What actually shipped in `_collapse_state`
   was **not** a log-barrier: it was a multiplicative shrink of the projection,
   `x* = (P x)·(1 − barrier)` with `barrier = −s·log(1 − ‖Px‖/‖x‖)`, which for
   `s > 1/ln(100) ≈ 0.217` went negative and flipped the sign of the collapsed
   state — the opposite of collapse. **Fix:** the term is dropped. Collapse is now
   the orthogonal projection `x* = P x` with `P = V Vᵀ`; because `P` is idempotent
   and symmetric it is non-expansive (`‖P x‖ ≤ ‖x‖`) and smooth, so there is no
   boundary to enforce and no penalty term is needed. The original concern is moot.
   (The logarithmic-norm reformulation μ₂(A) = λ_max(A_s) of the *certificate's*
   small-gain bound remains a separate, optional tightening — not required for the
   projection to be correct.)

### Status: Implemented

Done: `experiments/router_sigma0_encoder.py` and `experiments/router_reservoir_G.py`
are committed and produce `data/sigma0/router-encoder-output.jsonl` and
`data/sigma0/reservoir-G-output.jsonl`. The §6 numbers are the produced output;
the hand-entered claims in this appendix are kept only for provenance.

---

*Source of record: `src/cio_sde/collapse.py` (Theorem 1, Σ₀, Σ₀⁻¹);
`tests/test_cio_sde.py` (46 passing, 0 xfail) + `tests/test_sigma0_roa_certified.py` (4 passing —
the [#1991] machine-checked ROA certificate, `experiments/sigma0_roa_certify.py`); framework `docs/sigma0-collapse-certificate.tex`.
The router demonstration scripts `experiments/router_sigma0_encoder.py` and
`experiments/router_reservoir_G.py` are **committed and reproducible** — see §6
for produced results and Appendix A for the original design sketch.*

---

## Appendix M — Provenance: maintenance log & closed-gap history

> Moved here from the document head on 2026-07-07 for readability. Unedited, chronological.
> This is the anti-drift record: each entry is an external-reality reconcile pass (fresh test
> runs, artifact checks) or a dated closure. The document's claims are only as current as the
> latest entry that verified them.

> **Maintenance log — 2026-06-16.** This status pass reconciles the doc with the
> repo after a sprint day that landed **zero** commits to `src/cio_sde/`,
> `experiments/router_*`, or this certificate (the day went to the Kingdome game
> engine, dashboard 1.6, and the Σ₀ *application* modes — product, not the math).
> Because the research lane was skipped, the gap block below had silently gone
> stale: the [#509] !convergance epic (five priority research gaps) closed on
> 2026-06-15, along with [#505], [#506], [#507], [#516], [#517], [#520], [#523],
> and [#508] — yet none of those closures were reflected here. The `Optional`
> import defect (§3) is genuinely fixed and is now recorded. **Correction
> (2026-06-16):** a first version of this pass also marked the Appendix A
> "log-barrier" resolved — that was an overclaim caught in external review. What
> shipped was a misnamed multiplicative shrink with a sign-flip footgun, not a barrier.
> **Resolved (2026-06-17, [#661]):** the spurious term was dropped — `_collapse_state`
> now returns the clean orthogonal projection `x* = P x`, which is non-expansive
> (`‖P x‖ ≤ ‖x‖`) and smooth, so no boundary penalty is needed. The remaining
> work is re-tracked as live issues so this doc cannot drift again ([#657]–[#660]).
>
> **Maintenance log — 2026-06-19.** Reconcile pass after [#657], [#658], [#659]
> landed (verified against the repo: `pytest tests/test_cio_sde.py` → **30 passed,
> 0 xfail**; `data/sigma0_regime_sweep_report.json` → 900 collapse-prone trials,
> 100% prevented). The per-section status lines, the top status, and the footer had
> drifted behind these closures (still reading "29 passing, 1 xfail" and "§3 N=1
> HEURISTIC"); they are now aligned with ground truth. A plain-language summary was
> added at the top for non-specialist readers. The sole remaining frontier is a
> §3 sufficiency *theorem*.
>
> **Maintenance log — 2026-06-21.** External-reality verification pass against the
> repo: `pytest tests/test_cio_sde.py` → **33 passed, 0 xfail** (was 30 — three
> tests added since, all green); `data/sigma0_regime_sweep_report.json` →
> `collapse_prone_trials_total=900`, `headline_conditional_prevention_rate=1.0`;
> and the cited symbols (`collapse_certificate`, `AntiCollapseOperator`,
> `SurpriseMonitor`, `stability_gates`) all present in source. Reconciled the test
> count 30 → 33 in the live status lines (dated logs keep their period counts); every other claim verified to hold. Frontier unchanged
> (§3 sufficiency theorem, [#768]).
>
> **Maintenance log — 2026-06-21 (σ=0 grounding).** Added §7.1 wiring Σ₀ collapse to the
> established ML **σ=0 (zero-noise)** convention, grounded in five citations whose titles +
> arXiv IDs were verified via search (ICL data-noise σ: arXiv:2211.15661, 2306.04637;
> continual-learning weight-perturbation σ: arXiv:2404.00781, 2503.01595; in-context CL:
> arXiv:2509.22764). Backed by a new test — `test_sigma_zero_freezes_sigma_positive_explores`
> isolates the σ-axis (σ=0 freezes, σ>0 explores); suite now **34 passed, 0 xfail**.
>
> **Maintenance log — 2026-06-25 (§3 closed for normal A).** The §3 sufficiency claim is
> now PROVEN for **normal `A`** — [Theorem C3](SIGMA0-C3-NONCOLLAPSE-NORMAL.md), chaining
> `L1(normal) ∧ L2 ∧ L3 ∧ L4 ∧ L5 ⇒ P(permanent freeze) = 0`. Closing it surfaced (and
> fixed) two real defects in the shipped `AntiCollapseOperator`: (1) the bump magnitude
> `strength·p` was **scale-blind** while L2's threshold `Δ ∝ μ` — fixed with a μ-aware
> covariance floor (`_cov_floor`); (2) the hard `|λ|<eig_eps` aim could inject a
> **zero-rank** bump (G13) or, in full degeneracy, **all `d` modes** (a uniform shift that
> *lowers* anisotropy — the L2 `k=d` boundary) — fixed with banded near-null aiming clamped
> to `1 ≤ m ≤ d−1` (`_near_null_basis`). Machine-checked: 4 new tests
> (`test_c3_no_consecutive_freeze`, `test_l4_floor_lifts_anisotropy`,
> `test_l4_floor_scale_equivariant`, `test_g13_no_zero_rank_bump`) + the sweep
> `experiments/prove_c3_noncollapse.py` (3000 configs, 0 counterexamples, old bump fails
> 100%). Non-normal `A` remains the lone frontier ([#768]). *Honest caveat:* 8 pre-existing
> `test_cio_sde.py` failures (orphaned by the #1138 observe-only intervention default +
> surprise-canary tuning) are unrelated to this change and untouched by it.
>
> **Maintenance log — 2026-06-26 (§3 closed for ALL `A`; the 8 orphans fixed).** Two
> things landed. **(1) Non-normal freeze closed.** The §3 sufficiency claim now holds for
> **non-normal `A` too**: the alignment hypothesis L1 — the one place the normal-A proof
> used normality — was unnecessary. L2's operative bound `σ⁺ ≥ √(m(d−m))/d·b − aμ` holds
> for *any* rank-`m` orthogonal projector via the Frobenius reverse-triangle inequality
> (at `cond_flat`, Σ≈μI, so the misalignment penalty `≤ aμ√(m(d−m))` is bounded by the
> very `a(Σ)<ε_a` the gate asserts). Verified: `experiments/prove_c3_noncollapse_nonnormal.py`
> (4000 genuinely non-normal configs incl. the adversarial worst-case alignment, 0 lift
> failures) + `tests/test_cio_sde.py::test_c3_nonnormal_covariance_lift`. The C3 doc gains a
> §7 (L2′) and the L2 doc gains the alignment-free strengthening. **The contraction half**
> (Theorem 1's drift for non-normal `A`, the §1 cross-term — a different claim) was the last
> gap; it was **closed later the same day** via the spectral dichotomy (see the Closed block
> above and [SIGMA0-T1-NONNORMAL-DICHOTOMY.md](SIGMA0-T1-NONNORMAL-DICHOTOMY.md)), so **all of
> [#768] is now closed in-regime.** **(2) The 8 orphan
> failures fixed.** They were tests of collapse-machinery *behavior* (freeze, projection,
> NIS-canary-on-snap) running under the #1138 observe-only default, which suppresses the
> action they assert. Fixed by a `_acting(m)` test helper that opts each into
> `InterventionPolicy(observe_only=False)` — the regime they actually test — not by
> weakening assertions. `pytest tests/test_cio_sde.py` → **39 passed, 0 failed** (was
> 30 passed / 8 failed). "Machine-checked" here means closed-form algebra + sweep + pytest,
> **not** a Lean/Mathlib formal proof.
>
> **Maintenance log — 2026-06-29 (external-reality reconcile).** Verification pass against the
> repo, no claims changed: `pytest tests/test_cio_sde.py` → **42 passed, 0 xfail** (matches
> every live status line); `data/sigma0_regime_sweep_report.json` →
> `collapse_prone_trials_total=900`, `headline_conditional_prevention_rate=1.0`; and the cited
> symbols all resolve — `collapse_certificate`, `AntiCollapseOperator`, `stability_gates`,
> `dichotomy_certificate` in `src/cio_sde/collapse.py`, `SurpriseMonitor` in
> `src/cio_sde/surprise.py`. Nothing had drifted since the 2026-06-26 closures (both halves of
> [#768] remain closed in-regime; §3 PROVEN for all `A`). Frontmatter `updated:` bumped
> 2026-06-20 → 2026-06-29 to reflect this check; no frontier changes.
>
> **Maintenance log — 2026-07-04 (external-reality reconcile).** Verification pass against the
> repo; **no claims changed**. Fresh run this pass, not only the committed report:
> `pytest tests/test_cio_sde.py` → **42 passed, 0 xfail** (30.8s), and the §2/§3/§7.1
> proof-regression tests are among the 42 and green — `test_c3_no_consecutive_freeze`,
> `test_l4_floor_lifts_anisotropy`, `test_g13_no_zero_rank_bump`,
> `test_c3_nonnormal_covariance_lift` (C3 for all `A`), `test_collapse_is_nonexpansive_projection`
> (§2 / [#661]), and `test_sigma_zero_freezes_sigma_positive_explores` (§7.1 σ-axis) — so the
> load-bearing claims carry a live green run, not just a checked-in artifact.
> `data/sigma0_regime_sweep_report.json` → `collapse_prone_trials_total=900`,
> `headline_conditional_prevention_rate=1.0` (unchanged). Every cited cross-reference resolves:
> `collapse_certificate` / `stability_gates` / `dichotomy_certificate` / `lyapunov_value` /
> `AntiCollapseOperator` / `SemanticCollapseOperator` in `src/cio_sde/collapse.py`,
> `SurpriseMonitor` + `CovarianceField` in `src/cio_sde/surprise.py` (also `engine.py`), the four
> sibling proofs (T1-dichotomy, C3, L2, anti-collapse-hardening), all six `experiments/` drivers,
> and both `data/sigma0/*.jsonl` outputs. **Provenance check (new this pass):** `git log` shows the
> last commit touching this certificate *is* the 2026-06-29 reconcile itself (`34deba2f`, #1574) and
> the last `src/cio_sde/` change is #768's non-normal-contraction close on 2026-06-26 (`6b446b90`) —
> no commit since the last pass touched the source, tests, or this doc, so the match is structural,
> not coincidental. Both halves of [#768] remain closed in-regime; §3 PROVEN for all `A`. Frontmatter
> `updated:` bumped 2026-06-29 → 2026-07-04; no frontier changes.
>
> **Maintenance log — 2026-07-04 (frontier work: discrete-time certificate landed).**
> Beyond the reconcile above, this pass **opened four tracked frontiers and closed one**.
> Reviewing the proof↔evidence surface surfaced two concrete gaps: (a) every theorem is
> **continuous-time** (`e^{tA}`, `solve_continuous_lyapunov`, split by `Re λ`), yet §6's
> own evidence is **discrete-time** (spectral radius `ρ≈1.064`) — the theorem did not
> certify the quantity the demonstration measures; (b) the dichotomy's eig-based Riesz
> split **abstains on defective `A`** (Jordan blocks — `inv(V)` ill-conditioned). Filed as
> [#1988] (discrete-time dichotomy), [#1989] (defective-`A` via ordered Schur), [#1990]
> (the §2 trigger→theorem gap — the unproven *entry* condition to the whole chain), and
> [#1991] (local→global region-of-attraction). **[#1988] landed this pass:**
> `discrete_dichotomy_certificate` + `DiscreteDichotomyCertificate` (`src/cio_sde/collapse.py`)
> split `A` at `|z|=1−δ` via an **ordered real Schur** factorization (defective-safe, no
> eigenvector inverse), certify the active block with the **discrete Lyapunov/Stein** metric
> `AᴹᵀPAᴹ−P=−I` (`P⪰I` ⇒ per-step decay `√(1−1/λ_max(P))`, transient `√cond(P)`),
> lower-bound the **discrete Kreiss** constant, and decide the fate by the slow block's
> spectral radius `ρ_N` (>1 DIVERGE, <1 COLLAPSE, ≈1 MARGINAL — no third fate). For normal
> `A` it reduces to `ρ(A)<1 ⟺ collapse`; discretizing a continuous flow as `e^{A·dt}`
> preserves the fate (parity test). On a defective Jordan block the Schur split residual is
> machine-zero where the continuous eig path abstains. Machine-checked by three new tests
> (`test_discrete_dichotomy_radius_trichotomy`, `…_matches_continuous_under_exponential`,
> `…_defective_split_is_invariant`); suite **42 → 45 passing, 0 xfail**. Same evidence class
> as the continuous dichotomy — **PROVEN in-regime** (local linear Jacobian, discrete),
> "machine-checked" = closed-form algebra + tests, **not** Lean.
>
> **[#1989] landed too (same PR).** The *continuous* `dichotomy_certificate` was retrofitted to
> the same ordered-Schur split, so it now certifies **defective `A`** — a Jordan(−0.5,3) ⊕ [+0.3]
> rotated off-axis is split with residual `< 1e-9` and correctly classified DIVERGE, where the old
> eig + oblique-Riesz path (`inv(V)` on degenerate eigenvectors) was ill-conditioned. Suite **45 →
> 46 passing** (+`test_dichotomy_continuous_defective_via_schur`); the existing T1 tests are
> unchanged because the certificate's rate/transient are basis-independent (Schur vs eig agree on
> diagonalizable `A`). [#1990] (trigger→theorem) and [#1991] (local→global ROA) then advanced
> with MEASURED evidence — see the next log.
>
> **Maintenance log — 2026-07-04 (honesty red-team + frontier measurements #1990 / #1991).**
> Three things landed. **(1) Honesty hardening.** A new §7.2 red-teams the certificate's *own*
> honesty protocol — how a model games the evidence-class labels / citations / "verified" claims
> (honesty theater = §7's collapse one level up), and the single defense (bind every honesty
> signal to an external check the model can't control). **(2) [#1990] trigger — HEURISTIC →
> MEASURED.** `experiments/sigma0_trigger_calibration.py` (960 samples;
> `data/sigma0/trigger_calibration_report.json`) scores the four-signal trigger against the
> *spectral* ground truth: **precision 1.0** (0 false-fires over 720 off-regime samples — the §2
> forward assumption *trigger ⇒ collapse-regime* holds on this distribution) but **snapshot recall
> ≈ 0.08** (a sound but conservative, *late* detector); the `rank` signal carries the
> discrimination. Explicitly **not** upgraded to a theorem. **(3) [#1991] ROA first cut.**
> `experiments/sigma0_roa_estimate.py` (`data/sigma0/roa_estimate_report.json`) certifies a
> nonlinear basin `{V ≤ 2.31}` via a quadratic Lyapunov function, with **100% inside-convergence**
> validated on the reversed-Van-der-Pol benchmark (Khalil Ex. 8.4). Sublevel-invariance is PROVEN
> (Lyapunov/LaSalle); `c*` is MEASURED. Neither frontier is *closed* — #1990 is
> calibrated-not-proven, #1991 is a validated *method* / first cut — but both moved from open to
> MEASURED. Suite unchanged at **46 passing** (these are experiment artifacts, not new unit tests).
>
> **Maintenance log — 2026-07-04 (honesty layer measured; §7.3 added).** The §7.2 red-team gains an
> empirical companion, §7.3 — the defenses it names are now reproducible, machine-checked code: a
> grounded five-councilor Σ₀ council (`experiments/sigma0_council.py`) that upholds grounded claims
> by running their tests and **rejects a planted "0.99 SimpleQA SOTA" claim**; a strictly-proper
> honesty objective (incentive-compat gap **0.0000**); a **159-record golden answer-key**
> (`data/sigma0/golden_dataset.jsonl`, 26.4% honest negatives, anti-inflation machine-checked); and
> a **live benchmark** where **GPT-4o-mini confabulated on 0/42 negatives** (golden 0.95) while
> `always-assert` confabulates 100% at a *higher* raw score — confabulation-rate is the honesty
> axis, measured. Verification this pass: `pytest tests/test_cio_sde.py` → **46 passing**; the four
> artifacts resolve (`golden_dataset.jsonl` 159, `live_bench_results.json`,
> `trigger_calibration_report.json`, `roa_estimate_report.json`). No cert *theorem* changed this pass.
>
> **Maintenance log — 2026-07-04 (merge reconciliation + re-verification).** [#1997] **merged**, so
> everything the logs above describe — §7.2/§7.3, the [#1990]/[#1991] measurements, the four honesty
> artifacts — is now in `master` (this doc is read from `master`, no longer "staged on an open PR").
> Re-verified this pass: `pytest tests/test_cio_sde.py` → **46 passed, 0 xfail** (38.9 s); all eleven
> referenced artifacts resolve (the three `experiments/sigma0_*` calibration/ROA/council scripts +
> `trigger_calibration_report.json`, `roa_estimate_report.json`, `golden_dataset.jsonl` [159 records],
> `live_bench_results.json`, both `router_*` scripts, `collapse.py`, the `.tex`), and the §6 encoder
> `ρ=1.064` figure now carries its control-check (a fitting artifact — see §6). The two frontiers stay
> **honestly open**, unchanged: **[#1990]** trigger→theorem is calibrated-not-proven (precision 1.0,
> recall ≈0.08 over 960 samples), **[#1991]** local→global ROA is a validated first cut
> (sublevel-invariance PROVEN via LaSalle; `c*` MEASURED, not certified). Nothing was fabricated to
> force a closure; upgrading either to PROVEN needs a machine-checked theorem this pass does not claim.
>
> **Maintenance log — 2026-07-04 (#1991 ROA certification: MEASURED → PROVEN).** The step the entry
> above deferred is now done: the grid-measured basin `c*≈2.307` is a **machine-checked** inner region
> of attraction. `experiments/sigma0_roa_certify.py` proves `V̇ < 0` on `{V ≤ 2.25}` via an exact
> origin-ball lemma (`|N| ≤ 3‖x‖⁴`) plus rigorous **interval branch-and-bound** (`mpmath.iv`,
> directed rounding — **2323 boxes, 0 undecided**), with a control at `c_L = 2.5` (above `c*`) correctly
> **failing** to certify (teeth). So `{V ≤ 2.25}` is **PROVEN** (97.5% of the grid optimum; the last
> ~2.5% is interval overestimation near the tangency, not a rigor gap). New
> `tests/test_sigma0_roa_certified.py` (4 tests, `data/sigma0/roa_certified_report.json`) ⇒ **50 cert
> tests** (46 `test_cio_sde` + 4). §5 updated. This closes the *certification* half of [#1991] for the
> benchmark `f`; **[#1990]** (trigger→theorem) stays honestly open — a heuristic min-gate does not
> obviously imply the spectral condition, and may not be provable in general.
>
> **Maintenance log — 2026-07-07 (external-novelty audit — nearest-prior for Part I).** A
> reviewer-style "what do you add over the nearest paper" pass on Part I's *inference-time* claim
> (Part II's Σ_θ novelty search already landed 2026-07-07 — see §8's close-prior-art bullet). Two
> verified nearest-prior citations were missing and are now in References (lineage): **Huang et al.,
> ICLR 2024 (arXiv:2310.01798)** — intrinsic self-correction *without external feedback* degrades
> reasoning — the inference-time twin of §7's collapse-without-grounding claim (its *training-time*
> twin, Feng/Dohmatob, was already cited); and **Semantic Entropy Probes (Kossen et al.,
> arXiv:2406.15927)** as the nearest prior for §7.3's honesty probe. Both IDs verified against arXiv
> this pass (title/authors/venue), per this doc's no-unverified-ID rule. **Honest positioning, stated
> plainly so it cannot be laundered: the certificate claims no novel *mechanism*.** "Ungrounded
> self-reference degrades; external verification is the escape" is established prior art (Huang 2024 at
> inference; Feng 2024 / Shumailov 2024 at training). The certificate's actual contribution is (a) a
> **machine-checked in-repo formalization** of that result as a computable stability certificate
> (Theorems 1 / C3, the discrete + defective-`A` dichotomies — **50 passing tests**) and (b) **honest
> negative results** (e.g. §8.4's strong O(1) fresh-flow law **REFUTED → `n`-graded**). Framed as
> *novel AI* the nearest-paper question sinks it; framed as *disciplined formalization + honest
> measurement* it stands — which is what §7.2 (honesty-not-theater) demands. No theorem changed this
> pass; two arXiv-verified citations added.
>
> **Maintenance log — 2026-07-07 (discrete JSRR acceptance gate adopted; external validation).**
> A 2026-07-07 literature check found the looped-LM spectral-radius / peak-then-collapse result
> now published externally on **real** models — STARS (JSRR, arXiv:2605.26733), PLDR
> self-organized criticality (arXiv:2603.23539), and a fixed-point/attractor cluster — so the
> §1 object is externally corroborated, and its *novelty* is closed (adoption, not a new law).
> Acting on it: the serve-loop **acceptance gate is now the discrete criterion `ρ(A)<1`** (§1.2.3),
> the invariant appropriate to a discrete iteration, with the §1.2.1 continuous `proven_contracting`
> demoted to diagnostic + fallback. New `cio_sde.collapse.jsrr_certificate` (exact `ρ` + STARS'
> `‖Av‖₂²` single-step surrogate, numpy-only so it survives the minimal inference venv);
> `loop_lm.generate()` accepts iff `ρ<1−margin` (`SIGMA0_JSRR_MARGIN`, default 0). Machine-checked
> by `tests/test_sigma0_jsrr_gate.py` (12 cases) + four unchanged adjacent suites ⇒ **98 passing**.
> Evidence class is deliberately narrow: the gate's **verdict** is machine-checked, NOT a quality
> win (CART, arXiv:2606.01495, reports a null result), and it runs on the **empirical-Jacobian
> proxy** (true-JVP `ρ` deferred to a GPU run, #2029 matvec path). PR #2237. **Honesty leg NOT
> written:** the grounding-honesty study ([#2236] — spectral loop-stability → *factual* honesty,
> gated on external grounding) is untested, so no honesty AUROC is claimed here; it enters the doc
> only when MEASURED with a run pointer. Frontmatter `updated:` → 2026-07-07.

[#2237]: https://github.com/alex-place/lantern-os/pull/2237

### Closed-gap history

**Closed (landed 2026-06-15, via the [#509] !convergance epic):**
- [#504] — §6 demo driver scripts (`router_sigma0_encoder.py`, `router_reservoir_G.py`) are **MEASURED** (committed; run logs in `data/sigma0/`).
- [#505] — non-normal-Jacobian handling: `collapse_certificate()` now reports both the small-gain `alpha` bound and the exact full-spectrum `spectral_abscissa` (§1.1–1.2).
- [#506] — surprise↔Σ₀ integration **landed** (`engine.forward_step` consumes `m.surprise_monitor`, emits `surprise_spook`; `SurpriseMonitor.sigma0_proximity()` / `anti_collapse_signal()`). Residual carried to [#657] (below).
- [#507] / [#523] — real-data grounding demonstration (§6).
- [#516] / [#517] / [#520] — model-collapse literature integrated (two-phase collapse, double-scaling law, prediction-markets-as-grounding; §7 + References).
- [#508] — `.md`/`.tex` status-box reconcile pass.

**Closed (both halves of [#768] — in-regime, 2026-06-26):**
- **Theorem 1's *contraction* for non-normal drift `A`** ([#768]) — **now CLOSED in-regime.**
  The §1 cross-term (`P_M A P_N ≠ 0` for non-normal `A`) breaks the symmetric-split energy
  proof, and the small-gain / pseudospectral gates (§1.2.1) only over-reject. The fix is the
  **spectral (Riesz) dichotomy** ([SIGMA0-T1-NONNORMAL-DICHOTOMY.md](SIGMA0-T1-NONNORMAL-DICHOTOMY.md)):
  split by `A`'s OWN spectrum so the cross-term vanishes by invariance; the active block
  contracts within a certified Lyapunov envelope; the slow block's abscissa sign gives the
  collapse-vs-diverge fate, no third option. Shipped as `dichotomy_certificate`
  (`src/cio_sde/collapse.py`), surfaced at decode time in `loop_lm._stability_gates`,
  machine-checked by a 600-matrix sweep (0 failures, worst invariance residual 6.7e-13) and
  3 suite tests. For normal `A` it reduces to Theorem 1 exactly, so T1 is its special case.

- **§3 sufficiency *theorem* — now closed for ALL `A`** (2026-06-26). [Theorem
  C3](SIGMA0-C3-NONCOLLAPSE-NORMAL.md) proves Σ₀⁻¹ prevents permanent freeze: first for
  normal `A` (landed 2026-06-25), then for **non-normal `A` too** once L2′ (§7 of the C3
  doc) showed the alignment hypothesis L1 was removable — *any* rank-`m` bump lifts
  anisotropy at `cond_flat` (Σ≈μI) by a Frobenius reverse-triangle bound. The 900-run
  sweep ([#658]) is now corroboration. **[#768] is split:** its *freeze* half is closed
  here; its *contraction* half (above) remains. This is the **rescue** question, distinct
  from the drift one.

  *All previously-tracked gaps are now closed: [#657], [#658], [#659] landed 2026-06-19; [#660] (`.md`/`.tex` attribution + web-citation verification) closed.*

**Resolved (landed 2026-06-19):**
- [#658] — **§3 evidence upgraded N=1 → MEASURED.** `experiments/sigma0_regime_sweep.py` runs a forced-collapse rollout with/without Σ₀⁻¹ over an α × non-normality × noise grid with a fixed underdetermined (3-dim null) Jacobian. Over **900 trials that genuinely collapse without protection**, Σ₀⁻¹ suppressed collapse AND re-excited the state in **100%** (`data/sigma0_regime_sweep_report.json`). Honest caveat: in this construction the non-normal off-diagonal lifts the Jacobian's effective rank, so the collapse-prone cells are the diagonal ones (non_normality=0); the measured distribution spans α∈{−0.5,−0.2,−0.05} × noise∈{0.01,0.05,0.2}. The §3 label moves from N=1 HEURISTIC to MEASURED; a sufficiency theorem is still future work.
- [#657] — **§4 residual CLOSED.** The engine no longer self-observes; `forward_step` runs a Kalman predict/update cycle with process noise `Q=(g·dilation)²·dt`, so smooth exploration stays consistent (NIS≈m, silent) while the collapse snap / Σ₀⁻¹ kick spikes NIS — the canary fires under collapse. `test_surprise_monitor_integration` flipped `xfail` → hard pass (30 passed). *This was the last open technical gap in the Σ₀ machinery.*
- [#659] — **§4 decision CLOSED (RETIRED).** `p_gate`/`p_unbounded` formally retired, superseded by the `surprise.py` NIS canary; never implemented in `collapse.py` and will not be.

**Anti-collapse hardening (epic [#764]) — landed (verified 2026-06-21).** The full CSF-grounded defense-in-depth plan lives in [ANTI-COLLAPSE-HARDENING.md](ANTI-COLLAPSE-HARDENING.md). The code-verified bugs are now **resolved** (issues closed; fixes confirmed in source): [#765] (PCSF circuit-breaker `AttributeError` → true EMA on the declared `latency_ema_ms`, plus QUOTA_HIT recovery timer + half-open backoff in `src/convergence_io/pcsf.py`), [#766] (instrument→actuator loop **closed** — `loop_lm.generate()`'s `canary` path folds per-token self-repeat / n-gram echo / argmax-margin into `sigma0_proximity` and adapts `rep_penalty`/q as collapse nears), [#767] (memory confidence laundering + hash-chain ledgers). The proven-region wideners for non-normal `A` ([#768]: Lyapunov-SDP + pseudospectral-abscissa gates) **landed** as `stability_gates()` (§1.2.1). These extend the proven region of §1; they do **not** make the system globally uncollapsible — and the §3 *sufficiency theorem* (a closed-form proof that Σ₀⁻¹ always prevents collapse) remains the one genuine open frontier, distinct from #768's now-landed gates.

**Resolved (landed 2026-06-17):**
- [#661] — **§2 / Appendix A defect.** `_collapse_state`'s "log-barrier" was a misnamed multiplicative shrink that flipped sign for `strength > 0.217`. **Fixed:** the term is dropped; collapse is now the clean orthogonal projection `x* = P x` (non-expansive, smooth). The `log_barrier_strength` parameter was removed. Regression: `test_collapse_is_nonexpansive_projection`. *Flagged in external review 2026-06-16.*

> **Maintenance log — 2026-07-07 (publication pass + §8.6-5 measured).** Reconcile pass folding in
> the two pre-registered incremental-validity experiments (PR #2240) that answered the document's
> one open research question at corruption level: **N1** (`experiments/sigma_update_internal_signal_value.py`,
> 32-seed sim) *falsified* the hypothesis that a free intrinsic signal can extend the fixed-holdout
> budget (~1.0–1.2× equivalent value; weight-sweep strictly worse; near-oracle 4.10 ≪ fresh 12.68)
> → new §8.4.1 records the refined law (*freshness, not externality, is the active ingredient* —
> an intrinsic signal's error sticks with the champion like fixed-holdout luck). **N2**
> (`experiments/sigma_incremental_validity_ouro.py`, real Ouro-1.4B corruption ladder) measured
> incremental validity as **real, gross-only, scarcity-gated** (ΔAUC +0.121/+0.068/+0.019 at
> n=2/3/5; internal-alone 0.944; subtle cell empty by construction — weight corruption is binary,
> matching the measured quantization cliff) → §8.6 item 5 updated from "unmeasured" to half-closed;
> the open half is *subtle training-induced* badness, which requires the real A/B/C artifacts.
> Front-matter novelty paragraph, audit table (+2 rows), §8.5 claimed/not-claimed, and a Part II
> plain-language line updated to match. Joint law recorded: **internal signals detect; only fresh
> truth selects.** Also fixed in the same pass: `tests/test_sigma0_jsrr_gate.py` imported torch
> unguarded, breaking collection on torch-free CI — the audit table's "tests pass on a fresh clone"
> contract; now `pytest.importorskip`-guarded per repo convention.

> **Maintenance log — 2026-07-17 (external-novelty corner audit; Σ_G ledger split out; schedule
> race measured).** A reviewer-style pass over the corners the 2026-07-07 audits did *not* sweep
> (those closed the headline claims: loop spectral radius, Σ_θ components, the grounding thesis).
> Findings, all folded in this pass. **(1) Prior-art additions.** §3.1's schedule consequence is
> **self-triggered control** applied to this certificate's objects (Heemels-Johansson-Tabuada,
> CDC 2012; arXiv:1803.08980 — now cited in §3.1 + References); Σ₀⁻¹'s covariance leg has
> classical kin in RLS **covariance resetting / directional forgetting** (Kulhavý-Kárný 1984;
> arXiv:2003.03523, arXiv:2404.10844 — now cited in §3, mechanism novelty explicitly disclaimed);
> §8.4's problem shape is **the Ladder** (Blum & Hardt, arXiv:1502.04585 — now in §8.8) with
> Roelofs et al. (NeurIPS 2019) as the standing counterpoint; adjacent Part-I prior
> arXiv:2604.09979 added to References. **(2) Stale claim corrected.** §8.6 item 5's
> "no prior art surfaced" no longer holds — the detection lane is occupied (arXiv:2601.16874,
> 2602.10144, 2604.19884); corrected in place, per this document's own discipline. **(3) The
> three thin still-open corners** are now tracked as issues and composed in a new companion doc,
> [SIGMA0-GROUNDING-LEDGER.md](SIGMA0-GROUNDING-LEDGER.md) (*grounding has a price, a schedule,
> and a budget*): [#2690] schedule (self-triggered grounding), [#2691] budget
> (Thresholdout-gated promotion — the real A/B/C run), [#2692] price (freshness-law
> falsification: re-drawable noise vs re-drawn truth). The companion is deliberately a *ledger*,
> not a certificate — it upgrades nothing here, and if the two disagree this document wins.
> **(4) New measurement ([#2690] Phase 0).** `experiments/sigma0_scheduled_grounding.py` — the
> scheduled-vs-reactive grounding race: in the well-conditioned basin the **alarm premium is
> 2.25×** (charitable canary FPR 1.5%, median alarm step 14 vs cadence tick 3; reactive needs
> 0.90·B*_∞ where scheduled needs 0.40·B*_∞); the sliver basin is fully timing-indifferent (the
> Ouro-null, now produced rather than retrodicted). §3.1 gains the MEASURED block; audit table
> +1 row; `tests/test_sigma0_scheduled_grounding.py` (6 passing). Fresh audit run this pass:
> `pytest tests/test_cio_sde.py tests/test_sigma0_roa_certified.py tests/test_sigma_theta_gate.py
> tests/test_sigma_theta_thresholdout.py tests/test_sigma0_scheduled_grounding.py` → **74 passed**.
> Frontmatter `updated:` → 2026-07-17.

> **Maintenance log — 2026-07-17 (E-P run: the freshness law's own kill test fired; §8.4.1
> re-stated).** [#2692]'s pre-registered experiment ran the same day it was filed
> (`experiments/sigma_update_stochastic_signal.py`, 32 seeds, oracle-weight sweep per cell —
> no combiner alibi). **H-P1 CONFIRMED:** at fixed total error, moving error mass from
> checkpoint-fixed bias to re-drawn noise raises extraction steeply (n=50: 0.81 → 9.36 vs
> fixed-alone 0.61). **H-P2 REFUTED — the kill condition fired:** at fixed bias, pure re-drawn
> measurement noise rescued extraction 7.9× (0.81 → 6.43). A post-hoc, labeled-as-such control
> attributes the entire rescue to **zero-information dither** (6.42 vs 6.43, interior optimum)
> — de-ratcheting, not information; the same mechanism Thresholdout buys with Laplace noise,
> obtained free from any stochastic measurement. Fresh truth still strictly dominates every
> internal arm (12.90 > 9.36 > 6.43 > 0.81 > 0.61). §8.4.1 gains the RE-STATED block (three
> sentences now: *internal signals detect; fresh randomness de-ratchets; only fresh truth
> informs*), §8.5's claimed list is corrected to deterministic-only, §8.6-5's joint-law line
> carries the re-statement, audit table +1 row
> (`tests/test_sigma_update_stochastic_signal.py`, 6 passing — one test pins the refutation
> itself so it cannot be silently forgotten). This is the §8.7 protocol applied to our own
> law: a pre-registered falsification found the overstatement, and the correction — not the
> original claim — is the recorded result. Real-model arm folds into the A/B/C run ([#2691]).

> **Maintenance log — 2026-07-17 ([#2691] protocol layer: the three promotion-evidence arms,
> implemented and validated pre-L4).** The E-B gap splits into two halves — the *protocol* (who
> reads which task set, when, with what ledgers and budgets) and the *training* (real
> RLVR/distill steps on L4). The protocol half is now closed:
> `experiments/sigma_theta_abc/holdout_protocol.py` implements Fixed / Fixed+dither / Fresh-flow
> / Thresholdout+pool model-agnostically (an `eval_fn` callback; the L4 run swaps in the real
> exec evaluator) and validates them at **task-level Bernoulli-stuck fidelity** — per-
> (candidate,task) outcomes are a deterministic hash, so re-evaluation returns the same pass set,
> which is the *actual* stuck-luck mechanism (an upgrade over every Gaussian sim so far). 16
> seeds, 7/7 checks (`data/sigma0/holdout_protocol_report.json`;
> `tests/test_sigma_theta_holdout_protocol.py`, 6 passing; audit run now **86 passed** across the
> seven suites). Orderings reproduce at the higher fidelity (fixed gap +0.108 worst; fresh 0.934
> best extraction at 61× task consumption; Thresholdout best fresh-task efficiency), plus one new
> measured result: **Fixed+dither extracts 0.856 vs fixed 0.617 at identical task consumption** —
> the [#2692] de-ratcheting knob survives the fidelity upgrade and is the cheapest intervention
> in the set. Teeth run through the real seven-condition gate with arm-appropriate reasons (fixed
> catches the contaminated hack only via the cond-6 provenance ledger; fresh rejects it on
> merit, cond 1). §8.6 item 4 and the audit table updated. **The honest gap is unchanged and
> now precisely one thing: executing this protocol around real training on L4.**

> **Maintenance log — 2026-07-17 ([#2690] Phase 0.5: the prospective shot-call on a real
> learned system).** `experiments/sigma0_reservoir_deadline.py` ran the §3.1 machinery
> prospectively on the trained §6 reservoir: every quantity computed from the linearization
> FIRST (ρ(J)=0.9836, cond(P)≈4.8·10⁴ → pre-registered SLIVER call), then graded on the true
> nonlinear dynamics — the measured realistic grounding kick is 1.4·10⁴× the escape ceiling
> and forced fire-times are fully timing-indifferent even at B_real/100: **the call held**
> (5 new tests; audit suites now 8 files / 91 passed). Two honest records kept: (1) the
> first-run harness applied the basin-entry race unconditionally and it is VACUOUS in the
> sliver regime (1/100 usable traces, cadence ≫ horizon) — the instrument now branches on the
> pre-registered regime call, and the vacuity note stays in the script docstring; (2) the
> deadline rows are consistent-but-without-bite here, said so in the report. New
> evidence-backed pattern recorded in §3.1: both real learned loops measured so far (Ouro
> expansive, reservoir near-critical) land outside the well-conditioned regime — the
> schedule's bite may require deliberately JSRR-stabilized loops, which upgrades Phase 1's
> motivation from assumption to measurement.

> **Maintenance log — 2026-07-18 (conventional-grounding pass — every gap tied to an established
> method + source + reasoning; no new mechanism claimed anywhere).** A deliberate sweep to ensure
> each load-bearing construct is presented as the *conventional* result it is, with a
> venue-verifiable citation and a one-line reason for the gap. Two under-grounded spots were fixed
> in place: **§8.4.1 de-ratcheting** now cites **simulated annealing / stochastic acceptance**
> (Metropolis 1953; Kirkpatrick–Gelatt–Vecchi, *Science* 1983; Černý 1985; Ge et al., COLT 2015) —
> the mechanism our E-P result rediscovered, with the "interior optimum" identified as the
> temperature optimum — and states plainly that only the *measurement + stuck-vs-fresh framing in
> the holdout-reuse setting* is ours; and **§3.1's commitment inequality** now cites the standard
> **bounded-input reachable-set / invariant-set** theory (Kailath 1980; Sontag 1998; Blanchini &
> Miani 2015) it is a corollary of. References gain both clusters. **Gap → conventional grounding
> map** (the whole document at a glance; each row is *established method, not a Σ₀ contribution*):
>
> | Construct (gap) | Conventional method it *is* | Source |
> |---|---|---|
> | §1 collapse/contraction (Thm 1, C3) | Lyapunov stability; contraction analysis / matrix measure μ₂ | Lyapunov 1892; Lohmiller–Slotine 1998; Khalil 2002 |
> | §1.2.1 non-normal stability gates | numerical range, pseudospectra, Kreiss/Crouzeix constants | Trefethen–Embree 2005; Crouzeix–Palencia 2017 |
> | §1.2.2 routed loops are switched systems | switched-system / dwell-time stability | (arXiv refs in §1.2.2) |
> | §1.2.3 discrete acceptance gate | Jacobian spectral radius `ρ<1` (Schur) — adopted from STARS/JSRR | arXiv:2605.26733 |
> | §2 four-signal trigger [HEURISTIC] | conjunctive multi-indicator degeneracy detector (soft-AND / Gödel t-norm) — an operational definition, not a theorem | (labeled as such in §2) |
> | §3 Σ₀⁻¹ re-excitation | persistent excitation; RLS covariance-resetting / directional forgetting | Anderson 1977; Kulhavý–Kárný 1984 |
> | §3.1 commitment inequality + cadence | bounded-input reachable set + self-triggered control | Kailath 1980; Sontag 1998; Heemels–Johansson–Tabuada 2012 |
> | §4 canary | critical slowing down; Kalman innovation-consistency (NIS χ²) | Wissel 1984; Scheffer 2009; Bar-Shalom et al. 2001 |
> | §5 attractor graph / ROA | Markov state models; Lyapunov/LaSalle ROA via interval arithmetic | Khalil 2002 (Ex. 8.4) |
> | §7 collapse-without-grounding | model collapse; intrinsic self-correction degrades | Shumailov 2024; Feng 2024; Huang 2024 |
> | §7.1 σ=0 limit | ICL-as-estimator; continual-learning weight-perturbation σ | Akyürek 2022; Elsayed–Mahmood 2024 |
> | §7.2 honesty-theater | Goodhart / specification gaming; eval-awareness | Amodei 2016; Skalse 2022 |
> | §8.4.1 de-ratcheting (new) | stochastic acceptance / simulated annealing; Thresholdout noise | Kirkpatrick 1983; Dwork 2015 |
> | §8 Σ_θ gate | TRPO monotonic-improvement; reward-model overoptimization curve; reusable holdout | Schulman 2015; Gao 2023; Dwork 2015 |
> | §9 two-timescale composition [TARGET] | two-timescale stochastic approximation; singular perturbation | Borkar 1997; Khalil 2002 |
>
> **The one honest empirical gap is unchanged** and carries no novelty claim: §8/§9 have not
> controlled a *real* training run (sim-validated, real pending — the standard "validated in
> simulation, real-model validation outstanding" status). Net: the document's contribution is
> **disciplined in-repo formalization + honest measurement of standard results**, which is exactly
> what its own §7.2 (honesty-not-theater) and the 2026-07-07 nearest-prior audit already conceded;
> this pass makes that explicit at every gap. No theorem changed; citations added are classic and
> venue-verifiable (no arXiv IDs invented — see the fabricated-ID caution above).

> **Maintenance log — 2026-07-21 (Part IV added — the active face, DESIGN/TARGET, no theorem).**
> Added §10 (Part IV) as the certificate's forward-pointer to the Oracle answering interface
> ([CONVERGENCE-ORACLE-DESIGN.md], design PR #2818), so the theory and the interface cannot drift.
> It distinguishes **two grades of grounding**: *passive* (retrieval / held-out anchor — escapes
> collapse, ceilings at the ideal inductive predictor Solomonoff/AIXI, unbeatable *by inference*)
> and *active* ("act to know" — manufactures an observation no corpus had, escaping the ceiling on
> surfaces where an action resolves). The honesty guard is §8.4.1's freshness law turned into an
> engine: claim past-ceiling knowledge **only after** an action resolves; unresolved stays
> unverified; structurally-unactionable stays a pin. **Authority: lower than Part II** — no
> theorem, nothing machine-checked; imported mechanism is established (Bayesian optimal
> experimental design — Lindley 1956; value of information; active inference), **no novelty
> claimed**. One MEASURED datapoint added (§10.1): the freshness law observed on a **real code
> surface** (autowork apply-retry [#2762], run `autowork-2762-…`, PR #2795) — re-showing the model
> its own failed diff reproduced the identical wrong context (the ratchet); *withholding* it
> (de-anchoring) + feeding the real file (fresh truth) flipped triple-failure to first-try success.
> This corroborates §8.4.1 on code, it does **not** extend the proof — MEASURED-instance, one run,
> not a distribution, not machine-checked. Also re-ran the Part I backbone (`test_cio_sde` 46 +
> `test_sigma0_jsrr_gate` 12) with no drift; other suites stand from 2026-07-17. No Part I–III
> theorem or status was touched. **Same-day refinement:** Part IV was then consolidated for
> readability — the repeated authority caveats collapsed into one status line (§10.2 folded in),
> prose tightened, the imported mechanism cited (Lindley 1956 / Howard 1966 / Friston 2010), the
> `#2762`/`#2795` links defined, and the work linked from RESEARCH-CANON [07] + the README Σ₀ list.
> Substance and evidence class unchanged.

---
