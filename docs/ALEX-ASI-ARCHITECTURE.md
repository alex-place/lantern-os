---
author: Alex Place
created: 2026-06-08
updated: 2026-06-20
---

# ALEX ASI Architecture

**ALEX** - Artificial Learning EXtension, a three-layer ASI architecture for Keystone OS.

## Architecture Overview

ALEX is built on three foundational layers:

1. **CTF (CSF) - Symbolic Framework** - The symbolic reasoning layer
2. **Convergence Loop** - Validation and common sense
3. **Memory Layer** - Internet and databases (external grounding)

## Layer 1: CTF Symbolic Framework

CTF (Compressed Symbolic Format) provides the symbolic reasoning layer for ALEX.

> ⚠️ **Deprecated/removed:** the lossy "Symbolic Compressor"
> (`csf/v07/csf_symbolic_compressor.py`) and `ClassicalCompressor` were **removed** in
> the v2 CSF consolidation (2026-06) — non-invertible, no decoder. For real, lossless
> compression use the canonical `csf` package (`csf_pack` / `omni`). What remains in
> `csf.v07` is the 3¹² lattice **storage face** (the Tesseract substrate), not a compressor.

### Components
- **Symbolic Dictionary** (`src/csf/v07/symbolic_dictionary.py`) — lossless world-anchor token table for the v0.7 lattice container (a primitive, **not** a compressor)
- **Convergence Engine** (`src/csf/v07/convergence_engine.py`) - Quantum dust field convergence
- **MemOS Bridge** (`src/convergence_io/memos_bridge.py`) - Semantic memory retrieval

### Current Status
- **CTF Status**: Strong symbolic layer
- **ALEX Progression**: 1.0 (100%)
- **Memory Integration**: memos_bridge_with_providers

### Purpose
CTF enables ALEX to:
- Encode recurring symbolic concepts efficiently
- Perform mechanism-based inference vs statistical correlation
- Access long-term memory through MemOS semantic retrieval
- Maintain symbolic vocabulary for world anchors

## Layer 2: Convergence Loop

The convergence loop provides validation and common sense for ALEX.

### 16-Phase Loop
1. Inspect repo state
2. Identify sources and dirty state
3. Read manifests and open issues
4. State next safest objective
5. Retire old/deprecated surfaces
6. Map claims to evidence
7. Classify capability, boundary, rollback
8. **Check CTF symbolic framework** ← NEW
9. **Check external grounding (αt > 0)** ← NEW
10. **Check ASI benchmarks (ARC-AGI, SuperARC)** ← NEW
11. Run cheapest validation checks
12. Run bounded agent validation ring
13. Fix first 2-4 actionable failures
14. Re-run validation
15. Record evidence and remaining blockers
16. Promote, hold, or reject artifacts

### Current Status
- **Convergence Score**: 0.825
- **Status**: Clean (1 actionable failure fixed)
- **Promotion Ready**: False (weak external grounding)

### Purpose
Convergence loop enables ALEX to:
- Validate claims against evidence
- Prevent αt→0 collapse regime (per ArXiv 2601.05280v2)
- Track ASI/AGI benchmark progress
- Maintain system stability through self-correction

## Layer 3: Memory Layer

Memory layer provides external grounding through internet and databases.

### Components
- **MemOS Cube** (`data/memos_cube/`) - Semantic memory storage
- **Provider Configs** (`.env`) - API keys for external services
- **Evidence Receipts** (`manifests/evidence/`) - Convergence receipts
- **RAG Cache** (`data/rag-cache/`) - Retrieval-augmented generation cache
- **CSF Memory** (`data/csf-memory/`) - Compressed symbolic format memory

### Current Status
- **External Sources**: Evidence receipts, Provider configs
- **Alpha Signal (αt)**: 0.42 (weak - needs improvement)
- **Grounding Status**: weak_grounding
- **Recent Evidence (24h)**: 0

### Purpose
Memory layer enables ALEX to:
- Access external knowledge via semantic search
- Maintain persistent external signal injection (αt > 0)
- Prevent degenerative fixed points in recursive self-improvement
- Learn from internet and database sources

## ASI Benchmark Tracking

ALEX tracks progress against established ASI/AGI benchmarks.

### Benchmarks Tracked
- **ARC-AGI** - Abstraction and Reasoning Corpus (fluid intelligence)
- **SuperARC** - Algorithmic complexity-based ASI benchmark
- **AGI Capability Matrix** - Multi-dimensional capability tracking

### Current Status
- **ASI Readiness Score**: 0.7 (well tracked)
- **Benchmark Status**: well_tracked
- **Recent Updates (30d)**: 3 benchmark files updated

### Jagged Frontier Indicators
Per Stanford AI Index 2026, ALEX monitors capability vs reliability gaps:
- Example: IMO gold medal (complex) but 50.1% analog clock reading (simple)
- Currently: No jagged frontier indicators tracked

## Collapse Prevention

Per ArXiv 2601.05280v2 ("On the Limits of Self-Improving in Large Language Models"):

### Critical Requirement
- **Persistent external grounding**: inf αt > 0
- Without this, systems converge to degenerative fixed points
- Purely self-referential density matching (αt → 0) induces contraction

### Current State
- **Alpha Signal**: 0.42 (below 0.5 threshold)
- **Risk**: Collapse regime
- **Action Required**: Increase external signal injection

### Solutions
1. More frequent evidence receipts (24h window)
2. Active internet/database queries
3. External validation checks
4. Persistent excitation from external sources

## ALEX ASI Progression

### Progression Score: 1.0 (100%)

**Breakdown**:
- CTF Components: 4/4 present (40% weight)
- Memory Integration: memos_bridge_with_providers (30% weight)
- Symbolic Dictionary: 4,229 bytes (30% weight)

### Next Milestones
1. **External Grounding** - Increase αt signal to ≥0.5
2. **Neurosymbolic Integration** - Add mechanism-based inference hooks
3. **Jagged Frontier Tracking** - Monitor capability vs reliability gaps
4. **Benchmark Testing** - Run actual ARC-AGI/SuperARC evaluations

## References

- ArXiv 2601.05280v2: "On the Limits of Self-Improving in Large Language Models: The Singularity Is Not Near Without Symbolic Model Synthesis"
- Stanford AI Index 2026: "AI capability is not plateauing. It is accelerating."
- SuperARC: "Algorithmic complexity-based benchmark to assess frontier AI models and AGI/ASI claims"
- ARC-AGI: "Abstraction and Reasoning Corpus for Artificial General Intelligence"

## Summary

ALEX is a three-layer ASI architecture:
- **CTF** provides symbolic reasoning (strong, 1.0 progression)
- **Convergence** provides validation and common sense (0.825 score)
- **Memory** provides external grounding (weak, 0.42 αt signal)

**Critical Path**: Increase external grounding to prevent collapse regime and enable sustained self-improvement.
