# CEG — Convergence Execution Graph

**Module:** [`src/convergence_io/ceg.py`](../../src/convergence_io/ceg.py) · **Role:** the typed substrate the rest of the stack plugs into · **Tests:** [`test_ceg.py`](../../tests/test_ceg.py), [`test_ceg_engine.py`](../../tests/test_ceg_engine.py), [`test_ceg_v04.py`](../../tests/test_ceg_v04.py)
**Status:** Implemented + unit-tested (largest module, ~725 LOC). Python reference contract; not on the live JS path (see [README](README.md#status-honest)).

## What it is

CEG is the graph every request is compiled into. Formally:

```
G = (V, E, D, τ, S, H)
  V — typed nodes        E — typed directed edges
  D — time-dilation field (per-node, recomputed each tick — see DILATION.md)
  τ — execution-time model (latency targets shaped by D)
  S — system state (resource + memory + policy snapshots)
  H — hot-swap registry (hot_swap.py)
```

Every other primitive in the stack is a node or an annotation on this graph: PCSF picks the
`ResourceNode`, NAP/CCF gate via `ConstraintNode`/`AuthorityNode`, AAPF is emitted as `TraceNode`s,
DCF rides on `MemoryNode` provenance, and the dilation field is `D`.

## Node & edge taxonomy

| Node | Meaning |
|---|---|
| `IntentNode` | the **what** — user request / goal embedding |
| `ResourceNode` | the **how** — `LLM` \| `VM` \| `TOOL` \| `AGENT` (picked by [PCSF](PCSF.md)) |
| `ConstraintNode` | the **must** — predicate, scope, severity ([NAP](NAP.md)/[CCF](CCF.md)) |
| `AuthorityNode` | the **who** — policy set, identity scope |
| `MemoryNode` | the **remember** — CSF content + provenance ([DCF](DCF.md)) |
| `TraceNode` | the **audit** — [AAPF](AAPF.md) causal event |
| `UIProjectionNode` | feature-state projection for the UI |

Edges: `Requires` (hard pre-activation), `Enables` (soft), `Blocks`, `ExecutesOn`,
`TransformsInto`, `Observes`.

## Core types / API

- **`CEGraph`** — the mutable graph: `add_node` / `remove_node` / `add_edge` / `swap_node`
  (hot-swap a resource), `get_node`, `nodes_by_kind`, `edges_from` / `edges_to`,
  `blocked_by` / `required_by` (dependency queries), `snapshot()`, `advance_tick()`.
- **`ExecutionContract`** (+ `ExecutionConstraints`) — a declarative spec handed to the optimizer.
- **`PCSFOptimizer`** — given a contract + `SystemState`, returns an ordered **`ExecutionPlan`**
  (`ExecutionStep`s) that satisfies all constraints; `optimize()` / `reoptimize()` with a
  `CostWeights`-weighted node/total cost (cost is scaled by `D`).
- **`SystemState`** (`S`) — `ResourceState` + `MemoryState` + `PolicyState`, with
  `resource_health` / `resource_latency` / `memory_load` / `active_constraints` views.
- **`CEGExecutor`** — walks the plan tick-by-tick (`ExecutorStep`s), applying `D` and emitting traces.

## Invariants (enforced at mutation boundaries)

1. **Continuity** — no active execution interrupted without rollback.
2. **TraceComplete** — every node activation emits a `TraceNode` (→ AAPF).
3. **Constraint dominance** — `ConstraintNode` violations **block**, never warn.
4. **Bounded determinism** — same `G + S + D` → same plan (modulo wall-clock).

## Status & gaps

- Implemented end-to-end (graph → optimizer → executor) with the four invariants; covered by
  three dedicated test files plus the engine suite.
- It's the **design substrate**: the production 4177 chat path does not compile requests into a
  `CEGraph` today — `lib/stream-chat.js` routes directly and borrows the *concepts* (dilation →
  grounding) via the JS adapter rather than running this optimizer/executor.
