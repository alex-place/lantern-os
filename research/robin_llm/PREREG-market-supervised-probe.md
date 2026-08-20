# Pre-registration — market-implied uncertainty as supervision for an internal-confidence probe

**Date:** 2026-08-21. Written while the price backfill runs, before any of its numbers were seen.
Thresholds below do not move after data.

## The claim under test

The one idea family in 30+ milled that has survived two independent mill runs and two hand
reviews: **use settled prediction-market outcomes and market-implied uncertainty as the
ground-truth stream supervising a hidden-state confidence probe** — instead of the
correctness-vs-hallucination labels every published probe uses. The nearest prior art calibrates
*outputs* (KalshiBench evaluates; Beta-Bernoulli calibrates verbalized forecasts; US12032919
post-calibrates confidence scores). Nothing found supervises *internal* signals with market
ground truth. That is still not a novelty claim; it is an unplaced one.

## Why this could work at all (the mechanism, stated so it can be refuted)

A market price is a scalar that aggregates many agents' information under real stakes; its
distance from 0/1 is a measured degree of *world-uncertainty* for the exact question asked. A
correctness label is binary and conflates "the model was wrong" with "the question was hard".
If hidden states encode question-difficulty separately from answer-choice (the probe-ladder
results say factual truth is linearly decodable), then market-graded labels should teach a probe
*calibration* — not just detection — and transfer better to questions with no market.

## Gates, fixed now

**P0 — dataset viability (retrospective arm).** The backfill recovers `last_price` at close and
`spread`. A close price converges toward the outcome, so it risks being the label in disguise.
Gate: the retrospective arm proceeds only if **≥20% of matched rows have close price in
[0.05, 0.95]**. If not, close-price supervision is degenerate; the retrospective arm is KILLED
and only the prospective arm (below) remains honest.

**P1 — the probe comparison (one bounded day).** On Qwen2.5-1.5B via the existing
`probe_ladder.py` harness, mid-layer hidden states over the benchmark questions:
- Arm A: probe trained on binary correctness (the standard recipe).
- Arm B: probe trained to regress market-implied probability (or trained on outcome but
  weighted by market uncertainty; both count as B, whichever is pre-committed at run time —
  named in the run log before results).
- Same GroupKFold-by-question splits, same layer sweep, both arms score on held-out **settled
  outcomes**.
- **Gate:** Arm B is interesting iff its held-out ECE (calibration) beats Arm A by ≥20% relative
  **without** losing more than 2 points of AUROC. Anything else: recorded and dropped.

**P2 — controls.**
- Shuffle control: market probabilities permuted across questions → Arm B must collapse to
  Arm A or worse (if it does not, the "market signal" was never doing anything).
- Style control: the de-glossed methodology from `honesty_whitebox_vs_blackbox` applies — report
  the surface-features-only AUROC alongside, or the number means nothing.

**Kill conditions.** P0 fails → retrospective arm dead, say so. P1 gate missed → the family is
finally PLACED as "no better than correctness labels", recorded in the review file, and the mill
inherits it via priorwork.js.

## The prospective arm (the durable version, needs no luck)

Close prices may be degenerate; *pre-close* prices are the real signal and the public candles for
old markets 404. But `kalshi-collector.js` already snapshots live prices every 6 seconds in
production. **Logging (ticker, t, yes_bid, yes_ask) for open markets we already poll, then joining
on settlement, builds the non-degenerate dataset prospectively** — at horizon T−24h, T−7d, any
horizon we choose. That dataset is the proprietary asset version of this idea: nobody outside can
reconstruct our polled horizons. Zero new infrastructure; one JSONL append in a loop that already
runs.

## What this is not

Not a trading signal, not a claim the probe helps trading, and not a novelty claim. It is one
bounded comparison with pre-registered gates, plus one cheap logging change that makes the honest
version of the dataset exist.
