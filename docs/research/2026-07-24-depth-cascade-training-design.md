---
author: Claude lane (operator-prompted design, Alex Place 2026-07-24)
created: 2026-07-24
status: RESEARCH DESIGN — proposed; no ADR, no training commitment
parent: research/2026-07-23-sigma0-llm-design.md · research/2026-07-23-sigma0-rc1-model-spec.md
relates: ADR-0030/0031 · serving memo (2026-07-23) · R9 (#2874) · #2847 · #2850
---

# Depth-cascade training — making the spiral's rungs real by updating the weights

## The problem this answers

The measured depth-value curve on the current looped model plateaus at R2
(0.10 → 0.22 → 0.22; docs/research/2026-07-10-depth-value-n50.md), and the loop is
locally EXPANSIVE (true ρ(J) ≈ 8–11, #2029). The serving memo therefore correctly
restricts the local ladder to R∈{2,4} and pre-registers "the ladder stops at R2."
Operator conclusion (2026-07-24): there is no reason to dive past depth 2 **in the
current design** — because nothing in training ever made deeper steps informative.
Depth today is a compute axis with no training signal attached. This design attaches
the signal.

## The design in one line

**Train the ≤3B looped student so recurrence depth = refinement stage — shallow
proposes, deep repairs-given-failing-tests — using the Spiral's own verified traces
as depth-conditioned supervision, with a contraction objective so deep rungs are
stable, and a pre-registered monotone-depth kill test.**

The cascade moves into the weights: rungs of ONE dense model (ΔRAM=0, the property
that won the serving comparison) instead of two resident models.

## Components

1. **Depth-conditioned VTD.** The Spiral emits (candidate, failing-test signal,
   improved candidate) per turn — the escalation corpus. Train:
   - R2 (shallow): prompt → candidate (the propose distribution).
   - R4 (deep): prompt + candidate + failing tests → repaired candidate (the repair
     distribution, distilled from frontier rescues + own verified repairs).
   Conditioning carrier: recurrence depth itself (train-time `total_ut_steps` pinned
   per example class), so serve-time rung selection needs no extra tokens/adapters.
   Existing recipe (RC1 §6: LlamaFactory, LoRA r=8, ≤3 epochs) carries over; the
   delta is the depth-conditioned data schema.

2. **Per-rung verified credit (RLVR stage).** Fix-Rate reward assigned to the rung
   that produced the verified output: verify-at-R2 reinforces early exit;
   verify-only-after-repair reinforces the deep path. The verifier stays EXTERNAL
   (exec tests, held-out split mandatory — ADR-0031 Decision 3); Q-exit/learned
   halts are biased by verified outcomes at train time but never replace exec
   verification at serve time.

3. **Contraction objective (R9's training-objective half, first vehicle).**
   The expansive loop must be trained toward local contraction near committed
   states: STARS-style stability regularization + paraphrase-contraction
   (same-intent inputs → same fixed point), the exact composition audit-confirmed
   unoccupied (#2861 ~65% after round-2 #2874). This is what lets the JSRR serve
   gate PASS deep rungs instead of rejecting expansive ones — depth becomes
   certifiable, not just available.

## Pre-registered gates (all falsifiable, all before any "it works" claim)

- **G-D1 (the kill test):** post-training depth-value curve on HELD-OUT problems
  must be monotone through R4 (vs 0.10/0.22/0.22 today). Flat ⇒ the bet is dead;
  recorded as an honest negative.
- **G-D2:** dose-response discipline per #2847 — verification>imitation must hold;
  prior VTD measured −6 @ 63 aggressive traces (#2850 lineage). Utility-matched
  traces only.
- **G-D3:** corpus composition obeys the v1.10 mandate — ≥60% anchor mix in every
  train (the rule run-1 violated at 0.31 → honest negative).
- **G-D4:** every promotion behind Σ_θ on fresh held-out; JSRR receipts logged per
  rung during eval (extends RC1 B3).
- **G-D5 (the governing number):** cloud escalation rate must FALL when the R4
  repair rung lands; if repairs don't displace rescues, the rung isn't real.

## What this deliberately is NOT

- Not a new subsystem: it is RC1 §6 (VTD → RLVR-FixRate → ternary) made
  depth-aware. Same phases, same gates, one added axis.
- Not MoE-dependent — but MoE-compatible: the operator decision of 2026-07-24
  (ADR-0034) adopts MoE for the core as soon as the switched-system admission gate
  exists. This design trains the DENSE core first (P0/RC1 sequencing unchanged);
  under an MoE core its contraction objective must hold per active-expert
  composition and every gate below carries over unchanged.
- Not runtime weight modification (offline, opt-in, Σ_θ-gated — North Star rule).
- Not a claim: every number above is a target with a kill test, per the External
  Reality Rule.

## Sequencing

Blocked behind P0 (JSRR default-path + Σ₀⁻¹ armed) like all training work; slots
into the RC1 flow as the training recipe for whichever arm wins the bake-off
(the depth-conditioning bet favors RC1-L structurally — dense arms have no depth
axis — making the bake-off's core-slot condition genuinely winnable rather than
predicted-to-fail).
