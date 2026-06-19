# Superfleet Swarm — Design (in-house, one `!convergance` structure)

> **Principle (set by the owner):** prefer in-house software and models; unify into
> **one independent structure** (`!convergance`); **avoid cloud-only components as a
> principle.** The swarm runs fully offline — nothing external is load-bearing.

This is the design for waking the **sleeping 36-slot superfleet** (`config/agents.json`,
`data/status/super-jarvis-fleet.json`) into a live worker swarm. It is **not** a new
subsystem and **not** an "independent agent ecosystem" (which the
[Σ₀ Briefing](CONVERGANCE-SIGMA0-BRIEFING.md) forbids). It is **the Convergence Core,
scaled**: one Kernel, one queue, one memory, with a bounded pool of interchangeable
workers all running the same loop `Observe → Remember → Reason → Act → Verify → Converge`
on `Task` objects. It strengthens **Act** (parallel execution) and **Reason**
(idle-time research). That passes the Design Law.

## Control loop (the Supervisor / listener)

A single long-lived **Supervisor** (the "Founder" node) runs an autoscaling tick:

```
every tick (~2s):
  depth   = queue.pending()            # MCP queue_status / ledger
  active  = workers.active()           # = active_slots (already live)
  cap     = capacity()                 # config/agents.json: 36 ring → elastic 64

  want = min(depth, cap.workers - active)         # spawn workers WHEN tasks exist
  for i in 1..want: spawn_worker()

  if depth < LOW_WATERMARK and researchers < MAX_RESEARCH:   # research WHEN idle
      spawn_researcher()                                     # DREAM mode → grounded tasks

  reap_finished(); requeue_failed(backoff); record_outcomes()
```

Spawn-on-demand + drain-triggered research = the swarm never idles and never runs unbounded.

## Worker = the Convergence Loop on one Task

```
Observe   claim a task (single-writer dispatch — no distributed-claim problem)
Remember  retrieve relevant memories (JSONL + CSF + in-house graph)
Reason    Model-Broker picks the best model (leaderboard) → plan (convergence-agent)
Act       execute in a SANDBOX (git worktree): the coder brain edits, runs tools (MCP)
Verify    run the checks/tests; confidence ≤ 0.3 until verified (DREAM proposal rule)
Converge  emit Convergence Record + PCSF receipt → push fix / mark done → ack
          on failure → requeue with backoff + record the failure pattern (learning)
```

This is `task_run` (the seed Kernel consumer), wrapped with a sandbox + verify-loop +
ack/retry.

## Researcher (idle-time exploration)

- **Mode:** `LANTERN-DREAM` — exploration 0.9, confidence ≤ 0.3, **proposal-only**.
- **Does:** scans repo / open issues / failing PRs / local sources → emits **grounded**
  candidate tasks via `task_intake`, each carrying `[claim, evidence, confidence, source]`.
  Never injects ungrounded noise (External Reality Rule). **Opt-in by default** so it can
  never runaway-generate work.

## In-house module map (no external services load-bearing)

| Need | In-house module (`!convergance`) | Built on |
|---|---|---|
| Durable queue | **event-sourced JSONL ledger** (`data/queue/task-ledger.jsonl`) | `queue_ledger.py` + CSF; replay-on-restart = durability, no broker |
| Claim/dispatch | **Supervisor dispatches** to spawned workers | one owner ⇒ no distributed claim |
| Worker plumbing | **in-house process supervisor** (subprocess) | `.claude/agent-slots.json`, `convergence-kernel-wrapper` |
| Coder brain | **Σ₀-coder** (your LoRA) + `convergence-agent` | local, in-house model |
| Model serving | local **Ollama / llama.cpp** (owned substrate); cloud LLM **opt-in burst only** | Model-Broker — never cloud-principal |
| Sandbox | **git worktrees** | local, no Docker required |
| Memory + graph | **JSONL + CSF + in-house graph over CSF** | one memory |
| Tools | **your MCP server** | in-house |
| Multi-machine | **`mesh_bridge` / `mesh-hub`** (your P2P) | donated local machines, not cloud |
| Observability | **PCSF receipts + Convergence Records + in-house fleet dashboard** | `super-jarvis-fleet.json`, `status.js`, live `active_slots` |

## Local-first guarantees

- **Runs with the network unplugged** — Σ₀-coder + local models do the work; ledger, CSF
  memory, MCP tools, and mesh are all local.
- **Cloud is never load-bearing** — a cloud LLM is opt-in burst capacity, gated + logged.
  Pull the cloud and the swarm still converges, just slower.
- **One structure** — back up or fork the whole superfleet by copying the repo + `data/`.

## Roadmap

- **Phase 0 — DONE:** queue + MCP tools, `task_run` (single Kernel worker), live
  `active_slots`, task producers (the auto-merge zipper files tasks), `swarm-orchestrator`
  (multi-model dispatch + consensus), `mesh_bridge`/`mesh-hub`, model-leaderboard, worktree
  sandboxing, the 36/64 capacity contract.
- **Phase 1 — DONE:** in-house **durable task ledger** (`queue_ledger.py`) behind the
  existing queue tools; event-sourced, replay-on-restart. Closes the "queue resets on
  restart" gap. No external dependency.
- **Phase 2 — Supervisor / autoscaler:** the watermark loop above; caps from
  `config/agents.json`.
- **Phase 3 — Sandboxed executor worker:** wrap Σ₀-coder in a worktree; add Verify → Converge
  → push. Turns `task_run` from *proposal* into *executor* — closes the auto-merge loop's
  last mile.
- **Phase 4 — Researcher:** DREAM explorer → grounded `task_intake` on queue-low.
- **Phase 5 — Diversity / failover:** 3 agent types per convergence step
  (`agents.json` diversity policy), leaderboard routing, retry across types.
- **Phase 6 — Mesh scale-out** (donated machines) → **Phase 7 — in-house fleet dashboard.**

## Safety rails (non-negotiable)

- Bounded concurrency (ring slots) — never unbounded spawn.
- Every worker output is a **proposal** until Verified (conf ≤ 0.3); nothing writes
  permanent truth unverified.
- All actions evidence-stamped (PCSF receipt + Convergence Record).
- Sandboxed (one task can't corrupt another — `LANTERN-SANDBOX`).
- Outward actions still pass the auto-merge green-gate.
- Global pause kill-switch; **researcher off by default**.
