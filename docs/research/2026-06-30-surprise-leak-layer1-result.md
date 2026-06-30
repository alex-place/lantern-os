# Opening the leak, Layer 1: surprise separates hallucination — but the production primitive doesn't

**Date:** 2026-06-30
**Status:** research result (measured) — first empirical test of the [pumped-lossy-resonator](2026-06-30-pumped-lossy-resonator.md) thesis.
**Loop stages:** Verify (the leak).
**Harness:** [`experiments/surprise_leak_ab.py`](../../experiments/surprise_leak_ab.py)

## What was tested

The resonator note claims the loop's Verify-stage loss term is the per-token surprise
signal `−log₂ p(token)` from [`token-surprise.js`](../../apps/lantern-garage/lib/token-surprise.js),
wired into the groundedness canary as `modelUncertainty` — but the valve is closed (no
production caller plumbs real logprobs). Before opening it anywhere, the decisive,
cheapest question (Layer 1 of the test plan):

> Does the surprise **field** actually separate **wrong-confident** answers from **right** ones?

Tested on **199 Open Trivia DB factual questions**, two local logprob-exposing models via
Ollama's OpenAI-compatible endpoint (the only working path — OpenAI billing is dead).
The Python `surprise_field`/`field_to_uncertainty` are exact ports of `token-surprise.js`
(verified byte-identical on shared vectors). Hallucination label = answer fails a
deterministic string grader against gold. AUROC = how well an uncertainty signal ranks
hallucinations above correct answers (0.5 = chance).

## Result

| Model | n | Halluc. rate | **`field_uncertainty`** (proposed, tailMass) | `mean_bits` (perplexity baseline) | `p90_bits` | Δ(field−mean) 95% CI |
|---|---|---|---|---|---|---|
| qwen2.5-coder:1.5b | 199 | 80.4% | **0.519** | 0.762 | 0.731 | [−0.334, −0.140] |
| mistral:7b | 199 | 50.3% | **0.500** | 0.791 | 0.806 | [−0.352, −0.223] |

Two independent runs, same story, both decisive:

1. **The thesis holds. Raw per-token surprise separates hallucination.** Plain
   perplexity (`mean_bits`) scores AUROC **0.76–0.79**, and `p90_bits` **0.73–0.81** —
   well above chance, on a balanced (mistral) and an imbalanced (qwen) set. The Verify
   leak is real signal: a confidently-wrong answer *does* cost more bits per token than a
   right one. Farquhar et al.'s sequence-level claim shows up at the token level.

2. **But the production primitive is degenerate.** `field_to_uncertainty` scores **0.519
   and 0.500 — chance.** It is nonzero on **3% / 0%** of rows. Its `tailMass` gate counts
   only tokens costing **> 6 bits** (p < 1/64); these models are *confidently* wrong at
   low per-token surprise, so the gate almost never fires and the signal collapses. The
   paired-bootstrap Δ vs perplexity is **entirely below 0** in both runs — the field is
   not just unproven, it is decisively *worse* than the one-number baseline it was meant
   to improve on.

## Why it matters / what to do

The leak is worth opening — but **not with the current aggregation.** Before any
production caller plumbs logprobs into the groundedness canary
([`groundedness-canary.js:148`](../../apps/lantern-garage/lib/groundedness-canary.js)):

- **Drive `modelUncertainty` from `mean_bits`/`p90_bits` (perplexity), not the 6-bit
  `tailMass` field** — or lower/per-model-calibrate the bit threshold. The 6-bit gate was
  a guess; the data says it is set far above where these models express error.
- The raise-only, anchor-override wiring in the canary is fine and untouched by this — the
  fix is purely in `token-surprise.js`'s field→scalar map.

## Honest caveats

- **String grader is approximate** — it mislabels some correct-but-unmatched answers as
  hallucinations. That adds label noise, which *depresses* all AUROCs; the true perplexity
  separation is likely ≥ what's reported. An LLM-judge re-grade is the obvious tightening
  (blocked here: OpenAI judge billing-dead; a local judge would work).
- **Two small local models, one dataset.** The owned PLT model (ADR-0011) — the one whose
  decode we control end to end — is the model that actually matters for production and is
  untested here. The finding (perplexity > tailMass-field) should be re-run there.
- **80% / 50% hallucination rates** are small-model artifacts; AUROC is robust to the
  imbalance but the minority class bounds the CI width.
- This is **Layer 1 only** (signal validity). Layer 2 (does feeding surprise into the
  canary raise hallucination recall without raising FPR) and Layer 3 (does it raise
  end-to-end verified-pass-rate) remain unrun and now have a clear input: use perplexity,
  not the current field.

## Evidence

| Claim | Evidence | Confidence | Source |
|---|---|---|---|
| Raw surprise separates hallucination (AUROC 0.76–0.81) | `experiments/results/surprise_leak_ab_report.json`, two runs | High | measured (n=199×2) |
| `token-surprise.js` field collapses to chance (0.50–0.52) | same; nonzero on 0–3% of rows | High | measured |
| Field decisively worse than perplexity | paired bootstrap Δ CI below 0 both runs | High | measured |
| Python port == `token-surprise.js` | identical fields on shared vectors (`--selftest` + node cross-check) | High | repo |
| Ollama exposes per-token logprobs (v0.30.10) | live `/v1/chat/completions` returns `logprobs.content[].logprob` | High | repo (2026-06-30) |
| Sequence-level uncertainty predicts confabulation | Farquhar et al., *Nature* 2024 | Med | external |

## Resolution (2026-06-30) — the leak now carries signal

Acted on the "what to do" above. `fieldToUncertainty` in
[`token-surprise.js`](../../apps/lantern-garage/lib/token-surprise.js) was rewritten to
drive the scalar from a `0.5·meanBits + 0.5·p90Bits` perplexity blend through a
strictly-monotonic logistic (CENTER=5 bits, GAIN=1) instead of the chance-level 6-bit
`tailMass` gate. Because the transform is strictly monotonic, AUROC equals the ranking of
the blend at every bit scale — so the [0,1] shaping does not cost separation.

Re-validated **offline against this note's own committed labeled rows** (no model needed),
locked as a data-driven regression test in
[`test/token-surprise.test.js`](../../apps/lantern-garage/test/token-surprise.test.js):

| Model | old `tailMass` field | **new perplexity-blend field** | nonzero rows (old→new) |
|---|---|---|---|
| qwen2.5-coder:1.5b | 0.5188 (chance) | **0.7681** | 3% → 100% |
| mistral:7b | 0.5000 (chance) | **0.8108** | 0% → 100% |

The blend slightly *exceeds* `mean_bits`/`p90_bits` alone on both runs. The canary's
raise-only anchor-override wiring is unchanged. **Layers 2–3 remain unrun** — the open
input is now a calibrated, signal-bearing scalar rather than a degenerate one.
