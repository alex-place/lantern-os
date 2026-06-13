/*!
# CIO — Convergence IO Execution Kernel v1.0

Typed Rust reference implementation of the Convergence Execution Graph (CEG),
PCSF constraint optimizer, time dilation field, and hot-swap engine.

## What is intentionally NOT in v1.0
- No async runtime (Tokio introduced in v1.1)
- No real LLM backend binding
- No distributed execution
- No probabilistic planner
- No full hot-swap safety proofs

## Architecture

```
CSF (input spec)
  → CEGGraph (execution graph)
      → PCSFOptimizer (constraint-satisfying plan)
          → CIOExecutor (execution loop with dilation + swap)
              → CIOState (output state)
```

## Global invariants (enforced at type level)
1. Continuity    — NodeId is Copy; graph mutations are explicit
2. TraceComplete — every execute() call returns a TraceEvent
3. Constraint dominance — ConstraintViolation is non-exhaustive; callers must handle
4. Bounded determinism — pure functions; no hidden global state
*/

pub mod csf;
pub mod graph;
pub mod pcsf;
pub mod dilation;
pub mod hot_swap;
pub mod executor;

pub use csf::CSF;
pub use graph::{CEGGraph, Node, NodeId, EdgeKind};
pub use pcsf::{PCSFOptimizer, ExecutionPlan};
pub use dilation::dilation;
pub use hot_swap::HotSwapEngine;
pub use executor::{CIOExecutor, CIOState};
