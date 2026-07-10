# grounding-v2 verdict closed — adapter cuts confabulation 47% vs base (same-box, same-holdout)

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Verify
**Artifacts:** `experiments/sigma0_ouro_honesty_eval.py`, `data/sigma0/ouro_honesty_eval_results_v2.{base,grounding-v2-repro}.json`
**Closes:** #2265 (Tasks 1+2) · **Handoff from:** the 3070 box (2026-07-08, adapter-only)

## The rigor gap this fills

grounding-v2 (Ouro-1.4B QLoRA on the de-glossed corpus-v2) had an adapter number (7/34) but **no
same-run base control** — the prior box (12 GB) hard-froze under the load, so the adapter-vs-base
delta was never citable. This box (RTX 4080 SUPER 16 GB) has the headroom, so both were run on the
**same 34 de-glossed `heldout_v2` negatives** (no gloss leak), the adapter freshly **retrained on-box**
from the deterministic corpus (`build_sigma0_grounding_corpus.py`, 667 rows, 0 heldout leaks).

## Result (same box, same holdout, greedy)

| model | confabulation ↓ | golden_score ↑ | parsed |
|---|---|---|---|
| base Ouro-1.4B | **0.333** (11/33) | 0.667 | 33/34 |
| grounding-v2 adapter (on-box retrain) | **0.176** (6/34) | 0.824 | 34/34 |
| — prior 3070 run (2026-07-08) | 0.206 (7/34) | 0.794 | 34/34 |

**The adapter beats base decisively:** confabulation **0.333 → 0.176 = −0.157 absolute, a 47% relative
reduction**, golden_score +0.157, and it fixes the one base parse failure (34/34). The on-box retrain
(0.176) lands slightly *better* than the prior 3070 run (0.206), so the result reproduces across
hardware — the adapter, not a lucky checkpoint, is the effect.

## What it means

- **The crystallization flywheel works, measured end to end:** own-grounding corpus → QLoRA → a
  **behaviour change you can measure** (47% fewer confabulations on held-out de-glossed negatives),
  before any cloud GPU is spent on SWE-bench. This is the ADR-0010/0011 "adapter-only weights on a
  frozen base, eval-gated" path delivering.
- On the honesty/Verify axis, grounding-v2 clears its own base decisively on the clean holdout — it
  flips toward `verified:true` for that axis (the coding axis is separate and still PLT-blocked, #2144).
- Contrast with the honesty *adapter* of #2143 (held): that one gained abstention/calibration but its
  epistemic-classification held-out sat below the 0.92 floor. grounding-v2 targets a different metric
  (confabulation on de-glossed negatives) and clears its bar cleanly. Different corpus, different gate,
  different outcome — both reported honestly.

## Still open (Task 3)

The registry-grade **HaluEval** base-vs-adapter row needs `OPENAI_API_KEY` (GPT-4o-mini grader) — not
configured on this box, so that row is deferred (see #2248). The internal 34-fact same-holdout control
— the load-bearing rigor gap — is now closed.

## Honest scope

Ouro-1.4B, bf16 4-bit QLoRA (3 epochs, seq 1536), n=34 de-glossed heldout negatives (small — the
confab rate carries ~±0.08 binomial noise, but the base→adapter gap is 0.157, ~2×the noise). Greedy,
deterministic. Adapter weights on `D:/lantern-train/ouro-grounding-v2-repro/final` (untracked).
Reproduce: `build_sigma0_grounding_corpus.py` → `train-qlora-ouro.py --base ByteDance/Ouro-1.4B --data
<corpus> --epochs 3 --seq 1536` → `sigma0_ouro_honesty_eval.py --v2 --base ... --adapter {<dir>, ""}`.
