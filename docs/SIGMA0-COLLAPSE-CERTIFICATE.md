---
author: Alex Place
created: 2026-06-14
updated: 2026-06-20
---

# Σ₀ — The Collapse Certificate

*A computable stability certificate for convergence dynamics, and an honest
account of why an ungrounded self-improving system tends to collapse or diverge.*

---

## Plain-language summary

**What this is.** A stability certificate — a computable test (a check a computer can run automatically) — for a system that
updates itself over time, together with an honest account of what happens to a
self-improving system that has *no contact with outside reality*.

**The one-line result.** A system that only ever optimizes against its own
internal picture of the world has two failure modes and no happy third one: it
either **collapses** onto a single frozen, self-agreeing state (nicknamed the
"42-state"), or it **diverges** and runs away. The only escape is an **external
anchor** — real data, a measurement, a market, a ground truth. **Grounding is the
safety mechanism.** This is the same thing machine-learning researchers call
**model collapse** — train a model on its own output long enough and it degrades.

**How sure are we of each part?** Every claim below is labelled:
- **PROVEN** — the core collapse theorem (Theorem 1), with a machine-checked
  proof, for the well-behaved (symmetric / normal) case. *33 of 33 tests pass.*
- **MEASURED** — the anti-collapse operator (§3) and the early-warning "canary"
  (§4): not proven, but demonstrated over **900 forced-collapse runs (100%
  prevented)** plus a passing integration test.
- **HEURISTIC** — the four-signal collapse *trigger* (§2): a sensible operational
  definition, deliberately *not* dressed up as a theorem.

**What's left.** One genuine frontier: a *proof* (not just measurement) that the
anti-collapse operator always works. Everything else verified as of 2026-06-19 is
finished, machine-checked, and reproducible.

> **For the precise version, read on.** Each section carries its own status line.
> The summary above is the honest gist, not a substitute for the math.

---

Status: **Theorem 1 is proven and machine-checked** (`src/cio_sde/collapse.py`,
`tests/test_cio_sde.py` — **33 passing, 0 xfail**; the last gap [#657] closed
2026-06-19) **for the symmetric / normal case**. The collapse trigger (§2), the anti-collapse operator (§3), and the
early-warning readout (§4) are control-design heuristics — empirically supported, not
theorems. The §6 demonstration is now **reproducible**: both driver scripts are
committed and produce checked-in run logs (see §6). Read the per-section status
lines before relying on any claim here.

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
> landed (verified against the repo: `pytest tests/test_cio_sde.py` → **33 passed,
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
> count 30 → 33 throughout; every other claim verified to hold. Frontier unchanged
> (§3 sufficiency theorem, [#768]).

**Status taxonomy & tracked gaps.** Each claim is one of: **PROVEN** (theorem +
machine-checked), **MEASURED** (empirical, with a test/run pointer), **HEURISTIC**
(operational design, not derived from the theorem), or **UNIMPLEMENTED** (described
but not present in code). Gaps are tracked as GitHub issues and cross-linked here so
status cannot silently drift.

**Closed (landed 2026-06-15, via the [#509] !convergance epic):**
- [#504] — §6 demo driver scripts (`router_sigma0_encoder.py`, `router_reservoir_G.py`) are **MEASURED** (committed; run logs in `data/sigma0/`).
- [#505] — non-normal-Jacobian handling: `collapse_certificate()` now reports both the small-gain `alpha` bound and the exact full-spectrum `spectral_abscissa` (§1.1–1.2).
- [#506] — surprise↔Σ₀ integration **landed** (`engine.forward_step` consumes `m.surprise_monitor`, emits `surprise_spook`; `SurpriseMonitor.sigma0_proximity()` / `anti_collapse_signal()`). Residual carried to [#657] (below).
- [#507] / [#523] — real-data grounding demonstration (§6).
- [#516] / [#517] / [#520] — model-collapse literature integrated (two-phase collapse, double-scaling law, prediction-markets-as-grounding; §7 + References).
- [#508] — `.md`/`.tex` status-box reconcile pass.

**Open (the one genuine remaining frontier):**
- **§3 sufficiency *theorem*.** Σ₀⁻¹ is now MEASURED over a 900-run regime sweep ([#658], resolved below) — but a closed-form *proof* that it always prevents collapse (option a) is still future work. This is the sole real gap, and it is acknowledged honestly rather than tracked as a defect.

  *All previously-tracked gaps are now closed: [#657], [#658], [#659] landed 2026-06-19; [#660] (`.md`/`.tex` attribution + web-citation verification) closed.*

**Resolved (landed 2026-06-19):**
- [#658] — **§3 evidence upgraded N=1 → MEASURED.** `experiments/sigma0_regime_sweep.py` runs a forced-collapse rollout with/without Σ₀⁻¹ over an α × non-normality × noise grid with a fixed underdetermined (3-dim null) Jacobian. Over **900 trials that genuinely collapse without protection**, Σ₀⁻¹ suppressed collapse AND re-excited the state in **100%** (`data/sigma0_regime_sweep_report.json`). Honest caveat: in this construction the non-normal off-diagonal lifts the Jacobian's effective rank, so the collapse-prone cells are the diagonal ones (non_normality=0); the measured distribution spans α∈{−0.5,−0.2,−0.05} × noise∈{0.01,0.05,0.2}. The §3 label moves from N=1 HEURISTIC to MEASURED; a sufficiency theorem is still future work.
- [#657] — **§4 residual CLOSED.** The engine no longer self-observes; `forward_step` runs a Kalman predict/update cycle with process noise `Q=(g·dilation)²·dt`, so smooth exploration stays consistent (NIS≈m, silent) while the collapse snap / Σ₀⁻¹ kick spikes NIS — the canary fires under collapse. `test_surprise_monitor_integration` flipped `xfail` → hard pass (33 passed). *This was the last open technical gap in the Σ₀ machinery.*
- [#659] — **§4 decision CLOSED (RETIRED).** `p_gate`/`p_unbounded` formally retired, superseded by the `surprise.py` NIS canary; never implemented in `collapse.py` and will not be.

**Anti-collapse hardening (epic [#764]) — landed (verified 2026-06-21).** The full CSF-grounded defense-in-depth plan lives in [ANTI-COLLAPSE-HARDENING.md](ANTI-COLLAPSE-HARDENING.md). The code-verified bugs are now **resolved** (issues closed; fixes confirmed in source): [#765] (PCSF circuit-breaker `AttributeError` → true EMA on the declared `latency_ema_ms`, plus QUOTA_HIT recovery timer + half-open backoff in `src/convergence_io/pcsf.py`), [#766] (instrument→actuator loop **closed** — `loop_lm.generate()`'s `canary` path folds per-token self-repeat / n-gram echo / argmax-margin into `sigma0_proximity` and adapts `rep_penalty`/q as collapse nears), [#767] (memory confidence laundering + hash-chain ledgers). The proven-region wideners for non-normal `A` ([#768]: Lyapunov-SDP + pseudospectral-abscissa gates) **landed** as `stability_gates()` (§1.2.1). These extend the proven region of §1; they do **not** make the system globally uncollapsible — and the §3 *sufficiency theorem* (a closed-form proof that Σ₀⁻¹ always prevents collapse) remains the one genuine open frontier, distinct from #768's now-landed gates.

**Resolved (landed 2026-06-17):**
- [#661] — **§2 / Appendix A defect.** `_collapse_state`'s "log-barrier" was a misnamed multiplicative shrink that flipped sign for `strength > 0.217`. **Fixed:** the term is dropped; collapse is now the clean orthogonal projection `x* = P x` (non-expansive, smooth). The `log_barrier_strength` parameter was removed. Regression: `test_collapse_is_nonexpansive_projection`. *Flagged in external review 2026-06-16.*

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
[#764]: https://github.com/alex-place/lantern-os/issues/764
[#765]: https://github.com/alex-place/lantern-os/issues/765
[#766]: https://github.com/alex-place/lantern-os/issues/766
[#767]: https://github.com/alex-place/lantern-os/issues/767
[#768]: https://github.com/alex-place/lantern-os/issues/768

---

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

**Acceptance gate.** `loop_lm.generate()` now **consumes** the certificate (it was previously
computed but unused): it surfaces `stability_accepted = proven_contracting` on the empirical
exit-depth Jacobian, so a generation's latent trajectory carries an explicit
convergence-accept/reject verdict (`None` when too few tokens to certify).

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

---

## 3. The anti-collapse operator Σ₀⁻¹

**Status: MEASURED-over-distribution (as of 2026-06-19, [#658]). A 900-run regime
sweep (100 trials × 9 collapse-prone cells) shows Σ₀⁻¹ suppresses forced collapse in
100% of collapse-prone trials. A key lemma toward the proof is now CLOSED:
[L2 — the one-step anisotropy lift](SIGMA0-L2-ANISOTROPY-LIFT-PROOF.md) is proven
closed-form and machine-checked (a single Σ₀⁻¹ bump provably breaks the trigger's
flat condition). The full sufficiency *theorem* — non-normal `A`, all initial
conditions — remains the one open frontier ([#768]).**

Where Σ₀ projects **onto** the null subspace, Σ₀⁻¹ injects energy **along** it:

$$dx = f\,dt + dW + \Sigma_0^{-1}, \qquad \Sigma_0^{-1} = s\cdot p \cdot (V_{\text{null}}\,\xi)$$

with `ξ` random and `p ∈ [0,1]` the **collapse proximity** — 0 far from the
boundary (a no-op that costs nothing), rising toward 1 as `∇L`, rank, anisotropy,
and control sensitivity all approach their thresholds. The implementation
(`AntiCollapseOperator.excite` in `src/cio_sde/collapse.py`) correctly injects
noise in the null subspace and re-anisotropizes `Σ`. The proximity gate
(`AntiCollapseOperator.proximity`) is the soft-AND `min(p_grad, p_rank, p_flat,
p_ctrl)` over the four §2 signals.

**What is and isn't claimed.** This is a *well-motivated* control design:
re-exciting directions that have gone flat is a sensible way to keep the system
off the null manifold. But there is **no companion theorem** stating that Σ₀⁻¹
*prevents* collapse — in contrast to Theorem 1, which is proven (under §1's
hypothesis). That theorem-shaped gap is the one residual; the empirical support,
however, is now a distribution rather than a single run ([#658], resolved).

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

**Latent code defect — RESOLVED (2026-06-15).** `AntiCollapseOperator.__init__`
annotated `detector: Optional[...]` while `collapse.py` imported only `from typing
import Dict`, so `typing.get_type_hints()` raised `NameError: name 'Optional' is
not defined` (masked at import time by PEP 563 string annotations, but breaking any
runtime annotation introspection — Pydantic, FastAPI, dataclass eval, Sphinx
autodoc). Fixed: `collapse.py:33` now reads `from typing import Dict, Optional`.
Recorded here so the resolution is not lost.

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
`xfail` → **hard pass (33 passed, 0 xfail)**. This was the last open technical gap
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
- D. Amodei et al. (2016); J. Skalse et al. (2022) — reward hacking / specification gaming (§7).

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

The intended demonstration would run the Σ₀ machinery on the Keystone OS
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
`tests/test_cio_sde.py` (33 passing, 0 xfail — [#657] closed 2026-06-19); framework `docs/sigma0-collapse-certificate.tex`.
The router demonstration scripts `experiments/router_sigma0_encoder.py` and
`experiments/router_reservoir_G.py` are **committed and reproducible** — see §6
for produced results and Appendix A for the original design sketch.*