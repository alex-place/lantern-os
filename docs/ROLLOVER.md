# ROLLOVER.md — staging the Keystone kernel as the primary coding agent

> Epic: [#892](https://github.com/alex-place/lantern-os/issues/892). This doc is the
> staged plan and **measurable exit criteria** for moving the primary coding agent
> from Claude (cloud) to the in-house Keystone/Ouro kernel — and for the final step
> of dropping the Claude default. It documents behavior that already exists in code;
> it does not propose a new subsystem.

The North Star is unchanged (see [CONVERGANCE-SIGMA0-BRIEFING](CONVERGANCE-SIGMA0-BRIEFING.md)):
one loop, models are replaceable, **nothing advances without evidence**. Rollover is
just *which replaceable model the kernel path tries first* — gated, reversible, and
recorded.

---

## 1. Stages

| Stage | `KEYSTONE_ROLLOVER_MODE` | Who answers the kernel path | Claude's role | Advance requires |
|---|---|---|---|---|
| **0 — Shadow** | `shadow` (default/unset) | Claude only | Primary | Kernel components built + the Σ₀-K1 gates that don't need a live run (A, D, E) green |
| **1 — Assist** | `default` | Keystone/Ouro **first**, Claude fallback | Fallback | Gate **B** PASS (accuracy > 0.34 cold floor) **and** Gate **F** PASS (bytes-per-correct not worse than baseline) at stage `assist` |
| **2 — Default** | `default` | Keystone/Ouro first, Claude last-resort | Last-resort | Gate B/F PASS at stage `default` **and** escalation rate < Y% over N landed items (see §4) |
| **3 — Independent** | `default` (+ key removed) | Keystone/Ouro | Opt-in only | Stage-3 exit criteria (§4) — the only point at which the `ANTHROPIC_API_KEY` default is removed |

Stages are driven by a single env var, so a stage is a **config change, not a
deploy**, and rolling *back* is the same one-line change.

## 2. Routing (#ROUTE)

The kernel path has its own provider selection so it never inherits the chat
surface's Claude default — [`apps/lantern-garage/lib/provider-router.js`](../apps/lantern-garage/lib/provider-router.js)
`selectKernelProvider()`:

- `KEYSTONE_ROLLOVER_MODE = "shadow"` (default when unset) → **anthropic only**
  (`claude-opus-4-8`). Stage 0, safe: the kernel observes but does not drive.
- `KEYSTONE_ROLLOVER_MODE = "default"` → the `kernel` provider chain:
  `ollama:[keystone-ft, ouro:latest]` **first**, then `anthropic:[claude-opus-4-8]`
  as last-resort fallback.

`anthropic` is only ever *usable* when `ANTHROPIC_API_KEY` is set (`hasCredentials`),
so Stage 3 = removing that key turns Claude from "last-resort fallback" into
"opt-in only" without touching the chain.

## 3. Promotion gate (#GATE)

A stage may advance only when the **live kernel** clears the relevant Σ₀-K1 gates on
the 65-prompt golden set ([`data/eval/sigma0-prompts.jsonl`](../data/eval/sigma0-prompts.jsonl),
Gate A — done). Two bars gate cost/quality:

| Gate | Metric | Bar |
|---|---|---|
| **B — Continuation accuracy** | `eval_keystone.py` accuracy | must beat the **0.34** cold baseline (the ungrounded Ollama-HTTP row) |
| **F — Bytes-per-correct** | served cost per *correct* answer | must not regress vs the baseline row |

Mechanics:

1. `python scripts/eval_keystone.py --label keystone-<stage> --stage <stage> --engine loop`
   runs the golden set against the live kernel and writes a **stage-tagged** row to
   [`data/eval/leaderboard.jsonl`](../data/eval/leaderboard.jsonl) (`rollover_stage`).
2. `python scripts/rollover_gate.py --stage <stage>` (or `--run` to do both) reads
   that row, evaluates Gate B + Gate F, and prints **PASS/FAIL** plus an External
   Reality envelope `[claim, evidence, confidence, source]` — exit `0` on PASS, `1`
   on FAIL. Wire it into CI / `make gate-rollover` to block a stage advance.

The gate's threshold logic is pure and locked by
[`tests/test_rollover_gate.py`](../tests/test_rollover_gate.py) (0.34 boundary is not
a pass; cost regression blocks even when accuracy passes; envelope well-formed).

## 4. Stage-3 exit criteria — when the Claude default may be dropped (#FALLBACK / #DASH)

Removing the `ANTHROPIC_API_KEY` default is the irreversible-feeling step, so it has
the strictest, **measurable** bar. Drop the default only when, for **N = 3
consecutive rollover stages** at `KEYSTONE_ROLLOVER_MODE=default`:

1. **Quality:** Gate B PASS every stage (accuracy > 0.34 cold floor; target trending
   toward the grounded bar in [SIGMA0-K1-KERNEL-SPEC §3](SIGMA0-K1-KERNEL-SPEC.md)).
2. **Cost:** Gate F PASS every stage (bytes-per-correct ≤ baseline).
3. **Autonomy:** Claude **escalation rate < Y%** (default Y = 10%) of landed work
   items — i.e. the kernel finished the work itself ≥ 90% of the time. Escalations
   are recorded as convergence events (#897) so this rate is computed from real data,
   and the Keystone-vs-Claude landed-work share is the rollover dashboard (#898).

Until all three hold, `anthropic` stays in the chain as fallback.

## 5. Non-goals

- **Keep `anthropic` as an opt-in fallback** even after Stage 3 — "drop the default"
  ≠ "remove the provider". Models are replaceable; the chain stays pluggable.
- **No new agent ecosystem.** Rollover reuses `selectKernelProvider` + the existing
  fleet; it does not add a parallel agent stack (that would violate the convergence
  constraint).
- **State-ABI shim / kernel internals** (component 6, `StateABIShim`) are tracked in
  [SIGMA0-K1-KERNEL-SPEC](SIGMA0-K1-KERNEL-SPEC.md), not here. This doc is about
  *routing + promotion*, not the kernel's internals.

## See also

- Epic [#892](https://github.com/alex-place/lantern-os/issues/892) ·
  routing [#894](https://github.com/alex-place/lantern-os/issues/894) ·
  gate harness [#895](https://github.com/alex-place/lantern-os/issues/895) ·
  fleet gating [#896](https://github.com/alex-place/lantern-os/issues/896) ·
  fallback-as-convergence [#897](https://github.com/alex-place/lantern-os/issues/897) ·
  dashboard [#898](https://github.com/alex-place/lantern-os/issues/898)
- [SIGMA0-K1-KERNEL-SPEC.md](SIGMA0-K1-KERNEL-SPEC.md) — kernel gates A–F, components
- [CONVERGANCE-SIGMA0-BRIEFING.md](CONVERGANCE-SIGMA0-BRIEFING.md) — the North Star
