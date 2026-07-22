# Layer 2: does modelUncertainty change the canary's classification? Not on this dataset — and the code shows exactly why

**Date:** 2026-07-01
**Status:** research result (measured) — negative/inconclusive, with a clear methodological cause identified.
**Loop stages:** Verify (the leak).
**Harness:** [`experiments/surprise_leak_layer2_canary.js`](../../experiments/surprise_leak_layer2_canary.js)

## What was tested

#1679's exact question: does feeding `modelUncertainty` into
[`groundedness-canary.js`](../../apps/lantern-garage/lib/groundedness-canary.js)'s risk score
improve hallucination **detection** (recall/FPR through the real, shipped canary) vs the
text-only baseline it runs today with `SURPRISE_CANARY` off?

No new model generation was needed. The Layer-1 result files
(`experiments/results/surprise_leak_{qwen15b,mistral7b}.jsonl`, from
[the Layer-1 result](2026-06-30-surprise-leak-layer1-result.md)) already carry, per example: the
generated reply text (`prediction`), the hallucination label, and the exact `surpriseField`
shape (`{nTokens, meanBits, p90Bits, maxBits, tailMass}`) the canary's `toUncertainty()` consumes.
The harness calls the real `scoreReplyGroundedness()` twice per row — once with
`tokenSurprise: null` (today's live default), once with the real field + the correct per-model
calibration (#1681) — at the canary's own default threshold (0.5, no tuning).

## Result

| Dataset | n | too_short (canary can't score) | scored | text-only recall/FPR | text+surprise recall/FPR | Δ |
|---|---|---|---|---|---|---|
| qwen2.5-coder:1.5b | 199 | 184 (92.5%) | 15 | 0.7143 / 1.0000 | 0.7143 / 1.0000 | +0.0000 / +0.0000 |
| mistral:7b | 199 | 187 (94.0%) | 12 | 1.0000 / 1.0000 | 1.0000 / 1.0000 | +0.0000 / +0.0000 |

Zero measurable change from the surprise signal, on both datasets. Full confusion-matrix
counts + report: [`experiments/results/surprise_leak_layer2_canary_report.json`](../../experiments/results/surprise_leak_layer2_canary_report.json).

## Why — two independent, both fatal for this dataset

1. **92-94% of rows are structurally unscoreable.** `groundedness-canary.js`'s `MIN_TOKENS=16`
   returns `risk=0` unconditionally below that length — "not enough signal, don't cry
   ungrounded." The Layer-1 dataset is terse, one-line OpenTDB factual answers ("Charizard is
   a fire-type Pokémon" = 8 tokens). The canary was built for full chat replies, not short-answer
   QA; almost none of this dataset reaches its floor.
2. **On the ~6-8% that DO score, base (text-only) risk is already saturated at 1.0.** A bare
   factual assertion with no hedging and no anchor is exactly the "confident + unanchored"
   42-state signature by construction — `assertiveness * (1 - anchor)` is already at or near its
   ceiling before the surprise `sharpen` multiplier is ever applied. Since
   `risk = min(1, assertiveness * (1-anchor) * sharpen)`, once the un-sharpened term already
   hits 1, multiplying by `sharpen >= 1` cannot change anything — there's no "borderline case"
   left for the raise-only design to push over threshold. FPR = 1.0000 on the scored subset in
   both datasets confirms this: the canary is already flagging everything scoreable, signal or
   no signal.

Neither of these is a flaw in `modelUncertainty` or in the canary's raise-only design — the
canary's own docstring is explicit that `sharpen` only matters "inside the 42-state corner,"
never manufacturing risk where the text signal is already at 0 or already at 1. It's a mismatch
between *this specific dataset* (short, un-hedged trivia answers) and *this specific canary*
(tuned for longer, more discursive chat replies where partial hedging/partial anchoring produce
genuine mid-range risk scores for the surprise term to sharpen).

## Decision

**Keep `SURPRISE_CANARY` at its shipped default (OFF).** This test produced no evidence of
benefit — but critically, also no evidence of harm (FPR unchanged, not worsened). The honest
read is *insufficient evidence*, not *evidence against*: the null result is explained entirely by
a dataset/canary length mismatch, not by the underlying signal failing on realistic replies (the
signal's ranking validity was already established at Layer 1, AUROC 0.77–0.81 on the same data).

**What a real Layer 2 test needs:** a labeled dataset of full-length, discursive chat replies
(not one-line QA answers) with a genuine mix of hedged/anchored/confident-unanchored examples —
so the canary's base risk actually lands in the mid-range where `sharpen` has room to move it.
Candidates: replay real `dream-chat` convergence records with post-hoc hallucination labels, or a
longer-form QA set (e.g., ELI5-style or multi-sentence factual explanations) rather than OpenTDB's
one-line answers. Not attempted here — out of scope for this pass; flagging as the concrete
next step rather than re-running the same mismatched test with tuned thresholds.

## Honesty notes (REAL / APPROX / caveat)

- **REAL:** the canary calls, the confusion-matrix counts, the too_short rate — all measured
  directly against the shipped `scoreReplyGroundedness()`, no re-implementation.
- **Small N:** only 15 and 12 rows were actually scoreable per dataset — this is not a
  statistically powered result even within its own narrow claim; no bootstrap CI is reported
  because the scored-n is too small for one to be meaningful.
- **Not tested:** #1680 (Layer 3, end-to-end verified-pass-rate) depends on Layer 2 answering
  something conclusive first — it remains untested for the same reason.
