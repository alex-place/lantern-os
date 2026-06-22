# CEG — Convergence Execution Graph

**Module:** [`src/convergence_io/ceg.py`](../../src/convergence_io/ceg.py) · **Role:** the typed substrate everything else plugs into · **Tests:** [`test_ceg.py`](../../tests/test_ceg.py), [`test_ceg_engine.py`](../../tests/test_ceg_engine.py), [`test_ceg_v04.py`](../../tests/test_ceg_v04.py)

**Status:** Built and unit-tested (the biggest module here, ~725 lines). Python reference version; not on the live chat path — see the [README](README.md#status-honest).

## In one sentence

CEG turns a request into a **map of everything that has to happen** — the steps, what each step needs, and in what order — so the system can plan the whole job before doing any of it.

## The everyday version

Think of the **dependency chart a project manager draws**: a box for each task, arrows for "this can't start until that's done," and notes on who does what. Once you have the chart, you can find the right order, spot what's blocking what, and swap one contractor for another without redrawing everything.

CEG is that chart for a request, and every other piece of the stack shows up *on* it — it's the shared surface they all draw on. Formally it's written `G = (V, E, D, τ, S, H)`, which is just shorthand for six ingredients:

| Symbol | Plain meaning |
|---|---|
| **V** | the boxes (the things to do) |
| **E** | the arrows (how the boxes connect) |
| **D** | the "spend more time here" dial on each box (see [TDF](DILATION.md)) |
| **τ** | how long each step should take (shaped by D) |
| **S** | a snapshot of the current state — resources, memory, policy |
| **H** | the registry that lets you hot-swap one box for another |

## The kinds of boxes

Each box has a type, and each type is where one of the other primitives lives:

| Box | Stands for the… | Owned by |
|---|---|---|
| `IntentNode` | **what** — the user's goal | — |
| `ResourceNode` | **how** — an LLM, VM, tool, or agent | [PCSF](PCSF.md) |
| `ConstraintNode` | **must** — a rule that has to hold | [NAP](NAP.md) / [CCF](CCF.md) |
| `AuthorityNode` | **who** — identity and policy scope | — |
| `MemoryNode` | **remember** — stored content + where it came from | [DCF](DCF.md) |
| `TraceNode` | **audit** — a logged event | [AAPF](AAPF.md) |
| `UIProjectionNode` | what the UI should show | — |

The arrows have types too: `Requires` (hard — must finish first), `Enables` (a soft nudge), `Blocks`, `ExecutesOn`, `TransformsInto`, and `Observes`.

## What's in the toolkit

**The map itself — `CEGraph`.** Add or remove boxes and arrows, swap a resource live (`swap_node`), and ask dependency questions like "what's blocking this?" (`blocked_by`) or "what needs this?" (`required_by`).

**The plan — `ExecutionContract` → `PCSFOptimizer` → `ExecutionPlan`.** Hand the optimizer a contract (what you want, under what constraints) plus the current state, and it returns an **ordered, constraint-satisfying plan** — cheapest-first, where "cost" is scaled by each box's D dial.

**Running it — `CEGExecutor`.** Walks the plan one tick at a time, applies the D dial, and emits an audit trace as it goes.

## The rules it never breaks

Four invariants are enforced whenever the map changes:

1. **Continuity** — a running step is never cut off without a clean rollback.
2. **Trace-complete** — every step that runs leaves an audit record (→ [AAPF](AAPF.md)).
3. **Constraints win** — a broken rule **blocks** the action; it never just warns.
4. **Bounded determinism** — the same map + state + dials produce the same plan (give or take wall-clock timing).

## Status & gaps

- **Working end-to-end** — map → optimizer → executor, with all four rules, covered by three dedicated test files plus the engine suite.
- **It's the blueprint, not the live engine.** The site at 4177 doesn't actually compile requests into a CEG today — the live path routes directly and borrows the *ideas* (notably dilation → grounding) through a JavaScript adapter, rather than running this optimizer and executor.
