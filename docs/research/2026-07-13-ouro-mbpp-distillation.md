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
Record in `data/eval/ouro-promotion-log.jsonl`). The n=40 gap is within noise, so the honest
read is **no improvement**.

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
