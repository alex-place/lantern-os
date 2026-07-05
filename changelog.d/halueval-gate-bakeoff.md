### HaluEval gate bake-off: no cheap signal clearly beats free logprob (council-Delta ranks best but routes worst)

Follow-up to the surprise-gated four-arm test. On the SAME gpt-4o-mini + same 40 items, race the
logprob gate (FLARE) against self-consistency (semantic entropy, K=5) and cross-model council-Delta
(SAC3-style, {4o-mini, 4o, 3.5}). MEASURED:

| gate | AUROC | edge-vs-random |
|---|---|---|
| logprob (FLARE) | 0.861 | **0.059** |
| self_consistency | 0.851 | 0.056 |
| council_delta | **0.909** | 0.046 |

Reading: **council-Delta has the best AUROC (0.909) but beats logprob by only +0.048 — inside the
n=40 noise band (~0.08 CI) — and it actually ROUTES worse** (lowest edge), because a 3-member Delta
takes only 3 distinct values (heavy ties -> greedy top-k routing degrades). Edge tracks signal
*granularity* (continuous logprob > 5-level self-consistency > 3-level council), not just AUROC.
Self-consistency ~= logprob: 5x sampling buys nothing here.

Practical call: **use the free logprob gate.** The council's high AUROC is a hint worth more n + a
finer (continuous) Delta, not a win. None of the three is novel (FLARE / semantic-entropy / SAC3);
the strict Sigma0 hidden-state canary still needs an open model (Ouro) and is the separate
follow-up. `data/eval/halueval_gates_compare_results.json`.
