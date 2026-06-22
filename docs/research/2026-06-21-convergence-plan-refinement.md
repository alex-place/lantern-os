---
author: Alex Place
created: 2026-06-21
updated: 2026-06-21
---

# Refining the !convergence plan against the 2026 frontier

> ## 📖 In plain English (start here)
>
> The convergence loop's spine is built and one slice (trading) already closes end-to-end
> (see [the agent-spine note](2026-06-19-convergence-core-agent-spine.md)). What's left is the
> **governors**: gate actions on evidence, watch the loop for collapse, grade confidence against
> real outcomes, and distil what worked. This note does ~5 minutes of **web research** on how the
> field actually solved each of those in 2025–26 and **refines the open steps** — without adding a
> single subsystem.
>
> **The headline:** the frontier independently arrived at this project's design (learn from
> *experience*, not retraining; verify against *reality*) — and it hands us **four concrete
> sharpenings and one warning** that map cleanly onto code that already exists.

**Type:** Plan refinement — re-grounds the §6 build order of the agent-spine note against external research.
**Status:** Design-only. No serving code changed. Refines priorities and names concrete methods to mirror onto existing symbols.
**Grounding contract:** External Reality Rule. Web citations were **surfaced via live search on 2026-06-21**; the arXiv IDs are *as returned by search and not individually opened* — treat them as **medium-confidence pointers**, verify before building on any single one. Internal repo claims inherit the on-disk verification of the [2026-06-19 agent-spine note](2026-06-19-convergence-core-agent-spine.md).

---

## 0. What this refines

The agent-spine build order (§6) has **steps 1–4 landed** — the kalshi slice runs Reason → Verify →
Converge end-to-end. **Open:** step 5 (grounding gate on Act + Σ₀ canary on the live loop), step 6
(sprawl hygiene), and scheduling the close-loop pass. This note refines those, each mapped to an
existing repo symbol so the work stays **extension, not addition**.

Where the project sits in the field: the *Survey of Self-Evolving Agents* (arXiv:2507.21046)
classifies self-improvement by **what** is modified (prompts / code / **weights** / architecture)
and **how** (gradient / LLM-guided / evolutionary / **experience-driven**). Keystone sits in the
rare **experience-driven, non-weight** quadrant — the bounded one. Everything below strengthens
exactly that quadrant; nothing pushes toward weight modification.

---

## 1. Refinement A — the Act gate is a *step-wise, calibrated verifier*, not a pass/fail check

**Current plan (step 5a).** `groundingPolicy(D)` as a hard precondition: no important `result` is
acted on unless its record carries `[evidence_ids, confidence, source]` above the dilation-`D`
threshold.

**Frontier.** The 2026 move is **process reward models (PRMs) / step-wise verifiers** that score
*each* decision and beat outcome-only checks at inference time — **AgentPRM** (ACM Web Conf 2026,
`10.1145/3774904.3792551`), **AgentV-RL / Agentic Verifier** (arXiv:2604.16004; complementary
forward + backward agents that trace a solution and re-check it), and — almost exactly the
project's gate, named — **Guideline-Grounded Evidence Accumulation for High-Stakes Agent
Verification** (arXiv:2603.02798).

**Refinement.**
- *claim:* the Act gate should evaluate the **reasoning step that produced the result**, not just the
  final result — a PRM-style inference-time verifier over the record's evidence chain.
- *do:* extend [`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) to consume
  per-step evidence (the record already carries `evidence_ids`) and return a **calibrated
  go / look / stop**, not a boolean. "Guideline-grounded evidence accumulation" is the published
  shape of `groundingPolicy`.
- *caveat (ties to §3):* a verifier that discriminates but is **mis-calibrated** is dangerous, and
  *"seeing a proposed solution can actively harm calibration"* (arXiv:2602.06948) — so gate on the
  **evidence**, not on the model's self-grade.
- *confidence:* high — several independent 2026 sources converge, and it maps onto an existing symbol.

---

## 2. Refinement B — the live Σ₀ canary: add the trajectory triad, and respect the blind spot

**Current plan (step 5b).** Attach `SurpriseMonitor` / `AntiCollapseOperator` to the live loop; fire
`anti_collapse_signal()` (`inject_novelty` / `truncate_context` / `switch_agent`) when the loop
starts agreeing with itself.

**Frontier.** Runtime collapse/drift detection matured in 2026.
- **Spectral collapse** — *SIGMA: Scalable Spectral Insights for LLM Model Collapse*
  (arXiv:2601.03385) reads collapse off the spectrum — the *same* eigen-structure the certificate's
  §1 `collapse_certificate()` already computes, so the live canary can **reuse it**, not add a detector.
- **Trajectory-level signals** — the reported triad for *silent* collapse is **predictive-entropy
  contraction, representation drift, and tail-coverage erosion** — complementary to the cert's
  Kalman-NIS canary, which catches *innovation spikes*, not slow contraction.
- **The blind spot (the warning).** *The Boiling Frog Threshold* (arXiv:2603.08455): **gradual /
  periodic drift can be fundamentally invisible to internal monitors** — the prediction-error signal
  carries no extractable drift information. This is precisely the certificate §4 "calm while wrong"
  horse-blinders regime, now **independently confirmed**.

**Refinement.**
- *claim:* the live canary should fold **entropy-contraction + representation-drift + tail-erosion**
  alongside NIS, and **reuse the §1 spectral certificate** rather than add a parallel detector.
- *do:* the boiling-frog result is the strongest external vindication of the project's
  **non-negotiable external-grounding cadence** — because internal monitors are provably blind to
  slow drift, the loop must periodically *go look regardless of how calm it feels*. Wire a
  **time/▢-based mandatory grounding tick**, not only a proximity-triggered one.
- *confidence:* high on the triad's relevance; medium on thresholds (needs a sweep like the existing
  `experiments/sigma0_regime_sweep.py`).

---

## 3. Refinement C — replace the frozen 0.7/0.3 confidence with a *calibrated, outcome-graded* score

**Current state.** Records carry a **frozen v1 heuristic confidence** (0.7 online / 0.3 offline) and
are **never graded** (agent-spine §1). The kalshi slice now grades against settled markets — the one
real outcome wire.

**Frontier.** Calibration is the 2026 hinge.
- LLMs are **systematically overconfident** — *Agentic Uncertainty Reveals Agentic Overconfidence*
  (arXiv:2602.06948); **PolyBench** (arXiv:2604.14199): only 2 of 7 models earned positive returns
  despite *uniformly high stated confidence*.
- **Proper scoring rules fix it** — tokenized-**Brier** / proper-scoring-rule RL provably aligns
  expressed confidence with accuracy (Expected Calibration Error down by up to ~9 points).
- **Prediction markets as the grader** — an LLM prediction-market ensemble reached **Brier 0.177 vs a
  0.250 chance baseline** on claims with determinable ground truth, using five *epistemically diverse*
  predictor agents. That is the published analogue of this project's **Kalshi grounding + multi-agent
  council**.

**Refinement.**
- *claim:* the frozen heuristic confidence **is** the project's uncalibrated-overconfidence failure
  mode; replace it with an **outcome-graded score** evaluated by a **proper scoring rule (Brier)** over
  resolved records.
- *do:* generalise [`kalshi-convergence-outcomes.js`](../../apps/lantern-garage/lib/kalshi-convergence-outcomes.js)
  into a domain-agnostic **outcome grader** — wherever a record has a resolvable truth, compute its
  Brier contribution — and expose a running **Brier / ECE** as a first-class convergence signal (the
  loop's own report card). Grade the **outcome**, never the agent's self-assessment.
- *confidence:* high — the most-converged-upon finding across the search, and the project's strongest
  external claim (calibrated confidence grounded in real outcomes is exactly what the frontier says is
  missing).

---

## 4. Refinement D — Converge / `extract_patterns` must be *relevance-gated*, or memory becomes noise

**Current plan (step 4 + scheduling).** Invoke `extract_patterns()` periodically over `records.jsonl`;
feed the patterns back into Reason.

**Frontier.** Experiential memory is *the* 2026 infrastructure problem — with a sharp failure mode.
- **ExpeL** (arXiv:2308.10144) distils success-vs-failure into reusable "rules of thumb" — this *is*
  `extract_patterns`. But ExpeL **concatenates every insight into every prompt** and **scales poorly**.
- **"From Knowledge to Noise"** — *CTIM-Rover* (arXiv:2505.23422): undisciplined episodic memory
  **actively hurts** agents.
- Memory surveys (arXiv:2512.13564, arXiv:2603.07670) organise the space as **storage → reflection →
  abstraction** over episodic / semantic / procedural memory.

**Refinement.**
- *claim:* `extract_patterns()` is correct, but the **retrieval** of patterns into Reason must be
  **relevance-gated**, not dump-all — else the project re-creates ExpeL's scaling wall and
  CTIM-Rover's "knowledge → noise."
- *do:* pair `extract_patterns(min_confidence)` with **relevance + recency-gated retrieval** at Reason
  time (the existing `convergence-router` cache is the natural home), and **schedule** the close-loop
  pass (on-settlement for trading; periodic otherwise) — the remaining wire from agent-spine §6. This
  is the same lever as the **spacing-effect / ICCL** citation already in Research Canon [03] (PR
  #1000): *space and select* re-surfaced memory; do not dump it.
- *confidence:* high on the failure mode; the gating mechanism (graph vs vector vs router-cache) is a
  design choice.

---

## 5. Refined build order (supersedes agent-spine §6 for the *open* steps)

Steps 1–4 stand (landed). The open work, re-prioritised by leverage × external support:

1. **[highest] Calibrated outcome grader (Refinement C).** Generalise the kalshi outcome wire to any
   resolvable record; report a running **Brier / ECE**. Turns "never graded" into "graded + calibrated"
   — the frontier's #1 gap. *(Verify → Converge)*
2. **Act gate as a step-wise, calibrated verifier (Refinement A).** Make `groundingPolicy(D)` a
   guideline-grounded evidence gate returning go / look / stop on the record's evidence chain. *(Act)*
3. **Live Σ₀ canary v2 + mandatory grounding tick (Refinement B).** Fold entropy-contraction /
   representation-drift / tail-erosion + the §1 spectral certificate into the live `SurpriseMonitor`;
   add a **time-based** grounding tick to defeat the boiling-frog blind spot. *(Verify)*
4. **Relevance-gated pattern retrieval + scheduling (Refinement D).** Schedule `extract_patterns`;
   gate pattern re-surfacing by relevance/recency. *(Converge)*
5. **Hygiene (agent-spine step 6).** Reframe `three-doors-convergence-loop.js` as a Task through the
   one loop; keep the kernel-vs-io-engine split labelled.

None adds a subsystem; each mirrors a 2026-frontier method onto an existing symbol.

---

## Sources

**Web — surfaced via live search 2026-06-21; arXiv IDs as returned, *not individually opened* — verify before relying:**
- *Verifier gates / PRMs:* AgentPRM (ACM Web Conf 2026, `10.1145/3774904.3792551`); AgentV-RL / Agentic Verifier (arXiv:2604.16004); Guideline-Grounded Evidence Accumulation (arXiv:2603.02798); LLM-Reasoning frontier survey (arXiv:2504.09037).
- *Runtime collapse / drift:* SIGMA spectral collapse (arXiv:2601.03385); The Boiling Frog Threshold (arXiv:2603.08455); SAHOO safeguarded RSI (arXiv:2603.06333); ICLR 2026 Recursive Self-Improvement workshop.
- *Calibration / outcome grading:* Agentic Overconfidence (arXiv:2602.06948); PolyBench (arXiv:2604.14199); multi-agent calibration & rationalization (arXiv:2404.09127); LLM prediction-market Brier 0.177 (`t46.github.io/blogs/claim_prediction_market`).
- *Experiential memory:* ExpeL (arXiv:2308.10144); "From Knowledge to Noise" / CTIM-Rover (arXiv:2505.23422); memory surveys (arXiv:2512.13564, arXiv:2603.07670); AutoRefine (arXiv:2601.22758); Continual Experience Internalization (arXiv:2606.04703); Trainable Graph Memory (arXiv:2511.07800).
- *Framing:* Survey of Self-Evolving Agents (arXiv:2507.21046); Evaluation of LLM-based Agents (arXiv:2503.16416); Agentic RL landscape (arXiv:2509.02547).

**Internal:** [agent-spine build order](2026-06-19-convergence-core-agent-spine.md) · [convergence-core-mapping](../convergence-core-mapping.md) · [Σ₀ collapse certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md) · [Research Canon [03] + ICCL](../RESEARCH-CANON.md) · CLAUDE.md North Star.
