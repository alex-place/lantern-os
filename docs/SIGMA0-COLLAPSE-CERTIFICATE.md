# Σ₀ — The Collapse Certificate

*A computable stability certificate for convergence dynamics, and an honest
account of why an ungrounded self-improving system tends to collapse or diverge.*

Status: **Theorem 1 is proven and machine-checked** (`src/cio_sde/collapse.py`,
`tests/test_cio_sde.py`, 20 passing) **for the symmetric / normal case**. The
collapse trigger (§2), the anti-collapse operator (§3), and the early-warning
readout (§4) are control-design heuristics — empirically supported, not
theorems. The §6 demonstration is **not currently reproducible**: its two driver
scripts are absent from the repository (see the flag in §6). Read the per-section
status lines before relying on any claim here.

---

## 0. The object

We study a dissipative nonlinear system

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

---

## 1. The collapse-guarantee theorem

**Status: PROVEN, under an explicit hypothesis (A normal, or M is A-invariant).
Machine-checked for the symmetric case.**

Split the state space using the symmetric part `A_s`:

- **null subspace** `N = span{ vᵢ : |λᵢ(A_s)| < ε }` — the near-invariant modes
- **active subspace** `M` — its orthogonal complement, projector `P_M`

Define the Lyapunov function on the active modes only:

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

So for non-normal `A`, the §1 energy proof is **insufficient on its own**; the
cross term must be separately bounded (e.g. via `‖P_M A P_N‖` and a small-gain /
Young's-inequality argument that tightens `α` to an effective rate), or one must
fall back to the full-spectrum test.

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
authoritative contraction test). `collapse_certificate()` currently computes
only the former.

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

| condition | meaning |
|---|---|
| `‖∇ₓL‖ < ε_g` | no optimization signal remains |
| `rank(J_f) < ρ·n` | drift Jacobian has lost directional structure |
| `Σ` isotropically flat | uncertainty has no preferred direction |
| `‖∂H/∂u‖ < ε_c` | control cannot distinguish actions |

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

**Status: CONTROL-DESIGN HEURISTIC. Empirically shown (N=1, one forced-collapse
test) to suppress collapse. NO sufficiency theorem — unlike Theorem 1.**

Where Σ₀ projects **onto** the null subspace, Σ₀⁻¹ injects energy **along** it:

$$dx = f\,dt + dW + \Sigma_0^{-1}, \qquad \Sigma_0^{-1} = s\cdot p \cdot (V_{\text{null}}\,\xi)$$

with `ξ` random and `p ∈ [0,1]` the **collapse proximity** — 0 far from the
boundary (a no-op that costs nothing), rising toward 1 as `∇L`, rank, anisotropy,
and control sensitivity all approach their thresholds. The implementation
(`excite()`, `collapse.py` lines 261–275) correctly injects noise in the null
subspace and re-anisotropizes `Σ`. The proximity gate `proximity()` (lines
245–259) is the soft-AND `min(p_grad, p_rank, p_flat, p_ctrl)` over the four §2
signals.

**What is and isn't claimed.** This is a *well-motivated* control design:
re-exciting directions that have gone flat is a sensible way to keep the system
off the null manifold. But there is **no companion theorem** stating that Σ₀⁻¹
*prevents* collapse — in contrast to Theorem 1, which is proven (under §1's
hypothesis). The support is a single demonstration, reported as such.

**Empirical evidence (N=1).** On one forced-collapse run, Σ₀ fired on every step
and the state froze; with Σ₀⁻¹ active, Σ₀ stopped firing and the state escaped
the manifold. This is encouraging directional evidence, **not** a guarantee, and
not a sweep over regimes. (`AntiCollapseOperator`; the forced-collapse tests in
`tests/test_cio_sde.py` run for 20–30 steps and assert weaker directional
properties — the often-quoted "40/40 → 0/40" and "0.05 → 12.9" figures are
illustrative log values, not pinned by any test. Cite the tests, not the prose.)

**On "persistent excitation."** The classical PE result (Anderson 1977) concerns
*estimator/parameter* convergence under `∫φφᵀ ≥ αI`. Here there is no estimator
and no parameter being identified — only a state kept off a manifold. So Σ₀⁻¹ is
**inspired by / analogous to** persistent excitation; **no PE condition is
established**. (The Åström–Bohlin 1965 attribution should be reconciled between
the `.md` and `.tex` variants, where it is currently inconsistent.)

**Latent code defect (real, minor).** `AntiCollapseOperator.__init__` annotates
`detector: Optional[...]`, but `collapse.py` imports only `from typing import
Dict`. The module loads and all 20 tests pass *only* because `from __future__
import annotations` (PEP 563) keeps the annotation an unevaluated string;
`typing.get_type_hints()` on it raises `NameError: name 'Optional' is not
defined`, and any runtime annotation introspection (Pydantic, FastAPI,
dataclass eval, Sphinx autodoc) breaks. Against the "production-ready" framing
this is a genuine bug. One-line fix: `from typing import Dict, Optional`.

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

**Action required:** either implement `p_unbounded` / `p_gate` in `collapse.py`
and wire `p_gate` into `AntiCollapseOperator`, **or** keep §4 explicitly labeled
as a proposed (not-yet-implemented) readout. As written, the `p_gate`/`p_unbounded`
signal is not computed anywhere.

**Update — the right canary, now implemented (`src/cio_sde/surprise.py`).** The
eigenvalue readout above was the wrong early-warning. The correct one is *surprise
relative to uncertainty*: the Kalman normalized innovation squared (NIS),
`νᵀS⁻¹ν` with `ν = y − Cx̂`, `S = CΣCᵀ + R`. `NIS ≈ m` means model and reality
agree; `NIS ≫ m` means the model is overconfident relative to reality — it has
drifted and does not know it. This is the standard innovation-consistency χ² test
(Bar-Shalom, Li & Kirubarajan 2001), and unlike `p_gate` it is a property the
engine can actually compute: the `CovarianceField` already propagates Σ, but the
rollout never fused an observation — `SurpriseMonitor` adds the missing
measurement update and reads the innovation before it. The
`experiments/sigma0_horse_blinders.py` demonstration shows the regime the eigenvalue
signal cannot: a low-reality-coupling observer that is *calm while wrong* (low NIS,
growing error) during the gap before an unobserved disturbance "rustles" into a
visible dimension and the NIS spikes past threshold. The dangerous state is not the
spook — it is the quiet that precedes it.

---

## 5. Global structure: the attractor graph G

**Status: STANDARD CONSTRUCTION — correct, with a timescale-separation caveat.**

The system is **multistable**. Collect its attractors `{A₁,…,A_k}` (fixed
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

**Safe passages.** A basin boundary studded with **saddles** (mixed-sign
`Re λ`) has *stable manifolds* — ridges you can traverse without being captured
by a deep attractor. "Spin the vanda fast" = ride a boundary saddle with
rotation set by `Im λ`.

---

## 6. Demonstration on router data

> **⚠ REPRODUCIBILITY FLAG — read first.** This section describes a pipeline
> whose two driver scripts are **not present in the repository**. As of this
> revision, `experiments/` contains only `cio_sde_demo.py`,
> `crypto_tightband_observer.py`, `kalshi_cio_backtest.py`,
> `kalshi_tightband_analysis.py`, and `train_cio_kalshi.py`. **Both**
> `experiments/router_sigma0_encoder.py` **and**
> `experiments/router_reservoir_G.py` **are absent** — confirmed across
> `master`, `claude/sprint-1.5`, `claude/router-gate`,
> `claude/sigma0-documentation`, and `origin/master` (tracked on zero branches;
> no LFS pointer). **No numeric result below has a committed generating
> artifact. Treat this entire section as a PLANNED / NOT-YET-COMMITTED design
> sketch, not an established result.**

The intended demonstration would run the machinery above on the Lantern OS
conversation log (`data/conversations/garage-conversations.jsonl`), encoding
each turn as

$$x = [\text{novelty},\ \text{self\_repeat},\ \text{echo},\ \text{length}] \in [0,1]^4.$$

Two scripts are *specified* (and need to be written / committed before any of
this is reproducible):

- **`experiments/router_sigma0_encoder.py`** (MISSING) — would fit a local
  Jacobian per session, emit the spiral/canary/wall readouts, and build `π` and
  `P_ij`.
- **`experiments/router_reservoir_G.py`** (MISSING) — would train an echo-state
  network into one global flow that runs autonomously, *becoming* `G`, feeding
  its reconstructed fixed points back to the same Σ₀ certificate.

**Claimed result — UNVERIFIED, cannot currently be reproduced.** The narrative
result was that the log's dynamics collapse onto a **"parrot attractor"**
(`novelty ≈ 1, echo ≈ 0.72`) — a flow whose only fixed point is "quote the
prompt back," i.e. model collapse. **Because the generating scripts do not
exist, these numbers have no produced artifact and must be regarded as
hand-entered, not data-derived.** The previous claim that the result "appears
directly in the data, not inserted by hand" is **withdrawn** — it cannot be
substantiated as-is. Likewise, "cross-confirmed by both methods" is **withdrawn**:
neither method is currently runnable. (The only `0.72` in committed repo data is
an unrelated router-gate escalation *score* in `data/router-gate-decisions.jsonl`,
where the echo feature is in fact ≈ 0.199 — so even the coincidence does not
support the claim.)

**Honest caveats (strengthened).**
1. **The demonstration is not reproducible.** The two driver scripts are absent
   from every branch; nothing in §6 should be cited as an established result
   until they are committed with a logged run artifact.
2. Even if the scripts existed, the source log is mostly synthetic test traffic,
   so any numbers would be illustrative — the deliverable would be the pipeline,
   not the values.
3. A reservoir's autonomous rollout diverges unless projected back onto the
   valid `[0,1]⁴` domain; that projection *is* `π`. This is a real modeling step,
   but it is also an external bound imposed by hand (see §7), not an emergent
   property.
4. The certificate is unreliable at boundary fixed points where the hard clamp
   is non-smooth — a log-barrier is the proper fix and is **not yet
   implemented**.

**To make §6 real:** commit `router_sigma0_encoder.py` and
`router_reservoir_G.py` together with a checked-in run log, then replace the
withdrawn claims above with the actual produced numbers.

---

## 7. Why this is a warning against ASI

**Status: the one downstream claim worth keeping — but as a machine-learning
claim, on ML evidence, NOT as a consequence of the physics or of §6.**

The same equations read as a safety argument:

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
phenomenon of **model collapse** (Shumailov et al., *Nature* 2024 — recursive
training on synthetic data degenerates), closely related to **reward hacking /
specification gaming** (Amodei et al. 2016; Skalse et al. 2022). The "parrot
attractor" (train on reflections → converge to reflecting) is *literally model
collapse renamed*.

Two honest qualifications:

- The strict **"collapse OR diverge, no third option"** dichotomy is the
  *linearized* certificate's framing, not a general ML theorem. Real training
  also admits limit cycles and partial-information equilibria — better stated as
  "tends to degenerate or destabilize absent grounding."
- The empirical backing here inherits §6's missing-scripts problem and the
  synthetic-log caveat. The *argument* rests on the published model-collapse
  literature; the in-repo demonstration does not yet support it.

So: read §7 as an ML-safety claim, cite the model-collapse / reward-hacking
literature directly, and soften the strict dichotomy. On that footing it holds.

---

## References (lineage)

- A. M. Lyapunov, *The General Problem of the Stability of Motion* (1892) — `V(x)` method.
- H. Poincaré, *Mémoire sur les courbes…* (1880s) — node/saddle/center/**focus** (spiral) classification.
- I. Bendixson (1901) — `Re λ(A) ≤ λ_max(A_s)`; the symmetric part bounds the real spectrum (used in §1.2).
- C. Wissel (1984); M. Scheffer et al., *Nature* (2009) — critical slowing down / early-warning signals.
- B. D. O. Anderson (1977); Åström & Bohlin (1965) — persistent excitation / identifiability (invoked by analogy only in §3).
- J. Pathak et al. (2017–18) — reservoir reconstruction of attractors and Lyapunov spectra.
- I. Shumailov et al., *Nature* (2024) — model collapse under recursive training on synthetic data (§7).
- D. Amodei et al. (2016); J. Skalse et al. (2022) — reward hacking / specification gaming (§7).

*Web citations above are from prior knowledge; the live web-search backend was
unavailable when this was written and no URLs were fetched. Verify before formal
publication.*

---

*Source of record: `src/cio_sde/collapse.py` (Theorem 1, Σ₀, Σ₀⁻¹);
`tests/test_cio_sde.py` (20 passing); framework `docs/sigma0-collapse-certificate.tex`.
The §6 scripts `experiments/router_sigma0_encoder.py` and
`experiments/router_reservoir_G.py` are **referenced but not present** — §6 is
not reproducible until they are committed.*