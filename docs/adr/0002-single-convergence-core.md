---
adr: 0002
title: Single Convergence Core — reject architectural sprawl
status: Proposed
date: 2026-06-23
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0002: Single Convergence Core — reject architectural sprawl

## Status

Proposed — awaiting approval from Alex Place.

## Context

Keystone OS is built and maintained by one developer plus a fleet of concurrent agents. The
gravitational pull on such a system is **sprawl**: each agent, asked to "add a feature," tends
to add a *new top-level subsystem* (a dream engine, a swarm framework, a second planner). Left
unchecked, this produces a coordination nightmare and dilutes the thesis.

The North Star fixes one shape for the whole product: a single loop —
`Observe → Remember → Reason → Act → Verify → Converge` — over four objects (Memory, Task,
Tool, Convergence Record). This is the "Convergence Core."
([CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md);
[CLAUDE.md](../../CLAUDE.md) "Architectural Convergence Constraint"). The loop is implemented
concretely in [`src/convergence/kernel.py`](../../src/convergence/kernel.py) over
[`src/convergence/objects.py`](../../src/convergence/objects.py).

This ADR records the decision that governs **every** loop stage: extension over addition.

## Decision

We will maintain **one Convergence Core** and gate every feature on the question *"which loop
stage does this strengthen?"* A change that names a stage (Remember / Reason / Act / Verify /
Converge) is allowed; one that names no stage — or adds a parallel top-level subsystem — is
rejected.

Concretely forbidden (per the North Star): a separate dream engine, multiple memory systems,
independent agent ecosystems / swarms as top-level systems, digital-twin / BCI / mind-upload
concepts, and any top-level subsystem that does not improve the loop. All agents plug into the
same core rather than spawning their own.

## Options Considered

### Option A: Single Convergence Core (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low — one loop, four objects |
| Coordination | Low — every agent shares one spine |
| Extensibility | High via *extension* of a stage |

**Pros:** one mental model; agents interoperate; the thesis stays legible.
**Cons:** requires discipline + a gate; some features must be reframed to fit a stage.

### Option B: Federated subsystems (rejected)
Independent engines (dream, swarm, planner) coordinating via interfaces.
**Cons:** N×N integration surface, duplicated memory/state, thesis erosion. This is the exact
failure mode the constraint exists to prevent.

## Trade-off Analysis

Federation buys local autonomy at the cost of global coherence. For a solo-owned, agent-driven
system, coherence is the scarce resource — a feature is worthless if no other agent can find or
reuse it. The Core trades some "freedom to add" for guaranteed interoperability and a thesis
that survives contact with a large agent fleet.

## Consequences

- **Positive:** one spine all agents share; new capability accrues to the loop, not beside it;
  the Feature Gate gives reviewers a one-line accept/reject test.
- **Negative / trade-offs:** features sometimes need reframing to name a stage; the gate must be
  actively enforced in review or sprawl creeps back in.
- **Follow-ups:** §3 + §9 of [ARCHITECTURE.md](../ARCHITECTURE.md) track the honest gap — the
  live serving path does not yet drive the Kernel end-to-end for every request.

## Alternatives considered

See Options above. "Do nothing / no constraint" was rejected: it is the default that produces
sprawl.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| One loop + four objects is the mandated shape | [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md), [CLAUDE.md](../../CLAUDE.md) | High | project docs |
| Loop is implemented as one Kernel | [`kernel.py:23`](../../src/convergence/kernel.py) | High | code |
| Four objects exist as dataclasses | [`objects.py:41/67/95/131`](../../src/convergence/objects.py) | High | code |
| Forbidden list (dream engine, multi-memory, swarms, digital-twin) | [CLAUDE.md](../../CLAUDE.md) "FORBIDDEN" | High | project doc |
