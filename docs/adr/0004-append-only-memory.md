---
adr: 0004
title: Append-only JSONL + CSF archive as the only memory systems
status: Proposed
date: 2026-06-23
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0004: Append-only JSONL + CSF archive as the only memory systems

## Status

Proposed — awaiting approval from Alex Place.

## Context

The Remember stage needs durable, local, owner-controlled memory. Two failure modes loom: (1)
mutable stores that lose history (you can't ask "what did I believe last week, and with what
confidence?"); and (2) a proliferation of memory systems (a vector DB here, a SQLite there, a
cache somewhere else) that no agent can reason about as a whole — explicitly forbidden by the
North Star ("multiple memory systems → No").

The North Star also says learning is **persistent experience, not weight modification**:
improvement comes from retrieval over accumulated memory, never retraining.

## Decision

Memory is exactly **two stores, both owned locally**:

1. **Append-only JSONL logs** under `data/` — conversations, trading history, agent audits, and
   Convergence Records (`data/convergence/records.jsonl`, `issue-work-records.jsonl`). Entries
   are appended, never rewritten; confidence shifts by adding new records, not editing old ones.
   Concurrent writes funnel through [`lib/file-queue.js`](../apps/lantern-garage/lib/file-queue.js)
   to avoid interleaved corruption.
2. **One CSF archive** for lossless compression/versioning of that memory (see
   [ADR-0003](0003-one-canonical-csf-module.md)).

No third memory system is introduced. JSON *state* snapshots (flags, manifests, PCSF) are
current-state config, not the memory log, and are exempt.

## Options Considered

### Option A: Append-only JSONL + CSF (chosen)
**Pros:** full history + provenance; trivially local and inspectable; greppable; one ingestion
path; aligns with retrieval-not-retraining.
**Cons:** unbounded growth; no rich query engine out of the box (retrieval is token-budgeted
scan + CSF, see [`memory_query.py`](../src/convergence/memory_query.py)); compaction is manual.

### Option B: Embedded database (SQLite / vector DB) (rejected)
**Cons:** mutable rows erode the append-only invariant; adds a second memory system; couples the
loop to a query engine. Retrieval gains don't justify the coordination + history loss.

## Trade-off Analysis

A database would make some queries faster, but the project's scarce resource is *coherence and
ownership*, not query latency. Append-only JSONL keeps every claim, evidence, and confidence
value forever in a format the owner can read with `cat`; CSF handles size. Query richness is a
retrieval-layer concern that can improve *without* adding a store.

## Consequences

- **Positive:** nothing is lost; confidence is a first-class, time-stamped signal; one place to
  look; honors retrieval-not-retraining.
- **Negative / trade-offs:** logs grow; retrieval is scan/index-based, not SQL; compaction +
  confidence-field coverage are ongoing work.
- **Follow-ups:** unify the retrieval interface across JSONL read + CSF unpack (noted as a gap in
  [convergence-core-mapping.md](../convergence-core-mapping.md)).

## Alternatives considered

See Options. "Do nothing / let stores proliferate" is the forbidden multi-memory failure mode.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Memory = append-only JSONL + one CSF archive | [CLAUDE.md](../CLAUDE.md) core-objects; [CONVERGANCE-SIGMA0-BRIEFING.md](../CONVERGANCE-SIGMA0-BRIEFING.md) | High | project docs |
| Convergence Records persisted as JSONL | `data/convergence/records.jsonl`, `issue-work-records.jsonl` | High | repo survey |
| Concurrent appends serialized | [`lib/file-queue.js`](../apps/lantern-garage/lib/file-queue.js) | High | code |
| Memory serializes to JSONL | [`objects.py:55`](../src/convergence/objects.py) (`to_jsonl`) | High | code |
| Multiple memory systems forbidden | [CLAUDE.md](../CLAUDE.md) Feature Gate | High | project doc |
