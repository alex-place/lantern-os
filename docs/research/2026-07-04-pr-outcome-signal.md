# The council backtest, honestly: a real null + the runnable owner-only cousin

**Date:** 2026-07-04 · **Evidence class:** MEASURED · **Loop stage:** Verify/Converge
**Artifacts:** `experiments/pr_outcome_signal.py`, `data/sigma0/pr_outcome_signal_report.json`

## The council-Δ backtest is a real null (n=0)

The intended measurement — *does the Σ₀ council's Δ-disagreement predict decisions the operator
later reverted?* (`experiments/council_escalation_backtest.py`) — **cannot be produced.**
`data/convergence/council-reviews.jsonl` is **empty**: `councilReview()` is wired into the autowork
path but has logged **0** Δ records to disk, and git reverts are ~12 of 3015 commits — too rare to
power the label even if Δ existed. So the council-Δ number is genuinely blocked on *data*, and I
won't fabricate it. That's the honest null.

## The runnable, owner-only cousin

The question the council backtest was a proxy for — *can a cheap signal flag your bad work, on a
ground truth only you have?* — **is** answerable now, because your PR history is rich and private:
**1000+ merged vs 222 closed-unmerged ("rejected")** PRs. `pr_outcome_signal.py` self-pulls this
via `gh` and asks: does cheap PR metadata predict rejection? (GroupKFold **by author**, so it must
generalize across contributors, not memorize one.)

| Signal | AUROC |
|---|---|
| `is_draft` | **0.73** (near-tautological — drafts don't merge) |
| `title_len` | 0.62 |
| `deletions` | 0.59 |
| additions / churn / changed_files / n_labels | ~0.53 (≈ chance) |
| **combined** | **0.628** |
| **combined without draft/slop (the non-trivial signal)** | **0.565** ≈ chance |

## Reading

**Cheap metadata does NOT predict which of your real PRs get rejected** — the 0.63 is almost
entirely the obvious "drafts don't merge," and once that's removed the structural signal (size,
churn, files) is barely above chance (0.57). Rejection isn't legible from structure; it lives in
*content*.

That near-null is the point, and it **motivates the council Δ**: since metadata carries little
signal, the predictive value would have to come from a *semantic* signal — which is exactly what
`councilReview()`'s Δ (collapse-proximity × groundedness-risk × dissent) is meant to be, and why
logging it (turning the n=0 into real records) is the worthwhile next step. This is also the
methodology working as intended: a question grounded in data only the owner has, turned into a
real number (here, a real null) rather than a claim.

**Honest caveats:** "closed-unmerged" is a noisy bad-label (superseded / duplicate / auto-closed
slop mixed with genuine rejects); 222 positives across 7 authors; metadata-only (no content/semantic
features); reproducible only by the repo owner (private history) — which is the entire point.
