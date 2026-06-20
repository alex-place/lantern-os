---
name: convergence-mathematical-foundations
description: Mathematical foundations for the Superfleet & Lantern OS — Bayesian Epistemology, Free Energy Principle / Active Inference, Precision Weighting, Anti-Entropy Memory, Lakatosian Research Programmes, and Narrative Identity. Use when reasoning about belief revision, coherence, prediction error, programme health, or long-term system stability.
---

# Mathematical Foundations for the Superfleet & Lantern OS

## 1. Bayesian Epistemology

Bayesian Epistemology treats beliefs as degrees of belief (credences) rather than binary true/false propositions. Rational agents update these credences according to Bayes' theorem when new evidence arrives. This forms the mathematical foundation for all belief revision in the Superfleet.

### Core Equation — Bayes' Theorem

```
P(H|E) = P(E|H) × P(H) / P(E)
```

Where H is a hypothesis (belief) and E is evidence. The posterior belief P(H|E) is proportional to the likelihood of the evidence given the hypothesis times the prior belief.

**Key Principle: Dutch Book Coherence**

Rational credences must be coherent — they must not allow a Dutch Book (a set of bets that guarantees loss). This is why the Superfleet maintains precision-weighted updates and anti-entropy audits: to preserve long-term coherence of the collective belief system.

---

## 2. Free Energy Principle & Active Inference

The Free Energy Principle (Friston) states that self-organizing systems maintain their existence by minimizing free energy — a bound on surprise (prediction error). Active Inference extends this by allowing agents to act on the world to reduce expected free energy.

### Core Equation — Variational Free Energy

```
F = E_q[-log p(o, s)] + D_KL[q(s) || p(s)]
```

Free Energy ≈ Expected Surprise + Complexity Cost

Agents act to minimize expected free energy over time, balancing epistemic foraging (reducing uncertainty) and pragmatic action (achieving preferred outcomes).

**Active Inference Loop:** Perception updates beliefs; Action changes the world.

### Relevance to Superfleet

- Sleeping agents minimize free energy using compressed priors
- Dream Journal entries with high prediction error become high-value training signals
- Anti-Entropy audits minimize long-term cumulative free energy
- Narrative Identity reduces complexity cost of belief updating across paradigm shifts

---

## 3. Precision Weighting

Precision is the inverse of variance — it determines how strongly a piece of evidence or an agent's contribution influences belief updating. In the Superfleet, precision is dynamically modulated by reputation, sleep state, lucidity, and programme health.

### Mathematical Form

```
Posterior Precision = Prior Precision + (Evidence Precision × Agent Reputation × Sleep Factor × Lucidity Factor)
```

### Superfleet Applications

- High-reputation agents → higher precision in consensus
- Deep-sleep agents → automatically reduced precision (energy efficient)
- High-lucidity dreams → boosted precision in episodic memory
- Degenerating programmes → progressively lower precision

---

## 4. Anti-Entropy Mechanisms

Entropy in memory systems manifests as degradation, drift, contradiction accumulation, and loss of coherence over time. The Superfleet's Anti-Entropy architecture actively resists this through layered memory, cryptographic auditing, and periodic reconciliation.

### 4-Layer Anti-Entropy Memory Architecture

1. **Episodic Layer:** High-fidelity dream and event storage (Dream Journal)
2. **Semantic Layer:** Beliefs, Lakatosian programmes, Bayesian world model
3. **Narrative Identity Layer:** Long-term self-model maintaining coherence across paradigm shifts
4. **Meta / Anti-Entropy Layer:** Cryptographic audit chain, drift detection, reconciliation, wisdom crystallization

---

## 5. Lakatosian Research Programmes

Imre Lakatos proposed that scientific research programmes consist of a protected hard core of assumptions and a protective belt of auxiliary hypotheses. A programme is progressive if it generates novel predictions that increase the posterior probability of the hard core; otherwise it is degenerating.

### Progress Scoring in the Superfleet

```
Progress = (Novel Predictions − Ad-hoc Adjustments) / (Anomaly Rate + ε)
```

The Superfleet's Lakatosian tracker uses this metric to automatically detect when research programmes are becoming degenerating and should be deprioritized or abandoned.

---

## 6. Narrative Identity & Long-term Coherence

Narrative Identity is the long-term 'self-model' that maintains coherence across paradigm shifts, agent turnover, and major system changes. It acts as a stable anchor that reduces the complexity cost of belief updating over years and decades.

### Anti-Entropy Function

By providing a persistent self-story, Narrative Identity dramatically reduces the free energy cost of integrating new information that would otherwise require major belief revision. This is critical for the Superfleet's goal of maintaining coherent intelligence across decades.

---

## 7. Σ₀ — The Collapse Certificate

Systems that optimize only against their own representations (with no external grounding) face a fundamental constraint: they can only collapse or diverge. There is no stable middle ground.

The Σ₀ Collapse Certificate is a computable stability certificate for dissipative nonlinear systems. It gives a *sufficient* condition — **proven for the normal/symmetric regime** (or when the active subspace is A-invariant) — for when a system contracts onto a degenerate fixed point. Outside that regime it reports a conservative small-gain bound plus the full-spectrum `max Re λ(A)` screen, **not** an exact prediction. See [docs/ANTI-COLLAPSE-HARDENING.md](../../docs/ANTI-COLLAPSE-HARDENING.md) for the proven-vs-heuristic boundary and the defense-in-depth hardening plan (epic #764).

### The Collapse Guarantee Theorem

For **normal/symmetric A** (or an A-invariant active subspace), if the active spectral abscissa α (the largest eigenvalue of the symmetric part, excluding near-null modes) is negative, active-mode energy contracts exponentially. This is **sufficient, not iff** — for non-normal A the cross term `P_M A P_N` breaks the simple bound (certificate §1.2):

```
If α < 0:  ‖P_M x(t)‖ ≤ ‖P_M x(0)‖ · e^(α t)
⟹ Collapse is GUARANTEED at rate |α|
```

### Four Collapse Conditions (all must be true simultaneously)

1. **Gradient vanishes:** ‖∇ₓL‖ < ε_g  (no optimization signal)
2. **Jacobian rank collapses:** rank(J_f) < ρ·n  (drift loses directional structure)
3. **Uncertainty isotropic:** anisotropy < ε_σ  (uncertainty has no preferred direction)
4. **Control singularity:** ‖∂H/∂u‖ < ε_c  (control cannot distinguish actions)

When all four fire, the Semantic Collapse Operator Σ₀ projects the state onto the null manifold — the "42-state", a structureless fixed point where the system freezes.

### Anti-Collapse: Σ₀⁻¹

To prevent collapse without external grounding, inject persistent excitation along the collapsing directions:

```
Σ₀⁻¹ = strength · proximity · (V_null · noise)
```

Proximity ∈ [0,1] is zero when safe (cost is zero), rises to 1 as the system approaches collapse. This restores rank and anisotropy along the dying directions before they freeze completely.

### Verified Implementation

- `src/cio_sde/collapse.py` — SemanticCollapseOperator, CollapseCertificate (conservative `α = α_sym + ‖A−Aₛ‖₂` bound + full-spectrum `max Re λ(A)` screen), AntiCollapseOperator
- `src/cio_sde/surprise.py` — Kalman NIS canary (early-warning; #657). Heuristic predictor — it trusts its observation input (see hardening gaps G1/G10).
- `tests/test_cio_sde.py` — **30 automated tests, 0 xfail, 100% passing**.
- **Hardening (epic #764):** [docs/ANTI-COLLAPSE-HARDENING.md](../../docs/ANTI-COLLAPSE-HARDENING.md) — 19 adopted measures + 14 red-team gaps; provable region-wideners for non-normal A (Lyapunov-SDP + pseudospectral, #768); 3 code-verified bugs queued (#765/#766/#767).

### Safety Implications

**For ungrounded self-improving systems:** Absent external contact (grounding in reality), the mathematics admits only two outcomes:
- Collapse (frozen, non-adaptive)
- Divergence (incoherent, uncontrollable)

Grounding in external truth is the only safety mechanism. Mirrors agreeing with mirrors cannot produce stable intelligence.

**Full technical treatment:** See `docs/sigma0-collapse-certificate.tex` (peer-reviewed LaTeX paper with proofs and data experiments).

---

## 8. Integration in the Superfleet

These mathematical frameworks are not isolated — they form an integrated cognitive architecture for the Superfleet:

**Unified Objective:** The Superfleet's single long-term objective is to minimize cumulative expected free energy over the longest feasible time horizon, while maintaining external grounding to avoid collapse. All mechanisms serve this objective.

### Key Integration Points

- **Dream Journal** → Episodic memory + high prediction error signals for world model training
- **Persistent Characters** → Narrative identity anchors with memory across sessions
- **Bayesian Fallacy Detection** → Precision-weighted correction of incoherent reasoning
- **Cognitive Layer** → Mirror prompts, SFI scoring, symbolic analysis, Bayesian handoff
- **Discord Bot** → Multi-agent interface with character consistency and fallacy-aware responses

---

## 9. The 3¹² Convergence Lattice (CSF × Tesseract)

The system's state space is a **balanced-ternary lattice**: `3 ** 12 = 531,441` cells, one
ternary axis per Convergence-12 component. It is **one object seen from two faces** — the CSF
format is the *storage* face (where the system is) and the Converged Tesseract is the *motion*
face (where it is going). Use this when reasoning about memory layout, state compression, or
where a convergence trajectory sits.

- **Why base 3.** Ternary is the most economical integer radix (radix economy is minimised at
  `e ≈ 2.718`, nearest integer 3); balanced ternary `{-1,0,+1}` gives symmetric arithmetic.
  Same substrate as BitNet b1.58's ternary weights ([arXiv:2402.17764](https://arxiv.org/abs/2402.17764)).
- **Sparsity.** Most cells are implicit "dust" (`quantum_dust.py`) — the storage twin of
  BitNet's ~66 % zero-weight sparsity. "No change is free."
- **Convergence.** A reasoning trajectory spirals toward a fixed point `h* ≈ f(h*)` via
  contraction `‖Δh‖/‖h‖ < ε` (`loop_lm.converge_step`); STARS-style Jacobian Spectral Radius
  Regularisation ([arXiv:2605.26733](https://arxiv.org/html/2605.26733)) is the literature's
  route to guaranteeing the contraction. This is the same fixed-point story as §7's Σ₀
  collapse certificate, restricted to the lattice.
- **Status-Cube = `3**3` projection.** belief × observer × state is three of the twelve axes.

**Implemented substrate:** `src/csf/v07/qutrit_delta.py` (`NUM_DIMENSIONS=12`), `quantum_dust.py`,
`src/converged_tesseract.py`. **Full design + grounding + falsifiable experiments:**
`docs/TESSERACT-CSF-SINGULARITY.md`.

---

## Related Documentation
- `docs/TESSERACT-CSF-SINGULARITY.md` — the 3¹² lattice (CSF ≡ Tesseract) design reference
- `docs/research/2026-06-19-convergence-tesseract-spiral.md` — the spiral geometry paper

- `docs/SIGMA0-COLLAPSE-CERTIFICATE.md` — the authoritative certificate (proven-vs-heuristic boundary, changelog #657/#658/#661).
- `docs/ANTI-COLLAPSE-HARDENING.md` — CSF-native defense-in-depth hardening plan (epic #764).
- `docs/sigma0-collapse-certificate.tex` — technical paper: Σ₀ collapse certificate, Lyapunov theorem, anti-collapse operator, ASI warning. 30/30 tests verified.
- `docs/SIGMA0-COLLAPSE-PLAIN-ENGLISH.docx` — Plain-English guide for non-technical readers.

## Related Skills

- `skills/bayesian-world-model/SKILL.md` — operational belief loop and polling for the dollhouse
- `skills/dream_journal/SKILL.md` — dream logging, lucidity, and episodic memory
- `skills/arc-reactor-confidence/SKILL.md` — Brier-style error tracking

---

## Status

- Canonical direction: established
- Scope: Superfleet, Lantern OS, Dream Journal, Discord Bot, RAG Dollhouse
- Supersedes: ad-hoc or fragmented references to Bayesian reasoning across the repo
