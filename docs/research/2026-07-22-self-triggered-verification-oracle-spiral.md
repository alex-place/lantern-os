---
title: Self-triggered verification — the Oracle/Spiral's PRICE as an event-triggered controller
date: 2026-07-22
status: Proposed — design amendment to the Oracle=Spiral; needs Alex approval (never self-approve)
amends:
  - "The Oracle (answerability-first PLACE→PRICE→ANSWER→LEARN→ACT-TO-KNOW; #2818)"
  - "The Spiral (verified cascade applied recursively; ADR-0030 / #2823)"
  - "ADR-0012 Nested Adaptive Reason (ReasonVerdict; Q-exit × fidelity escalation)"
---

# Self-triggered verification: the Oracle/Spiral's PRICE as an event-triggered controller

## This is not a new mechanism

The **Oracle is the Spiral** — one answering machine: PLACE (council four-verdict
grounded/seam_open/pin/refuted) → **PRICE** → ANSWER → LEARN → ACT-TO-KNOW, run as a
**verified cascade applied recursively** over a growing verified memory, whose single
governing number is the **escalation rate, designed to only fall**. [ADR-0012](../adr/0012-nested-adaptive-reason.md)
already routes each Reason unit through **Converge / Escalate / Abort** on a shared
`ReasonVerdict`, and already lists the collapse-certificate fate + the surprise /
groundedness canaries as inputs.

This document adds exactly **one** cross-domain graft to that machine: it makes **PRICE**
a *self-triggered controller*. Nothing else changes — same doors, same cascade, same
escalation corpus.

## The gap

ADR-0012 decides *which door* a Reason unit exits, but the machine still pays for its
expensive signals — the Fix-Rate (M4) verify, the escalation check, the canary read — on
a **fixed cadence** (every unit / every step). That is over-actuation: most steps of a
healthy, contracting loop don't need a verify, and a diverging loop should have been
caught *before* it spent the depth. ADR-0012 itself flags this — the certificate fate and
canaries are "purely diagnostic; reported, not consumed" (`loop_lm.py:73`), i.e. the
signal that should schedule the spend is discarded.

## The cross-domain transfer

**Event-triggered / self-triggered control** (Tabuada; Heemels; arXiv:1707.02531,
1609.07534 — both already in `F:\arxiv-corpus`) says: *don't actuate on a fixed clock —
compute the next actuation time from the system's own measured error decay, and act only
when a Lyapunov-like error threatens to cross a threshold.* We have already made this exact
transfer once: the **Kalshi adaptive poll** (`kalshi-adaptive-poll.js`) replaced a fixed 6 s
clock with a send-on-delta cadence `Δt = β/σ²ₘₐₓ` derived from measured per-market variance.

The looped LLM is a discrete dynamical system `h_{t+1} = f(h_t)`. That is the bridge: the
same self-triggered math that scheduled a *poll* from measured price variance can schedule
the spiral's *verify/escalation spend* from measured **loop-convergence** dynamics — over
loop-steps instead of wall-clock.

## The control law (PRICE becomes self-triggered)

Each step, read what the loop already computes cheaply:

- `ρ(J_t)`, `‖J_t‖₂`, non-normality gap `‖J_t‖₂ − ρ(J_t)` (JVP/VJP power iteration; STARS
  arXiv:2605.26733; the #2029 measurement).
- residual decay `r_t = ‖h_{t+1} − h_t‖` and its ratio `r_t/r_{t-1}` (Lyapunov-candidate).
- surprise / groundedness canaries (ADR-0012's observe-only signals — **now spent**).

From the measured decay rate `λ̂ = r_t/r_{t-1}`, **predict two horizons**:

```
n_converge  = steps until r_t · λ̂^n < ε             (unit will cross the Converge door)
n_barrier   = steps until B(h_t) would enter the unsafe set   (collapse / non-normal blow-up)
next_check  = min(n_converge, n_barrier)             (self-triggered: pay the verify HERE, not every step)
```

PRICE (today "dilation × grounding-ledger budget") gains a **measured, dynamical basis**:
the price of a unit is `n_converge` vs `n_barrier` — cheap-and-converging earns acceptance
at the cheapest tier; predicted-to-hit-the-barrier is priced for escalation *before* it
spends the depth.

## The barrier layer (certificate: diagnostic → predictive)

Today the collapse certificate ([docs/SIGMA0-COLLAPSE-CERTIFICATE.md](../SIGMA0-COLLAPSE-CERTIFICATE.md))
gives a **local-linear fate** (contract / spiral / diverge) that ADR-0012 uses as a
`break`. Upgrade it to a **barrier function** `B(h)` with a **reach-while-avoid** guarantee
(neural control-barrier-function verification: arXiv:2605.02526, 2511.06341; cooperative
reach-avoid 2601.20324): if the *predicted* trajectory would enter the unsafe set
(confident-but-unanchored, or non-normal transient with `‖J‖₂>1`), escalate **pre-emptively**
at `n_barrier`, not after the fact. This is the formal "avoid degeneration" guard, and it is
what finally *spends* the surprise/groundedness canaries ADR-0012 leaves passive.

## Where it lands (existing primitives — no new subsystem)

| Piece | Change |
|---|---|
| **PRICE** (oracle) | becomes the self-triggered predictor: `(ρ(J), r_t/r_{t-1}) → (n_converge, n_barrier) → next_check`. |
| `ReasonVerdict` (ADR-0012) | gains `next_check_step` (self-triggered schedule) + `barrier_margin`. Doors unchanged. |
| certificate `_stability_gates` | promoted from passive diagnostic to the **predictive** door-2 break (ADR-0012 step 2, made self-triggered). |
| **Spiral** escalation | the Fix-Rate verify / escalation-check is *paid on `next_check`*, not every turn. |
| **escalation corpus** | each frontier rescue is tagged with its measured decay signature `(ρ(J), λ̂, canary)` — so VTD teaches the cheap tier the **decay → outcome** map, not just the answer. |

## Why this serves the one number

Self-triggered verification spends the verifier budget **only when the dynamics predict a
door-crossing**, and escalates **before** a collapse instead of after — so it drives the
**escalation rate down faster** than fixed-cadence routing, and it spends the VoI
"burning-tokens" exploration cost (oracle ACT-TO-KNOW) exactly where information is highest.
"Escalation rate designed to only fall" becomes a **measured control target**, not an
emergent hope.

## Novelty (grounded in the 2026-07-22 patent cross-check)

- Google's **Universal Transformers** family (US10740433 → US11860969 → US12536408) fences
  the *base recurrence*; **STARS** regularizes the *weights'* spectral radius. Neither
  **schedules the verifier** from measured decay.
- ADR-0012 routes on the verdict but does **not** self-trigger *when* to compute it.

The narrow, concrete contribution is therefore: **a self-triggered, barrier-safe schedule
for the verify/escalation spend, driven by the loop's own measured convergence dynamics** —
exactly the "measured, grounding-aware runtime certificate with explicit intervention
outcomes" the [Σ₀ reading pack](SIGMA0-ARXIV-READING-PACK-2026-07.md) demanded (its #2029),
and not covered by the patents or by STARS.

## Falsifiable first experiment (measure before building — #2029)

On the real serving loop (`ouro_serve.py`, `OURO_NATIVE=1`), log `ρ(J_t)`, `‖J_t‖₂`,
`r_t/r_{t-1}`, and the surprise canary per step across a prompt set — **before** any control
law. Then test the one claim the whole graft rests on:

> **Does the measured decay rate `λ̂` predict the step where the Converge/Escalate door
> fires (and where groundedness fails)?**

- **If yes** → the self-triggered schedule is earned; measure escalation-rate + verifier
  spend vs the fixed-cadence ADR-0012 baseline (the graft must lower both without losing
  fidelity).
- **If no** → the machine degrades safely to today's fixed-cadence routing; the graft is
  dropped. No stability claim, no schedule change, ships before this measurement exists.

## Domain → primitive → paper map

| Cross-domain technique | Oracle/Spiral primitive it drives | Source |
|---|---|---|
| Self-/event-triggered control (act from measured decay) | PRICE → `next_check` schedule | 1707.02531, 1609.07534 (+ Kalshi adaptive-poll precedent) |
| Switched-system Lyapunov / dwell-time | residual-decay validity across routing regimes | 2405.03560 |
| Jacobian spectral radius + non-normality | the measured state `ρ(J), ‖J‖₂` | STARS 2605.26733; #2029 |
| Neural barrier / reach-while-avoid certificates | predictive collapse barrier `B(h)` | 2605.02526, 2511.06341, 2601.20324 |
| Ternary honesty / abstention | the Abort door (seam_open, never bluff a pin) | TruthRL 2509.25760, AbstentionBench 2506.09038 |
| VoI / active inference | spending the schedule where info is highest (ACT-TO-KNOW) | Howard 1966, Lindley 1956, Friston 2010 |

## Honest limits

- This is a **design amendment (Proposed)**. The load-bearing claim (decay predicts the
  door) has now been **measured** (see *Measured result*, #2833): on Ouro-1.4B it is **not**
  predictive — the loop plateaus (`ρ(J)>1` in 21/21), so there is no Converge-door crossing
  to forecast. The amendment degrades to fixed-cadence routing, pending a deeper-R re-run
  before the graft is finally kept or dropped.
- The barrier `B(h)` over a raw high-dimensional hidden state needs a **defined state
  abstraction** before any formal reach-avoid guarantee — per the reading pack, "global
  convergence" stays an aspiration until the abstraction + bounded region exist.
- It consumes only already-trained/analytic parts (Q-exit gate, certificate, canaries) — no
  retraining — honoring the Persistent-Learning rule.

## Measured result — the load-bearing claim, run (2026-07-22, #2833)

The falsifiable first experiment is now **run**, not proposed. Harness:
`experiments/oracle_spiral/measure_decay_predicts_door.py` on the real Ouro native loop
(`ByteDance/Ouro-1.4B`, `loop_lm._truncated_forward` at `q=1.0` → the full per-UT-step
trajectory), 21 prompts across six regimes (easy-factual, arithmetic, multi-step,
open-ended, unanswerable, fictional). Per step it logs `r_t=‖Δh‖/‖h‖`, `λ̂=r_t/r_{t-1}`,
`ρ(J)`/`‖J‖₂` (the STARS JSRR certificate on the empirical loop Jacobian), the trained
Q-exit step, the convergence step, and the stability verdict. Raw data +
prediction table: `data/oracle/decay-predicts-door.jsonl`.

**Verdict: NOT predictive** — and the reason is sharper than "λ̂ mispredicts the door":
on Ouro-1.4B there **is no converge-door crossing to predict.**

| Measurement (21/21 prompts) | Value |
|---|---|
| UT loop depth | **4 steps** (Ouro-1.4B is R4 — only 3 residual ratios per unit) |
| early decay `λ̂` | 0.448–0.560 (mean 0.485) — contracts *early* … |
| residual floor (best any step) | **0.236** — … then **plateaus**, never near `ε=0.05` |
| convergence door | **max_depth in 21/21** — the loop never reaches a fixed point |
| `ρ(J)` | 1.19–2.31 (mean 1.75) — **> 1 in 21/21** (non-normal / spiral) |
| JSRR-stable (`ρ(A)<1`) | **0/21** |
| trained Q-exit | `threshold_met` at step 4 (= max depth) in 21/21 — no early exit either |

The naive geometric extrapolation from `λ̂` predicts convergence at step 5–6, but the loop
plateaus at `‖Δh‖/‖h‖ ≈ 0.24–0.5` and rides to full depth every time. So the **premise** of
the self-triggered *convergence* predictor — a contracting loop whose decay forecasts a
Converge crossing — **does not hold** for this model. Per the decision rule, the
`(ρ(J), λ̂) → n_converge → next_check` schedule is **not earned** on Ouro-1.4B; the amendment
**degrades to fixed-cadence routing**, as designed. What *is* consistently present is the
**barrier** signal (`ρ(J)>1` / non-normal in 21/21) — but on this set it fires for
*everything*, so as estimated it does not yet **discriminate** healthy from unhealthy units.

**Honest confounds (why this is a first answer, not the last word):**
1. **R4 is too shallow to power the test.** Four UT steps give only three residual ratios —
   almost no horizon for a decay forecast. The claim deserves a re-run on a deeper-loop
   variant (Ouro-2.6B / higher-R) where a real trajectory exists, *before the graft is
   permanently dropped.*
2. `ε=0.05` sits far below the model's residual plateau (~0.24–0.5); no `ε` near the plateau
   would reveal geometric decay, because the residual genuinely stops falling.
3. `ρ(J)` here is the mean-outer-product empirical Jacobian (loop_lm's estimator); a
   JVP/VJP power iteration on the true per-step map is a stronger `ρ(J)` — a follow-up.
4. n=21, one model, one forward per prompt (not full generation). Per "measure before
   building," that is the point: a MEASURED answer where there was a design claim.

**Net for the amendment:** ship fixed-cadence routing (no self-triggered *convergence*
schedule) on Ouro-1.4B; keep the barrier/non-normal instrument but treat it as
not-yet-discriminating; re-run #2833 on a deeper-R Ouro before either adopting or finally
dropping the self-triggered graft. Either way, the load-bearing claim is now **measured**.
