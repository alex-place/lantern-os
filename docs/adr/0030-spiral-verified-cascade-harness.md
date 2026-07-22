---
adr: 0030
title: The Spiral — a verified-cascade convergence loop as the owned local reasoning core
status: Accepted
date: 2026-07-22
deciders: Alex Place (owner), Claude lane
approved-by: Alex Place (in-session, 2026-07-22)
supersedes: none
superseded-by: none
---

# ADR-0030: The Spiral — a verified-cascade convergence loop as the owned local reasoning core

## Status

Accepted (Alex Place, in-session, 2026-07-22). The **architecture** and the **Phase-0 build**
(no new weights) are accepted now; **Phases 1–2** (own weights) are gated behind Phase-0 evidence
and remain research options, not commitments.

## Context

The owned-model question has drifted between "distill our own tiny model" and "just rent a frontier
model." Two facts settle it:

1. **We can't out-parameter the frontier, and don't need to.** Open Qwen3-Coder-32B already ≈ Claude
   3.5 on SWE-bench; a home-grown frontier model is not the moat. The moat is a **system**: the
   smallest hardware (CPU / 8GB), **owned verified-trace data**, local/private, and a verifier we own.
2. **The wins that look like architecture are actually memorization.** ARC-Prize's teardown of TRM/HRM
   (arcprize.org/blog/hrm-analysis) shows the tiny-recursive puzzle results are largely memorization
   (hidden ARC-AGI-2 ≈ 2%); the *outer refinement loop* does the work, not the hierarchy. So the source
   of generalization has to be an **external verifier**, not the parameters.

This touches the whole loop but is centered on **Reason → Act → Verify → Converge**. We already shipped
the pieces in isolation: the live single-shot verified cascade (cheap → run tests → escalate on fail;
[experiments/verified_cascade_live.py](../../experiments/verified_cascade_live.py), #2800, measured
8.3× cheaper at ≈0% escalation on a strong cheap tier), the constraint-aware cheap-tier picker
([`selectCheapStandin`](../../apps/lantern-garage/lib/local-model-registry.js), #2814), the outcome
router ([`lib/coding-backend/router.js`](../../apps/lantern-garage/lib/coding-backend/router.js)), and
the verified convergence ledger (#2797). What was missing is the **loop that runs them on ONE problem
until it's solved or honestly can't be** — and the honest per-step verifier that gates each turn.

Web-grounded 2026 (design of record:
[docs/research/2026-07-22-spiral-verified-cascade-design.md](../research/2026-07-22-spiral-verified-cascade-design.md)):
per-step cascade routing is a named frontier — Policy-Guided Stepwise Model Routing (arXiv 2605.06116),
Cluster-Route-Escalate (2606.27457), escalation decision theory (2605.06350) — including the property we
need: for verifiable-outcome tasks, on a failed verify you *escalate inheriting the prior attempt's
progress*. The per-step code reward is concrete: **Fix Rate** — fraction of failing tests a patch newly
passes, minus a regression penalty — grounded in SWE-Shepherd (2604.10493) / SWE-TRACE (2604.14820).

## Decision

**We will build the owned local reasoning core as the "Spiral": the CLAUDE.md convergence loop run on
ONE problem, whose per-turn engine is a verified cascade.** Each turn: the **cheap owned tier** proposes
the next step; the **Fix-Rate verifier (M4)** gates it; only on a stall do we **escalate that step to a
rented frontier tier, inheriting the accumulated verified memory**. A verified step commits to a growing
memory (the ratchet); an unverified step de-ratchets. The loop halts on solved, on an answerability
decline ("honest can't"), or a turn cap. **Generalization comes from the verifier, not scale.** The
surface is **dream-chat.html** — a user drives a spiral and watches it converge.

Build order, de-risked, most value first:

- **Phase 0 — the verified-cascade harness (NO new weights).** Reassemble the shipped parts into the loop.
  Implemented here: [`lib/spiral-harness.js`](../../apps/lantern-garage/lib/spiral-harness.js) (the loop
  + per-turn cascade + escalation-corpus emission) and
  [`lib/spiral-fix-rate.js`](../../apps/lantern-garage/lib/spiral-fix-rate.js) (the M4 ratchet metric).
  Emits the escalation corpus (each escalated, advancing step = a frontier demonstration on a step the
  cheap tier couldn't do = a distillation target). Measurable on SWE-bench today.
- **Phase 1 — VTD-specialize a 7–14B cheap tier** on the Phase-0 escalation corpus (Verified-Trace
  Distillation). The "own weights" bet, gated on Phase-0 evidence.
- **Phase 2 — the from-scratch tiny recursive core** (growing memory + rotational anti-collapse as
  trainable modules). Gated on Phase-1 evidence. The ambitious, highest-risk piece — never built first.

This is **not** a new subsystem or a separate engine: it is the one loop, focused (Memory = growing
verified memory; Task = the problem; Tool = the tier calls; Convergence Record = each committed step).
It is `extension over addition` per ADR-0002/0013.

## Consequences

- **Positive:**
  - The long horizon is **affordable**: the cheap tier clears most steps (sufficiency regime, 8.3×
    cheaper measured), so "spiral for a long time" ≈ many cheap steps + a few escalations.
  - The tiny-core risk is **de-risked**: the floor is frontier quality (you can always escalate,
    inheriting progress); you only *pay* frontier on the hard steps. A weak core still ships — it just
    escalates more.
  - **Self-improvement is mechanical**: every escalation is a labeled distillation target; VTD trains the
    cheap tier on them, so the one governing number — **escalation rate** — is designed to only fall.
  - Generalization is **anti-memorization by construction**: nothing commits unless reality (Fix Rate)
    ratchets it.
- **Negative / trade-offs:**
  - Home is **verifiable domains** (code, math). Open-domain tasks lack a hard M4 → the spiral there
    degrades to plain cascade quality; we do not claim the ratchet outside verifiable tasks.
  - Code's per-step signal (Fix Rate) is **noisier than an exact math check** → expect lower-vs-frontier
    on SWE than rStar-Math got on MATH.
  - The tiny-recursive arch (Phase 2) is **proven on puzzles/tabular only, not code/language** — hence it
    is quarantined behind Phase 0/1, which don't depend on it.
  - Unbounded memory can saturate → Phase 1+ needs cap + retrieval (Titans-Revisited critique).
- **Follow-ups:**
  - Wire the harness as a `spiral_solve` chat tool + progress panel in dream-chat.html (this PR starts it).
  - A Phase-0 SWE-bench run producing the first escalation corpus (feeds Phase 1).
  - Phase-1 VTD recipe as its own ADR when Phase-0 evidence justifies it (relates to ADR-0015/0024/0025).

## Alternatives considered

- **Rent a frontier model only (do nothing).** Rejected: no owned data flywheel, no CPU/8GB story, no
  privacy/local moat — and it's the opposite of the shipped cascade's measured economics.
- **Distill a home-grown frontier model.** Rejected: we can't out-parameter open 32B coders that already
  match Claude 3.5; scale is not our edge.
- **Build the novel tiny-recursive arch first (TRM/HRM from scratch).** Rejected: proven only on
  puzzles/tabular, no code/language evidence, no tooling — highest risk, so it's Phase 2 behind evidence.
- **Single-shot cascade only (what we shipped).** Kept as the per-turn engine, but insufficient alone:
  it doesn't accumulate progress across turns on one hard problem, and it emits no distillation corpus.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Single-shot verified cascade works live, ≈8.3× cheaper at ≈0% escalation | [experiments/verified_cascade_live.py](../../experiments/verified_cascade_live.py); #2798/#2800 | High | measured on-box |
| Fix-Rate ratchet metric implemented + tested (anti-memorization gate) | [lib/spiral-fix-rate.js](../../apps/lantern-garage/lib/spiral-fix-rate.js); [test/spiral-fix-rate.test.js](../../apps/lantern-garage/test/spiral-fix-rate.test.js) | High | this PR (19 tests green) |
| Spiral loop (grow-memory + per-turn cascade + honest halt + corpus) implemented + tested | [lib/spiral-harness.js](../../apps/lantern-garage/lib/spiral-harness.js); [test/spiral-harness.test.js](../../apps/lantern-garage/test/spiral-harness.test.js) | High | this PR |
| Per-step cascade routing + escalate-inheriting-progress is a real 2026 frontier | arXiv 2605.06116, 2606.27457, 2605.06350 | High | external, web-grounded |
| Fix Rate is the code step-PRM signal | SWE-Shepherd 2604.10493, SWE-TRACE 2604.14820 | Medium | external |
| Tiny-recursive wins are largely memorization → verifier must be external | arcprize.org/blog/hrm-analysis; TRM 2510.04871; HRM 2506.21734 | High | external |
| Constraint-aware cheap-tier picker + outcome router exist to wire the tiers | [local-model-registry.js](../../apps/lantern-garage/lib/local-model-registry.js) (#2814); [coding-backend/router.js](../../apps/lantern-garage/lib/coding-backend/router.js) | High | in-repo |
| Tiny-recursive arch unproven for code/language (Phase-2 risk) | TRM/HRM demonstrated on ARC/Sudoku/Maze only | High | external |
