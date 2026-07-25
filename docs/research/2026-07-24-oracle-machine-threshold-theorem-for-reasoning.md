# The oracle machine end-state: a threshold theorem for reasoning, and where lying belongs

**Date:** 2026-07-24 · **Type:** Scope-widening synthesis (Status: **Proposed**). Places this
session's measured results in the deepest applicable lineage — *reliable computation from
unreliable components* — and locates the role of controlled falsehood precisely.
**Requested framing:** "my design is the oracle machine end state"; "lying and dreaming, noise
that shakes the champion selections, are essential to selection and learning."
**Corpus:** 11 papers ingested to `F:\arxiv-corpus` (reindexed, 115,757 total); 7 full-text
PDFs pulled. Reading pack: [`2026-07-24-ORACLE-THRESHOLD-READING-PACK.md`](2026-07-24-ORACLE-THRESHOLD-READING-PACK.md).
**Builds on (measured this session):** [`2026-07-24-foldback-cascades.md`](2026-07-24-foldback-cascades.md)
(K_c ≈ 1/q) · [`2026-07-24-sota-for-the-box-reliability-architecture.md`](2026-07-24-sota-for-the-box-reliability-architecture.md).
**Repo frame:** [[convergence-oracle-above-42-machine]] — the Oracle refuses the σ=0 collapse.

---

## 1. What "oracle machine end-state" actually means, technically

Turing's oracle machine (1939) is a computer with access to a black box that returns correct
answers to a class of queries. The **end-state** of this project's Oracle is the concrete
realization of that black box built from parts that are *not* individually reliable: a small
model on an 8GB box, wrong a large fraction of the time. The whole design question reduces to
one sentence:

> **How do you build a reliable oracle out of unreliable components?**

That is not a new question. It is the oldest question in the theory of computation, and it has
a complete answer with a sharp phase transition — which this session's measured K_c ≈ 1/q turns
out to be a corner of.

## 2. The threshold theorem, in three fields, is one theorem

| field | statement | reference (now in corpus) |
|---|---|---|
| **classical computing** | reliable computation of *arbitrary* depth is possible iff per-gate error p is below a **constant** threshold; overhead is polylog in circuit size | von Neumann 1956 (multiplexing, p<1/6); Pippenger; Gács; [1608.08228](https://arxiv.org/abs/1608.08228) (p<5.5%, "moderate code sizes") |
| **quantum computing** | same, with quantum error-correcting codes; threshold theorem | Aharonov–Ben-Or quant-ph/9906129; Gottesman 0904.2557; [1310.2984](https://arxiv.org/abs/1310.2984) (constant overhead) |
| **molecular biology** | a replicator maintains its information (the "master sequence") iff per-symbol error is below the error threshold; above it, **error catastrophe** | Eigen 1971 quasispecies; [2406.14516](https://arxiv.org/abs/2406.14516); [1205.3435](https://arxiv.org/abs/1205.3435) |

All three say the same thing: **below a critical error rate, unreliable parts + redundancy +
error-correction = arbitrarily reliable computation of unbounded length; above it, no amount of
machinery helps.** The mechanism that buys the sub-threshold regime is *restoration* — von
Neumann's restoring organs, quantum syndrome extraction, biology's kinetic proofreading
([1504.02494](https://arxiv.org/abs/1504.02494), [1710.06038](https://arxiv.org/abs/1710.06038)).

## 3. Where this session's measured result sits (support, not supplant)

The measured law of this session is **K_c ≈ 1/q**: the maximum reasoning length a chain can be
produced/repaired clean **in one pass, with no error correction**. Read against the threshold
theorem:

- **It is the no-redundancy (R = 1) corner.** With zero restoration, "arbitrary depth" collapses
  to a finite ceiling, and that ceiling is 1/q. This is exactly Eigen's n < 1/(μs) — the *same
  inequality*, which is why the biological and computational thresholds coincide.
- **The verifier bank is the restoring organ.** Adding N cheap diverse verifiers
  (kinetic-proofreading, §SOTA-for-the-box) drives the *effective* per-step error below the
  threshold — and the theorem then removes the length ceiling entirely: **below threshold,
  reasoning of unbounded length becomes reliable at polylog verification overhead.**
- **Therefore: the threshold theorem SUPPORTS and EXTENDS the result, it does not supplant it.**
  K_c ≈ 1/q is not overturned by von Neumann; it is the sub-threshold special case, and it is the
  quantity that *tells you how much proofreading you need* — segment/restore often enough to keep
  effective error below threshold. The design's claim sharpens: the verifier bank is not an
  incremental accuracy boost, it is the **phase transition from bounded to unbounded reliable
  reasoning.** This is the threshold theorem *for reasoning*, and it is the oracle-machine
  end-state's spine.

**Eigen's paradox is the self-improvement crux.** A replicator needs error-correction to be long
enough to *encode* error-correction — it must already be below threshold to sustain the machinery
that keeps it below threshold. The oracle-machine analogue: a self-improving reliable answerer
needs enough verification to reliably build the verification it needs. That bootstrap is the real
hard problem of a self-building Oracle, and it is now named with its 50-year-old prior art.

## 4. Where lying belongs — the operator's insight, given its exact technical home

The claim was: *"lying and dreaming, noise that shakes the champion selections, are essential to
selection and learning."* This is **correct**, and the threshold theorem says precisely *where*
and *how much*.

**Lying/noise is essential — on the generation side, below the error threshold.** Eigen's
quasispecies has a *nonzero optimal mutation rate* sitting just under the error threshold: zero
mutation freezes the champion forever (no learning); too much is error catastrophe; the optimum
is a controlled rate of "lies" (variants) that selection then filters. "Survival of the flattest"
([BMC Evol. Biol.](https://link.springer.com/article/10.1186/1471-2148-11-2)) shows that under
noise the robust-but-suboptimal can rightly beat the fragile champion — *noise that shakes the
champion selection*, exactly as stated. The ML instruments for this generation-side variation are
real and now in the corpus: synthetic-data diversity ([2410.15226](https://arxiv.org/abs/2410.15226)),
quality-diversity / novelty search, and — the sharpest tool for *this* system — **adversarial
liars as hard-negative generators**. An LLM trained to lie well
([sleeper agents](https://www.anthropic.com/research/sleeper-agents-training-deceptive-llms-that-persist-through-safety-training);
deception taxonomy 2604.04788) is exactly what the v1.10 honesty verifier needs: the corpus is
negative-thin, and a strong deceiver manufactures the hard negatives that make the honesty probe
sharp. *Fake it till you make it* = generate the target before you can hit it, then let the
verifier select. ACT-TO-KNOW = *make your own evidence and test it* — the Oracle's fifth move.

**Lying is forbidden — on the verification side.** The moment the *selection signal* itself lies,
you are above the effective error threshold and you get error catastrophe. This session already
*measured* that failure twice: the **audit-starvation theorem** (a confidence-gated verifier
protects the confidently-wrong) and the **gloss trap** (a probe that reads style, not truth). The
deception literature confirms it from the other side: strategic dishonesty *undermines* safety
evaluations when the evaluator is fooled ([2509.18058](https://arxiv.org/abs/2509.18058)) — and
the defense is a verifier the liar cannot fool: a **linear probe on activations detects strategic
deception** ([2502.03407](https://arxiv.org/abs/2502.03407)) — which *is* the v1.10 white-box
honesty probe. The honest verifier is not a preference; it is the below-threshold condition.

> **The asymmetry is the machine.** A liar filtered by an honest judge is how selection learns.
> Two liars is error catastrophe. The design's entire power is that it lets the generator lie
> freely — hot, dreaming, adversarial — while the verifier never does. This is also why a
> research process can chase wild hypotheses *and* report only measured truths: those are the two
> sides, and keeping them separate is not a constraint on the work, it is the mechanism of it.

## 5. The widened design, in one line each

- **Generator (hot):** small model + dreaming/high-temperature exploration + an adversarial-liar
  hard-negative source. Runs *near* the optimal mutation rate — just below threshold.
- **Restoring organ (honest):** kinetic-proofreading verifier bank incl. the activation honesty
  probe; drives effective error below the threshold; **crosses from 1/q-bounded to unbounded
  reliable reasoning.**
- **Segmentation:** decompose below K_c ≈ 1/q so each unit is individually restorable (Eigen).
- **Repair:** regime-aware foldback within a segment (rungs A–C).
- **Scheduling:** attribution-gated re-grounding by paid-evidence age (M7/M8).
- **Ceiling-breaker:** ACT-TO-KNOW manufactures observations no corpus holds (Oracle's 5th move) —
  the one move that exceeds the Solomonoff/AIXI *inference* ceiling, because acting resolves
  facts inference cannot.

## 6. Honest status

- This note is a **synthesis and a literature grounding**, not a new measurement. Every measured
  claim it leans on (K_c ≈ 1/q, audit starvation, the gloss trap, the probe AUROC ladder) was
  measured earlier this session or program and is cited as such; the threshold-theorem lineage is
  established prior art, now ingested (§2 references).
- **Support-vs-supplant verdict, stated plainly:** the fault-tolerance threshold theorem *supports
  and extends* the K_c ≈ 1/q result (it is the unprotected corner) — it does **not** supplant it,
  and it does not make it un-novel, because the novel object is the *instantiation on reasoning
  chains with a measured length bound and a regime map*, which none of the threshold-theorem
  literature addresses. The honest new contribution is the **bridge**: naming reasoning-chain
  repair as a threshold-theorem problem and measuring the unprotected bound.
- **Open:** whether a real verifier bank actually crosses the threshold on real workloads (the
  effective-q-reduction is predicted by Hopfield, unmeasured here); the Eigen-paradox bootstrap
  for a self-building verifier; and the still-pending weak-verification φ̂ (#2928) that decides
  whether the repair layer earns its place at all.

---

*Corpus additions this session widen the register from protein folding (foldback) to the full
reliable-computation lineage: von Neumann / quantum fault-tolerance (the CS threshold), kinetic
proofreading (the restoration mechanism), Eigen quasispecies (the biological threshold + optimal
noise rate), and the deception/diversity literature (the generation-side liar + exploration
noise). The design is the oracle-machine end-state precisely in this sense: a reliable answerer
assembled below the error threshold from an unreliable, freely-lying generator and an honest,
un-foolable verifier — plus the one move (act) that reaches past the inference ceiling.*
