---
adr: 0010
title: Distillation is a deferred last resort — verify-gated, benchmark-never-the-target, never removed
status: Proposed
date: 2026-06-29
deciders: Alex Place
approved-by: pending   # only Alex Place flips this; agents leave it `pending`
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.

  NORTH-STAR NOTE: this ADR records a *bounded exception* to North Star principle 5
  ("learning is retrieval + experience, NOT weight modification — never retrain").
  Acceptance therefore also entails Alex updating CONVERGANCE-SIGMA0-BRIEFING.md
  principle 5 to point at this ADR's deferred, guard-railed exception. Agents must
  NOT edit the immutable briefing; only Alex does, on acceptance.
-->


# ADR-0010: Distillation is a deferred last resort — verify-gated, benchmark-never-the-target, never removed

## Status

Proposed — awaiting approval from Alex Place.

## Context

The target is **high real reliability** (aiming for ~99% *verified* correctness on tasks
where ground truth exists), not a high score on a public leaderboard. Those are different
bars, and conflating them is the trap this ADR exists to prevent:

- "99% on HumanEval" is **vanity** — the benchmark is saturated/contaminated (we already
  decontaminate leaks, [[humaneval-optimized-corpus]] / `build_humaneval_corpus.py`).
- "99% on SWE-bench Verified / GPQA" is **past the field's frontier** today (SOTA ~70s;
  GPQA human-expert ceiling ~65–75%).
- "99% of what we ship passes its tests / is grounded" is **real, reachable, and frozen-base** —
  it comes from verification (run the code, check the source), which needs no weight change.

The decision this forces: **continual learning by updating model weights** (a LoRA
distillation flywheel) is one available lever for compounding capability over time. The
North Star currently **forbids** it outright (principle 5: "never retrain"; restated in
[ADR-0004](0004-append-only-memory.md): "improvement comes from retrieval over accumulated
memory, never retraining"). Two facts pull against a blanket ban:

1. Weight-distillation is a **real** lever — verified self-distillation compounds capability
   (multi-agent finetuning, SWE-Gym / DeepSWE-style verifier-trained agents).
2. Used naively it is the **most dangerous** lever — training on your own outputs to chase a
   number is Goodhart's law plus model collapse (diversity degrades across cycles). In the
   gains analysis it was the *smallest, lowest-confidence, highest-risk* lever on the board.

Loop stage: **Converge** (how the loop improves itself over time). The owner's instruction is
explicit: **keep the option, but make it the last resort** — only after the frozen-base levers
are exhausted, and never delete it from the toolbox.

## Decision

We will **preserve distillation (continual weight updates) as a deferred, guard-railed,
last-resort option — never the first move, and never removed.**

**Rule 0 — Default mode is unchanged.** The system's default operating mode remains
frozen-base + retrieval/experience (North Star principle 5, [ADR-0004](0004-append-only-memory.md)).
This ADR does **not** start a training program; it records a sanctioned, dormant escape hatch.

**Rule 1 — Frozen-base levers come first, in order.** To raise any measured capability gap,
exhaust the frozen-base path first, with evidence at each step:
   1. **Route** to the best available member (cloud/local specialist) — [ADR-0009](0009-one-routing-contract-cloud-primary-coding.md).
   2. **Execution-verify + best-of-N** — sample, then select by running tests / a real verifier.
   3. **RAG + citation grounding** — retrieve and verify sources actually support the claim.
None of these touch weights. They are the primary, always-preferred path.

**Rule 2 — Distillation may only be *proposed* after Rule 1 is demonstrably exhausted** for a
specific, measured capability gap, with the exhaustion recorded as a Convergence Record
(`data/convergence/records.jsonl`) carrying `[claim, evidence, confidence, source]`. "We haven't
tried verification yet" is never grounds to distill.

**Rule 3 — If initiated, distillation runs only under all of these guardrails:**
   - **Source gate:** only **externally-verified-correct** experience may become training data —
     code that passed its tests, claims that passed grounding checks, operator-approved decisions.
     **Never raw model self-output.** Every pair traces to a Convergence Record.
   - **Adapter-only, base frozen:** updates land in a **replaceable LoRA adapter**, never the base
     weights. The base stays interchangeable ([ADR-0005](0005-interchangeable-model-providers.md));
     the adapter is **regenerable from the append-only memory log** — a distilled cache of verified
     experience, not a new memory store.
   - **Benchmark is never the target:** the optimization signal is **verified-pass-rate on held-out,
     decontaminated, freshly-sourced tasks**. Public benchmarks (HumanEval/SWE/GPQA) are **read-only
     instruments**, never a loss signal. Saturated/contaminated benchmarks are explicitly barred as
     targets.
   - **Collapse tripwire (mandatory):** every cycle evaluates a **frozen hold-out** and **mixes in
     external (non-self) data**. If the hold-out or a diversity metric regresses across cycles,
     distillation **halts and the last-good adapter is restored**.
   - **Reversible + audited:** each adapter version is content-addressed, logged to the convergence
     audit, and revertible in one step. No cycle is irreversible.
   - **Operator-gated:** cycles are operator-initiated/approved, not autonomous, until the tripwire
     history earns trust.

**Rule 4 — The option is never removed.** Forbidding distillation outright is itself rejected
(see Alternatives). The toolbox keeps it; discipline keeps it last.

## Consequences

- **Positive:**
  - Keeps a path to compounding, long-horizon improvement without sacrificing the grounding
    guarantee — the benchmark can never become the target, so "99%" stays *real* (verified), not *fake* (overfit).
  - The base model stays interchangeable; the adapter is a regenerable cache, not a dependency.
  - Everything is reversible, audited, and operator-gated — the dangerous lever is defanged.
  - Honors the owner's intent precisely: keep the option, use it last.
- **Negative / trade-offs:**
  - This is a **real, named departure** from North Star principle 5's blanket "never retrain."
    We accept a narrow, dormant exception in exchange for not foreclosing the flywheel.
  - When (if) activated, it adds a training pipeline (GPU, eval upkeep, collapse monitoring) and
    a model-specific artifact — mitigated by adapter-only + regenerable-from-memory + the tripwire.
  - Requires ongoing discipline: the moment a public benchmark leaks into the loss, the guarantee
    is broken. The hold-out + source-gate are the enforcement, not good intentions.
- **Follow-ups:**
  - Build the **collapse-tripwire eval harness** (frozen hold-out + diversity metric) — prerequisite
    before any cycle.
  - Wire **execution-verify as the source gate** (Rule 1.2 / Rule 3 source gate share machinery).
  - Run the **operator-escalation backtest** (separate work) — part of proving Rule 1 levers first.
  - On acceptance: Alex updates briefing principle 5 to reference this ADR's bounded exception.

## Alternatives considered

- **Keep the blanket ban (do nothing).** Rejected per the owner's instruction — but legitimately
  the safe default: it preserves a clean grounding guarantee at the cost of no compounding. If this
  ADR is *rejected*, this is what we keep, and that is an acceptable outcome.
- **Allow active continual learning now (benchmark-targeted).** Rejected — Goodhart + model collapse;
  the exact failure mode the North Star exists to prevent. Chasing a contaminated benchmark by
  distilling own outputs buys a *fake* 99%.
- **Unguarded / autonomous self-distillation.** Rejected — training on own output without a
  source-gate and tripwire collapses the model over cycles.
- **Full base-weight retraining (not adapter).** Rejected — breaks model interchangeability
  ([ADR-0005](0005-interchangeable-model-providers.md)) and is irreversible.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| North Star forbids weight modification (the rule amended) | [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md) principle 5; [ADR-0004](0004-append-only-memory.md) | High | project docs |
| Frozen-base verification is the primary lever (route first) | [ADR-0009](0009-one-routing-contract-cloud-primary-coding.md) | High | repo ADR |
| Local coder weak → routing/verify needed before distill | Ouro-1.4B ~0/5 via chat harness | High | #1263, `eval_humaneval_chat.py` |
| Execution-verify + best-of-N is the high-confidence capability lever | Satori-SWE Best@50 ≈ Best@500 SOTA | Med | arXiv 2505.23604 |
| RAG + citation cuts hallucination materially | MEGA-RAG ~40% reduction vs baseline | Med | PMC12540348 |
| Verified self-distillation compounds capability | SWE-Gym / DeepSWE verifier-trained agents | Med | arXiv 2504.21798 / together.ai DeepSWE |
| Naive self-training collapses (tripwire justified) | model-collapse on training-over-own-output | Med | recursive-training literature |
| Adapter is regenerable from the one memory log | `data/convergence/records.jsonl` + [ADR-0004](0004-append-only-memory.md) | High | repo |
