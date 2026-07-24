# Σ₀ serving-architecture decision memo (2026-07-23)

**Decision fixed by operator:** distilled student (not from-scratch — see the supersession banner
in [SIGMA0-OURO-CODER.md](../SIGMA0-OURO-CODER.md)). This memo selects the serving architecture
for that student. Produced by a 6-option scored comparison, 3 independent derivations of the
depth-escalation economics, a prior-art clearance, and an adversarial refutation whose corrections
are **adopted** below (the refutation collapsed the original per-answer cost claims; what survives
is stated exactly).

## Recommendation

**Build Option E — one resident ≤3B distilled Ouro looped student with an external-verifier-gated
depth ladder (R2→R4, same weights) as the local escalation tier — composed under the existing
cloud-frontier rescue (Option C) for the hard tail.** Scores: C 7.5, E 7, A (no escalation) 5,
B (7B two-pool) 4, F (MoE-lite) 4, D (cloud-only) 3.

Rejected: **B** — the 7B tier physically cannot co-reside on the 8GB box (~7.5GB needed vs
~2.8GB free); it *is* the tension, not the fix. **F** — a switched system the collapse
certificate does not cover (§1.2.2), and it adds a router without adding a strong tier. **D** —
abandons local-first.

## The math (refutation-corrected)

Two-rung stopping form (shallow s → deep D on the SAME weights), escalation reach
g = (1−p_s)(1−f), f = verifier false-accept:

```
E[C] = c_s + g·c_D        P(verified) = p_s + g·p_D        CPV = E[C]/P(verified)
```

- **vs single-shot small:** E wins iff p_D/c_D > p_s/c_s. *f cancels.*
- **vs a two-pool cascade** (separate large L, RAM M_L, swap λ): E wins iff
  c_D/p_D < (c_L+λ)/p_L; at **equal capability (p_L=p_D)** this is c_D < c_L+λ — always true.

**Adopted corrections (the refutation's load-bearing points):**
1. **Mediant non-dominance** — CPV lies strictly between the rungs' cost-effectiveness ratios: a
   cascade can never beat BOTH single-shot-small and always-deep per verified answer. "Cheaper"
   is honest only vs always-deep, never vs the cheap rung.
2. **Regime sandwich** — with the ~4× depth-FLOP tax, beating single-shot needs p_s < ~0.25,
   while the "g≈0, 8.3×" sufficiency story needs p_s high. The two headline wins are mutually
   exclusive regimes.
3. **No number transfer** — 8.3× / ≈0% escalation (#2798/#2800) are cross-MODEL results; the
   depth axis's p_d, g, f are **unmeasured**.
4. **Monotone depth gain is contradicted by measurement** — exec-graded depth curve 0.10 (R1) →
   0.22 (R2) → 0.22 (R4) (docs/research/2026-07-10-depth-value-n50.md): a hard plateau at ~2
   loops; the real loop is expansive (ρ(J)≈8–11, post-#2029). Do NOT extrapolate past trained
   depth; R16 is not a rung until a deeper-trained student exists.

**What survives unconditionally:** ΔRAM(depth escalation) = 0 — the escalation tier is more
forward passes on already-resident weights. On the 8GB box this is the ONLY local
more-compute-reliability axis, and it makes "fully-local verified answers" a coherent operating
point for the first time (resolves review tension #4). At equal capability it strictly dominates
a two-pool cascade on compute AND RAM.

## Cheaper and smarter?

- **Cheaper:** YES vs the infeasible 7B two-pool (unconditional, RAM+compute at equal
  capability); NO vs single-shot small (mediant); CONDITIONAL vs always-deep (needs high p_s).
- **Smarter:** CONDITIONAL and modest — P(verified) rises with any p_D>0, but the measured
  plateau caps the local ladder at ~R2 gains; NOT smarter than a real larger model — which is
  why the cloud rescue arm stays.

## Novelty (audited grade — final)

**known-repackaged (algorithm) + empirical-instantiation (measurement).** The composition is
Korf 1985 iterative deepening / Luby–Sinclair–Zuckerman 1993 optimal restart-escalation /
Hansen–Zilberstein monitored anytime stopping; LLM-era: Reflexion, AlphaCode/CodeT; patent-claim
level: Intel US11869232B2. Full audit trail:
[AI novelty-verification protocol](2026-07-23-ai-novelty-verification-protocol.md) §4. The
publishable residue is a MEASUREMENT — the depth-rescue profile of a looped LM under an external
verifier — and the engineering benefit is that Luby schedules + Hansen–Zilberstein monitoring can
be **imported** as the escalation policy instead of derived.

## Wire-it-locally plan (gated on the rung experiment)

1. Student serve config: `KEYSTONE_SERVE_OURO=1 OURO_4BIT=1` (Q4 ≈0.9–2.0GB fits ~2.8GB free).
2. Depth lever: `OURO_UT_STEPS` (resizes the recurrent KV cache correctly); rungs R∈{2,4} only
   (trained ceiling); per-token exit stays `OURO_MODE=qexit`.
3. Verifier gate: the Phase-0 exec verifier (`spiral_solve` 8s runner) with a **held-out test
   split**; pass ⇒ emit; fail ⇒ next rung; ladder exhausted ⇒ cloud rescue; offline ⇒ honest
   halt. `SIGMA0_GROUNDED=1` metadata stays token-neutral.
4. Hard depth cap + per-task budget.

**The gate experiment (run BEFORE trusting the ladder):**
`.venv-train/Scripts/python.exe scripts/eval_humaneval_ouro.py --limit 164 --exit-at-step {2,4}`
on the Q4 student — record per-rung p_d, verifier-gated escalation rate g, false-accept f (via
held-out split), latency. Ship condition: monotone p_d AND (crossover (i) OR g low enough that
E[C]≈c_s). Pre-registered expectation from the measured plateau: **the ladder stops at R2** —
which would confirm depth as a cheap tier and formally justify the cloud rescue arm.

## Provenance

Derived and refuted 2026-07-23 (3 independent derivations, max-effort refutation, 14-entry +
classical + patent prior-art audits). Related: [ADR-0021](../adr/0021-serving-substrate-retain-ouro-custom-loop.md),
[ADR-0024](../adr/0024-sigma0-frontier-training-program.md) (ρ correction applied),
[ADR-0026](../adr/0026-ternary-serving-artifact-distillation-target.md),
[RC1 spec](2026-07-23-sigma0-rc1-model-spec.md), [design of record](2026-07-23-sigma0-llm-design.md).
