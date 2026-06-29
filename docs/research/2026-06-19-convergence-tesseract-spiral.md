---
author: Alex Place
created: 2026-06-19
updated: 2026-06-20
---

# From Early-Exit to Convergence: Recasting LoopLM Recurrence as a Continuous Contraction Spiral over the Status-Cube

**Date:** 2026-06-19
**Type:** Research paper (proposal + first prototype)
**Status:** Draft. Contribution is inference-time math + a falsifiable experiment harness. No pretraining claim; no model selected; one code path added (`mode="converge"` in [`src/sigma0/loop_lm.py`](../../src/sigma0/loop_lm.py)).

> **⛔ E2 RUN AND REFUTED 2026-06-28.** Measured on the real Ouro-1.4B: the latent loop does **not** contract within its 4 trained steps (per-step `‖Δh‖/‖h‖` still ~0.18–0.22 at the final step), so `mode="converge"` exit never fires at ε=0.05 and the contraction-spiral premise collapses to a relabel of Q-exit — exactly as §6 warned. The usable adaptive-depth signal is the **trained Q-exit gate**, not latent contraction. Evidence + the salvage: [`2026-06-28-csf-tesseract-novelty-and-e1-kill.md`](2026-06-28-csf-tesseract-novelty-and-e1-kill.md).
**Grounding contract:** External Reality Rule. Every load-bearing claim is tagged **[implemented]**, **[proven (conditional)]**, or **[hypothesis — to be measured]**. Metaphor is labeled as metaphor.

Related canon: [`OURO-LOOPLM.md`](../OURO-LOOPLM.md) · [`SIGMA0-OURO-CODER.md`](../SIGMA0-OURO-CODER.md) · [`SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md) · [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md) · [`2026-06-19-kernel-model-frontier.md`](2026-06-19-kernel-model-frontier.md) · [`TESSERACT-CSF-SINGULARITY.md`](../TESSERACT-CSF-SINGULARITY.md) (this spiral is the **motion face** of the 3¹² lattice)

---

## Abstract

Ouro's LoopLM ([arXiv:2510.25741](https://arxiv.org/abs/2510.25741)) reuses weight-tied
layers R times in latent space and exits via a learned **Q-exit** gate — it stops looping at
the first recurrent step where a cumulative exit-probability CDF crosses a quality knob `q`.
We observe that this is a recurrence that **halts on confidence**, not one that **converges on
a fixed point**: the loop can stop while the latent state is still moving. We propose three
upgrades. **(1)** Replace confidence-exit with **convergence-exit**: iterate the weight-tied
block until the last-token hidden state contracts, ‖hₜ − hₜ₋₁‖/‖hₜ₋₁‖ < ε, i.e. until
h\* ≈ f(h\*). This inherits the Σ₀ collapse certificate's fixed-point guarantee — **for normal
operators only**, a gap we state up front. **(2)** Advance the *convergence-loop stage*
(Observe→Remember→Reason→Act→Verify→Converge) on each recurrent step instead of looping in
place, turning a circle into a **spiral**. **(3)** Take the continuous (Neural-ODE) limit, so
the trajectory is a curve over the Status-Cube **× depth** manifold — a **tesseract-shaped
spiral**, used here as a precise geometric claim (a 3-cube × ℝ product), not a physics
metaphor. We ship a measurable prototype of (1) and a four-experiment plan that can falsify the
central claim before any of the prose is trusted.

---

## 1. What is real vs. what is the contribution

| Component | Status | Source |
|---|---|---|
| Q-exit recurrence `exit = first t: CDF(t) ≥ q` | **[implemented]** | [`loop_lm.py`](../../src/sigma0/loop_lm.py) §3 |
| Convergence loop Observe→…→**Converge** | **[implemented]** (architecture) | [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md) |
| Σ₀ collapse / fixed-point (Theorem 1) | **[proven (conditional)]** — normal operators only | [`SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md) |
| Status-Cube (belief × observer × state) | **[implemented]** (data model) | Status Cube / Impossibility Engine |
| Convergence-exit `mode="converge"` | **[implemented — this paper]** | [`loop_lm.py`](../../src/sigma0/loop_lm.py) `converge_step` |
| Stage-advancing spiral | **[hypothesis — to be measured]** | §4, E4 |
| Continuous tesseract spiral (ODE limit) | **[hypothesis — formal only]** | §5 |

The contribution is the bottom three rows. The top four are the substrate we build on, cited so
the paper does not re-import the unsourced-claim mistake.

---

## 2. Background: Q-exit halts, it does not converge

The paper's per-token rule (reproduced in [`loop_lm.py`](../../src/sigma0/loop_lm.py)):

```
λ_t  = σ(gate_t)                 instantaneous exit prob at step t
S_t  = Π_{j≤t}(1 - λ_j)          survival
p_t  = λ_t · S_{t-1}             exit pdf
CDF  = Σ_{j≤t} p_j
exit = first t with CDF(t) ≥ q   Q-exit
```

`q` is a *compute/quality knob*, not a convergence criterion. Two latent states with identical
gate logits exit at the same depth even if one has settled (hₜ ≈ hₜ₋₁) and the other is still
slewing. The gate is trained to predict "good enough to decode," which correlates with — but is
not — "the recurrence has reached a fixed point." **This paper's wedge is that gap.**

---

## 3. Upgrade 1 — convergence-exit (implemented)

Let f be the weight-tied recurrent block, hₜ = f(hₜ₋₁) the last-token latent at depth t. Exit at

> **t\* = first t with ‖hₜ − hₜ₋₁‖ / ‖hₜ₋₁‖ < ε**,  reported reason `fixed_point`.

If f is a contraction (Lipschitz constant L < 1 in the operative norm) then by Banach the
iteration converges to a unique h\* = f(h\*) and ε directly bounds the residual. **This is where
the Σ₀ collapse certificate plugs in**: Theorem 1 establishes the fixed-point/collapse property
**for normal operators**; the non-normal case is the certificate's known open gap (cross-term),
so convergence-exit's guarantee is **conditional**, and the abstract says so.

**Prototype (shipped in this branch).** [`Sigma0LoopLM.converge_step`](../../src/sigma0/loop_lm.py)
computes the contraction trajectory `‖Δh‖/‖h‖` over `hidden_states_list` — data the Ouro forward
pass **already returns** — and exits at the first sub-ε step. `generate(mode="converge", eps=…)`
returns `mean_contraction` per run. No new weights, no pretraining: it reads the existing latent
trajectory and changes only the stopping rule. Baseline (`mode="qexit"`) is unchanged and
remains the default, so the comparison is apples-to-apples on one model.

---

## 4. Upgrade 2 — loop → spiral (stage-advancing recurrence)

Today every recurrent step reuses the same block at the same point in the convergence loop: a
**circle** in (latent × stage) space. Bind the recurrent index to the convergence **stage** s(t)
∈ {Observe, Remember, Reason, Act, Verify, Converge} so each step both deepens latent reasoning
(Ouro's depth axis) and rotates the control phase. A trajectory that returns to "Observe" at
*greater latent depth* each orbit is, by definition, a **spiral**, not a loop:

```
   stage (angular)  ──►  Observe → Remember → Reason → Act → Verify → Converge ─┐
   depth  (radial)  ──►  each full orbit exits one radius deeper toward h*      │
                         └────────────────────── spiral ◄──────────────────────┘
```

**[hypothesis — E4]:** binding stage to depth beats fixed-stage recurrence at equal mean depth.
Falsifiable, not asserted.

---

## 5. Upgrade 3 — the continuous tesseract spiral (formal)

Take the discrete recurrence to its continuous limit:

> **dh/dτ = g(h, s(τ))**,  with s(τ) the convergence-stage phase, τ the continuous depth.

The Status-Cube is 3-D (belief × observer × state). Adjoining the continuous depth/phase axis τ
makes the state space a **4-cube (tesseract)** = (3-cube) × ℝ, and the inference trajectory a
continuous curve on it whose *projection onto belief-space contracts to a fixed point*. "Tesseract
spiral" is therefore a **precise geometric object** — a geodesic-like spiral on the 3-cube × ℝ
manifold — and is used in that sense only. Any 4-D-physics reading is **metaphor** and is out of
scope (per the [collapse-certificate honesty pass](../SIGMA0-COLLAPSE-CERTIFICATE.md), physics
framing must be labeled, not claimed). The discrete prototype in §3 is the Euler discretisation
of this ODE; the continuous form is presented as formal structure, **not** as running code.

---

## 6. Experiments (falsify before you believe)

All run via [`scripts/eval_keystone.py`](../../scripts/eval_keystone.py) against the golden set
[`data/eval/sigma0-prompts.jsonl`](../../data/eval/sigma0-prompts.jsonl); rows land in the
standing leaderboard, not in this prose.

| # | Question | Method | Kills the claim if… |
|---|---|---|---|
| **E1** | Does convergence-exit match Q-exit accuracy at lower depth? | `mode=converge` vs `mode=qexit`, compare accuracy + `mean_depth` | accuracy drops or depth rises |
| **E2** | Does the recurrence actually contract? | log `mean_contraction`; sweep ε | `‖Δh‖/‖h‖` does not decrease across steps (orbits/diverges → no spiral) |
| **E3** | Where does the guarantee break? | normal vs non-normal blocks | non-normal contracts as well as normal (then Theorem 1's gap is moot — or the math is wrong) |
| **E4** | Does the spiral beat the circle? | stage-bound vs fixed-stage recurrence | equal/worse accuracy at equal depth |

**E2 is the load-bearing experiment.** If the latent trajectory does not contract, there is no
fixed point, no spiral, and the paper collapses to a relabeling of Q-exit. We prototype E2 first.

---

## 7. Honest scope

- Theorem 1 is proven **only for normal operators**; convergence-exit's guarantee is conditional
  and the non-normal case is open ([certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md)).
- "Tesseract" is a geometric claim (3-cube × ℝ), **not** a physics result.
- Everything here is **inference-time**: no pretraining (Ouro needed 7.7T tokens), no new weights.
- Only the `mode="converge"` path and `converge_step` are code; §4–5 are formal/▮hypothesis.
- Numbers do not exist yet. This document is **not** trustworthy until E1/E2 produce leaderboard
  rows — by design.

---

### Sources
- Ouro LoopLM — [arXiv:2510.25741](https://arxiv.org/abs/2510.25741)
- Coconut (continuous latent reasoning) — [arXiv:2412.06769](https://arxiv.org/abs/2412.06769)
- Internal: [`loop_lm.py`](../../src/sigma0/loop_lm.py) · [`SIGMA0-COLLAPSE-CERTIFICATE.md`](../SIGMA0-COLLAPSE-CERTIFICATE.md) · [`CONVERGANCE-SIGMA0-BRIEFING.md`](../CONVERGANCE-SIGMA0-BRIEFING.md)
