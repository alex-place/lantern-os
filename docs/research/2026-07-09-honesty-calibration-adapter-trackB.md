# Track-B honesty/calibration adapter — trained, measured, held (not promoted)

**Date:** 2026-07-09 · **Evidence class:** MEASURED · **Loop stage:** Verify
**Artifacts:** `scripts/build_honesty_calibration_aug.py`, `data/sigma0/honesty_calibration_aug.jsonl`,
`data/sigma0/honesty_trackB_{train,holdout}.jsonl`, `experiments/eval_honesty_trackB.py`,
`data/sigma0/honesty_trackB_eval.jsonl`, adapter `D:/lantern-train/ouro-honesty-trackB/final` (untracked)
**Issue:** #2143 (Track B) · **Decision:** trained + measured; **HELD, not promoted** (honest gate call).

## What was built

The balanced epistemic corpus (`ouro_honesty_train_balanced.jsonl`, 147 rows) teaches the
CLASS/VERIFIED classifier but has **zero abstention rows** and no confidence-calibration examples —
exactly the two slices #2143 asked to add. `build_honesty_calibration_aug.py` authors them
deterministically (20 abstention + 20 calibration, phrasing **disjoint** from the 4 built-in probes
in `eval_sigma0_adapter.py`, so the gate measures generalization not memorization).

Combined corpus (187) was split by a deterministic stratified 20% holdout → **train 148 / holdout 39**
(32 epistemic, 4 calibration, 3 abstention). QLoRA on `ByteDance/Ouro-1.4B` (r=16, α=32, bf16, 4-bit,
3 epochs, 57 steps, ~19 min on the RTX 4080 SUPER; train loss 0.25 → 0.06, no NaN).

## Held-out results (fully clean — no holdout row was trained on)

| Metric | base Ouro-1.4B | +Track-B adapter | Floor |
|---|---|---|---|
| epistemic BOTH-correct (CLASS ∧ VERIFIED) | 0.233 (7/30) | **0.867** (26/30) | 0.92 |
| abstention rate (no-evidence probes) | 0.40 (2/5) | **1.00** (5/5) | — |
| calibration (directional: high-conf↔true) | 0.00 (0/4) | **1.00** (4/4) | — |

(Base emits the CLASS/VERIFIED / confidence structure only sporadically — it lands 0.233 epistemic and
0.40 abstention by partial/lucky format, 0.0 calibration. The adapter lifts every axis: +0.63
epistemic, +0.60 abstention, +1.00 calibration.)

## The honest call: HELD, not promoted

The adapter is a clear win on the two capabilities the issue targeted — **abstention 0 → 1.00** and
**calibration → 1.00** on a clean holdout. But the promotion gate is *matrix*: it must **not regress
epistemic held-out below 0.92** (v2 = 0.958). On a **fully clean** holdout this adapter scores
**0.867**, nominally below the 0.92 floor (though n=30, so ±0.06 binomial noise).

Crucially, **the 0.867 and the incumbent's 0.958 are not comparable:**
- The incumbent (`ouro-honesty-balanced`) trained on the *full* balanced corpus, so it saw my 30-row
  holdout — evaluating it there is leaked in its favour.
- The issue's stated held-out (`golden_dataset`, 159 rows) is **~58% overlapping** with the balanced
  training corpus (93/159 statements substring-present), so the incumbent's 0.958 there is itself
  partly leaked — not a clean generalization number.

There is **no clean common holdout** disjoint from both corpora today, so a fair matrix-gate
comparison can't be made, and I will not flip the incumbent on a floor the clean number doesn't clear.

## Recommendation (for the promotion decision)

1. **Author a fresh common holdout** (≥40 epistemic statements disjoint from both `ouro_honesty_train_balanced` and `golden_dataset`), then eval both adapters on it — the only fair matrix gate.
2. Or **top up the epistemic slice** (more CLASS/VERIFIED rows) so the combined-corpus adapter recovers ≥0.92 clean while keeping the new abstention/calibration behaviour, then retrain.

The abstention + calibration data and the reproducible train/eval pipeline are the durable
deliverable; promotion is deferred to a clean gate. Logged to `data/eval/ouro-promotion-log.jsonl`
as `hold`.

## Honest caveats

Ouro-1.4B, bf16 4-bit QLoRA, n=39 holdout (small — the epistemic figure carries ±0.06); "directional"
calibration is a coarse high/low check, not ECE on a large set; the adapter weights live on `D:/`
(untracked). MEASURED, not PROVEN. Reproduce: `build_honesty_calibration_aug.py` → split →
`train-qlora-ouro.py --data honesty_trackB_train.jsonl` → `eval_honesty_trackB.py --adapter <dir>`.
