---
adr: 0003
title: One canonical CSF module
status: Proposed
date: 2026-06-23
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0003: One canonical CSF module

## Status

Proposed — awaiting approval from Alex Place.

## Context

CSF (Convergence-Fitted Searchable Format) is the project's lossless binary archive — the "one
CSF archive" half of the persistence model (the other half is append-only JSONL; see
[ADR-0004](0004-append-only-memory.md)). Historically CSF accreted **multiple writers**: a
segmented v1 `CsfArchive` with its own `csf_compress/decompress/merge/search` CLIs, a v0.3
`csf_file` writer, and lossy v0.7 *symbolic text* compressors. Multiple formats meant callers
picked the wrong one, archives were written in incompatible layouts, and "which CSF do I use?"
was a recurring tax.

The v2 consolidation (2026-06, repo v1.5.0) resolved this.

## Decision

We will keep **exactly one canonical CSF module** with a single public API at the package root,
[`src/csf/__init__.py`](../src/csf/__init__.py): `pack`/`unpack`/`read_file` for file/blob
archives and `compress`/`decompress` for byte strings, backed by the engine
[`csf_pack.py`](../src/csf/csf_pack.py).

- The duplicate/legacy **writers** are **deleted** so they cannot be called by mistake.
- Existing on-disk archives remain openable **read-only** via
  [`src/csf/legacy.py`](../src/csf/legacy.py).
- The v07 lattice primitives (Tesseract "storage face") and the Status-Cube container
  ([`status_cube.py`](../src/csf/status_cube.py)) are retained as kept components.
- **No second CSF format may be re-introduced.** New needs extend the one module.

## Options Considered

### Option A: One canonical module, legacy read-only (chosen)
**Pros:** one obvious API; impossible to write the wrong format; old data still readable.
**Cons:** one-time migration; lost the niche strengths of deleted writers (e.g. symbolic ratios
— which were lossy fiction anyway).

### Option B: Keep multiple writers behind a façade (rejected)
**Cons:** the façade hides, but does not remove, the footgun; writers drift; the "which format"
tax persists.

## Trade-off Analysis

Deleting working code feels lossy, but a *writer* that can be called by mistake is a liability,
not an asset. Read-only legacy support preserves the only thing that mattered (existing data)
while removing the ways to create new divergence.

## Consequences

- **Positive:** `import csf` is the one true entry; new code can't fork the format; archives
  stay consistent.
- **Negative / trade-offs:** docstrings/spec must not over-promise the codec — see the known
  divergence below.
- **Follow-ups:** [ARCHITECTURE.md §9.3](../ARCHITECTURE.md#9-known-divergences--debt) — the
  public API advertises `zstd-19+LDM` ([`__init__.py:12`](../src/csf/__init__.py)) but active
  paths have bottlenecked on zlib / low-level zstd; verify the real codec before quoting ratios.
  This is a perf-debt follow-up, not a reason to add a second format.

## Alternatives considered

See Options. "Do nothing" (keep all writers) was the status quo that caused the problem.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| One public API at package root | [`src/csf/__init__.py:12-18`](../src/csf/__init__.py) | High | code |
| Legacy writers deleted, read-only via legacy.py | [`__init__.py:27`](../src/csf/__init__.py), [`legacy.py`](../src/csf/legacy.py) | High | code |
| v07 lattice + Status-Cube kept | [`status_cube.py`](../src/csf/status_cube.py); [CLAUDE.md](../CLAUDE.md) CSF section | High | code + doc |
| Codec claim vs reality is open debt | [`__init__.py:12`](../src/csf/__init__.py) vs ARCHITECTURE.md §9 | Medium | doc + prior measurement |
