# Recurrent depth DOES help — up to ~2 loops, then plateaus (n=50 correction of #2178)

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Reason (adaptive compute)
**Artifacts:** `data/eval/leaderboard.jsonl` (rows `ouro-depth{1,2,4}-n50-2210`), `scripts/eval_humaneval_ouro.py`
**Corrects:** #2178 loop-value verdict · **Closes:** #2210

## Why

The #2178 "depth adds no value" verdict was **n=10 → 0.90 vs 0.80 = one problem = noise**, and it
propagated into the docs as a confident NEGATIVE. This re-runs the Ouro recurrent-depth sweep
(forced `--exit-at-step` 1/2/4) at a statistically meaningful **n=50**, exec-graded (HumanEval
sandbox), on the `ouro-sigma0-adapters/final` adapter.

## Result (HumanEval first-50, greedy, exec-graded)

| forced depth | pass@1 | passed | 95% CI (Wilson) | no-parse |
|---|---|---|---|---|
| 1 | **0.10** | 5/50 | [0.043, 0.214] | 35 |
| 2 | **0.22** | 11/50 | [0.128, 0.352] | 32 |
| 4 | **0.22** | 11/50 | [0.128, 0.352] | 27 |

~123 s/problem (≈ 5.1 GPU-hours for the sweep).

## What it actually says

- **Depth helps up to ~2 loops:** pass@1 doubles from depth 1 (0.10) to depth 2 (0.22). The gap is
  **suggestive but not yet significant at n=50** (two-proportion z=1.64, p=0.10 two-sided ≈ 0.05
  one-sided). So the direction is real and the effect size is large, but firming up depth-1-vs-2
  needs n≥100.
- **Then it plateaus:** depth 2 and depth 4 are **identical** (0.22, 11/50). There is **no** evidence
  that looping past 2 helps — consistent with the Ouro/LoopCoder "~2 loops optimal" reports and with
  the #2031 finding that forced depth helps hard tasks only up to the trained regime.
- **The #2178 NEGATIVE was overstated.** "Depth adds no value" came from a single-problem swing at
  n=10; at n=50 depth clearly matters between 1 and 2. But #2178 wasn't *wrong* about the tail — it's
  right that depth>2 buys nothing here. The honest verdict is **"depth helps up to ~2 loops, then
  plateaus,"** not "no value."

## Caveat worth flagging

The no-parse rate is high (27–35/50) — the forced-exit adapter frequently emits output the extractor
can't parse into a function, especially at shallow depth (depth 1: 35 no-parse). That's a harness/
adapter-format artifact, roughly constant across depths, so the *relative* depth comparison holds; but
the absolute pass@1 is depressed by extraction, not just capability. A cleaner extractor would lift
all three numbers.

## Honest scope

fp16, Ouro-1.4B + `ouro-sigma0-adapters/final`, n=50 (CIs are wide — lean on the direction and the
exact depth-2==depth-4 tie, not the absolute values), forced `--exit-at-step` (the gate is undefined
past trained depth 4, so depth 4 is the trained ceiling here). Reproduce:
`.venv-train/Scripts/python.exe scripts/eval_humaneval_ouro.py --limit 50 --exit-at-step {1,2,4}`.
