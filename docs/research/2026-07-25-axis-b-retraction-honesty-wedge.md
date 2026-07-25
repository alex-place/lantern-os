# Axis B RETRACTED — the open-weights honesty wedge collapses with scale

**Date:** 2026-07-25 · **Type:** Retraction of a claim made earlier in this program.
**Status:** [measured — two valid rungs, both failing their pre-registered gate].
**Artifacts:** `experiments/results/honesty_whitebox_vs_blackbox_deglossed.Qwen2.5-1.5B-Instruct.json`
· `...Qwen2.5-7B-Instruct.json`

## What was claimed

That a small **open** model plus a white-box activation probe would beat a **closed** frontier
model on honesty (confident-wrong rate), because the probe needs activations a closed model will
not expose — "the one axis size cannot buy back." It was the sole owned advantage in the
ORACLE-1.5B / ORACLE-P benchmark predictions, and the pre-registered kill condition said so
explicitly.

## What the measurement says

Same de-glossed set (294 statements / 224 stem-groups), same steelmanned black-box arm, two scales:

| | white-box probe | best black-box | wedge | gate (≥10pp) |
|---|---|---|---|---|
| Qwen2.5-1.5B | 0.8349 | 0.7577 (verbalized) | **+7.7pp** | FAIL |
| Qwen2.5-7B-4bit | 0.9192 | **0.9154** (verbalized) | **+0.4pp** | **FAIL** |

Controls clean at both rungs (surface 0.526 — identical, as it must be on identical data;
shuffle 0.520). So both are valid measurements, not dataset defects.

**The wedge does not widen with scale. It collapses — 7.7pp → 0.4pp.** Per-family at 7B, the
black-box arm actually *wins* on two of three: factual 0.988 vs 0.983, assoc 0.932 vs 0.897,
arith 0.826 vs 0.824.

## Why — and why the pre-registered prediction was wrong

The scale argument rested on the probe ladder (white-box detectability rising with scale). That
part held: the probe did improve, 0.835 → 0.919. **What was missed is that the black-box arm
improves faster.** Verbalized confidence jumped 0.7577 → 0.9154: a bigger model simply *says*
whether it believes a statement far more accurately, and that closes the gap from the other side.
This exact mechanism was named as a watch-item before the run, and it is what happened.

The deeper reading: at sufficient scale a model's *self-report* becomes an efficient readout of
the same internal state the probe reads. The activation probe is not accessing privileged
information — it is accessing information the model will also tell you, if asked well.

## Consequences (stated plainly)

1. **Axis B is retracted as an owned advantage.** A closed frontier model with a well-elicited
   verbalized-confidence signal is not structurally disadvantaged on honesty detection. The
   ORACLE-P claim "open 1.5B beats closed 70B on honesty (0.05 vs 0.17 confident-wrong)" is
   **not supported** and must not be repeated.
2. **The product thesis loses one of its two legs.** What survives is reliability-per-dollar
   (axis A) — real, but a cost argument, not an unassailable moat.
3. **The v1.10 white-box program needs re-scoping**, not abandoning: the probe still works
   (0.919 AUROC at 7B) and remains useful as *one verifier in the bank* and as an
   **off-gradient training auditor** (its anti-Goodhart role, where the point is precisely that
   it is NOT the thing being optimized — a role verbalized confidence cannot fill, because
   training against a model's own self-report is exactly what Goodharts it). That is a narrower
   and honest claim, and it is untested.

## Honest scope of the retraction

- Two rungs on one model family, one de-glossed statement set (294 rows), one task type. It does
  not prove no wedge exists anywhere — it does show the wedge is absent at both scales reachable
  on this hardware, and *shrinking* in the direction that matters.
- The black-box arm was steelmanned deliberately (verbalized + logprobs + trained combination).
  A weaker baseline would have manufactured a pass at both rungs. That choice is why this
  measurement is worth trusting.
