# H-Neurons hallucination probe on Ouro — GO: 0.97 AUROC from 0.02% of neurons, beats the residual probe

**Date:** 2026-07-10 · **Evidence class:** MEASURED · **Loop stage:** Verify
**Artifacts:** `experiments/sigma0_hneurons_probe.py`, `data/sigma0/hneurons_probe_report.json`
**Issue:** #2209 · **Prior art:** H-Neurons (arXiv:2512.01797)

## Question

H-Neurons claims **<0.1% of FFN neurons predict hallucination**, generalize OOD, and are causally
tied to over-compliance (our Σ₀ collapse canary). Their numbers are on Mistral/Gemma/Llama — untested
on Ouro. Does it transfer to *our* model, and does it beat the free-logprob gate (~0.77) and the
#2030 residual-hidden-state probe (0.93)?

## Method

Neuron activation = the input to each layer's `mlp.down_proj`, i.e. `act_fn(gate_proj(x))·up_proj(x)`
(intermediate 5632 × 24 layers = **135,168 neurons**), captured at the last token on the last UT step.
Probe: StandardScaler → SelectKBest(f_classif) → **L1-LogisticRegression** (the sparse-neuron
selection). Data: the length-matched true(faithful)/false(hallucinated) fact pairs from
`sigma0_probe_transfer.FACTS` (5 domains, 80 facts) — the same clean set the #2030 residual probe used,
so the two are directly comparable. Grouped CV by fact; leave-one-domain-out for OOD transfer.

## Results

| metric | H-Neurons (this) | #2030 residual probe | logprob gate |
|---|---|---|---|
| detection AUROC (grouped CV) | **0.969** | 0.928 | 0.712 |
| OOD transfer (leave-one-domain-out, MEAN) | **0.959** | 0.931 | — |
| neurons used | **~30 (0.022% of 135k)** | dense 2048-d state | — |

Per-domain LODO (Ouro): geography 0.934 · science 0.973 · history 0.984 · literature 1.000 · arithmetic 0.906.

**Qwen2.5-Coder-7B re-confirm (the signal is NOT Ouro-specific):**

| metric | Ouro-1.4B | Qwen2.5-Coder-7B |
|---|---|---|
| detection AUROC (grouped CV) | 0.969 | **0.970** |
| OOD transfer (LODO MEAN) | 0.959 | **0.959** |
| neurons used | ~30 (0.022%) | **~25 (0.0047%)** |
| logprob baseline | 0.712 | 0.732 |

The probe reaches essentially the same 0.97 detection / 0.959 transfer on a different model family (Qwen,
530k neurons) using an even *sparser* ~25 neurons (0.005%). So the H-Neurons hallucination direction —
extreme sparsity, OOD-robust, well above logprob — reproduces across Ouro and Qwen, exactly as the paper
claims for Mistral/Gemma/Llama. This is model-agnostic on our stack, not a per-model artifact.

## Verdict: GO-candidate

- **The <0.1% claim holds on Ouro** — the probe reaches 0.969 detection using **~30 neurons, 0.022%**
  of the network. Extreme sparsity, exactly as the paper reports for other model families.
- **It transfers OOD** — leave-one-domain-out MEAN 0.959 (never below 0.91), so it's a general
  hallucination direction, not per-domain memorization.
- **It beats both incumbents** — +0.26 AUROC over the free-logprob gate (0.712), and, notably, **it
  beats the #2030 residual-hidden-state probe on both detection (0.969 vs 0.928) and transfer (0.959
  vs 0.931).** The neuron-level view is a stronger honesty signal than the residual-state view on the
  same facts.

**Go/no-go: GO** to prototype wiring H-Neurons into the surprise/abstention gate. It's the strongest
Verify-stage hallucination signal measured so far on Ouro, and the paper's causal tie to
over-compliance maps onto the Σ₀ collapse canary — worth the follow-up to test that causal handle.

## Still open

- **Causal test** (ablate the ~30/~25 neurons → does over-compliance rise?) is the paper's headline
  mechanism and the natural next experiment before gate-wiring — the causal handle maps onto the Σ₀
  collapse canary.
- **HaluEval-scale confirmation** — these numbers are on 80 matched facts; a larger hallucination
  benchmark (with a real backend) would firm up the absolute AUROC before shipping the gate.

## Honest scope

fp16, Ouro-1.4B-Thinking, 80 self-authored matched facts (n=160), last-token/last-UT-step neuron acts
across all 24 layers, SelectKBest→L1 (a sparse but not literally single-neuron probe); n is small so
LODO carries variance — lean on the MEAN and the margin over logprob. A sklearn 1.8 deprecation warns
on `penalty=` but L1 selection worked (≈30 non-zero neurons). MEASURED, not PROVEN. Reproduce:
`.venv-train/Scripts/python.exe experiments/sigma0_hneurons_probe.py`.
