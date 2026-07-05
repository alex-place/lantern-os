# Surprise-gated grounding on HaluEval: the design test (four-arm), honestly

**Date:** 2026-07-05 · **Evidence class:** MEASURED · **Loop stage:** Verify
**Artifacts:** `experiments/halueval_gated.py`, `data/eval/halueval_gated_results.json`

## What the premise A/B did and didn't show

`halueval_ab.py`: always-ground vs never-ground = 52-55% -> 20% hallucination. That is the RAG
premise (grounding helps) — the most-replicated result in NLP, real but not a novel claim. It
grounds *all* items unconditionally, so it does not test *selective* grounding at all.

## The four-arm test

**A** never-ground | **B** always-ground | **C** surprise-gated (ground the k least-confident
baseline answers) | **C_random** (ground a random k). The gate signal is the baseline answer's mean
token-logprob — **oracle-free** (computed before knowing correctness, never from the gold). No
threshold is tuned: the whole budget frontier k=0..N is swept, and C is judged only against
C_random at *equal budget* (grounding a random subset = the A->B line).

## Result (MEASURED, n=40, gpt-4o-mini, deterministic gold-contains)

- Surprise separates hallucination: **AUROC ~0.87** (conf on wrong -0.33 vs right -0.07).
- Gate beats random across the frontier: **+0.06 mean gap**; 50% budget = 28% vs 36%; 90% of the
  A->B gain captured at 68% budget.
- Reading: you can skip grounding the confident ~third and keep ~90% of the benefit.

## Honest verdict

- **Novel? No.** Confidence-gated retrieval is FLARE / adaptive-RAG. This is an owned, *reproduced*
  measurement of a known technique, not a new method.
- **Caveats:** n=40 (edge ~4 items, wide CI); AUROC uncontrolled for answer-commonness (the
  length / base-rate confound family caught repeatedly this cycle); the gate is the cheapest proxy
  (token-logprob); "gold-contains" is a substring grader; HaluEval passages are answer-bearing by
  construction, so the A->B magnitude is a best-case ceiling.
- **Where novelty would live:** this logprob gate (AUROC ~0.87, +0.06) is the **baseline to beat**.
  If the Sigma0 hidden-state surprise canary (0.99 on matched pairs, earlier this cycle) or the
  council-Delta gates *better than logprob* on the same 40 items, that is the genuinely-owned
  contribution — falsifiable, one experiment away, hold-everything-else-fixed.

## Follow-up (same day): the API-feasible gate bake-off

The strict hidden-state canary **cannot** run on gpt-4o-mini (closed model, no internal states —
which is *why* FLARE uses logprobs), so it moves to Ouro (open model) as a separate, heavier test.
What *is* directly comparable now: race logprob against the other cheap gates the system leans on,
same model, same 40 items (`experiments/halueval_gates_compare.py`).

| gate | AUROC | edge-vs-random | prior art |
|---|---|---|---|
| logprob | 0.861 | **0.059** | FLARE |
| self_consistency (K=5) | 0.851 | 0.056 | semantic entropy |
| council_delta ({4o-mini,4o,3.5}) | **0.909** | 0.046 | SAC3 |

- **No cheap signal clearly beats free logprob.** council-Delta's higher AUROC (+0.048) is inside
  the n=40 noise band, and it **routes worst** — a 3-member Delta has only 3 values, so heavy ties
  wreck greedy top-k routing even though the ranking is good. Edge tracks *granularity*
  (continuous > 5-level > 3-level), not AUROC. Self-consistency is a wash (5x cost, no gain).
- **Practical:** use the free logprob gate; the council's rank quality is a hint worth more n and a
  *continuous* Delta (embedding-variance disagreement, more members), not a deployment win.
- Still not novel (all three published). The owned, potentially-novel question — does the Sigma0
  hidden-state canary beat logprob — remains open and needs Ouro.
