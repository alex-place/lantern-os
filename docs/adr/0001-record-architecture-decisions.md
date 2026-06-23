---
adr: 0001
title: Record architecture decisions
status: Accepted
date: 2026-06-23
deciders: Alex Place
supersedes: none
superseded-by: none
---

# ADR-0001: Record architecture decisions

## Status

Accepted

## Context

Keystone OS is a solo-developer, local-first reasoning system worked by a fleet of
concurrent agents (`claude/`, `gemini/`, `codex/`, … lanes). Architectural knowledge today
is spread across ~120 `docs/*.md` files, dated audits
([ARCHITECTURE-AUDIT-2026-06-13.md](../ARCHITECTURE-AUDIT-2026-06-13.md)), mapping docs
([convergence-core-mapping.md](../convergence-core-mapping.md)), and session chat logs.
There is no single place that records *why* a structural choice was made, so:

- New agents re-derive the architecture every session instead of reading it.
- Settled decisions get re-litigated (e.g. "should we add a second memory system?") even
  though the North Star already forbids them.
- The reasoning behind a choice is lost once the chat that produced it scrolls away,
  leaving only the code.

The Σ₀ North Star ([CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md))
demands that important claims carry evidence and that we reject architectural sprawl. A
durable decision log is the Remember-stage tool that makes those constraints enforceable
over time.

## Decision

We will record architecture decisions as **Architecture Decision Records (ADRs)** kept in
`docs/adr/`, one Markdown file per decision, using the lightweight MADR-style template in
[`0000-template.md`](0000-template.md).

- ADRs are numbered sequentially (`NNNN-kebab-title.md`) and **append-only**: an accepted
  decision is never rewritten; it is superseded by a newer ADR.
- Each ADR records Context, Decision, Consequences, Alternatives, and an Evidence table
  honoring the External Reality Rule (`[claim, evidence, confidence, source]`).
- [`docs/adr/README.md`](README.md) is the index and the authoring guide.
- ADRs record *why* (the decision history); [ARCHITECTURE.md](../ARCHITECTURE.md) records
  *what is true now* (the current-state snapshot). The two are kept consistent.

## Consequences

- **Positive:**
  - Decisions and their rationale survive past the chat that produced them.
  - Agents can read settled constraints instead of re-deriving or re-litigating them.
  - Forbidden directions (sprawl, second memory system, digital-twin scope creep) have a
    citable record, not just folklore.
- **Negative / trade-offs:**
  - Small per-decision overhead: structural changes now require writing an ADR.
  - Risk of drift if ARCHITECTURE.md and the ADR log aren't kept in sync — mitigated by
    treating "update the docs" as part of any structural change.
- **Follow-ups:**
  - Backfill ADRs for decisions already in force (single Convergence Core, one CSF module,
    append-only JSONL + CSF memory, interchangeable-models provider layer, dual-boot
    4177/4178 topology, monoworkstream one-lane-per-agent).
  - Produce [ARCHITECTURE.md](../ARCHITECTURE.md) as the canonical current-state writeup.

## Alternatives considered

- **Do nothing (status quo):** keep decisions in scattered docs and chat. Rejected — this
  is the exact failure mode above; it does not scale to a multi-agent fleet.
- **One growing "architecture decisions" section inside CODEMAP.md:** rejected — couples
  decision history to a status roadmap that churns, and offers no per-decision supersession.
- **External tooling (a wiki / issue tracker only):** rejected — decisions must live in the
  repo next to the code they govern, version-controlled and reviewable in the same PR.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| No ADR practice exists today | `docs/` has no `adr/` dir prior to this change | High | repo survey 2026-06-23 |
| Architecture knowledge is scattered | ~120 `docs/*.md`; overlapping arch docs (CODEMAP, ARCHITECTURE-AUDIT-2026-06-13, convergence-core-mapping) | High | `ls docs/` |
| North Star forbids sprawl + requires evidence | [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md) | High | project doc |
