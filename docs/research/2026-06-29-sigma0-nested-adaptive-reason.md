# Nested Adaptive Reason — Q-exit (within-model) × fidelity escalation (cross-model), gated by the stability canaries

**Date:** 2026-06-29
**Stage improved:** Reason (+ Verify as the gating signal)
**Status:** Design — proposed, not yet wired. ADR to follow with Alex's approval.

## The one-line thesis

The Σ₀ loop has **two** independent adaptive-compute mechanisms that currently never
talk to each other, and **two** stability canaries that observe but never *decide*.
Wire all four into a single **Reason** stage so that one shared "are we converging?"
signal drives both *how deep we think in one model* and *when we escalate to a better
model* — and so the canaries stop being passive dashboards and become the routing
trigger.

This is one stage, four existing objects, zero new subsystems. It strengthens Reason
+ Verify; it adds no sprawl.

## The four pieces today (and the gap)

| Piece | Layer | What it does now | Gap |
|---|---|---|---|
| **Ouro Q-exit / accel** (`src/sigma0/loop_lm.py`, `generate(mode=qexit\|converge\|accel)`) | within-model | Per-token adaptive recurrent depth. Exit on trained confidence CDF ≥ q (`qexit_step`), first-order fixed point (`converge_step`), or spiral-robust acceleration (`accel_step`). ~25–43% compute saved at 95–98% fidelity. | Saturating depth (`reason="max_depth"`) just stops — there is **no escalation door**. A hard token simply gets a shallow answer. |
| **Fidelity escalation** (`lib/wide-search.js` low→high; `lib/keystone-escalation.js` `runKernelWithEscalation`) | cross-model | Run the cheap/local model first; escalate to a stronger model on failure/verify-miss. | Escalation triggers on coarse outcomes (test fail, `applied_unverified`). It is **blind to the within-model convergence signal** — it can't tell "the small model is thrashing" from "the small model is confidently wrong." |
| **DecodeCanary / collapse-canary** (`loop_lm.py` `DecodeCanary`; `lib/collapse-canary.js`) | observer | Folds self-repeat / n-gram echo / argmax-margin / entropy into `sigma0_proximity` ∈ [0,1]. `adapt=True` already nudges `q`/`rep_penalty`. JS side is **passive — logs, never routes**. | The proximity signal that *should* trigger escalation is thrown away at the model boundary. |
| **groundedness-canary** (`lib/groundedness-canary.js`) | observer | Detects confident-but-unanchored claims (assertion density net of hedging) — the "mirror loop." | Passive observer. A fluent ungrounded answer passes straight through. |
| **Collapse certificate gates** (`loop_lm.py` `_stability_gates`: numerical_range / lyapunov / pseudospectral + non-normal dichotomy) | observer | Spectral fate of the latent loop: CONTRACT vs DIVERGE. | `loop_lm.py:73` — *"Purely diagnostic; reported, not consumed by the gate."* This is the exact line the integration deletes. |

## The unifying contract: one `ReasonVerdict`, three exit doors

Define a single struct that both layers produce/consume per Reason unit (a token loop,
a draft, a research pass):

```
ReasonVerdict = {
  converged:  bool,     // inner loop reached a fixed point / Q-exit threshold
  depth:      number,   // realized recurrent depth (or pass count)
  proximity:  number,   // collapse proximity  (DecodeCanary / collapse-canary)
  grounded:   number,   // 1 - ungrounded score (groundedness-canary)
  stable:     'contract' | 'spiral' | 'diverge',   // _stability_gates fate
  reason:     'threshold_met' | 'fixed_point' | 'accel_fixed_point'
            | 'max_depth' | 'collapse' | 'divergence' | 'ungrounded',
}
```

A Reason unit exits through exactly **one of three doors**, and the door — not a
coarse pass/fail — decides what happens next:

1. **Converge door** (`converged && stable==='contract' && proximity<τ_c && grounded>τ_g`)
   → accept. Cheapest model, fewest steps. This is the common case and the whole point.

2. **Escalate door** (`reason ∈ {max_depth, collapse, divergence, ungrounded}` *or*
   `stable!=='contract'`) → **the within-model failure becomes the cross-model
   trigger**. Hand the *same* prompt up the fidelity ladder (Wide Search low→high;
   kernel chain in `keystone-escalation`). Crucially, escalate on *ungrounded* and
   *spiral/diverge* too — not just "tests failed" — so a confidently-wrong small model
   is caught before it lands.

3. **Abort door** (budget exhausted across the whole ladder) → return with an honest
   low-confidence `ReasonVerdict` and the evidence trail, never a fabricated answer
   (External Reality Rule).

## How the two layers nest

```
Reason(task):
  for tier in fidelity_ladder:            # OUTER: cross-model  (wide-search / kernel chain)
     verdict = run_model(tier, task):     # INNER: within-model (Ouro Q-exit / accel)
         for step in 1..max_depth:        #   adaptive recurrent depth, per token
             advance latent block
             v = ReasonVerdict from gates+canaries this step
             if v.converge_door: return v          # cheap success
             if v.spiral/diverge: break            # stop digging a bad hole early
         # max_depth or instability → fall through to escalate
     if verdict.converge_door: return verdict      # accept at this tier
     # else: escalate door → next, stronger tier
  return abort_verdict                              # ladder exhausted, honest low-conf
```

- **Inner** = the salvage we already proved (adaptive depth, 25–43% compute saved).
  Adding the gates as a *break* condition (door 2 inside the loop) means we **stop
  spending depth on a token the certificate says will diverge** — strictly cheaper,
  and it removes the false-converge on spiral dynamics that `accel_step` was built for.
- **Outer** = the cross-model escalation Wide Search and the kernel chain already do.
  Feeding it the inner `ReasonVerdict` means it escalates on the *right* signal:
  not "no output" but "output we can't trust" (ungrounded / unstable / depth-saturated).

The combination is what's rare: **adaptive reasoning that knows when to think harder
in-place vs. when to call a bigger model — using the same convergence math (the
collapse certificate) for both decisions.**

## Why this is certificate-consistent, not a heuristic bolt-on

The collapse certificate's non-normal dichotomy (§1.1, the spiral/skew case) is exactly
where first-order `‖Δh‖` plateaus while the direction keeps rotating — `accel_step`
already handles it for the *exit*. Promoting the same `_stability_gates` fate from
"reported" to "consumed" means the **escalate door fires on the certificate's DIVERGE
fate**, and the **converge door requires its CONTRACT fate**. The routing decision
inherits the proof, instead of re-deriving a weaker proxy.

## Minimal, falsifiable rollout (each step is independently shippable)

1. **Surface the verdict.** Have `loop_lm.generate()` return a per-call `ReasonVerdict`
   (it already computes `exit_reason`, `mean_depth`, `canary_*`, and `_stability_gates`
   — just assemble + return them). *No behavior change.* Pure observability.
2. **Inner break on instability.** Add door-2 `break` when `_stability_gates` reports
   non-contract for `patience` steps. Bench: compute saved vs. fidelity on the existing
   `bench_ouro_loop.py` / `eval_humaneval_ouro.py` — must stay ≥ baseline quality.
3. **Outer trigger on verdict.** In `wide-search.lowPass`/`highPass` and
   `keystone-escalation.runKernelWithEscalation`, replace the coarse "did it apply?"
   gate with `verdict.escalate_door` (add `ungrounded` + `unstable` to the escalate
   set). Bench: escalation rate + landed-work share on `convergence-autonomous-work`.
4. **Close the loop in the JS serving path.** Make `collapse-canary` + `groundedness-
   canary` *return a routing hint* (not just log) so the chat serving path escalates a
   collapsing/ungrounded local reply to the cloud tier — same contract, JS side.

Each step has a metric and a kill-switch env var; none requires retraining (we consume
the *trained* Q-exit gate + the analytic certificate — Persistent-Learning rule holds).

## What this explicitly does NOT do

- No new memory system, no separate dream/reason engine — it is the existing Reason
  stage with its existing knobs wired to its existing observers.
- No model assumption — `fidelity_ladder` is the provider chain; Ouro is the default
  inner model but any recurrent/looped model exposing a depth+gate fits the same contract.
- No silent acceptance — door 3 always returns evidence + confidence, never a fabricated
  pass.

## Open questions for the ADR

- Thresholds τ_c (collapse), τ_g (grounded), and `patience` for the instability break —
  set empirically from step 2/3 benches, or learned?
- Does the outer escalate door re-run the inner loop from scratch at the higher tier, or
  warm-start from the lower tier's draft (cheaper, as Wide Search's `lowPass.draft`
  already does)?
- Cost ceiling: cap ladder depth by `budget.remaining()` so a pathological task can't
  walk the whole chain.
