---
title: Σ₀ Ouro Coder — Function-Calling Retraining Plan, Web-Grounded Refinement
created: 2026-06-21
status: reference / shared
prepared_by: Σ₀ coder agent (literature pass + implementation), for the team
---

# Σ₀ Ouro Coder — FC Retraining Plan: Web-Grounded Refinement

## Summary

The local Σ₀ Ouro coder can call tools but does so unreliably — it under-triggers,
over-refuses, and over-reaches for `Bash`. Before spending GPU time on a retrain, we
tested the planned fix against the current published state of the art (five papers,
2024–2026) rather than guessing. **The plan holds up.** We sharpened three things and
shipped them. The most useful insight: the field has converged on an *iterative,
measured* training loop rather than a one-shot retrain — which is the same convergence
loop this project is built on — so we also built the measurement instrument to run it.

Per the project's external-reality rule, every finding below carries
**[claim · evidence · confidence · source]**.

## Findings

1. **~10% irrelevance ("negative") data is the right ratio for our size class.**
   - *Evidence:* Hammer ablated the irrelevance fraction on **Qwen2-1.5B** (our exact
     size) and found ~10% optimal (7,500 of ~75k). Too few → over-triggers; too many →
     over-refuses.
   - *Confidence:* High — direct ablation on a same-size model.
   - *Source:* arXiv:2410.04587.
   - *Action taken:* corpus negative ratio set to 10%.

2. **Function masking is the lever that kills the tool-name bias.**
   - *Evidence:* Hammer masks tool names + parameter names (keeping the human-readable
     descriptions) so the model grounds selection in *what a tool does*, not its name;
     this is why Hammer-1.5B reaches 72% irrelevance at sub-2B.
   - *Confidence:* High.
   - *Source:* arXiv:2410.04587.
   - *Action taken:* ~50% of our canonical (repo-trace) positives are mask-augmented.

3. **Tool-call training works best as an iterative, measured loop — not one-shot.**
   - *Evidence:* LoopTool runs *diagnose failures → generate data targeting exactly
     those failures → retrain → re-evaluate*, 2–5 rounds, with gains that grow per
     iteration. This is the Observe → Reason → Act → Verify → Converge loop applied to
     training, and it grounds every round in measured reality.
   - *Confidence:* Medium-high — recent (Nov 2025), consistent results across model sizes.
   - *Source:* arXiv:2511.09148.
   - *Action taken:* built an in-domain evaluation gate to serve as the loop's
     measurement instrument (see "What shipped").

4. **Over-engineered synthetic data backfires.**
   - *Evidence:* Two 2025–26 studies show template-heavy synthetic data produces
     "highly learnable patterns" that cause overfitting/bias, while diversity-promoting
     generation improves out-of-distribution robustness.
   - *Confidence:* Medium-high.
   - *Sources:* arXiv:2601.17829, arXiv:2511.01490.
   - *Action taken:* the synthetic examples we generate are now assembled for diversity
     (the build reports 93.5% distinct phrasings), and we declined to pad the corpus
     with templated filler — a course-correction this evidence validates.

5. **We must evaluate against our own tool schema, not just the public benchmark.**
   - *Evidence:* BFCL measures generic function-calling; it does not test our specific
     eight-tool schema, where the real failures live.
   - *Confidence:* High.
   - *Source:* BFCL v3/v4 + internal retraining handoff.
   - *Action taken:* a 29-case in-domain evaluation with an explicit pass/fail release gate.

## The refined plan (one loop)

```
data (rebalance) → retrain (QLoRA) → measure (in-domain eval + BFCL)
        ↑                                        │
        └────── targeted data for the failures ──┘   (repeat 2–3 rounds)
```

- **Bar to clear:** the sub-2B state of the art (Hammer-1.5B) — irrelevance ≥ 70,
  relevance ≥ 88.
- **Release gate (our schema):** irrelevance ≥ 70 **and** relevance ≥ 88 **and** per-tool
  trigger balanced within 2× **and** malformed-shell-args < 2%.

## What shipped

- **Corpus builder + train/serve parity fix** — rebuilds the training data through the
  exact serving format and fixes a mismatch that was a root cause of under-triggering.
- **In-domain evaluation gate + the three research refinements above** — the gate doubles
  as the loop's measurement instrument and is self-verifying without GPU time.

## Open items / next

- **Baseline the current model** on the in-domain gate to get round-0 numbers (needs the
  model served on the GPU).
- **Run the loop:** round-0 → diagnose the weakest tools/categories → targeted data →
  round-1.
- The "answer-normally" (no-tool) class is still below target; closing it cleanly needs a
  real harvest of no-tool answers rather than templated filler (consistent with finding 4).

## Sources

- Hammer — Robust Function-Calling via Function Masking: https://arxiv.org/abs/2410.04587
- LoopTool — Closing the Data-Training Loop for Tool Calls: https://arxiv.org/pdf/2511.09148
- Linguistic & Argument Diversity in Synthetic FC Data: https://arxiv.org/abs/2601.17829
- Synthetic Eggs in Many Baskets (synthetic-data diversity): https://arxiv.org/html/2511.01490v1
- Berkeley Function Calling Leaderboard v3/v4: https://gorilla.cs.berkeley.edu/leaderboard.html
