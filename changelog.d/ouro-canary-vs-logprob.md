### The Sigma0 hidden-state canary does NOT beat logprob as a grounding gate (measured null on Ouro)

The genuinely-owned, non-FLARE test: does the Sigma0 loop-surprise canary route grounding better
than a model's own logprob? Run on Ouro-1.4B-Thinking (open model, hidden states accessible;
feasibility first confirmed HaluEval-QA baseline 68% -> grounded 38%, so the A/B/C structure holds).
Oracle-free signals from Ouro's own baseline answer, same 40 items:

| gate | AUROC | routing edge vs random |
|---|---|---|
| logprob (FLARE) | 0.564 | **+0.048** |
| canary_resid (loop surprise \|\|h_T - h_{T-1}\|\|) | **0.661** | -0.016 |
| canary_rho (contraction) | 0.661 | -0.007 |
| canary_hnorm | 0.519 | -0.009 |
| cv_probe (supervised, GroupKFold) | 0.567 | -0.003 |

**NULL: the canary does not beat logprob as a gate.** It out-RANKS logprob (0.66 vs 0.56, +0.097 —
but within the n=40 noise band, and notable only because Ouro's logprob is near-chance) yet it
ROUTES grounding WORSE than random (negative edge), while logprob is the only signal with a positive
edge. Mechanism: loop-surprise tracks intrinsic difficulty, not grounding-fixability — it fires on
hard b=0,g=0 items grounding can't fix. The supervised probe (0.567) confirms the earlier 0.99 was a
matched-pair artifact that does NOT transfer to real-generation gating.

Third confirmation of the thread's real finding: **ranking hallucination != routing grounding**
(council-delta on gpt-4o-mini, canary on Ouro — both out-ranked, both under-routed). Only free
logprob has held a positive routing edge across both models. MEASURED
(`data/eval/ouro_canary_vs_logprob_results.json`); n=40, Ouro-1.4B fp16, gold-contains grader,
format-degeneration noise. Honest terminus of the "find novelty" thread: no owned signal beat the
published baseline.
