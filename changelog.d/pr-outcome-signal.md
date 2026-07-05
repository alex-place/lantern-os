### Council backtest: real null (n=0) + the runnable owner-only cousin (PR-rejection signal)

The council-Δ backtest (`council_escalation_backtest.py`) is genuinely unrunnable —
`data/convergence/council-reviews.jsonl` is empty (councilReview logs 0 Δ records) and reverts are
~12/3015 commits, too rare to power the label. So the council-Δ number is a real null, not fabricated.

`experiments/pr_outcome_signal.py` produces the well-powered, owner-only question it was a proxy for:
does a cheap signal predict which PRs get REJECTED (closed-unmerged)? On your history (1292 PRs, 222
rejected, GroupKFold by author): combined AUROC **0.628**, but dominated by the near-tautological
`is_draft` (0.73); **without draft/slop the non-trivial structural signal is 0.565 ≈ chance**. So
metadata does NOT flag which real PRs get rejected — a near-null that *motivates* logging the
council's semantic Δ (where predictive value would live). MEASURED
(`data/sigma0/pr_outcome_signal_report.json`); reproducible only by the repo owner (private history).
