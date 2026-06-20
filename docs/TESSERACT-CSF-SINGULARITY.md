# The 3¹² Convergence Lattice — CSF and the Tesseract Are One Object

**Date:** 2026-06-19
**Type:** Design consolidation (the "one pair → one lattice" singularity)
**Branch:** `research/convergence-tesseract-spiral`
**Status:** Consolidation of two existing designs into one. No new runtime object is
introduced — this doc proves that the **CSF format** and the **Converged Tesseract** are
the *same* `3**12` ternary lattice viewed from two faces, and re-files them under a single
Convergence-Core object so the project stops carrying two design threads.

**Grounding contract (External Reality Rule).** Every load-bearing claim is tagged
**[implemented]** (code exists and runs), **[grounded]** (external peer literature supports
it), or **[hypothesis — to be measured]**. Metaphor is labelled as metaphor.

**Reads first:** [`CONVERGANCE-SIGMA0-BRIEFING.md`](CONVERGANCE-SIGMA0-BRIEFING.md) (immutable North Star) ·
[`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md) ·
[`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md) ·
[`convergence-core-mapping.md`](convergence-core-mapping.md)

---

## TL;DR

> The project was carrying **two** designs — "CSF" (a binary memory/compression format) and
> "the Tesseract" (a 4-cube reasoning geometry). They are not two things. They are **one
> object**: a `3**12 = 531,441`-cell **balanced-ternary lattice**. CSF is how a point on the
> lattice is **stored**; the Tesseract spiral is how a point **moves** across it toward a
> fixed point. The substrate is already built ([`src/csf/v07/`](../src/csf/v07/) +
> [`src/converged_tesseract.py`](../src/converged_tesseract.py)); this doc unifies the
> vocabulary and the docs. Per the anti-sprawl law, **two design threads collapse to one
> Convergence-Core object.**

---

## 0. What is real vs. what is the contribution

| Component | Status | Source |
|---|---|---|
| `3**12` ternary state space, `NUM_DIMENSIONS=12`, `TOTAL_POSITIONS=531441` | **[implemented]** | [`qutrit_delta.py`](../src/csf/v07/qutrit_delta.py) |
| Sparse "dust" field: baseline + active deltas, most cells implicit | **[implemented]** | [`quantum_dust.py`](../src/csf/v07/quantum_dust.py) |
| Observer-collapsed wavefront over the `3**12` field | **[implemented]** | [`converged_tesseract.py`](../src/converged_tesseract.py) |
| Convergence-exit (contraction `‖Δh‖/‖h‖ < ε` to a fixed point) | **[implemented]** | [`loop_lm.py`](../src/sigma0/loop_lm.py) `converge_step` |
| Base-3 is the most economical integer radix | **[grounded]** | radix-economy literature (§5) |
| Ternary `{-1,0,+1}` is a viable, efficient compute substrate | **[grounded]** | BitNet b1.58 (§5) |
| Recurrent-depth latent trajectories spiral toward fixed points | **[grounded]** | Geiping et al.; STARS (§5) |
| **CSF ≡ Tesseract (one lattice, two faces)** | **[contribution — this doc]** | §3 |
| Each Convergence-12 component = one ternary axis | **[hypothesis — design]** | §2 |
| Dust-sparsity ≡ BitNet zero-weight sparsity | **[measured — refined (X3, 2026-06-19)]** — value-sparsity is population-dependent; not the same mechanism | §3.3, §6.1 |
| Convergence-exit measures contraction faithfully (not fooled by orbits/divergence) | **[measured — supported (X4, 2026-06-19)]** — instrument semantics validated | §6.1 |

The contribution is the bottom three rows: a **mapping**, not new machinery. Everything above
the divider already exists or is externally grounded.

---

## 1. The "pair" problem

Two threads grew up separately in the repo:

- **CSF** — *Convergence-Fitted Searchable Format*. A family of binary containers for memory
  ([`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md)): v0.3 symbolic, v0.7 qutrit
  engine, v0.8 CSF-Pack, v1 segmented. Framed as **storage**.
- **The Tesseract** — a 4-cube reasoning geometry: the Status-Cube (belief × observer × state)
  × a depth axis, with an inference trajectory that contracts to a fixed point
  ([`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md)).
  Framed as **geometry / reasoning**.

The North Star forbids exactly this: *"One loop. Four objects. Everything else is
implementation. Reject architectural sprawl."* Two parallel design vocabularies for what is
provably one mathematical object **is** sprawl. This doc removes it.

---

## 2. The lattice: why `3**12`

### 2.1 Base 3 — not mysticism, radix economy **[grounded]**

The width of a positional number system trades digit-count against per-digit cost. *Radix
economy* `E(b, N) = b · floor(log_b N + 1)` is minimised, over real bases, at `b = e ≈ 2.718`;
the closest integer is **3**, so **ternary is the most economical integer radix for large
state spaces** ([Wikipedia: Radix economy]; [Quanta, *How Base 3 Computing Beats Binary*];
Hayes, *Third Base*, American Scientist). **Balanced** ternary `{-1, 0, +1}` additionally gives
symmetric arithmetic (negation = digit flip; sign = leading nonzero digit) — the property that
made Setun (1958) work. This is the principled reason the lattice is base-3 and the CSF engine
is a *qutrit* engine, not a bit engine.

### 2.2 Twelve axes — the Convergence-12 **[hypothesis — design]**

The North Star defines **Convergence 12**: twelve native components, each owning one stage of
the loop or the system itself ([`CONVERGANCE-SIGMA0-BRIEFING.md`](CONVERGANCE-SIGMA0-BRIEFING.md)).
The lattice gives each component **one ternary axis**:

| Axis | Component | Ternary reading `{-1, 0, +1}` |
|---|---|---|
| 0 | Kernel | retreat / hold / advance the loop |
| 1 | Model-Broker | downgrade / keep / upgrade model tier |
| 2 | Memory | forget / hold / commit |
| 3 | Graph | prune / keep / link |
| 4 | Tools | abort / noop / execute |
| 5 | Coder | revert / hold / patch |
| 6 | Verify | refuted / unknown / confirmed |
| 7 | Dream (explore) | exploit / balance / explore |
| 8 | Observatory | stale / known / rescan |
| 9 | Sandbox | rollback / hold / commit |
| 10 | Convergence | diverging / stable / converging |
| 11 | Local | cloud / hybrid / local |

A **system state is one point in `{-1,0,+1}^12`** = `3**12 = 531,441` cells. The mapping in
this table is a *design proposal* (each axis's semantics is a hypothesis to validate against
the running components), but the **size and shape are implemented**:
[`qutrit_delta.py`](../src/csf/v07/qutrit_delta.py) hard-codes `NUM_DIMENSIONS = 12` and
`TOTAL_POSITIONS = 3 ** 12`.

### 2.3 The Status-Cube is a `3**3` projection **[implemented]**

The Status-Cube (belief × observer × state) is **three** of the twelve axes. It is the
human-readable shadow of the full lattice — a `3**3 = 27`-cell projection. "Tesseract" in the
spiral paper means the `3`-cube × ℝ depth product; the lattice generalises that to all twelve
axes. No physics is claimed; "tesseract/lattice" is a **precise geometric object**, and any
4-D-spacetime reading is metaphor and out of scope (consistent with the spiral paper's honesty
pass).

---

## 3. The singularity: one lattice, two faces

| | **Storage face — "CSF"** | **Motion face — "Tesseract"** |
|---|---|---|
| **Question** | *Where is the system?* | *Where is it going?* |
| **Object** | a point / delta-stream on the lattice | a trajectory across the lattice |
| **Code** | [`qutrit_delta.py`](../src/csf/v07/qutrit_delta.py), [`quantum_dust.py`](../src/csf/v07/quantum_dust.py), [`csf_pack.py`](../src/csf/csf_pack.py) | [`converged_tesseract.py`](../src/converged_tesseract.py), [`loop_lm.py`](../src/sigma0/loop_lm.py) |
| **Operation** | `observe(pos, deltas)` / `get_state(pos)` | `update_present(t)` → wavefront slice; `converge_step` → fixed point |
| **Loop stage** | **Remember** | **Observe → Reason → Act → Verify → Converge** |
| **External anchor** | BitNet ternary storage; CSF radix economy | recurrent-depth latent reasoning; STARS stability |

The two faces share **one** state representation, so they are one object. Concretely:

### 3.1 Storage face — CSF writes a point **[implemented]**

A lattice cell is a 12-vector of `QutritState(amplitude 0-7, phase 0-7)`. Change is a list of
`QutritDelta(dim_index, amp_delta, phase_delta)` packed to **2 bytes each**
([`qutrit_delta.py`](../src/csf/v07/qutrit_delta.py)). The `QuantumDustField`
([`quantum_dust.py`](../src/csf/v07/quantum_dust.py)) holds a **baseline** (converged cells) +
**active deltas** (deviations); every other cell is implicit **"dust."** `get_state` resolves
`baseline ⊕ deltas`, else returns `None` (dust). This is CSF's symbolic v0.7 lineage — the
storage face.

### 3.2 Motion face — the Tesseract moves the point **[implemented]**

`ConvergedTesseract` ([`converged_tesseract.py`](../src/converged_tesseract.py)) never
materialises all `531,441` cells. It loads a **minimal observer-collapsed wavefront** — the
cells within a ternary-Hamming radius of the present `center`, ranked by information density
(active deltas > baseline > dust). The wavefront *is* the spiral's current position; advancing
`update_present(t)` walks the lattice. `loop_lm.converge_step` supplies the **stopping rule**:
iterate until `‖h_t − h_{t-1}‖ / ‖h_{t-1}‖ < ε`, i.e. until the trajectory reaches a fixed
point `h* ≈ f(h*)`. Storage face says *where*; motion face says *toward what*.

### 3.3 The cross-grounding — claimed, then measured and **refined** **[measured (X3)]**

The most economical observation in `quantum_dust.py` is that **"no change" is nearly free**:
most cells are dust, so confirmations cost nothing. This *resembles* BitNet b1.58's empirical
finding that **~66 % of ternary weights settle to 0** and zeros are skipped (matmul → add)
(§5). The original draft of this section claimed the two were **"the same phenomenon."**
**X3 measured it and refined that down** (§6.1):

- The naive `dust_percentage` (address sparsity) is **~99.95 %** for *every* field — a category
  error vs BitNet, which has no empty address space.
- The fair, BitNet-comparable metric is **value-sparsity** (fraction of stored `(cell, dim)`
  amplitude slots equal to 0). It is **population-dependent**: **0.137** for a uniform-random
  field (≈ the 1/8 prior — confirming the metric is honest), **0.835** for the realistic
  populator, and it reaches BitNet's **0.66 only when the population is deliberately tuned** to it.
- BitNet's ~66 % is a **learned** 2/3 ternary mass; the dust field's rate is **structural /
  data-dependent**. They share a *substrate*, not a *mechanism* — matching the number is a
  coincidence of population.

So the lattice unification (§3.1–3.2, all `[implemented]`) **stands**; the *sparsity-equivalence
sub-claim* is **weaker than first stated** and now reads "the dust field *can exhibit*
BitNet-like value sparsity," not "is the same phenomenon." Honest convergence, exactly as the
External Reality Rule intends.

---

## 4. Where this lives in the loop

```
        ┌──────────────── one 3^12 balanced-ternary lattice ────────────────┐
        │                                                                    │
 Observe ─► Remember ─► Reason ─► Act ─► Verify ─► Converge                   │
   │           │          │        │       │          │                      │
   │        CSF writes   Tesseract wavefront walks   convergence-exit         │
   │        the point    selects/moves the point     contracts to h*         │
   └────────── storage face ──────┴────────── motion face ──────────────────┘
```

Nothing new is added to the loop. The lattice is the **substrate** the four core objects
(Memory, Task, Tool, ConvergenceRecord) already live on:

- a **Memory** is a stored lattice point (+ its delta history) — CSF face;
- a **ConvergenceRecord** is a measured contraction step toward `h*` — Tesseract face;
- **Tasks/Tools** select which axis (component) the next delta acts on.

---

## 5. External grounding (sources)

**Why base-3 (storage radix):**
- *Radix economy* — base 3 minimises digit-cost; optimum is `e`, nearest integer 3.
  [Wikipedia: Radix economy](https://en.wikipedia.org/wiki/Radix_economy) ·
  [Quanta — *How Base 3 Computing Beats Binary*](https://www.quantamagazine.org/how-base-3-computing-beats-binary-20240809/) ·
  [American Scientist — *Third Base*](https://www.americanscientist.org/article/third-base)

**Ternary as a real compute substrate (storage ↔ compute):**
- BitNet b1.58 — every weight `{-1,0,+1}`, ~66 % zeros, matmul→add, ~16–32× memory cut.
  [arXiv:2402.17764](https://arxiv.org/abs/2402.17764) ·
  [microsoft/BitNet](https://github.com/microsoft/BitNet)
- Sparse-BitNet — 1.58-bit models are naturally semi-structured-sparsity friendly.
  [arXiv:2603.05168](https://arxiv.org/pdf/2603.05168)
- T-SAR — CPU-only ternary LLM inference via in-place SIMD ALU reorganisation.
  [arXiv:2511.13676](https://arxiv.org/pdf/2511.13676)
- Hyperdimensional computing / Vector Symbolic Architectures — ternary `{-1,0,1}` sparse
  high-dimensional codes. [arXiv:2111.06077](https://arxiv.org/abs/2111.06077) ·
  [Part II — arXiv:2112.15424](https://arxiv.org/abs/2112.15424)

**Spiral / motion-to-fixed-point (the Tesseract face):**
- Geiping et al. — *Scaling up Test-Time Compute with Latent Reasoning: A Recurrent Depth
  Approach*; reports emergent **orbit trajectories, directional drift, per-token convergence
  rates**. [arXiv:2502.05171](https://arxiv.org/pdf/2502.05171)
- STARS — *Stabilizing Recurrent Dynamics …*: constrains latent states to **asymptotically
  stable fixed points** via Jacobian Spectral Radius Regularisation with random loop sampling.
  Directly addresses the spiral paper's open **non-normal-operator** gap.
  [arXiv:2605.26733](https://arxiv.org/html/2605.26733)
- SpiralFormer — looped transformers learn hierarchical dependencies via multi-resolution
  recursion. [arXiv:2602.11698](https://arxiv.org/pdf/2602.11698)
- *A Survey on Latent Reasoning*. [arXiv:2507.06203](https://arxiv.org/pdf/2507.06203)
- Ouro LoopLM (weight-tied recurrence + Q-exit), the substrate the spiral paper extends.
  [arXiv:2510.25741](https://arxiv.org/abs/2510.25741)

---

## 6. Falsify before you believe

| # | Claim | Method | Kills the claim if… |
|---|---|---|---|
| **X1** | Round-trip integrity: any lattice point survives CSF store→load | pack a `QuantumDustField`, unpack, diff states | any cell differs |
| **X2** | The wavefront is genuinely minimal | measure active-cell count vs `531,441` over a session | wavefront ≈ full field (no compression win) |
| **X3** | Dust-sparsity ≈ BitNet zero-sparsity | steady-state `dust_percentage` of a converged field on real memory | far from the ~2/3 ternary-zero regime |
| **X4** | Motion converges, not orbits | log `mean_contraction` from `converge_step` per axis | `‖Δh‖/‖h‖` does not decrease (it orbits/diverges) |

X3 and X4 are the load-bearing ones: X3 tests whether storage-sparsity and compute-sparsity
are the same phenomenon; X4 tests whether the spiral actually spirals. **Both were run on
2026-06-19** — see §6.1.

### 6.1 Measured results (2026-06-19)

Run via a Workflow (implement → run → 3-lens adversarial verify; all six verifier lenses
returned **sound, reproduced = true**). Reproducible scripts:
[`experiments/x3_dust_vs_bitnet_sparsity.py`](../experiments/x3_dust_vs_bitnet_sparsity.py) and
[`experiments/x4_converge_step_instrument.py`](../experiments/x4_converge_step_instrument.py)
(run as `PYTHONPATH=src python …`); raw numbers in
[`experiments/results/`](../experiments/results/).

**X3 — dust vs BitNet sparsity → `refined`.** Address sparsity (`dust_percentage`) = **0.99951**
for every field — a category error vs BitNet, which has no empty address space. The fair
*value*-sparsity (zero fraction over stored `(cell,dim)` amplitudes) is **population-dependent**:
**0.137** uniform-random (≈ the 1/8 prior — the metric is honest) · **0.835** realistic populator ·
**0.6625** only when deliberately tuned to BitNet's 0.66 · spread **0.698**. BitNet's 66 % is
*learned*; the field's rate is *structural / data-dependent*. → The sparsity-equivalence
sub-claim (§3.3) is **weakened, not confirmed**; the lattice unification itself (§3.1–3.2) is
untouched.

**X4 — `converge_step` contraction instrument → `supported` (semantics).** On synthetic
trajectories of known type (eps = 0.05, max_steps = 12): **contraction** `h_t = h* + 0.5^t(h_0−h*)`
→ deltas `[0.50, 0.47, 0.39, 0.25, 0.13, 0.068, 0.034]`, exits step 8 `fixed_point`; **orbit**
(constant-norm rotation) → rel pinned at 0.134, `max_depth`, **no false fixed_point**;
**divergence** `1.3^t·h_0` → rel 0.30, `max_depth`. The instrument faithfully reports contraction
and is **not fooled** by orbits or divergence. Honest caveats: this validates the *measurement
semantics* against a faithful reference implementation, **not** a real Ouro trajectory — the
verification ran on branch `auto/issue-732` where `loop_lm.converge_step` is absent (it ships
here on `research/convergence-tesseract-spiral`, [`loop_lm.py`](../src/sigma0/loop_lm.py) §3);
the optional real Ouro-1.4B CPU run failed cleanly on a `huggingface-hub` version conflict
(torch is CPU-only).

**Still open:** X1 (CSF round-trip integrity) and X2 (wavefront minimality) — not yet run.

---

## 7. Honest scope

- The **mapping** (§3) is the contribution; the lattice itself is pre-existing code.
- The **axis semantics** in §2.2 are a design proposal, not measured behaviour.
- `{-1,0,+1}` (balanced) vs `{0,1,2}` (the engine's current unsigned `pos % 3`) differ by a
  `−1` shift; the engine stores unsigned today. Adopting balanced ternary end-to-end is a
  **follow-up**, not a claim of current state.
- "Tesseract / lattice" is geometry (`3`-cube × axes), **not** a physics result.
- This is all **inference-time / storage-time**: no pretraining, no weight modification —
  consistent with the North Star ("learning through retrieval, not retraining").

---

## 8. What changes in the repo (consolidation, not addition)

Tracked by the comet leap [`COMET-LEAP-P2-TESSERACT-CSF-SINGULARITY.md`](COMET-LEAP-P2-TESSERACT-CSF-SINGULARITY.md):

1. **This doc** becomes the single design reference for the `3**12` lattice.
2. [`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md) gains a "lattice view" pointer
   (qutrit_delta = the storage face).
3. [`RESEARCH-CANON.md`](RESEARCH-CANON.md) gains the external anchors above under the right
   components.
4. [`convergence-core-mapping.md`](convergence-core-mapping.md) reclassifies CSF from
   "implementation-detail leak" to "storage face of the lattice."
5. [`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md)
   gains the STARS citation (closes its non-normal gap) and a cross-link here.
6. [`skills/convergence-mathematical-foundations`](../skills/convergence-mathematical-foundations/SKILL.md)
   gains a "3¹² Convergence Lattice" section.
