---
adr: 0012
title: Nested adaptive Reason — Q-exit (within-model) x fidelity escalation (cross-model)
status: Proposed
date: 2026-07-01
deciders: Claude (agent), per issue #1527's own instruction to draft this ADR first
approved-by: pending   # only Alex Place flips this; agents leave it `pending`
supersedes: none
superseded-by: none
---

<!--
  APPROVAL GATE: leave status `Proposed` and approved-by `pending`. An ADR is not
  binding until Alex Place explicitly approves it; only then set status `Accepted`
  and approved-by `Alex Place (YYYY-MM-DD)`. Never self-approve.
-->

# ADR-0012: Nested adaptive Reason — Q-exit (within-model) x fidelity escalation (cross-model)

## Status

Proposed

## Context

Loop stage: **Reason** (+ **Verify** as the gating signal).

The Σ₀ loop has two independent adaptive-compute mechanisms today that never talk to
each other, and two stability canaries that observe but never *decide*:

| Piece | Layer | What it does now | Gap |
|---|---|---|---|
| Ouro Q-exit / accel (`src/sigma0/loop_lm.py`, `Sigma0LoopLM.generate(mode=qexit\|converge\|accel)`) | within-model | Per-token adaptive recurrent depth; exits on trained confidence CDF, first-order fixed point, or spiral-robust acceleration. Measured 25-43% compute saved at 95-98% fidelity (`scripts/bench_ouro_loop.py`). | Saturating depth (`exit_reason` from `max_depth`) just stops — no escalation door. |
| Fidelity escalation (`lib/wide-search.js` low->high; `lib/keystone-escalation.js` `runKernelWithEscalation`) | cross-model | Runs the cheap/local model first, escalates to a stronger model on failure/verify-miss. | Blind to the within-model convergence signal — can't distinguish "thrashing" from "confidently wrong." |
| `DecodeCanary` / `collapse-canary.js` | observer | Folds self-repeat / n-gram echo / argmax-margin / entropy into `sigma0_proximity`. JS side logs only, never routes. | The signal that should trigger escalation is discarded at the model boundary. |
| `groundedness-canary.js` | observer | Detects confident-but-unanchored claims. | Passive; a fluent ungrounded answer passes straight through. |
| Collapse certificate gates (`loop_lm.py` `_stability_gates`) | observer | Spectral fate (CONTRACT vs DIVERGE) of the latent loop. | `loop_lm.py:73` — "purely diagnostic; reported, not consumed by the gate." |

Full design already written up: `docs/research/2026-06-29-sigma0-nested-adaptive-reason.md`
(2026-06-29). This ADR formalizes that design for the approval gate the issue itself
requires — it does not introduce new technical content beyond that doc.

Two open issues sit on this gap and are the reason this ADR exists now:
- **#1527** — "Implement nested-adaptive Reason (Q-exit x fidelity escalation), gated
  by the stability canaries." Its own issue body states: *"Blocked on: ADR approval
  (Alex). Draft an ADR Status: Proposed first; do not wire until accepted."* This ADR
  is that draft.
- **#1423** — "Adaptive-compute coder with visible thinking budget (Reason)." Asks to
  productize the Q-exit gate with a live compute-spent-vs-confidence meter. Investigated
  2026-07-01: the telemetry (`mean_depth`, `exit_reason`, `canary_*`) is real and already
  computed/persisted (`scripts/ouro_serve.py:185-209` `_persist_loop_meta`,
  `data/eval/leaderboard.jsonl`) — but **only** when the server runs with
  `OURO_NATIVE=1`. The default live-serving path (`OURO_NATIVE=0`, cached HF `generate()`)
  never runs the adaptive loop at all — per the server's own comment
  (`scripts/ouro_serve.py:53-56`), native mode is "far slower (~1 s/token)... NOT the
  chat default." So a genuinely *live*, per-message meter during normal coding chat needs
  one of: (a) flipping the default coding-serving path to native mode (a real latency
  trade-off), or (b) a parallel shadow call purely for telemetry (2x compute per request).
  Both are the same wiring decision this ADR is about, not a separate one.

## Decision

We will define one shared `ReasonVerdict` struct, produced/consumed per Reason unit
(a token loop, a draft, a research pass):

```
ReasonVerdict = {
  converged:  bool,
  depth:      number,
  proximity:  number,    // collapse proximity (DecodeCanary / collapse-canary)
  grounded:   number,    // 1 - ungrounded score (groundedness-canary)
  stable:     'contract' | 'spiral' | 'diverge',
  reason:     'threshold_met' | 'fixed_point' | 'accel_fixed_point'
            | 'max_depth' | 'collapse' | 'divergence' | 'ungrounded',
}
```

A Reason unit exits through exactly one of three doors:

1. **Converge** (`converged && stable==='contract' && proximity<τ_c && grounded>τ_g`) →
   accept at the cheapest tier.
2. **Escalate** (`reason ∈ {max_depth, collapse, divergence, ungrounded}` or
   `stable!=='contract'`) → the within-model failure becomes the cross-model trigger;
   hand the same prompt up the fidelity ladder (Wide Search / `keystone-escalation`).
3. **Abort** (ladder budget exhausted) → return an honest low-confidence verdict with
   the evidence trail, never a fabricated answer (External Reality Rule).

Nesting: the fidelity ladder (outer, cross-model) wraps the Q-exit loop (inner,
within-model); the certificate gates become a `break` condition inside the inner loop
(stop spending depth once divergence is detected) instead of a passive log line.

Rollout is four independently-shippable steps, each with its own bench and env-var
kill-switch, none requiring retraining (consumes the already-trained Q-exit gate + the
analytic certificate, honoring the Persistent-Learning rule):

1. **Surface the verdict** — `loop_lm.generate()` already computes `mean_depth`,
   `exit_reason`, `canary_*`, `_stability_gates`; assemble and return them as one
   `ReasonVerdict`. No behavior change, pure observability.
2. **Inner break on instability** — add the door-2 `break` when `_stability_gates`
   reports non-contract for `patience` steps. Bench: compute saved vs. fidelity on
   `bench_ouro_loop.py` / `eval_humaneval_ouro.py`; must stay ≥ baseline quality.
3. **Outer trigger on verdict** — in `wide-search.js` low/high pass and
   `keystone-escalation.runKernelWithEscalation`, replace the coarse "did it apply?"
   gate with `verdict.escalate_door` (adds `ungrounded` + `unstable` to the escalate
   set). Bench: escalation rate + landed-work share on `convergence-autonomous-work`.
4. **Close the loop in the JS serving path** — `collapse-canary.js` +
   `groundedness-canary.js` return a routing hint (not just log) so a collapsing or
   ungrounded local reply escalates to the cloud tier in live chat serving.

## Consequences

- **Positive:**
  - One convergence signal drives both "think harder in place" and "call a bigger
    model," instead of two mechanisms that can silently disagree.
  - Escalation starts firing on *ungrounded* and *spiral/diverge*, not just "tests
    failed" — catches a confidently-wrong small-model answer before it lands, which
    today's coarse pass/fail gate cannot.
  - Stops burning recurrent depth on a token the certificate already says will diverge
    (step 2 alone is a strict compute saving, independent of the other steps).
  - Steps are independently shippable and independently revertible (env-var
    kill-switches) — a bad bench result on step 2 does not block or unwind step 1.
- **Negative / trade-offs:**
  - Step 4 changes live chat-serving behavior (a collapsing/ungrounded local reply that
    previously returned to the user now escalates to a paid cloud call) — real latency
    and cost impact that needs its own measurement before it ships, not just a bench
    number in isolation.
  - A genuinely live "compute-spent" meter (#1423's literal ask) requires either running
    the local coder in native (slow) mode by default, or paying for a parallel shadow
    call — both raise either latency or cost for every local coding turn, in exchange for
    a UI affordance. That trade-off is this ADR's to make, not a bug fix.
  - Four new fields (`ReasonVerdict`) become part of the contract between the Python
    loop and the JS serving/escalation layers — one more shape to keep in sync across
    the language boundary.
- **Follow-ups:** once Accepted, #1527 (wiring) and the live-meter half of #1423 can
  proceed per the four-step rollout above, each as its own PR with its own bench.

## Alternatives considered

- **Do nothing** (leave the two mechanisms separate). Rejected: the escalation layer
  keeps escalating on coarse outcomes only, missing the "confidently wrong" failure
  mode that the canaries already detect but don't route on — a known, named gap, not a
  hypothetical one.
- **Heuristic bolt-on** (e.g., escalate whenever `canary_max_proximity` crosses a fixed
  threshold, without touching `_stability_gates`). Rejected: the collapse certificate's
  non-normal dichotomy already characterizes exactly the spiral/skew case where a naive
  proximity threshold either fires too early (mid-spiral, still contracting) or too late
  (past the point `accel_step` would have caught it). Routing on the certificate's fate
  inherits a proof; a threshold re-derives a weaker proxy.
- **Always run native mode** (make `OURO_NATIVE=1` the default so telemetry and
  escalation are always live). Rejected as the default without a bench: native mode is
  measured far slower per token than the cached path; flipping the default without
  first measuring the fidelity/latency trade-off on real traffic would trade a known
  regression for an unmeasured gain.

## Evidence

| Claim | Evidence (file:line / commit / PR) | Confidence | Source |
|---|---|---|---|
| Q-exit adaptive depth saves 25-43% compute at 95-98% fidelity | `docs/research/2026-06-29-sigma0-nested-adaptive-reason.md` row 1; `scripts/bench_ouro_loop.py` | Medium — cited from existing research doc, not independently re-run in this session | Research doc + bench script |
| `_stability_gates` fate is computed but not consumed | `src/sigma0/loop_lm.py:73` (comment: "purely diagnostic; reported, not consumed by the gate"), confirmed present at `src/sigma0/loop_lm.py:417` (`_stability_gates(A_emp)` call site) | High — read directly, 2026-07-01 | Direct file read |
| Depth/canary telemetry exists and is persisted, but only in native mode | `scripts/ouro_serve.py:53-56` (native-mode comment), `:185-209` (`_persist_loop_meta`, writes `data/eval/leaderboard.jsonl`), `:246-268` (`_generate`, `_persist_loop_meta` only called inside `if _loop is not None`) | High — read directly, 2026-07-01 | Direct file read |
| No `ouro-deep` benchmark rows exist yet in this environment | `grep -c "benchmark.*ouro-deep" data/eval/leaderboard.jsonl` → 0 | High — measured directly, 2026-07-01 | Direct command output |
| collapse-canary.js / groundedness-canary.js are observe-only today | `lib/collapse-canary.js`, `lib/groundedness-canary.js` (cited in research doc; not re-read line-by-line this session) | Medium | Research doc, prior session context |
