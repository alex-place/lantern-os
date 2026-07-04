# Does Ouro internally "know" truth? A confound-controlled hidden-state probe

**Date:** 2026-07-04 · **Evidence class:** MEASURED (pilot) · **Loop stage:** Verify
**Artifacts:** `experiments/sigma0_hidden_probe.py`, `data/sigma0/hidden_probe_report.json`

## Question

The serving-design research ([memo](2026-07-04-serving-design-sota.md)) found that mid-2026 SOTA
hallucination detection is a **linear probe on internal hidden states** (AUROC 0.90–1.00 on 7–8B
models), beating logit/surprise signals (~0.70–0.80). Now that Ouro loads locally, does *our*
1.4B model's hidden state linearly encode factual truth — and does it beat the model's own stated
confidence? This reuses the exact per-recurrent-step hidden-states hook built for the loop-Jacobian
measurement.

## Method

For each statement we forward Ouro-1.4B-Thinking, capture the residual hidden state at the **last
token** at each recurrent (UT) step (`hidden_states_list`, dim 2048), and the mean answer-token
**log-probability** (the model's own confidence). Probe = StandardScaler → PCA → LogisticRegression
(strong L2), evaluated with **GroupKFold(5) split by fact** so a fact's true and false versions never
straddle the train/test line — the probe must **generalize to unseen facts**, not memorize words.

## The confound we caught first

The naive run on **HaluEval-QA** looked spectacular — probe AUROC **0.994**. It was a lie. HaluEval's
right answers are terse entities ("Arthur's Magazine", mean 2.1 words) while hallucinated ones are
full sentences ("First for Women was started first.", mean 10.8 words). **Answer length alone scores
AUROC 0.98** — so the probe was reading *surface form*, not truth. This is the same text-surface trap
that made the certificate's ρ=1.064 meaningless. We did **not** claim truth-detection from it.

## The clean result (length-matched minimal pairs)

Fix: 48 minimal pairs where the true and false statement are identical except the swapped fact
("The capital of France is **Paris**" vs "…is **Rome**"), so surface form carries no signal.

| Signal | AUROC | |
|---|---|---|
| Answer **length** (confound) | **0.500** | form is now chance — the confound is gone |
| Model's own **answer log-prob** | 0.767 | the model's stated confidence |
| **Hidden-state probe (best UT step)** | **≈0.99** | reads truth from the internal state |

Per UT step: **0.79 → 0.98 → 0.99 → 0.99** (steps 0–3). The truth representation **strengthens with
recurrent depth** — the loop "resolves" the fact over its steps.

**Reading:** on statements where surface form gives zero signal, a linear probe on Ouro's hidden
states separates true from false at ~0.99 AUROC — far above the model's own confidence (0.77). Ouro
**internally represents whether a statement is true even when its output confidence doesn't reveal
it.** That is a genuine, cheap (one matmul/token) Verify-stage signal, and it directly motivates a
probe arm for [ADR-0017](../adr/0017-surprise-gated-decoding.md) (a hidden-state probe is a stronger
trigger than token surprise, whose measured range was 0.76–0.81).

## Honest caveats

- **Pilot, small n** (48 matched pairs / 96 statements). 0.99 is a point estimate near ceiling; the
  robust claim is "clearly ≫ 0.5, ≫ the 0.500 length confound, and ≫ the 0.767 logprob."
- **The facts are well-known** ones Ouro almost certainly knows. The probe reads out truth the model
  *internally represents*; on facts the model doesn't know, there is no truth signal to read, so it
  would fail. So this measures "statements the model internally believes false," which for known
  facts equals actual falsehood.
- **Self-authored** matched facts (minimal-pair swaps minimize authoring bias; grouped CV forces
  cross-fact generalization). fp16, Ouro-1.4B (small), UT-step hidden states (not intra-step layers).
- **MEASURED, not PROVEN** — a GPU experiment with a run pointer, not a machine-checked theorem.
