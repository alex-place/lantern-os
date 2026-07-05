# Is Ouro's Q-exit actually adaptive? Weakly — to token-entropy, not task difficulty

**Date:** 2026-07-04 · **Evidence class:** MEASURED · **Loop stage:** Reason (adaptive compute)
**Artifacts:** `experiments/sigma0_qexit_adaptive.py`, `data/sigma0/qexit_adaptive_report.json`

## Question

Ouro's headline over a fixed-depth model is *adaptive recurrent-compute*: the trained early-exit
gate should spend **more** recurrent steps on **harder** inputs. `bench_ouro_loop.py` measures the
global depth↔quality knob (and ADR-0012 reports "25–43% compute saved at 95–98% fidelity" from it),
but nothing measured the *per-input adaptivity itself* — does the gate allocate depth by difficulty?

## Method

For each input, the gate emits a per-step logit; replicating `modeling_ouro.py:769-782` exactly,
`λ_i = sigmoid(gate_i)` is the exit hazard, the exit PDF is `p_i = λ_i·remaining` (remaining decays
by `1-λ_i`, last step takes the rest), and the model's preferred depth is the **expected exit depth**
`E[d] = Σ (i+1)·p_i`. We compute `E[d]` at the last token for 24 prompts across an easy/medium/hard
gradient and correlate it with an **objective** difficulty proxy — next-token entropy at the prompt's
last position — so the result doesn't rest on hand-labeled tiers.

## Result

| | easy | medium | hard |
|---|---|---|---|
| **E[exit depth]** (of max 4) | 3.39 | 3.46 | 3.35 |

- **Flat across difficulty tiers** — hard inputs get **no more** depth than easy ones (3.35 vs 3.39).
- **corr(E[d], next-token entropy) = 0.48** — a moderate positive relationship: the gate *does* track
  something, but it's **local token-uncertainty, not task hardness**. (My "hard" prompts were a poor
  proxy: `17×23=` has *low* next-token entropy — the model confidently emits a first digit — even
  though the arithmetic is hard.)
- Mean E[d] ≈ **3.4 / 4** overall: the gate prefers **near-full depth for nearly everything**.

## Reading (honest, non-overclaiming)

On Ouro-1.4B, the Q-exit gate is **only weakly adaptive** — it correlates with local next-token
entropy (0.48), **not** with task difficulty, and it wants near-full depth (~3.4/4) almost always. So
the intuitive framing "the loop spends more thinking on harder problems" **overstates it** for this
model at its trained depth.

This **refines, does not refute, ADR-0012**: the measured 25–43% savings come from the *global depth
knob* (forcing fewer `max_steps`, a real speed↔quality lever that stands) plus a roughly-uniform
~15% average early-exit (3.4 vs 4) — **not** from the gate cleverly routing more compute to hard
inputs. And note: at the default `early_exit_threshold=1.0` the model runs full depth regardless of
the gate, so the gate's preference isn't even applied unless a threshold < 1 is set.

## Caveats

24 prompts (pilot); difficulty tiers are hand-labeled and next-token entropy is an imperfect hardness
proxy; the "Thinking" variant; measured at the trained depth 4, so `E[d]` is bounded to a coarse
`[1,4]`. A larger prompt set and a better hardness proxy (e.g. multi-step-solve success) could sharpen
this. MEASURED, not PROVEN.
