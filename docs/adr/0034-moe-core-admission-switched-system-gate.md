---
adr: 0034
title: MoE for the Σ₀ core — adopted as soon as feasible; feasibility = the switched-system certification gate
status: Proposed (recording the operator decision of 2026-07-24; awaiting Alex's formal approval)
date: 2026-07-24
deciders: Alex Place (operator direction, in-session 2026-07-24), Claude lane (drafting)
supersedes: none (amends the MoE stance of research/2026-07-23-sigma0-llm-design.md §3.1 and the serving memo's Option-F rejection)
superseded-by: none
---

# ADR-0034: MoE for the Σ₀ core — adopted as soon as feasible

## Status

Proposed. The operator direction (in-session, 2026-07-24) is: **"we are using MoE — as soon as
is feasible."** This ADR records that decision and defines *feasible* precisely, so the
commitment is real and the safety story stays honest. It does not enable an MoE core today.

## Context

Every prior 2026-07-23 document held MoE OUT of v1 behind a named admission gate:

- The design of record (§3.1) defers MoE because a routed loop is a **switched dynamical
  system**, and the Collapse Certificate's Part I stability results (the ρ(J)<1 machinery, the
  JSRR gate's theory basis) are proven for a FIXED update map only — cert §1.2.2 explicitly
  voids them for routed/MoE loops. Quoting §1 numbers for a routed core is forbidden.
- The serving memo rejected Option F (MoE-lite) as an "uncertified switched system."
- A 2026-07-23 grep confirmed the switched-system certification tooling **does not exist**.

The operator has now decided the destination: MoE is the capability path (sparse capacity is
how a ≤4GB-footprint model punches above its active-parameter class). The gate does not
disappear — it becomes the critical path.

## Decision

1. **The Σ₀ core adopts a mixture-of-experts architecture as soon as it is feasible.**
2. **Feasible means the MoE admission gate exists and passes** — nothing else unlocks it:
   - **(a) Per-expert contraction receipts.** JSRR-style acceptance per active expert
     composition: every expert path the router can select carries its own measured ρ with the
     same verdict machinery the dense loop has today.
   - **(b) Dwell-time certification.** Switched-system stability needs more than stable
     pieces: either a common Lyapunov certificate across experts, or a measured **minimum
     dwell time** between router switches meeting the average-dwell-time condition. The serve
     path must MONITOR dwell time and reject generations that switch faster than the
     certified bound.
   - **(c) Router canary.** Router-entropy / expert-churn added as canary axes (a router that
     thrashes is the switched analog of the collapse the NIS canary watches for).
   - **(d) External verification unchanged.** Held-out exec verification, the M1 gate, Σ_θ
     promotion gating, and the ≥60% anchor mandate apply to an MoE core exactly as to dense.
3. **Until (a)–(c) exist and pass, the dense ≤3B looped core remains the product**, and Part-I
   stability numbers may not be quoted for any routed configuration (cert §1.2.2 stands).
4. **The gate tooling moves to the FRONT of the parallel R lane** (design of record §9): it is
   now the critical path to an operator-decided destination, not a deferred curiosity.

## Consequences

- The envelope is unchanged: ≤4GB footprint, CPU-viable; MoE spends the budget on sparse
  capacity (total params may exceed 3B if the ACTIVE set and memory stay in the envelope —
  the envelope binds on footprint, which is what the operator's size rule protects).
- The depth-cascade training design (research/2026-07-24-depth-cascade-training-design.md)
  composes: its contraction objective must hold per active-expert composition, and its
  monotone-depth kill test carries over unchanged.
- Honest sequencing: P0 (JSRR on the default dense path) still comes first — the dense gate
  is a strict prerequisite skill for the switched one.
- Risk on record: switched-system certification at this scale is research, not engineering;
  if the dwell-time story cannot be made measurable, feasibility is never reached and this
  ADR's commitment stays unexecuted rather than executed unsafely.

## Evidence

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| Part I voids for routed loops | cert §1.2.2 | High | in-repo, machine-checked scope statement |
| Admission tooling absent today | 2026-07-23 grep (design of record §3.1) | High | in-repo |
| Switched stability needs common-Lyapunov or dwell-time | classical switched-systems theory (Liberzon; Hespanha–Morse ADT) | High | external, textbook |
| Operator decision: MoE as soon as feasible | in-session statement, 2026-07-24 | High | operator |
