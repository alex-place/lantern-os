---
adr: 0031
title: Spiral Coder — the ARC-AGI-2 budgeted-efficiency track as the SOTA target for the verified inductive-synthesis loop
status: Accepted
date: 2026-07-23
deciders: Alex Place (owner), Claude lane
approved-by: Alex Place (in-session, 2026-07-23)
supersedes: none
superseded-by: none
extends: 0030
---

# ADR-0031: Spiral Coder — ARC-AGI-2 budgeted-efficiency track as the SOTA target

## Status

Accepted (Alex Place, in-session, 2026-07-23). Extends [ADR-0030](0030-spiral-verified-cascade-harness.md)
(the Spiral harness) by naming the external niche the harness competes in, the measurable
SOTA bar, and the one design change a real execution-verified test showed is required.

## Context

ADR-0030 shipped the Spiral: a per-turn verified cascade (cheap → Fix-Rate-verify →
escalate-inheriting-progress) whose generalization comes from the **verifier, not scale**.
It had no external niche or SOTA claim. This ADR sets one, grounded in the mid-2026 field:

- **The refinement loop is the field's live frontier.** ARC Prize's 2025 review names "the
  refinement loop — a per-task iterative program-optimization loop guided by a verifier" as
  the defining trend; the canonical pipeline is *model proposes a rule in code → verifier
  executes vs ground truth → refine* (ARC Prize 2025 Technical Report, arXiv:2601.10904).
  **That is the Spiral, exactly.**
- **Harness > scale is measured.** "Harness design matters as much as pretraining scale —
  identical models show ±20% variance from scaffolding, search, and verification tools"
  (arahim ARC-AGI guide, 2026). This is the empirical basis for the ADR-0030 bet.
- **ARC-AGI-1 has fallen** (frontier ~90–96%, "retired to warm-up") — it is NOT a valid
  target. The live, contested niche is **ARC-AGI-2's budgeted / Kaggle-constrained track**,
  where "the gap between unlimited compute and Kaggle's limits turned out to be the whole
  story." Incumbents (ARC Prize 2025 Kaggle): **NVARC 24% @ ~$0.20/task**, ARChitects 16.5%,
  MindsAI 12.6%; unlimited-compute frontier sits low-80s at **$10–30/task** (GPT-5.2 Pro 54%
  @ $15.72). The budgeted corner is where an owned ≤8GB model + a strong harness can win.
- **Induction generalizes; transduction memorizes.** HRM (27M) and TRM (7M) get their gains
  from the refinement loop but are *transductive* (predict the grid) and, per ARC Prize's own
  ablation, "will not generalize" (they memorize eval tasks). Execution-guided *inductive*
  program synthesis "outperforms all reference algorithms in compositional generalization"
  (arXiv:2507.15877).

## Decision

1. **Niche.** The Spiral Coder's SOTA target is the **cost-efficiency Pareto frontier of
   ARC-AGI-2's budgeted track** (score vs $/task under real compute limits), via
   **execution-guided inductive program synthesis** — emit a *program*, verify it by
   execution against the demonstration pairs, refine. Not ARC-AGI-1 (fallen); not the
   unlimited-compute top-line (frontier's, not ours).

2. **Architecture = ADR-0030 unchanged, with two commitments.** Keep the Ouro loop and the
   verified cascade. (a) Output type is a **program** (inductive), run by `exec-verify`
   against demo pairs; Fix-Rate = fraction of pairs solved. (b) Halt/advance is the **exact
   external verifier**, never a learned ACT halt (ARC Prize showed a learned halt "mainly
   saves compute" and drives memorization).

3. **Held-out generalization gate (NEW — forced by evidence).** A run of the real harness +
   real `python` exec (`experiments/spiral_arc_smoketest.js`, 2026-07-23) showed a program
   that **memorizes the train I/O passes every training test (Fix-Rate 1.0 → harness
   "solved") yet fails the held-out pair** — the transduction trap, reproduced. Therefore the
   Spiral Coder's verifier for ARC MUST split the demo pairs and **verify on held-out pairs**,
   not just the pairs used to synthesize. An exact train verifier is necessary but not
   sufficient for convergence.

4. **Measurable SOTA bar.** A point on the score-vs-$/task plane on ARC-AGI-2 public eval.
   It is SOTA only if it (a) sits on/above the **budgeted** Pareto frontier (target: the
   NVARC 24% @ $0.20/task band, at ~$0 API via the owned model), (b) **beats equal-compute
   Best-of-N** program sampling (Snell 2025 — if it only ties, the verifier is too weak), and
   (c) its explicit programs **transfer to held-out pairs** (the generalization the
   transductive incumbents lack).

## Consequences

- **Falsification, before any weight work:** run the Spiral as an inductive synthesizer on
  ARC-AGI-2 public eval with the real owned model (Ouro serving env), cost-instrumented. If
  verified refinement does not beat equal-compute Best-of-N and does not land on the budgeted
  frontier, the thesis is wrong and we learn it cheaply.
- **Honest boundary:** we will not top ARC-AGI-2's unlimited-compute frontier or beat the
  frontier's raw score. The **DSL/primitive design** for inductive ARC is the real hard part
  and the main risk. The inductive route provably misses the ~distinct set of tasks only
  transduction solves (ARC Prize 2024 report) — combining the two is a later move, not v1.
- **What already exists:** harness (`spiral-harness.js`), Fix-Rate PRM (`spiral-fix-rate.js`),
  exec sandbox (`exec-verify.js`), tiers/escalation (`spiral-tiers.js`), `spiral_solve` tool.
  **To build:** the held-out gate (Decision 3), an ARC task adapter (pairs → `spiral_solve`
  tests), a candidate-program DSL/prompt, and the cost-instrumented ARC-AGI-2 eval harness.

## Evidence

- Real harness run (this session): `experiments/spiral_arc_smoketest.js` — verified cascade
  solves a mirror task ($0.02, generalizes); memorizer passes train / fails held-out.
- ARC Prize 2025 Technical Report (arXiv:2601.10904); ARC Prize HRM analysis (2025-08-15).
- Execution-guided neural program synthesis vs test-time FT (arXiv:2507.15877).
- Scaling test-time compute (Snell et al., ICLR 2025, arXiv:2408.03314).
- TRM (arXiv:2512.11847); cost-effective ARC harnesses (arXiv:2607.06764).
