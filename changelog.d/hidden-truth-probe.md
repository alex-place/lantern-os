### Ouro's hidden states linearly encode truth (AUROC ≈0.99, confound-controlled)

Reusing the per-recurrent-step hidden-states hook, `experiments/sigma0_hidden_probe.py` tests
whether a linear probe on Ouro-1.4B-Thinking's internal state detects factual truth. The naive
HaluEval-QA run looked great (probe AUROC 0.994) but was a **length confound** — right answers are
terse entities, hallucinated ones full sentences, so answer length alone scores 0.98 (the same
text-surface trap as the debunked ρ=1.064). Controlled with 48 length-matched minimal pairs
("…is Paris" vs "…is Rome"), grouped-CV by fact:

- **hidden-state probe AUROC ≈ 0.99** (best UT step; rises 0.79→0.99 with recurrent depth)
- **length confound AUROC = 0.500** (gone) · **model's own answer-logprob AUROC = 0.767**

So Ouro internally "knows" whether a statement is true even when its stated confidence doesn't —
a genuine, cheap Verify-stage signal that beats token-surprise (0.76–0.81) and motivates a probe arm
for ADR-0017. MEASURED pilot (`data/sigma0/hidden_probe_report.json`); caveats: small n, well-known
facts, self-authored matched pairs, fp16, Ouro-1.4B. See `docs/research/2026-07-04-hidden-state-truth-probe.md`.
