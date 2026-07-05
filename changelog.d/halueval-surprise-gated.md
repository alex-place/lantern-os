### HaluEval surprise-gated grounding: the design test, not just the premise (four-arm A/B/C)

`experiments/halueval_ab.py` showed always-ground beats never-ground (52-55% -> 20% hallucination) —
the RAG *premise*. `experiments/halueval_gated.py` adds the arms that test ADR-0017's actual
*design*: **C** surprise-gated (ground only the k least-confident baseline answers) vs **C_random**
(ground a random k) at equal budget. The gate is oracle-free (baseline mean token-logprob, never the
gold) and the whole budget frontier is swept (no threshold tuned).

MEASURED (n=40, gpt-4o-mini, deterministic gold-contains): the surprise signal separates
hallucination at **AUROC ~0.87**, and gated grounding **beats random at equal budget across the
frontier** (+0.06 mean gap; 50% budget = 28% vs 36% hallucination; captures 90% of the A->B gain at
68% budget). So selective grounding has real value — you can skip grounding the confident third and
keep ~90% of the benefit.

Honest scope: this gate IS FLARE's mechanism (confidence-gated retrieval) — an owned, reproduced
measurement of a known technique, **not** a novel method. n=40 (edge ~4 items, wide CI); AUROC is
uncontrolled for answer-commonness. Its real use is as the **baseline to beat**: whether the Sigma0
hidden-state surprise canary or the council-Delta gates *better than logprob* on the same items is
the genuinely-owned open question. `data/eval/halueval_gated_results.json`.
