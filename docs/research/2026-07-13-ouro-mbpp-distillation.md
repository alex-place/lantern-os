# Ouro-1.4B coder — 14B-teacher MBPP distillation (eval-gated, honest negative)

**Date:** 2026-07-13 · **Lane:** mookman11 · **Stage:** Act (serving the local coder)

## What

Tried to improve the served Ouro-1.4B coding adapter by distilling from the strong **local**
teacher (Qwen2.5-Coder-14B, ~0.83 HumanEval via ollama) and eval-gating the result through the
existing continual-training flywheel (`scripts/continual_ouro_pipeline.py`).

New tooling: [`scripts/distill_from_teacher.py`](../../scripts/distill_from_teacher.py) — the
teacher solves MBPP tasks, each solution is **execution-verified against MBPP's own asserts**
(the Σ₀ green-subprocess gate), and only passing solutions become `{instruction,input,output}`
training rows. 900 tasks → **734 verified rows** (82% teacher pass rate).

## Recipe

- Corpus: 734 distilled + 191 harvested-verified + 1200 `humaneval-train` anchor = 2125 rows.
- Train: **warm-start from the incumbent** adapter, 2 epochs, lr 1e-4, r16 (532 steps; loss 0.62→0.33).
- Gate: HumanEval pass@1 (n=40) on candidate **and** incumbent; promote iff Δ ≥ 0.03.

## Result — REJECT (live adapter unchanged)

| adapter | pass@1 (n=40) | no-parse | other (logic) |
|---|---|---|---|
| incumbent (live) | **0.250** (10/40) | 20 | 10 |
| distilled candidate | 0.200 (8/40) | **16** | 15 |

Δ = −0.05 < margin 0.03 → **rejected**; the live `final/` adapter is untouched (Convergence
Record in `data/eval/ouro-promotion-log.jsonl`).

**Paired-diff significance** (`scripts/eval_paired_diff.py` on the per-problem detail files):
B−A **+0.05**, SEM 0.101, **95% CI [−0.148, +0.248]**, sign-test **p=0.80**, **24/40 ties**
(9 incumbent-wins, 7 candidate-wins) → **NOT significant**. Candidate and incumbent are
statistically indistinguishable; the −0.05 is noise.

### The binding constraint is the eval, not the training

At n=40 the pass@1 CI is **±0.20** — the eval physically cannot resolve the sub-5% change a
single distillation pass could plausibly buy, and a decisive n≈400 is ~13 h at Ouro's ~2 min/
problem. So **blind on-box HumanEval-gated training iteration is not productive on this box** —
every candidate near the incumbent lands inside the same noise band. The productive moves are
(a) a **faster eval** (batched decode / shorter budget) to shrink the CI, or (b) a **big-enough
lever** (a much larger verified HumanEval-style teacher corpus) that clears ±0.20 in one shot —
not more small warm-start touch-ups the eval can't score.

## The actionable insight

The failure *breakdown* moved in opposite directions: the distilled candidate **parsed better**
(no-parse 20→16) but was **logically worse** (other-errors 10→15). MBPP-style distillation taught
the model to emit cleaner, fenced, runnable functions, but MBPP's easy tasks did not transfer the
HumanEval-level *logic*, and the 2-epoch warm-start shifted the model off its HumanEval-tuned
behavior. So the distilled data is a **parseability** booster, not a **correctness** booster.

**Next lever** (for a future, larger-budget run): keep the logic breadth (train `humaneval-train`
heavy, **fresh**, no warm-start regression) with the verified-distilled rows as a minority
parseability signal, and settle the promote/hold with a **larger-n eval** (n=40 cannot resolve a
sub-5% change). A bigger *verified* teacher corpus in a HumanEval-completion style (not MBPP) is
the real unlock — but verifiable HumanEval-style tasks that don't contaminate the eval are scarce.

## Reusable artifacts

- `scripts/distill_from_teacher.py` — teacher→verified-corpus generator (any ollama teacher, any
  test-carrying dataset). Feeds the #1198/#2267 distillation flywheel.
- `data/distill/mbpp-teacher-verified.jsonl` (gitignored runtime data; backed up on the training box).
