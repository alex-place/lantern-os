---
adr: 0025
title: RLVR + generative-replay ("dreaming") continual weight updates, double-gated by exec-holdout + stability cert
status: Proposed
date: 2026-07-07
deciders: Alex Place
approved-by: pending
supersedes: none
superseded-by: none
---

# ADR-0025: RLVR + "dreaming" continual weight updates, double-gated

- Status: **Proposed** (requires Alex's explicit acceptance; agents may not flip this — see [adr-approval-gate])
- Loop stage: **Verify** (the update gate) + **Reason** (the updated policy) + **Remember** (verified-memory replay buffer)
- Relates to: [ADR-0010](0010-verify-gated-continual-learning-last-resort.md) (continual-learning rules — this ADR is the *mechanism* for 0010's verify-gated last-resort path), [ADR-0015](0015-qwen-teacher-verified-distillation.md) (verified distillation — extended, not replaced), [ADR-0024](0024-sigma0-frontier-training-program.md) (frontier program — this is the *continual-update* half 0024 explicitly excludes), [ADR-0017](0017-surprise-gated-decoding.md) (surprise canary), [ADR-0021](0021-serving-substrate-retain-ouro-custom-loop.md)
- Research backing: [data/research/reports/20260707T180737-rlvr-continual-learning-dreaming-stability-cert-weight-updates.md](../../data/research/reports/20260707T180737-rlvr-continual-learning-dreaming-stability-cert-weight-updates.md)
- Theory backing: [SIGMA0-COLLAPSE-CERTIFICATE.md §8 (Part II — the Update Certificate Σ_θ)](../SIGMA0-COLLAPSE-CERTIFICATE.md#8-the-update-certificate-σ_θ) — the Σ_θ parallel merged into the unified Convergence Certificate, which formalizes (and adversarially bounds) this double-gate. **Key consequence for Gate A:** a *fixed* exec holdout goes stale in O(1) adaptive gates (model-level accept/reject is high-leakage selection, not a Dwork scalar query), so Gate A's holdout **must be a continually-replenished flow of fresh verified problems**, and the safe update rate is bounded by the fresh-ground-truth sourcing rate.

## Reconciliation with Accepted ADRs (read first)

- **ADR-0010** Rule 0 keeps frozen-base + retrieval as the default; Rule 3 makes adapter-only the
  sole weight path. This ADR does **not** override either — it *specifies the mechanism* by which
  0010's "verify-gated continual learning, last resort" path actually decides to ship a LoRA
  delta, and adds a second, load-bearing gate 0010 left unspecified.
- **ADR-0024** proposes a *pretraining program* and explicitly states it is "**not** continual weight
  modification of the deployed model." This ADR covers precisely that excluded case: bounded,
  double-gated continual updates to the *serving* adapter. The two are complementary — 0024 trains
  the base artifact; 0025 governs online improvement of the deployed one.
- **North Star principle 5** ("learning is retrieval + experience, NOT weight modification") governs
  the running loop; accepting this ADR scopes a *rare, certified exception* — the update is the
  exception, retrieval remains the rule.

## Context

Research this cycle ([report](../../data/research/reports/20260707T180737-rlvr-continual-learning-dreaming-stability-cert-weight-updates.md)) established three load-bearing facts:

1. **RLVR is the right update rule** because on-policy sampling keeps updates in a low reverse-KL
   region near the base, making RL structurally forgetting-robust vs SFT — and the KL penalty is
   *not* what does it (Wolfe 2026, MEASURED). But RLVR has *intra-task* forgetting — "correct-set
   turnover" (arXiv:2606.03087, MEASURED).
2. **"Dreaming" is generative replay in an offline phase**, not a separate engine: replay the
   verified JSONL/CSF buffer (+ generic anchor data) during the update (Dream2Learn arXiv:2603.01935;
   Sleep-time Compute arXiv:2504.13171; replay-generic arXiv:2603.04964 — all MEASURED). This
   satisfies the North Star's "dream = reasoning strategy, not subsystem" constraint.
3. **The stability cert cannot gate the failure mode.** It certifies local hidden-state contraction
   (`max Re λ(A)<0`), not reward-boundary integrity; its trigger is a *late* detector (precision 1.0,
   recall ≈0.08, #1990) and is subject to instrument↔actuator decoupling (#766). Reward hacking and
   correct-set turnover live in the held-out task distribution, not hidden-state dynamics — confirmed
   by an independent adversarial cross-check (grok-4) that landed on the repo's own documented caveat.

Small-scale feasibility is real but requires the efficiency literature, not naive GRPO: sample-efficient
reward estimation (arXiv:2603.18444), adaptive rollout skipping zero-advantage groups (arXiv:2602.14338),
inference-for-training trades (arXiv:2606.08854), and Hybrid-LoRA for RLVR post-training (arXiv:2605.18822).

## Decision (proposed)

Adopt a **double-gated continual-update mechanism** for the serving adapter, ordered cheapest/safest first:

1. **Rule 0 unchanged:** frozen base + retrieval is default; no weight delta ships unless it beats
   retrieval on the frozen holdout.
2. **Verified distillation is the primary spend** (extends ADR-0015): cloud teacher proposes,
   **execution is teacher-of-record**, train **LoRA (rank ≤16)** on passing traces only.
3. **"Dreaming" = offline replay of VERIFIED traces only** — the JSONL/CSF buffer (passing patches,
   successful tool trajectories, source-checked research, human-approved drafts) + generic anchor
   data, replayed in a sleep phase on cloud L4, never the local box ([local-pc-freezes-ram-exhaustion]).
   **Guardrail (convergent grok+GPT synthesis):** never train on the model's *unverified*
   self-generated opinions/"thoughts" — internally-generated examples are untrusted until a
   compiler/test/source-check/human verifies them, or the replay buffer becomes a model-collapse
   feeder. (Dream2Learn [2603.01935] is a vision method — framing inspiration, not license to
   self-train on synthetic thoughts.)
4. **RLVR/GRPO last and small** (on-policy, execution-graded, sample-efficient variants), and every
   candidate checkpoint must pass **BOTH gates to ship**:
   - **Gate A — exec holdout (load-bearing):** a frozen held-out execution suite with a **hard
     no-regression bar** (rejects reward hacking + correct-set turnover). This is the authority.
   - **Gate B — stability cert (cheap early-abort):** the Σ₀ collapse certificate on the decode
     Jacobian rejects degenerate hidden-state dynamics before wasting an eval. Necessary, not
     sufficient; never the sole authority.
   The RL loop stays disabled until Gate A's holdout is flat-or-up over a sustained window.

Program invariants (inherited from ADR-0024): evidence-classed claims with artifacts; every update is
cheap to reject; honesty/quality bound to external checks the model does not control; one loop, no sprawl;
operator authority over every gate.

### First-100-GPU-hour allocation (operating recommendation, NOT a literature result)

Convergent synthesis skeleton for the Phase-1 spike — a decision input, not a finding:

| Budget | Spend | Why |
|---|---|---|
| ~15h | Baselines + **sealed** eval sets | else every later "gain" may be leakage/overfit |
| ~40h | Verified teacher→adapter distillation | highest expected gain/hour; passing traces only |
| ~25h | Offline replay ("sleep") ablations | does replay prevent regression + aid new-task learning? |
| ~15h | Small RLVR pilot | only code/reasoning with hard execution rewards |
| ~5h | Red-team + rollback tests | plant reward hacks, retention regressions, format exploits |

### First falsifiable experiment (the Phase-1 gate)

Three adapters from the same frozen Ouro checkpoint, **equal compute**: **A** = distillation only;
**B** = distillation + verified replay; **C** = distillation + replay + narrow RLVR. Evaluate all on
new execution-graded tasks, old mastered tasks, fresh hidden tasks, tool-call correctness,
source-grounded research, latency/memory, and Gate-B monitor events. **Promotion rule:** C wins only
if it beats B on new tasks *without* worse retention, more reward/eval divergence, or instability.
Decision tree: **B wins** → "dreaming" = replay+verification, RLVR waits; **A wins** → the replay
recipe needs work; **none win** → stop updating weights, improve retrieval/tools instead. This is the
cheapest test of whether weight updates earn their keep at all.

## Consequences

- **Positive:** turns 0010's abstract "verify-gated last resort" into a concrete, safe mechanism; the
  stability cert gets a real, honest role (cheap early-abort) instead of an overclaimed one; RLVR's
  built-in forgetting-robustness is exploited; reuses existing verified-memory + exec-verify machinery.
- **Negative / risks:** RLVR at 1.4B/8GB is a trickle even with efficiency variants — expect single-digit
  verifiable problems/GPU-hour; Gate A requires a curated, frozen, non-leaking exec holdout (build cost);
  the stability cert must not be trusted beyond "degeneration screen" or it re-introduces the honesty
  theater §7.2 warns about; feasibility latency numbers are unmeasured (spike required, see Open questions).

## Alternatives considered

- **SFT continual updates:** rejected — forward-KL mode-covering drifts far from base, erasing capability
  (the exact forgetting RLVR avoids).
- **Stability cert as the sole gate:** rejected — cannot detect reward hacking / forgetting (§3); this is
  the central research finding.
- **Naive fixed-budget GRPO:** rejected at this scale — rollout cost dominates; use difficulty-adaptive,
  sample-efficient variants.
- **Full-weight finetune:** rejected — optimizer states won't fit 8GB; adapter carries capability (#2178).
- **A separate "dream engine" subsystem:** rejected by North Star — dreaming is replay-as-strategy.

## Open questions (to resolve before Phase-1 GPU commit)

- Measured RLVR throughput at Ouro-1.4B on cloud L4 (problems/GPU-hour) — currently unmeasured.
- Exec-holdout construction: size, refresh policy, leakage guard, the exact no-regression bar.
- Whether FuRA-style spectral *preconditioning* (arXiv:2605.22869) — acting before the update — is a
  better use of the certificate machinery than post-hoc Gate B alone.

## Evidence

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| RL/RLVR forgetting-robust vs SFT via on-policy low-reverse-KL; KL penalty not the cause | Wolfe 2026 (cameronrwolfe.substack.com/p/rl-continual-learning) | High (MEASURED) | external |
| RLVR intra-task forgetting (correct-set turnover) | arXiv:2606.03087 | High (MEASURED) | external |
| Dreaming = generative replay / sleep-time consolidation | arXiv:2603.01935, 2606.03979, 2504.13171, 2603.04964 | High (MEASURED) | external |
| Stability cert = hidden-state contraction only; late detector; instrument↔actuator gap | SIGMA0-COLLAPSE-CERTIFICATE.md §1/§2 (#1990, #766) | High (repo doc) | in-repo |
| Reward hacking is the RLVR pathology the cert can't see | arXiv:2507.17746 + grok-4 adversarial cross-check | Medium-High | external + red-team |
| Small-scale RLVR feasible via efficiency variants | arXiv:2603.18444, 2602.14338, 2606.08854, 2605.08441, 2605.21266 | Medium-High (MEASURED) | external |
| LoRA (not full) for RLVR at 8GB; adapter carries capability | arXiv:2605.18822, 2606.25700; in-repo #2178 | High | external + in-repo |
| Naïve holdout reuse overfits → rotating-tier + fresh-flow required | arXiv:1506.02629 (Dwork et al.) | High (PROVEN, external) | external |
| Release-gate additions (fresh-task gain, provenance, rollback), GPU-hour skeleton, A/B/C first experiment, verified-only dreaming guardrail | grok + GPT syntheses, 2026-07-07 | Medium (convergent but **correlated** — overlapping corpus, not independent) | model synthesis |
| RLVR throughput at Ouro-1.4B | not measured this cycle | Open | — |
