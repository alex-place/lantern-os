# Loop-value experiment — does Ouro's recurrent depth add value? (#2178)

**Date:** 2026-07-06 · **Verdict:** NEGATIVE — looping adds compute + latency, not capability.
**Consequence:** Ouro stays **research-only**; Qwen2.5-Coder remains the local engine (#2171).

## Question
Ouro-1.4B's pitch is *adaptive recurrent depth* — loop the weight-tied block N times to "think
harder." The founder-timeline make-or-break question: **on our substrate, does deeper looping beat
shallow at equal weights?** If yes, Ouro earns the local coding slot. If no, it stays a research bet.

## Method
`scripts/eval_humaneval_ouro.py --exit-at-step {1,2,4}` forces the Ouro UT loop to exit at a fixed
depth; HumanEval, exec-graded (real unit tests, subprocess-sandboxed), greedy pass@1. The tuned
adapter (`ouro-sigma0-adapters/final`) is held fixed and **only the depth varies**, isolating the
loop's contribution from the weights'. (Max depth is **4** — the model's `total_ut_steps`; the
issue's "6" is not physically reachable for this checkpoint.) Base-model rows already existed.

## Data
**Tuned adapter, depth sweep (HumanEval, n=10, exec-graded):**

| depth (UT steps) | pass@1 | latency |
|---|---|---|
| 1 (shallowest) | **0.90** (9/10) | 62.7 s/prob |
| 2 | 0.80 (8/10) | 52.1 s/prob |
| 4 (deepest) | 0.80 (8/10) | **92.8 s/prob** |

**Base model, depth sweep (HumanEval, n=20, pre-existing leaderboard rows):**

| depth | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| pass@1 | 0.05 | 0.00 | 0.00 | 0.00 |

Leaderboard rows: `ouro-adapter-depth{1,2,4}-2178`, `ouro-base-depth{1..4}` in
`data/eval/leaderboard.jsonl`.

## Reading it
1. **The adapter is the capability, not the loop.** Base → tuned takes 0.05 → 0.90 (a huge lift from
   the *weights*). Within the tuned model, varying depth does **not** lift accuracy.
2. **Looping does not climb — it's flat-to-worse.** 0.90 → 0.80 → 0.80. It **peaks at the shallowest
   depth** and never rises with more recurrence, while latency grows to ~93 s/problem at depth 4.
3. **~15× slower than the shipped engine** for equal-or-worse accuracy (Qwen2.5-Coder ≈ 6 s/task at
   ≈0.96 on the coding-golden set, on-box #2173).

## Why (the mechanism — this was predicted)
Additional loops run over the **same tokens with no external grounding**. A weight-tied recurrent
block re-reads the identical context and refines a **fixed-size latent state** — it has no channel
to add *information* it didn't already have (verified this session: arXiv:2605.30757 — compressed
loops add compute, not a growing scratchpad). The [Σ₀ collapse certificate](../SIGMA0-COLLAPSE-CERTIFICATE.md)
says an ungrounded self-referential loop's fates are frozen self-agreement or drift — so the best
case is flat and the realistic case is slight degradation, which is exactly what the curve shows.
This is a **lossy resonator with no pump**.

## The one path that could rescue Ouro's looping (research, not serving)
The fix for an unpumped loop is a pump: **inject grounding every pass.** That splits two ways:
- **Outer (token-level) grounding** — retrieve / tool / verify *between* generations. This is a
  *pumped* loop and it works — but it **is** the control plane / iterative-RAG / FLARE (retrieve when
  free-logprob is low, the signal we validated). It is **model-agnostic**: Ouro's recurrence adds
  nothing; Qwen gets the identical benefit. We are already building this.
- **Inner (latent-level) grounding** — cross-attend to retrieved evidence *inside* the recurrent
  block, so each UT step refines the state with new external input. This is the **only** version
  where Ouro's looped architecture could be non-redundant — but it needs architectural surgery +
  retraining (frontier-training territory, ADR-0024), and it is speculative.

**The kill-or-justify gate for the entire Ouro line, in one sentence:**
> *Does retrieval-augmented recurrent depth beat retrieval-augmented re-prompting at equal grounding
> budget?* If not, the control plane already captures 100% of the value and the recurrence is a
> slower way to do what re-prompting does.

## Honest caveats
- **n=10** → ±1 problem ≈ 10%; 0.90 vs 0.80 is one failure. The claim is not "depth collapses
  accuracy" — it is "depth does **not raise** it, and strictly costs more latency." That holds.
- **Coding only** — Ouro's *weak* axis. A reasoning harness (GSM8K/MATH, where the paper claims loop
  value) does not exist in-repo; building one is the fair follow-up. But even a generous reasoning
  result would not change the serving decision, only the research bet.
- Single greedy pass, one checkpoint, depth ≤ 4.

## Decision
**Loop-value NEGATIVE on the runnable evidence.** Ouro-1.4B stays kernel/research-only; Qwen2.5-Coder
remains the local coding engine (already shipped, #2171). The recurrence's only route to a product
slot is the *inner-grounded-recurrence* research question above — logged, not adopted.
