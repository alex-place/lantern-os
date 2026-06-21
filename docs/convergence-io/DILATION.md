# D — Time Dilation Field

**Module:** [`src/convergence_io/dilation.py`](../../src/convergence_io/dilation.py) · **Role:** the `D` in CEG's `G=(V,E,D,τ,S,H)` · **Tests:** [`tests/test_dilation.py`](../../tests/test_dilation.py)
**Status:** Implemented + unit-tested. This is the primitive whose *concept* most clearly reaches the live path — the JS [`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) mirrors its dilation→grounding mapping (see [README](README.md#status-honest)).

## What it is

A per-node scalar `D(v)` that makes the system **spend more time where it's uncertain and less
where it's confident** — a compute analogue of gravitational time dilation:

```
D(v) = f(uncertainty, cost_pressure, confidence)

  high uncertainty   → D > 1   (slow region — explore deeply, take more time)
  high confidence    → D < 1   (fast region — execute quickly)
  high cost_pressure → D < 1   (compressed — optimize for speed/cost)
```

Applied per-node per-tick by the executor:

```
dilated_latency = base_latency * D(v)
cost(edge)     *= D(source_node)
```

## Core types / API

- **`dilation(uncertainty, cost_pressure, confidence, ...) → float`** — the field function itself.
- **`grounding_policy(D, base_max_results=5, ...) → GroundingPolicy`** — **the load-bearing bridge**:
  maps a node's `D` to how much grounding to buy. High `D` (uncertain) ⇒ more retrieval / more
  external checks; low `D` ⇒ answer fast. This is the piece the JS path reimplements.
- **`DilationField`** — the per-graph state:
  - `DilationField(max_dwell_ticks=8, dwell_threshold=1.5)` — caps how long a node may stay in a
    slow region (anti-stall).
  - `update_node(...)` / `update_from_health(node_id, health, latency_ratio)` — recompute `D` from
    live signals.
  - `get(node_id)`, `apply_to_graph(graph)` (writes `D` onto every node), `snapshot()`.
- **`NodeDilationState`** — per-node dwell/`D` bookkeeping.
- **`SwapConvergenceGuard`** — prevents hot-swap oscillation: `record_swap` / `is_oscillating`
  / `reset`, bounded by `max_swaps` over a `window_ticks` window (so dilation-driven re-routing
  can't thrash between two resources forever — supports CEG's *bounded determinism* invariant).

## How it composes

`D` is what couples the graph to reality: PCSF latency/health signals feed `update_from_health`,
the resulting `D` reshapes `τ` (latency targets) and edge costs in the `PCSFOptimizer`, and
`grounding_policy(D)` decides how hard the Verify stage works. More uncertainty ⇒ slower, more
grounded execution — the Σ₀ "verification is mandatory" rule expressed as a field.

## Status & gaps

- Implemented with the field function, the grounding-policy mapping, dwell caps, health-driven
  updates, and an oscillation guard; directly unit-tested.
- The **live** consumer is the JS [`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js)
  adapter, not this Python module — the two encode the same dilation→grounding idea and should be
  kept in agreement, but they are separate implementations.
