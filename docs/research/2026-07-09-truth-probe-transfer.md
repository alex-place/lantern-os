# The Ouro truth probe is a real, domain-general direction — and it works where the model is blind

**Date:** 2026-07-09 · **Evidence class:** MEASURED · **Loop stage:** Verify
**Artifacts:** `experiments/sigma0_probe_transfer.py`, `data/sigma0/probe_transfer_report.json`
**Follow-up to:** [#2022](../SIGMA0-COLLAPSE-CERTIFICATE.md) / [2026-07-04 hidden-state truth probe](2026-07-04-hidden-state-truth-probe.md) · **Closes:** #2030

## Question

The [pilot probe](2026-07-04-hidden-state-truth-probe.md) hit AUROC **0.99** on length-matched
minimal pairs — but at **ceiling on easy facts**, which is uninformative, and possibly reading
per-fact features rather than a transferable "truth direction." Two things had to be shown to make
the number mean something:

1. an **informative, sub-ceiling** AUROC on facts the model is genuinely uncertain about, and
2. **cross-domain transfer** — a real truth direction must generalize to a held-out domain, not
   memorize per-fact word features.

## Method

Larger, **domain-tagged** matched set: 5 domains × 16 facts = **80 facts → 160 examples**
(geography, science, history, literature, arithmetic). Each fact is a minimal pair — same template,
one swapped fill — so true and false differ only in the *fact*, not surface form. We forward
Ouro-1.4B-Thinking, capture the last-token residual hidden state at each recurrent (UT) step
(dim 2048) and the mean answer-token log-probability.

**Hardness is data-defined, not guessed.** For each fact, `margin = logprob(true) − logprob(false)`
under the model; small `|margin|` = the model itself can't tell true from false. We tercile the
facts by `|margin|` and report probe AUROC within each tercile using the best step's **out-of-fold**
predictions (no refit → no leakage). This avoids me mislabeling what a 1.4B model finds "obscure."

**Transfer** = leave-one-domain-out (LODO): train the probe on 4 domains, test on the held-out 5th.
A label-shuffle permutation gives the chance floor.

Confounds controlled: minimal pairs (length AUROC reported), balanced labels (base rate 0.5 — the
[#2028](https://github.com/alex-place/lantern-os/issues/2028) base-rate confound), and grouped /
held-out splits so a fact's true+false never straddle the train/test line.

## Results

| Metric | Value |
|---|---|
| Full-set probe AUROC (best UT step 2) | **0.928** |
| Per-UT-step curve | 0: 0.643 · 1: 0.877 · **2: 0.928** · 3: 0.922 |
| Length-confound AUROC | **0.515** (≈ chance) |
| Base rate (positive) | **0.500** |
| Model answer-logprob AUROC (full) | 0.66 |

**Data-defined hardness (probe @ best step vs the model's own logprob):**

| Tercile | mean \|logprob margin\| | probe AUROC | logprob AUROC |
|---|---|---|---|
| **hard / uncertain** | 0.099 | **0.885** | **0.528** |
| medium | 0.533 | 0.929 | 0.565 |
| easy / confident | 2.489 | 0.968 | 0.895 |

**Cross-domain transfer (leave-one-domain-out, best step):**

| Held-out domain | probe AUROC | shuffled floor |
|---|---|---|
| geography | 0.926 | 0.637 |
| science | 0.902 | 0.570 |
| history | 0.969 | 0.637 |
| literature | 0.984 | 0.719 |
| arithmetic | 0.871 | 0.543 |
| **MEAN** | **0.931** | **0.621** |

## What this means

- **The probe is informative below ceiling.** On the model-uncertain tercile — where the model's own
  logprob is at chance (**0.53**) — the hidden-state probe still separates truth at **0.885**. The
  internal representation encodes factual truth *even when the model cannot surface it in its output
  distribution*. That gap (0.885 vs 0.53) is the honest headline: a real Verify-stage signal that
  beats the model's stated confidence exactly where confidence fails.
- **It's a domain-general direction, not memorization.** Trained on 4 domains and tested on a
  never-seen 5th, transfer AUROC is **0.93** (floor 0.62). The truth direction generalizes across
  geography → science → history → literature → arithmetic.
- **The confounds are dead.** Length AUROC 0.515, base rate 0.500 — the 0.99 pilot's ceiling was
  easy-fact saturation, not surface form and not base rate.

## Honest caveats

fp16; Ouro-1.4B (small model); self-authored matched facts (minimal-pair swaps); features are
per-UT-step last-token states, not intra-step layers; ~16 facts/domain, so per-domain transfer AUROC
has real variance (rely on the MEAN and the shuffled floor for the load-bearing claim). MEASURED, not
PROVEN. Reproduce: `.venv-train/Scripts/python.exe experiments/sigma0_probe_transfer.py`.
